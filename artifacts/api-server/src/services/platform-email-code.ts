import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, sessionsTable, usersTable, type Session } from "@workspace/db";
import { platformMfaKey } from "../lib/platform-mfa";
import { assertRecoveryEnrollment } from "../lib/platform-mfa-recovery";
import { sendRecoveryEmailDetailed, type EmailPayload, type RecoveryEmailResult } from "./resend-email";
import { logPlatformEmailEvent } from "../lib/security-log";
import { randomUUID } from "node:crypto";

const error = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
export function emailCodeHash(sessionId: string, code: string) {
  return createHmac("sha256", platformMfaKey()).update(`email-mfa:${sessionId}:${code}`).digest("hex");
}

export function matchesEmailCode(session: Session, email: string, code: string): boolean {
  if (!/^\d{6}$/.test(code) || !session.mfaEmailCodeHash || session.mfaEmailAddress !== email ||
    !session.mfaEmailExpiresAt || session.mfaEmailExpiresAt.getTime() <= Date.now()) return false;
  const expected = Buffer.from(session.mfaEmailCodeHash, "hex");
  const supplied = Buffer.from(emailCodeHash(session.id, code), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

/** Reserve under the account lock; network I/O must never hold database locks. */
export async function sendPlatformEmailCode(
  sessionId: string,
  send: (payload: EmailPayload) => Promise<RecoveryEmailResult> = sendRecoveryEmailDetailed,
) {
  const [candidate] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!candidate) throw error("Logga in igen.", 401);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hash = emailCodeHash(sessionId, code);
  const reserved = await db.transaction(async tx => {
    const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, candidate.userId)).for("update");
    const [session] = await tx.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).for("update");
    const now = new Date();
    if (!user?.isActive || !user.isPlatformAdmin || !session || session.revokedAt ||
      session.mfaVerifiedAt || session.mfaAttempts >= 8 || session.expiresAt <= now ||
      session.createdAt.getTime() + 10 * 60_000 <= now.getTime() ||
      (user.mfaLockedUntil?.getTime() ?? 0) > now.getTime() ||
      (user.lockedUntil?.getTime() ?? 0) > now.getTime()) throw error("Logga in igen.", 401);
    await assertRecoveryEnrollment(tx, user, session);
    const recent = await tx.select({ id: sessionsTable.id }).from(sessionsTable).where(and(
      eq(sessionsTable.userId, user.id), gt(sessionsTable.mfaEmailSentAt, new Date(now.getTime() - 60_000)),
    )).limit(1);
    if (recent.length) throw error("Vänta en minut innan du begär en ny kod.", 429);
    // Expiry stays null until the provider accepts the message. Older codes stop working immediately.
    await tx.update(sessionsTable).set({
      mfaEmailCodeHash: hash, mfaEmailAddress: user.email, mfaEmailSentAt: now, mfaEmailExpiresAt: null,
    }).where(eq(sessionsTable.id, sessionId));
    return { email: user.email, expiresAt: new Date(Math.min(now.getTime() + 5 * 60_000, session.createdAt.getTime() + 10 * 60_000)) };
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: RecoveryEmailResult = { outcome: "unknown" };
  const attemptId = randomUUID();
  try {
    result = await Promise.race([
      send({ to: reserved.email, subject: "Din inloggningskod till Traivo",
        html: `<p>Din inloggningskod till Traivo är:</p><p style="font-size:28px;font-weight:bold;letter-spacing:5px">${code}</p><p>Koden gäller i högst fem minuter och kan bara användas en gång. Dela inte koden med någon.</p><p>Om du inte försökte logga in, kontakta din administratör.</p>` }),
      new Promise<RecoveryEmailResult>(resolve => { timeout = setTimeout(() => resolve({ outcome: "timeout" }), 15_000); }),
    ]);
  } catch { result = { outcome: "unknown" }; }
  finally { clearTimeout(timeout); }
  await logPlatformEmailEvent(candidate.userId, attemptId, result);
  const sent = result.outcome === "accepted";
  await db.update(sessionsTable).set(sent
    ? { mfaEmailExpiresAt: reserved.expiresAt }
    : { mfaEmailCodeHash: null, mfaEmailExpiresAt: null }).where(and(
      eq(sessionsTable.id, sessionId), eq(sessionsTable.mfaEmailCodeHash, hash), isNull(sessionsTable.revokedAt),
    ));
  if (!sent) throw error("Inloggningskoden kunde inte skickas. Vänta en minut och försök igen.", 503);
}
