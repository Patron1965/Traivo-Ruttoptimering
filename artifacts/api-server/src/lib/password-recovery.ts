import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  db,
  passwordResetTokensTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import { hashToken, notifySessionRevoked } from "./session";
import { hashPassword } from "./password";
import { sendRecoveryEmail, isRecoveryEmailConfigured } from "../services/email";
import { getEnvConfig } from "./env-config";
import { hasAmbiguousLoginEmail } from "./login-email";

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export const PASSWORD_RESET_ACCEPTED_MESSAGE =
  "If an account exists for that email, a password reset link will be sent.";
export const PASSWORD_RESET_UNAVAILABLE_MESSAGE =
  "Password reset is temporarily unavailable. Please try again later.";
export const PASSWORD_RESET_INVALID_MESSAGE =
  "This password reset link is invalid or has expired.";
export const PASSWORD_RESET_COMPLETE_MESSAGE =
  "Your password has been reset. You can now sign in.";

/**
 * The origin is intentionally not derived from Host, X-Forwarded-Host, or any
 * other request header.  Deployments must configure a trusted web origin.
 */
export function isPasswordRecoveryConfigured(): boolean {
  return isRecoveryEmailConfigured() && Boolean(trustedRecoveryOrigin());
}

function trustedRecoveryOrigin(): string | undefined {
  // Development links must resolve against the development database, not the
  // published application that shares the configured production origin.
  // This value is supplied by the runtime, never by a request header.
  if (process.env.NODE_ENV === "development" && process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return getEnvConfig().AUTH_APP_ORIGIN;
}

function recoveryUrl(token: string): string {
  const origin = (trustedRecoveryOrigin() ?? "").replace(/\/+$/, "");
  return `${origin}/reset-password?token=${encodeURIComponent(token)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Creates a one-use reset credential and sends it through the bound SendGrid
 * connector. Callers must check global configuration before calling
 * this function so unknown addresses and configured addresses have identical
 * public behavior when delivery is unavailable.
 */
export async function issuePasswordReset(
  email: string,
  options?: { userId: string; waitForDelivery: true; invitation?: boolean },
): Promise<boolean> {
  email = normalizeRecoveryEmail(email);
  const candidates = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, isActive: usersTable.isActive })
    .from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${email}`)
    .limit(2);
  const user = candidates.length === 1 && candidates[0].isActive &&
    (!options || candidates[0].id === options.userId) ? candidates[0] : undefined;

  if (!user) {
    // Keep the unknown-address path bounded and asynchronous-looking without
    // ever sending a fabricated email. The public route returns the same
    // generic acceptance response for both paths.
    await new Promise((resolve) => setTimeout(resolve, 25));
    return false;
  }

  const token = randomBytes(32).toString("hex");
  const issued = await db.transaction(async (tx) => {
    const now = new Date();
    const [current] = await tx.select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, user.id), eq(usersTable.isActive, true), eq(usersTable.email, user.email)))
      .for("update");
    if (!current || await hasAmbiguousLoginEmail(tx, email)) return false;
    // Only the latest outstanding request remains usable.
    await tx.update(passwordResetTokensTable)
      .set({ usedAt: now })
      .where(and(
        eq(passwordResetTokensTable.userId, user.id),
        isNull(passwordResetTokensTable.usedAt),
      ));
    await tx.insert(passwordResetTokensTable).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    return true;
  });
  if (!issued) return false;

  const delivery = sendRecoveryEmail({
    to: user.email,
    toName: user.name,
    subject: options?.invitation ? "Välkommen till Traivo Route – aktivera ditt konto" : "Återställ ditt lösenord för Traivo Route",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;line-height:1.5">
        <h2>${options?.invitation ? "Aktivera ditt konto" : "Återställ ditt lösenord"}</h2>
        <p>${options?.invitation ? "Du har blivit inbjuden till Traivo Route." : "En återställning av ditt lösenord har begärts."}</p>
        <p><a href="${recoveryUrl(token)}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">Välj lösenord</a></p>
        <p>Länken gäller i 30 minuter och kan bara användas en gång. Om du inte väntade dig detta kan du ignorera meddelandet.</p>
      </div>
    `,
  });

  // Delivery runs as a bounded background operation. Unknown addresses take
  // the same minimum path below without sending a fabricated message, and
  // provider failures can never change the public response by account.
  if (options?.waitForDelivery) return await delivery;
  void delivery.then((delivered) => {
    if (!delivered) console.error("[AUTH] Password recovery delivery failed");
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  return true;
}

/**
 * Atomically claims a reset token, changes the password, and revokes all
 * existing sessions. The token claim and password write are in one
 * transaction, which prevents replay even when two requests race.
 */
export async function resetPassword(
  token: string,
  password: string,
): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const [candidate] = await tx
      .select({ userId: passwordResetTokensTable.userId })
      .from(passwordResetTokensTable)
      .where(and(
        eq(passwordResetTokensTable.tokenHash, hashToken(token)),
        isNull(passwordResetTokensTable.usedAt),
        gt(passwordResetTokensTable.expiresAt, now),
      ))
      .limit(1);
    if (!candidate) return null;

    // Serialize reset requests and new reset requests for this account. This
    // makes invalidating all previous credentials atomic even under a race.
    const [lockedUser] = await tx
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(and(eq(usersTable.id, candidate.userId), eq(usersTable.isActive, true)))
      .for("update");
    if (!lockedUser || await hasAmbiguousLoginEmail(tx, lockedUser.email)) return null;

    const [claimed] = await tx
      .update(passwordResetTokensTable)
      .set({ usedAt: now })
      .where(and(
        eq(passwordResetTokensTable.tokenHash, hashToken(token)),
        isNull(passwordResetTokensTable.usedAt),
        gt(passwordResetTokensTable.expiresAt, now),
      ))
      .returning({ userId: passwordResetTokensTable.userId });

    if (!claimed) return null;

    // A successful reset invalidates every other outstanding link too.
    await tx.update(passwordResetTokensTable)
      .set({ usedAt: now })
      .where(and(
        eq(passwordResetTokensTable.userId, claimed.userId),
        isNull(passwordResetTokensTable.usedAt),
      ));

    const passwordHash = await hashPassword(password);
    const [updatedUser] = await tx
      .update(usersTable)
      .set({
        passwordHash,
        failedLoginAttempts: 0,
        failedLoginWindowStartedAt: null,
        lockedUntil: null,
      })
      .where(eq(usersTable.id, claimed.userId))
      .returning({ id: usersTable.id });

    if (!updatedUser) return null;

    const revoked = await tx
      .update(sessionsTable)
      .set({ revokedAt: now })
      .where(and(eq(sessionsTable.userId, claimed.userId), isNull(sessionsTable.revokedAt)))
      .returning({ id: sessionsTable.id });

    return revoked.map((session) => session.id);
  });

  if (!result) return false;
  for (const sessionId of result) notifySessionRevoked(sessionId);
  return true;
}

export function normalizeRecoveryEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function recoveryHtmlPreviewIsSafe(name: string): string {
  // Kept exported for focused tests without exposing the actual token.
  return escapeHtml(name);
}