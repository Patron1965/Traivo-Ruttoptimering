import type { Request, Response, NextFunction } from "express";
import { db, auditLogTable } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { getClientIp } from "../lib/security-log";

const AUDITED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const RESOURCE_PATTERNS: Array<{ pattern: RegExp; resource: string }> = [
  { pattern: /^\/api\/routes/, resource: "route" },
  { pattern: /^\/api\/stops/, resource: "stop" },
  { pattern: /^\/api\/vehicles/, resource: "vehicle" },
  { pattern: /^\/api\/drivers/, resource: "driver" },
  { pattern: /^\/api\/customers/, resource: "customer" },
  { pattern: /^\/api\/users/, resource: "user" },
  { pattern: /^\/api\/webhooks/, resource: "webhook" },
  { pattern: /^\/api\/organizations/, resource: "organization" },
  { pattern: /^\/api\/org-settings/, resource: "organization" },
  { pattern: /^\/api\/optimize/, resource: "optimization" },
  { pattern: /^\/api\/tracking\/location/, resource: "telemetry" },
];

const SKIP_PATHS = [
  /^\/api\/track(?:\/|$)/i,
  /^\/api\/tracking\/location/,
  /^\/api\/health/,
  /^\/api\/notifications\/mark-read/,
  /\/auth\//,
];

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "currentpassword",
  "newpassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
]);

function detectResource(path: string): string {
  for (const { pattern, resource } of RESOURCE_PATTERNS) {
    if (pattern.test(path)) return resource;
  }
  return "unknown";
}

function extractResourceId(path: string): string | null {
  const match = path.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

function safeJsonClone(value: unknown): unknown {
  if (value == null) return value;
  try {
    const json = JSON.stringify(value, (key, val) => {
      if (key && SENSITIVE_KEYS.has(key.toLowerCase())) return "[redacted]";
      if (typeof val === "string" && val.startsWith("data:image")) return "[image_omitted]";
      if (typeof val === "string" && val.length > 1000) return val.substring(0, 1000) + "...[truncated]";
      return val;
    });
    return JSON.parse(json);
  } catch {
    return null;
  }
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("X-Request-ID", req.requestId);

  if (!AUDITED_METHODS.has(req.method)) return next();
  if (SKIP_PATHS.some((p) => p.test(req.path))) return next();

  const startTime = Date.now();
  const isCustomerLink = /^\/api\/stops\/[^/]+\/customer-link\/?$/i.test(req.path);
  const requestBody = /^\/api\/stops\/[^/]+\/customer-link\/sms\/?$/i.test(req.path)
    ? { revision: req.body?.revision, resend: req.body?.resend }
    : /^\/api\/send-sms\/?$/i.test(req.path)
    ? { payload: "[redacted]" }
    : isCustomerLink
    ? { action: ["create", "replace", "revoke"].includes(req.body?.action) ? req.body.action : "invalid" }
    : safeJsonClone(req.body);

  res.on("finish", () => {
    // Only audit requests made by an authenticated user. Org/identity is taken
    // strictly from the session — never from client-supplied body/query — so a
    // caller cannot forge entries into another tenant's log (audit runs before
    // route-level auth enforcement, so unauthenticated/401 writes are skipped).
    if (!req.user) return;
    const orgId = req.user.organizationId;

    const resourceType = detectResource(req.path);
    const resourceId = extractResourceId(req.path);

    db.insert(auditLogTable)
      .values({
        organizationId: orgId,
        userId: req.user.id,
        userEmail: req.user.email,
        action: req.method,
        resourceType,
        resourceId,
        method: req.method,
        path: req.path,
        statusCode: String(res.statusCode),
        requestId: req.requestId,
        ipAddress: getClientIp(req),
        userAgent: req.headers["user-agent"] || null,
        diff: requestBody as object | null,
        metadata: {
          homeOrganizationId: req.user.homeOrganizationId ?? req.user.organizationId,
          workspaceOrganizationId: req.user.workspace?.organizationId ?? null,
          durationMs: Date.now() - startTime,
          // Keep the authenticated admin as userId; this names the assisted
          // driver/route without ever turning an assistance request into an
          // impersonated session.
          assistedDriverId: req.headers["x-traivo-assist-driver-id"] ?? null,
          assistedRouteId: req.headers["x-traivo-assist-route-id"] ?? null,
        },
      })
      .catch((err) => {
        console.error("[AUDIT] Failed to write log:", err?.message || err);
      });
  });

  next();
}
