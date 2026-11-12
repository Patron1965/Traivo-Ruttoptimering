import { Router, type IRouter, type Request } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { RedeemPlatformMfaOperatorRecoveryBody, RedeemPlatformMfaOperatorRecoveryResponse } from "@workspace/api-zod";
import { db, usersTable, sessionsTable, passwordResetTokensTable, platformMfaRecoveryGrantsTable } from "@workspace/db";
import { rateLimit } from "express-rate-limit";
import { assertRecoveryEnrollment, recoveryAudit, redeemOperatorRecovery } from "../lib/platform-mfa-recovery";
import { handleError } from "../lib/errors";
import { verifyPassword, hashPassword } from "../lib/password";
import { createSession, revokeSession, validateAndTouchSession, sessionMeta, hashToken, notifySessionRevoked } from "../lib/session";
import { platformMfaKey } from "../lib/platform-mfa";
import { matchesEmailCode, sendPlatformEmailCode } from "../services/platform-email-code";
import { getEnvConfig } from "../lib/env-config";
import { logSecurityEvent } from "../lib/security-log";
import type { UserRole } from "../middleware/auth";
import recoveryRouter from "./recovery";
import { platformPasswordOnlyTestMode } from "../lib/platform-auth-policy";
import { driverSessionUser } from "../lib/driver-device-policy";

export function createAuthRouter(sendCode: typeof sendPlatformEmailCode = sendPlatformEmailCode) {
const router: IRouter = Router();
const operatorRecoveryBody = RedeemPlatformMfaOperatorRecoveryBody.extend({
  email: z.string().trim().toLowerCase().pipe(RedeemPlatformMfaOperatorRecoveryBody.shape.email),
}).strict();
// Deliberately use the socket peer, not an untrusted forwarded header. Behind a
// proxy this is a conservative shared limit; account lockouts also persist in DB.
router.post("/auth/mfa/operator-recovery", rateLimit({
  windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
  validate: { xForwardedForHeader: false },
}), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const input = operatorRecoveryBody.safeParse(req.body);
    if (!input.success) {
      await db.transaction(tx => recoveryAudit(tx, undefined, "failed", undefined, { reason: "invalid_input" }));
      res.status(400).json({ error: "Ogiltiga uppgifter" }); return;
    }
    const token = await redeemOperatorRecovery(input.data.email, input.data.password, input.data.recoveryToken);
    if (!token) { res.status(401).json({ error: "Ogiltiga uppgifter eller återställningsgodkännande" }); return; }
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: 10 * 60_000 });
    const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
    await sendCode(session.id);
    res.json(RedeemPlatformMfaOperatorRecoveryResponse.parse({ mfaRequired: true, enrollmentRequired: false }));
  } catch (err) {
    const status = err instanceof Error && "statusCode" in err && err.statusCode === 503 ? 503 : 500;
    res.status(status).json({ error: status === 503 ? "Operatoråterställning är inte tillgänglig." : "Återställningen kunde inte genomföras." });
  }
});

const SESSION_COOKIE = "routeai_session";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function cookieOptions() {
  const config = getEnvConfig();
  return {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
    path: "/",
  };
}

function getTokenFromRequest(req: Request): string | null {
  const cookieToken = req.cookies?.[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function publicUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role as UserRole,
    isPlatformAdmin: user.isPlatformAdmin,
    platformPasswordOnlyTestMode: user.isPlatformAdmin && platformPasswordOnlyTestMode(),
    organizationId: user.organizationId,
    driverProfileId: user.driverProfileId,
  };
}

router.post("/auth/login", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      const attemptedEmail =
        typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null;
      await logSecurityEvent({
        req,
        action: "login.failed",
        statusCode: 400,
        userEmail: attemptedEmail,
        reason: "invalid_input",
      });
      res.status(400).json({ error: "Ogiltig e-post eller lösenord" });
      return;
    }
    const config = getEnvConfig();
    const email = parsed.data.email.trim().toLowerCase();

    const candidates = await db
      .select()
      .from(usersTable)
      .where(sql`lower(trim(${usersTable.email})) = ${email}`)
      .limit(2);
    const user = candidates.length === 1 ? candidates[0] : undefined;

    const genericError = () =>
      res.status(401).json({ error: "Felaktig e-post eller lösenord" });

    if (!user?.isActive) {
      // Avoid leaking which emails exist.
      await logSecurityEvent({
        req,
        action: "login.failed",
        statusCode: 401,
        userEmail: email,
         reason: candidates.length > 1 ? "ambiguous_email" : "user_not_found",
      });
      genericError();
      return;
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await logSecurityEvent({
        req,
        action: "login.failed",
        statusCode: 423,
        organizationId: user.organizationId,
        userId: user.id,
        userEmail: user.email,
        reason: "account_locked",
      });
      res.status(423).json({
        error: "Kontot är tillfälligt låst på grund av för många misslyckade försök. Försök igen senare.",
      });
      return;
    }

    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) {
      const now = Date.now();
      const windowMs = config.ACCOUNT_LOCKOUT_WINDOW_MIN * 60_000;
      // Only count failures inside the rolling window; older failures reset it.
      const withinWindow =
        user.failedLoginWindowStartedAt != null &&
        now - user.failedLoginWindowStartedAt.getTime() < windowMs;
      const attempts = (withinWindow ? user.failedLoginAttempts ?? 0 : 0) + 1;
      const shouldLock = attempts >= config.ACCOUNT_LOCKOUT_THRESHOLD;
      await db
        .update(usersTable)
        .set({
          failedLoginAttempts: shouldLock ? 0 : attempts,
          failedLoginWindowStartedAt: shouldLock
            ? null
            : withinWindow
              ? user.failedLoginWindowStartedAt
              : new Date(now),
          lockedUntil: shouldLock
            ? new Date(now + config.ACCOUNT_LOCKOUT_DURATION_MIN * 60_000)
            : user.lockedUntil,
        })
        .where(eq(usersTable.id, user.id));
      if (shouldLock) {
        await logSecurityEvent({
          req,
          action: "login.failed",
          statusCode: 423,
          organizationId: user.organizationId,
          userId: user.id,
          userEmail: user.email,
          reason: "account_locked",
        });
        res.status(423).json({
          error: "Kontot har låsts på grund av för många misslyckade försök. Försök igen om en stund.",
        });
        return;
      }
      await logSecurityEvent({
        req,
        action: "login.failed",
        statusCode: 401,
        organizationId: user.organizationId,
        userId: user.id,
        userEmail: user.email,
        reason: "invalid_password",
      });
      genericError();
      return;
    }

    if (user.mfaRecoveryRequired) {
      res.status(401).json({ error: "Operatoråterställning krävs.", code: "PLATFORM_MFA_RECOVERY_REQUIRED" }); return;
    }
    const requiresMfa = user.isPlatformAdmin && !platformPasswordOnlyTestMode();
    if (requiresMfa) platformMfaKey();
    const { token, session } = await createSession({
      verifiedCredentials: { email: user.email, passwordHash: user.passwordHash },
      userId: user.id,
      organizationId: user.organizationId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });

    await logSecurityEvent({
      req,
      action: requiresMfa ? "platform.mfa.pending" : user.isPlatformAdmin ? "platform.password_only_test.login" : "login.success",
      statusCode: 200,
      organizationId: user.organizationId,
      userId: user.id,
      userEmail: user.email,
    });

    res.cookie(SESSION_COOKIE, token, cookieOptions());
    if (requiresMfa) {
      await sendCode(session.id);
      res.json({ mfaRequired: true, enrollmentRequired: false });
      return;
    }
    res.json({ user: publicUser(user), token, session: sessionMeta(session) });
  } catch (err) {
    handleError(res, err);
  }
});

// Unless the explicit temporary password-only mode is active, pending platform
// sessions cannot authenticate elsewhere. Recovery sessions always fail closed.
async function pendingPlatformSession(req: Request) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  const [session] = await db.select().from(sessionsTable)
    .where(and(eq(sessionsTable.tokenHash, hashToken(token)), sql`${sessionsTable.revokedAt} IS NULL`));
  if (!session || session.driverAccess || session.mfaVerifiedAt || session.mfaAttempts >= 8 ||
    Date.now() - session.createdAt.getTime() > 10 * 60_000 ||
    session.expiresAt.getTime() < Date.now()) return null;
  const [user] = await db.select().from(usersTable).where(and(
    eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId),
    eq(usersTable.isActive, true), eq(usersTable.isPlatformAdmin, true),
  ));
  return user && (!user.mfaLockedUntil || user.mfaLockedUntil.getTime() <= Date.now()) ? { session, user } : null;
}

router.get("/auth/mfa/status", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const pending = await pendingPlatformSession(req);
    if (!pending) { res.status(401).json({ error: "Logga in igen" }); return; }
    res.json({ mfaRequired: true, enrollmentRequired: false });
  } catch (err) { handleError(res, err); }
});

router.post("/auth/mfa/enroll", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(410).json({ error: "Autentiseringsapp används inte längre. Logga in med koden som skickas via e-post." });
});

router.post("/auth/mfa/resend", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const pending = await pendingPlatformSession(req);
    if (!pending) { res.status(401).json({ error: "Logga in igen." }); return; }
    await sendCode(pending.session.id);
    res.status(204).end();
  } catch (err) { handleError(res, err); }
});

router.post("/auth/mfa/verify", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Ogiltig kod" }); return; }
    const pending = await pendingPlatformSession(req);
    if (!pending) { res.status(401).json({ error: "Logga in igen" }); return; }
    const result = await db.transaction(async (tx) => {
      // Account edits lock user before sessions; use the same order here.
      const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, pending.user.id)).for("update");
      if (!user?.isActive || !user.isPlatformAdmin) return null;
      const [session] = await tx.select().from(sessionsTable).where(eq(sessionsTable.id, pending.session.id)).for("update");
      if (!session || session.revokedAt || session.mfaVerifiedAt || session.mfaAttempts >= 8 ||
        Date.now() - session.createdAt.getTime() > 10 * 60_000) return null;
      if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > Date.now()) return null;
      if (session.expiresAt.getTime() <= Date.now()) return null;
      await assertRecoveryEnrollment(tx, user, session);
      if ((user.lockedUntil?.getTime() ?? 0) > Date.now()) return null;
      if (!matchesEmailCode(session, user.email, parsed.data.code)) {
        await tx.update(sessionsTable).set({ mfaAttempts: session.mfaAttempts + 1 }).where(eq(sessionsTable.id, session.id));
        const withinWindow = user.mfaFailureWindowStartedAt &&
          Date.now() - user.mfaFailureWindowStartedAt.getTime() < 15 * 60_000;
        const attempts = (withinWindow ? user.mfaFailedAttempts : 0) + 1;
        await tx.update(usersTable).set({
          mfaFailedAttempts: attempts,
          mfaFailureWindowStartedAt: withinWindow ? user.mfaFailureWindowStartedAt : new Date(),
          mfaLockedUntil: attempts >= 8 ? new Date(Date.now() + 15 * 60_000) : null,
        }).where(eq(usersTable.id, user.id));
        return null;
      }
      if (user.mfaRecoveryRequired) {
          await tx.update(platformMfaRecoveryGrantsTable).set({ completedAt: new Date() })
            .where(eq(platformMfaRecoveryGrantsTable.id, session.mfaRecoveryGrantId!));
          await tx.update(usersTable).set({ mfaRecoveryRequired: false }).where(eq(usersTable.id, user.id));
          await recoveryAudit(tx, user, "completed", session.mfaRecoveryGrantId!);
      }
      await tx.update(usersTable).set({
        mfaFailedAttempts: 0, mfaFailureWindowStartedAt: null, mfaLockedUntil: null,
      }).where(eq(usersTable.id, user.id));
      const revoked = user.mfaRecoveryRequired ? await tx.update(sessionsTable).set({ revokedAt: new Date() })
        .where(and(eq(sessionsTable.userId, user.id), sql`${sessionsTable.id} <> ${session.id}`,
          sql`${sessionsTable.revokedAt} IS NULL`)).returning({ id: sessionsTable.id }) : [];
      if (user.mfaRecoveryRequired) await tx.update(passwordResetTokensTable).set({ usedAt: new Date() })
        .where(eq(passwordResetTokensTable.userId, user.id));
      const [verified] = await tx.update(sessionsTable).set({
        mfaVerifiedAt: new Date(), mfaEmailCodeHash: null, mfaEmailExpiresAt: null,
      }).where(eq(sessionsTable.id, session.id)).returning();
      return { user, session: verified, revoked };
    });
    if (!result) {
      await logSecurityEvent({ req, action: "platform.mfa.failed", statusCode: 401,
        organizationId: pending.user.organizationId, userId: pending.user.id, userEmail: pending.user.email });
      res.status(401).json({ error: "Felaktig eller förbrukad kod. Försök igen." }); return;
    }
    for (const other of result.revoked) notifySessionRevoked(other.id);
    await logSecurityEvent({ req, action: "platform.mfa.verified", statusCode: 200,
      organizationId: result.user.organizationId, userId: result.user.id, userEmail: result.user.email });
    // Only expose the session bearer after the email challenge was verified.
    // Mobile clients need it for their existing authenticated API transport.
    res.json({ user: publicUser(result.user), token: getTokenFromRequest(req), session: sessionMeta(result.session) });
  } catch (err) { handleError(res, err); }
});

router.post("/auth/logout", async (req, res) => {
  try {
    const token = getTokenFromRequest(req);
    if (token) await revokeSession(token);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    await logSecurityEvent({
      req,
      action: "logout",
      statusCode: 200,
      organizationId: req.user?.organizationId ?? null,
      userId: req.user?.id ?? null,
      userEmail: req.user?.email ?? null,
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/auth/me", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: "Ingen aktiv session" });
      return;
    }
    const session = await validateAndTouchSession(token);
    if (!session) {
      if (await pendingPlatformSession(req)) {
        res.status(401).json({ error: "Slutför tvåstegsverifieringen", mfaRequired: true });
        return;
      }
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.status(401).json({ error: "Sessionen har gått ut" });
      return;
    }
    const [user] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId)))
      .limit(1);
    if (!user?.isActive) {
      res.status(401).json({ error: "Användaren finns inte" });
      return;
    }
    res.json({ user: { ...driverSessionUser(publicUser(user), session), ...(req.user?.workspace ? {
      organizationId: req.user.organizationId, role: req.user.role, driverProfileId: null,
      homeOrganizationId: req.user.homeOrganizationId, workspace: req.user.workspace,
    } : {}) }, session: sessionMeta(session) });
  } catch (err) {
    handleError(res, err);
  }
});

// Password recovery is kept in its own route module, while mounting it here
// ensures the existing auth route registration owns the complete auth surface.
router.use(recoveryRouter);
return router;
}

export { hashPassword };
export default createAuthRouter();
