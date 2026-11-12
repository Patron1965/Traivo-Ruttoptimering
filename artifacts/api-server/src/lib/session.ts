import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, organizationsTable, sessionsTable, usersTable, type Session } from "@workspace/db";
import { getEnvConfig } from "./env-config";
import { sessionAuthenticationAllowed } from "./platform-auth-policy";
import { validDriverDevice, DRIVER_DEVICE_DAYS } from "./driver-device-policy";

type SessionRevocationListener = (sessionId: string) => void;
const sessionRevocationListeners = new Set<SessionRevocationListener>();

export async function organizationAllowsAccess(organizationId: string): Promise<boolean> {
  const [org] = await db.select({ archivedAt: organizationsTable.archivedAt }).from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  return Boolean(org && !org.archivedAt);
}

/** Registers integrations which must stop work immediately after a session is revoked. */
export function onSessionRevoked(listener: SessionRevocationListener): () => void {
  sessionRevocationListeners.add(listener);
  return () => sessionRevocationListeners.delete(listener);
}

export function notifySessionRevoked(sessionId: string) {
  for (const listener of sessionRevocationListeners) listener(sessionId);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getSessionTimeouts() {
  const config = getEnvConfig();
  return {
    idleMs: config.SESSION_IDLE_TIMEOUT_MIN * 60_000,
    absoluteMs: config.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
    idleTimeoutMin: config.SESSION_IDLE_TIMEOUT_MIN,
    absoluteTimeoutHours: config.SESSION_ABSOLUTE_TIMEOUT_HOURS,
  };
}

export async function createSession(opts: {
  userId: string;
  organizationId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  verifiedCredentials?: { email: string; passwordHash: string | null };
}): Promise<{ token: string; session: Session }> {
  const { absoluteMs } = getSessionTimeouts();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + absoluteMs);
  const session = await db.transaction(async (tx) => {
    const [organization] = await tx.select({ archivedAt: organizationsTable.archivedAt }).from(organizationsTable)
      .where(eq(organizationsTable.id, opts.organizationId)).for("share");
    if (!organization || organization.archivedAt) {
      throw Object.assign(new Error("Kundföretaget är arkiverat. Kontakta administratören."), { statusCode: 403 });
    }
    const [user] = await tx.select().from(usersTable).where(and(
      eq(usersTable.id, opts.userId), eq(usersTable.organizationId, opts.organizationId),
    )).for("update");
    if (!user?.isActive || user.mfaRecoveryRequired || opts.verifiedCredentials &&
      (user.email !== opts.verifiedCredentials.email || user.passwordHash !== opts.verifiedCredentials.passwordHash)) {
      throw Object.assign(new Error("Kontot ändrades. Logga in igen."), { statusCode: 401 });
    }
    if (opts.verifiedCredentials) {
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now())
        throw Object.assign(new Error("Kontot är tillfälligt låst."), { statusCode: 423 });
      if (user.isPlatformAdmin && (user.mfaLockedUntil?.getTime() ?? 0) > Date.now())
        throw Object.assign(new Error("Kontot är tillfälligt låst."), { statusCode: 423 });
      const candidates = await tx.select({ id: usersTable.id }).from(usersTable)
        .where(sql`lower(trim(${usersTable.email})) = lower(trim(${user.email}))`).limit(2);
      if (candidates.length !== 1) {
        throw Object.assign(new Error("Kontot kan inte identifieras entydigt."), { statusCode: 401 });
      }
      await tx.update(usersTable).set({ failedLoginAttempts: 0, failedLoginWindowStartedAt: null,
        lockedUntil: null, lastLoginAt: new Date() }).where(eq(usersTable.id, user.id));
    }
    const [created] = await tx
    .insert(sessionsTable)
    .values({
      userId: opts.userId,
      organizationId: opts.organizationId,
      tokenHash: hashToken(token),
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent ?? null,
      expiresAt,
    })
    .returning();
    return created;
  });
  return { token, session };
}

/**
 * Validates a session token, enforcing absolute and idle timeouts.
 * On success, touches lastActivityAt and returns the session row.
 * On failure (missing/expired/idle/revoked), revokes the session and returns null.
 */
export async function validateAndTouchSession(token: string): Promise<Session | null> {
  const { idleMs } = getSessionTimeouts();
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.tokenHash, hashToken(token)), isNull(sessionsTable.revokedAt)))
    .limit(1);

  if (!session || !await organizationAllowsAccess(session.organizationId)) return null;
  const [user] = await db.select({ isActive: usersTable.isActive, isPlatformAdmin: usersTable.isPlatformAdmin, mfaRecoveryRequired: usersTable.mfaRecoveryRequired, mfaLockedUntil: usersTable.mfaLockedUntil, lockedUntil: usersTable.lockedUntil }).from(usersTable).where(and(
    eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId),
  ));
  if (session.driverAccess) {
    if (!user?.isActive || !await validDriverDevice(session)) return null;
  } else if (!sessionAuthenticationAllowed(user, session)) return null;

  const now = Date.now();
  const absoluteExpired = now > session.expiresAt.getTime();
  const idleExpired = now - session.lastActivityAt.getTime() > (session.driverAccess ? DRIVER_DEVICE_DAYS * 86400_000 : idleMs);

  if (absoluteExpired || idleExpired) {
    await db
      .update(sessionsTable)
      .set({ revokedAt: new Date() })
      .where(eq(sessionsTable.id, session.id));
    notifySessionRevoked(session.id);
    return null;
  }

  await db
    .update(sessionsTable)
    .set({ lastActivityAt: new Date() })
    .where(eq(sessionsTable.id, session.id));

  return session;
}

/**
 * Validates a session without updating lastActivityAt. Long-lived transports
 * must use this so outgoing traffic cannot keep a session alive.
 */
export async function validateSessionWithoutTouch(token: string): Promise<Session | null> {
  const { idleMs } = getSessionTimeouts();
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(and(eq(sessionsTable.tokenHash, hashToken(token)), isNull(sessionsTable.revokedAt)))
    .limit(1);

  if (!session || !await organizationAllowsAccess(session.organizationId)) return null;
  const [owner] = await db.select({ isActive: usersTable.isActive, isPlatformAdmin: usersTable.isPlatformAdmin, mfaRecoveryRequired: usersTable.mfaRecoveryRequired, mfaLockedUntil: usersTable.mfaLockedUntil, lockedUntil: usersTable.lockedUntil })
    .from(usersTable).where(and(eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId)));
  if (session.driverAccess) {
    if (!owner?.isActive || !await validDriverDevice(session)) return null;
  } else if (!sessionAuthenticationAllowed(owner, session)) return null;

  const now = Date.now();
  if (now > session.expiresAt.getTime() || now - session.lastActivityAt.getTime() > (session.driverAccess ? DRIVER_DEVICE_DAYS * 86400_000 : idleMs)) {
    await db
      .update(sessionsTable)
      .set({ revokedAt: new Date() })
      .where(eq(sessionsTable.id, session.id));
    notifySessionRevoked(session.id);
    return null;
  }

  return session;
}

export async function revokeSession(token: string): Promise<void> {
  const revoked = await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.tokenHash, hashToken(token)), isNull(sessionsTable.revokedAt)))
    .returning({ id: sessionsTable.id });
  for (const session of revoked) notifySessionRevoked(session.id);
}

/**
 * Revokes every active session for a user.  The websocket transport subscribes
 * to the revocation event, so this also closes live websocket connections
 * immediately instead of waiting for their next heartbeat.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  const revoked = await db
    .update(sessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.revokedAt)))
    .returning({ id: sessionsTable.id });
  for (const session of revoked) notifySessionRevoked(session.id);
}

export function sessionMeta(session: Session) {
  const { idleTimeoutMin, absoluteTimeoutHours } = getSessionTimeouts();
  return {
    idleTimeoutMin: session.driverAccess ? DRIVER_DEVICE_DAYS * 24 * 60 : idleTimeoutMin,
    absoluteTimeoutHours: session.driverAccess ? DRIVER_DEVICE_DAYS * 24 : absoluteTimeoutHours,
    absoluteExpiresAt: session.expiresAt.toISOString(),
  };
}
