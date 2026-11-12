import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable, sessionsTable, passwordResetTokensTable, supportAccessTable, platformMfaRecoveryGrantsTable as grants, auditLogTable } from "@workspace/db";
import { hashToken } from "./session";
import { platformMfaKey } from "./platform-mfa";
import { verifyPassword } from "./password";
import { getEnvConfig } from "./env-config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export function requireOperatorRecoveryPolicy() {
  if (process.env.PLATFORM_MFA_RECOVERY_POLICY !== "operator")
    throw Object.assign(new Error("Operatoråterställning är inte tillgänglig."), { statusCode: 503 });
  platformMfaKey();
}
export const issueRecoverySchema = z.object({
  userId: z.guid(),
  expectedEmail: z.string().trim().toLowerCase().email().max(254),
  operatorRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,79}$/),
  incidentRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,79}$/),
  confirmation: z.literal("REVOKE-AND-REQUIRE-MFA"),
  productionConfirmation: z.string().optional(),
}).strict();

export async function recoveryAudit(tx: Tx, user: typeof usersTable.$inferSelect | undefined, action: string, grantId?: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditLogTable).values({
    userId: user?.id, organizationId: user?.organizationId,
    action: `platform.mfa.operator_recovery.${action}`, resourceType: "platform_mfa_recovery",
    resourceId: grantId, method: action === "approved" || action === "replaced" ? "CLI" : "POST",
    path: "operator-recovery", statusCode: action === "failed" ? "401" : "200", metadata,
  });
}

/** Trust root: offline runtime/database access, NOT the self-declared operator reference. */
export async function issueOperatorRecovery(input: z.input<typeof issueRecoverySchema>, deliver: (token: string) => Promise<void>) {
  const args = issueRecoverySchema.parse(input);
  requireOperatorRecoveryPolicy();
  if (process.env.NODE_ENV === "production" && args.productionConfirmation !== `PRODUCTION:${args.userId}`)
    throw new Error("Explicit production confirmation required");
  const token = randomBytes(32).toString("hex");
  return db.transaction(async tx => {
    const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, args.userId)).for("update");
    if (!user?.isActive || !user.isPlatformAdmin || user.email.trim().toLowerCase() !== args.expectedEmail)
      throw new Error("Active platform account and expected email must match");
    const candidates = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(sql`lower(trim(${usersTable.email})) = ${args.expectedEmail}`).limit(2);
    if (candidates.length !== 1) throw new Error("Ambiguous email");
    const now = new Date();
    await tx.update(sessionsTable).set({ revokedAt: now }).where(eq(sessionsTable.userId, user.id));
    await tx.update(passwordResetTokensTable).set({ usedAt: now }).where(eq(passwordResetTokensTable.userId, user.id));
    await tx.delete(supportAccessTable).where(eq(supportAccessTable.actor, user.id));
    await tx.update(grants).set({ revokedAt: now }).where(and(eq(grants.userId, user.id), sql`${grants.revokedAt} IS NULL`));
    await tx.update(usersTable).set({
      mfaRecoveryRequired: true, mfaSecret: null, mfaPendingSecret: null, mfaPendingSessionId: null,
      mfaRecoveryHashes: null, mfaLastStep: null,
    }).where(eq(usersTable.id, user.id));
    const [grant] = await tx.insert(grants).values({
      userId: user.id, expectedEmail: args.expectedEmail, tokenHash: hashToken(token),
      operatorRef: args.operatorRef, incidentRef: args.incidentRef, expiresAt: new Date(Date.now() + 15 * 60_000),
    }).returning();
    await recoveryAudit(tx, user, user.mfaRecoveryRequired ? "replaced" : "approved", grant.id,
      { operatorRef: args.operatorRef, incidentRef: args.incidentRef, authority: "offline_runtime_access" });
    // A failed delivery rolls back revocation. A failed commit leaves an unusable token.
    await deliver(token);
    return { grantId: grant.id, expiresAt: grant.expiresAt };
  });
}

export async function assertRecoveryEnrollment(tx: Tx, user: typeof usersTable.$inferSelect, session: typeof sessionsTable.$inferSelect) {
  if (!user.mfaRecoveryRequired && !session.mfaRecoveryGrantId) return;
  requireOperatorRecoveryPolicy();
  const [grant] = session.mfaRecoveryGrantId ? await tx.select().from(grants)
    .where(eq(grants.id, session.mfaRecoveryGrantId)).for("update") : [];
  if (!user.mfaRecoveryRequired || !grant || grant.userId !== user.id || !grant.consumedAt ||
    grant.revokedAt || grant.completedAt || grant.expiresAt.getTime() <= Date.now() ||
    grant.expectedEmail !== user.email.trim().toLowerCase())
    throw Object.assign(new Error("En ny operatoråterställning krävs."), { statusCode: 401 });
}

export async function redeemOperatorRecovery(email: string, password: string, token: string) {
  requireOperatorRecoveryPolicy();
  return db.transaction(async tx => {
    const candidates = await tx.select().from(usersTable)
      .where(sql`lower(trim(${usersTable.email})) = ${email}`).limit(2).for("update");
    const user = candidates.length === 1 ? candidates[0] : undefined;
    const fail = async () => { await recoveryAudit(tx, user, "failed"); return null; };
    if (!user?.isActive || !user.isPlatformAdmin || !user.mfaRecoveryRequired) return fail();
    const now = Date.now();
    if ((user.lockedUntil?.getTime() ?? 0) > now || (user.mfaLockedUntil?.getTime() ?? 0) > now) return fail();
    const [grant] = await tx.select().from(grants).where(and(eq(grants.userId, user.id), eq(grants.tokenHash, hashToken(token)))).for("update");
    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk || !grant || grant.consumedAt || grant.revokedAt || grant.completedAt ||
      grant.expiresAt.getTime() <= now || grant.expectedEmail !== email) {
      const config = getEnvConfig();
      const within = user.failedLoginWindowStartedAt && now - user.failedLoginWindowStartedAt.getTime() < config.ACCOUNT_LOCKOUT_WINDOW_MIN * 60_000;
      const attempts = (within ? user.failedLoginAttempts : 0) + 1;
      await tx.update(usersTable).set({ failedLoginAttempts: attempts,
        failedLoginWindowStartedAt: within ? user.failedLoginWindowStartedAt : new Date(now),
        lockedUntil: attempts >= config.ACCOUNT_LOCKOUT_THRESHOLD ? new Date(now + config.ACCOUNT_LOCKOUT_DURATION_MIN * 60_000) : user.lockedUntil,
      }).where(eq(usersTable.id, user.id));
      return fail();
    }
    await tx.update(grants).set({ consumedAt: new Date(now) }).where(eq(grants.id, grant.id));
    const sessionToken = randomBytes(32).toString("hex");
    await tx.insert(sessionsTable).values({ userId: user.id, organizationId: user.organizationId,
      tokenHash: hashToken(sessionToken), mfaRecoveryGrantId: grant.id,
      expiresAt: new Date(Math.min(grant.expiresAt.getTime(), now + 10 * 60_000)) });
    await recoveryAudit(tx, user, "redeemed", grant.id);
    return sessionToken;
  });
}