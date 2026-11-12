import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { validateAndTouchSession } from "../lib/session";
import { verifyDriverStopOwnership } from "../services/field-service";
import { resolveWorkspace } from "../lib/workspace-context";
import { driverSessionUser } from "../lib/driver-device-policy";

export type UserRole = "admin" | "dispatcher" | "driver" | "viewer";

const SESSION_COOKIE = "routeai_session";
const UUID_PARAM_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidParam(value: string): boolean {
  return UUID_PARAM_REGEX.test(value);
}

function getSessionToken(req: Request): string | null {
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isPlatformAdmin?: boolean;
  organizationId: string;
  driverProfileId: string | null;
  homeOrganizationId?: string;
  workspace?: { organizationId: string; organizationName: string; expiresAt: string };
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authMiddleware(validateSession = validateAndTouchSession) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const workspaceToken = req.get("X-Traivo-Workspace");
    if (workspaceToken) {
      _res.setHeader("Cache-Control", "no-store");
      _res.vary("X-Traivo-Workspace");
    }
    const token = getSessionToken(req);
    if (!token) {
      if (workspaceToken) {
        _res.status(401).json({ code: "WORKSPACE_INVALID", error: "Ingen aktiv session." });
        return;
      }
      next();
      return;
    }

    try {
      const session = await validateSession(token);
      if (session) {
        const [user] = await db
          .select()
          .from(usersTable)
          // A session's organization is the authorization boundary. Confirm the
          // user is still a member of that organization, but never replace the
          // session scope with a request value or a user-table value.
          .where(and(eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId)))
          .limit(1);

        if (user?.isActive && (session.driverAccess || !user.mfaRecoveryRequired)) {
          req.user = driverSessionUser({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role as UserRole,
            isPlatformAdmin: user.isPlatformAdmin,
            organizationId: session.organizationId,
            driverProfileId: user.driverProfileId,
          }, session);
          if (workspaceToken) {
            const workspace = user.isPlatformAdmin && !session.driverAccess
              ? await resolveWorkspace(workspaceToken, session.tokenHash, user.id) : null;
            if (!workspace) {
              _res.status(403).json({ code: "WORKSPACE_INVALID", error: "Företagsåtkomsten har upphört. Återgå till Superuser och välj företag igen." });
              return;
            }
            req.user = Object.freeze({ ...req.user, homeOrganizationId: session.organizationId,
              organizationId: workspace.organizationId, role: "admin", driverProfileId: null, workspace: Object.freeze(workspace) });
            // Platform management endpoints intentionally accept an explicit
            // target. All operational callers must agree with the issued scope.
            if (!req.path.replace(/^\/api/, "").startsWith("/platform/")) {
              for (const supplied of [req.body?.organizationId, req.query.organizationId]) {
                if (supplied != null && supplied !== workspace.organizationId) {
                  _res.status(403).json({ error: "Organisationen matchar inte aktuell företagsåtkomst." });
                  return;
                }
              }
            }
          }
        }
      }
    } catch {
      if (workspaceToken) {
        _res.status(503).json({ code: "WORKSPACE_INVALID", error: "Företagsåtkomsten kunde inte verifieras." });
        return;
      }
    }

    if (workspaceToken && !req.user) {
      _res.status(401).json({ code: "WORKSPACE_INVALID", error: "Ingen giltig session för företagsåtkomsten." });
      return;
    }

    next();
  };
}

export function requireAuth() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: authentication required", ...(/\/customer-link\/?$/.test(req.path) ? { code: "UNAUTHORIZED" } : {}) });
      return;
    }
    next();
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: authentication required" });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }

    next();
  };
}

export function requirePlatformAdmin() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: authentication required" });
      return;
    }
    if (req.user.isPlatformAdmin !== true) {
      res.status(403).json({ error: "Forbidden: platform administrator required" });
      return;
    }
    next();
  };
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Write paths the `driver` role is permitted to mutate (driver-app flows).
 * Matched against the path with any leading `/api` stripped.
 */
const DRIVER_WRITE_ALLOW: RegExp[] = [
  /^\/tracking\/location$/,
  /^\/tracking\/route-session$/,
  /^\/stops\/[^/]+$/,
  /^\/stops\/[^/]+\/execution-events$/,
  /^\/stops\/[^/]+\/proof$/,
  /^\/stops\/[^/]+\/service-report$/,
  /^\/stops\/[^/]+\/messages(?:\/read)?$/,
  /^\/stops\/[^/]+\/exceptions$/,
  /^\/drivers\/[^/]+$/,
  /^\/drivers\/[^/]+\/preferences$/,
  /^\/routes\/[^/]+\/handoff$/,
  /^\/routes\/[^/]+\/(?:start|end|execution\/(?:start|end))$/,
  /^\/routes\/[^/]+\/incidents$/,
  /^\/routes\/[^/]+\/messages$/,
  /^\/notifications\/(?:[^/]+\/read|read-all)$/,
];

/**
 * Sensitive admin surfaces — writes require the `admin` role regardless of
 * any other operational permission.
 */
const ADMIN_WRITE_ONLY: RegExp[] = [
  /^\/portal-admin(?:\/|$)/,
  /^\/send-sms\/?$/i,
  /^\/app-users(?:\/|$)/,
  /^\/user-groups(?:\/|$)/,
  /^\/organizations\/[^/]+\/settings$/,
  /^\/branding(?:\/|$)/,
];

export function hasOnlyDriverStopStatusFields(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const allowedFields = new Set(["status", "organizationId"]);
  const attemptedFields = Object.keys(body as Record<string, unknown>);
  return attemptedFields.length > 0 && attemptedFields.every((field) => allowedFields.has(field));
}

/**
 * Centralized least-privilege write authorization. Runs after authentication
 * for every mutating request. Encodes the full role→write matrix in one place:
 *   - admin:      all writes
 *   - dispatcher: all operational writes except admin surfaces
 *   - driver:     only the allowlisted driver-app writes
 *   - viewer:     no writes (read-only)
 * Read requests (GET/HEAD/OPTIONS) and unauthenticated public routes pass through.
 */
export function authorizeWrite() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      next();
      return;
    }
    if (!WRITE_METHODS.has(req.method)) {
      next();
      return;
    }

    const path = req.path.replace(/^\/api/, "");
    if (/^\/auth\/logout\/?$/.test(path)) {
      next();
      return;
    }

    const role = req.user.role;
    // District planning is never a driver-app operation, even if the general
    // driver write allowlist is expanded in the future.
    if (/^\/district-plans(?:\/|$)/.test(path) && role !== "admin" && role !== "dispatcher") {
      res.status(403).json({ error: "Forbidden: district planning requires a planner role" });
      return;
    }
    // Platform authorization is an independent privilege, never inherited
    // from an organization's "admin" role.
    if (path === "/platform" || path.startsWith("/platform/")) {
      if (req.user.isPlatformAdmin !== true) {
        res.status(403).json({ error: "Forbidden: Traivo Superuser required" });
        return;
      }
      next();
      return;
    }
    if (role === "admin") {
      next();
      return;
    }

    if (role === "viewer") {
      res.status(403).json({ error: "Forbidden: read-only role cannot modify data", ...(/\/customer-link\/?$/.test(req.path) ? { code: "FORBIDDEN" } : {}) });
      return;
    }

    if (ADMIN_WRITE_ONLY.some((re) => re.test(path))) {
      res.status(403).json({ error: "Forbidden: admin role required" });
      return;
    }

    if (role === "dispatcher") {
      next();
      return;
    }

    if (role === "driver") {
      if (DRIVER_WRITE_ALLOW.some((re) => re.test(path))) {
        // A driver may only modify their OWN driver profile, not another
        // driver's record in the same org.
        const driverMatch = path.match(/^\/drivers\/([^/]+)(?:\/preferences)?$/);
        if (driverMatch && driverMatch[1] !== req.user.driverProfileId) {
          res.status(403).json({ error: "Forbidden: drivers may only modify their own profile" });
          return;
        }

        const stopMatch = path.match(/^\/stops\/([^/]+)(?:\/(execution-events|proof|service-report|messages(?:\/read)?|exceptions))?$/);
        if (stopMatch) {
          if (!req.user.driverProfileId) {
            res.status(403).json({ error: "Forbidden: driver account has no linked driver profile" });
            return;
          }
          if (!isUuidParam(stopMatch[1])) {
            res.status(400).json({ error: "Invalid stop id" });
            return;
          }

          try {
            const ownershipError = await verifyDriverStopOwnership(
              stopMatch[1],
              req.user.organizationId,
              req.user.driverProfileId,
            );
            if (ownershipError) {
              res.status(ownershipError.statusCode).json({ error: ownershipError.message });
              return;
            }
          } catch (error) {
            next(error);
            return;
          }

          if (!stopMatch[2]) {
            if (!hasOnlyDriverStopStatusFields(req.body)) {
              res.status(403).json({ error: "Forbidden: drivers may only update stop status" });
              return;
            }
          }
        }

        next();
        return;
      }
      res.status(403).json({ error: "Forbidden: insufficient role", ...(/\/customer-link\/?$/.test(req.path) ? { code: "FORBIDDEN" } : {}) });
      return;
    }

    res.status(403).json({ error: "Forbidden: insufficient role", ...(/\/customer-link\/?$/.test(req.path) ? { code: "FORBIDDEN" } : {}) });
  };
}

export function getOrgId(req: Request): string {
  if (req.user) {
    return req.user.organizationId;
  }
  // Organization ids from a body or query string are client-controlled and
  // must never establish a tenant boundary.
  throw new OrgScopeError("Authenticated organization scope is required");
}

/** Reject client-supplied tenant scopes which disagree with the session. */
export function assertOrgScope(req: Request, suppliedOrganizationId: unknown): string {
  const organizationId = getOrgId(req);
  if (
    suppliedOrganizationId != null &&
    (typeof suppliedOrganizationId !== "string" || suppliedOrganizationId !== organizationId)
  ) {
    throw new OrgScopeError("Forbidden: organizationId does not match authenticated organization", 403);
  }
  return organizationId;
}

export class OrgScopeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OrgScopeError";
    this.statusCode = statusCode;
  }
}
