import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db, portalAccountsTable as accounts, portalTokensTable as tokens, type PortalAccount } from "@workspace/db";
import { hashPassword, verifyPassword } from "../lib/password";
import { getEnvConfig } from "../lib/env-config";
import { sendRecoveryEmail, type EmailPayload } from "./resend-email";
import { organizationAllowsAccess } from "../lib/session";

export const portalTokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const portalEmail = (value: string) => value.trim().toLowerCase();
export const PORTAL_SESSION_MS = 8 * 60 * 60_000;
const dummyHash = `scrypt:00000000000000000000000000000000:${"00".repeat(64)}`;
export function portalOrigin() {
  // Trusted configuration only: never use Host or a forwarded request header.
  return process.env.NODE_ENV === "development" && process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}` : getEnvConfig().AUTH_APP_ORIGIN;
}
export async function portalSession(token: unknown): Promise<PortalAccount | null> {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [row] = await db.select({ account: accounts }).from(tokens).innerJoin(accounts, eq(accounts.id, tokens.accountId))
    .where(and(eq(tokens.hash, portalTokenHash(token)), eq(tokens.purpose, "session"),
      gt(tokens.expiresAt, new Date()), eq(accounts.enabled, true)));
  return row?.account && await organizationAllowsAccess(row.account.organizationId) ? row.account : null;
}
export async function loginPortal(email: string, password: string) {
  return db.transaction(async tx => {
    const [account] = await tx.select().from(accounts).where(eq(accounts.email, portalEmail(email))).for("update");
    const valid = await verifyPassword(password, account?.passwordHash ?? dummyHash);
    if (!account?.enabled || (account.lockedUntil && account.lockedUntil > new Date())) return null;
    if (!valid) {
      const attempts = (account.lockedUntil ? 0 : account.failedAttempts) + 1;
      await tx.update(accounts).set({ failedAttempts: attempts >= 8 ? 0 : attempts,
        lockedUntil: attempts >= 8 ? new Date(Date.now() + 15 * 60_000) : null }).where(eq(accounts.id, account.id));
      return null;
    }
    await tx.update(accounts).set({ failedAttempts: 0, lockedUntil: null }).where(eq(accounts.id, account.id));
    const token = randomBytes(32).toString("hex");
    await tx.insert(tokens).values({ hash: portalTokenHash(token), accountId: account.id,
      purpose: "session", expiresAt: new Date(Date.now() + PORTAL_SESSION_MS) });
    return { token, identity: { id: account.id, name: account.name } };
  });
}

export type PortalMail = (payload: EmailPayload) => Promise<boolean>;
export async function invitePortal(accountId: string, organizationId: string | null, mail: PortalMail = sendRecoveryEmail) {
  const origin = portalOrigin();
  if (!origin) return false;
  const issued = await db.transaction(async tx => {
    const [account] = await tx.select().from(accounts).where(and(eq(accounts.id, accountId),
      ...(organizationId ? [eq(accounts.organizationId, organizationId)] : []), eq(accounts.enabled, true))).for("update");
    if (!account) return null;
    await tx.delete(tokens).where(and(eq(tokens.accountId, account.id), eq(tokens.purpose, "login")));
    const token = randomBytes(32).toString("hex");
    await tx.insert(tokens).values({ hash: portalTokenHash(token), accountId: account.id,
      purpose: "login", expiresAt: new Date(Date.now() + 30 * 60_000) });
    return { account, token };
  });
  if (!issued) return false;
  // Fragment avoids access-log/referrer disclosure. UI consumes and removes it.
  const url = `${origin.replace(/\/+$/, "")}/portal/access#token=${issued.token}`;
  let accepted = false;
  try { accepted = await mail({ to: issued.account.email, subject: "Din åtkomst till Traivos kundportal",
    html: `<p>Öppna kundportalen direkt utan lösenord. Din personliga länk gäller i 30 minuter och kan användas en gång. Vidarebefordra inte länken.</p><p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Öppna kundportalen</a></p><p>Om du inte väntade dig detta mejl kan du ignorera det.</p>` }); }
  finally { if (!accepted) await db.delete(tokens).where(eq(tokens.hash, portalTokenHash(issued.token))); }
  return accepted;
}
export async function redeemPortalAccess(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  const hash = portalTokenHash(value);
  return db.transaction(async tx => {
    const [observed] = await tx.select().from(tokens).where(and(eq(tokens.hash, hash), eq(tokens.purpose, "login")));
    if (!observed) return null;
    // Same account-first locking order as invitations, revocation and password reset.
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, observed.accountId)).for("update");
    const [current] = await tx.select().from(tokens).where(and(eq(tokens.hash, hash),
      eq(tokens.purpose, "login"), gt(tokens.expiresAt, new Date()))).for("update");
    if (!account?.enabled || !current) return null;
    await tx.delete(tokens).where(eq(tokens.hash, hash));
    const token = randomBytes(32).toString("hex");
    await tx.insert(tokens).values({ hash: portalTokenHash(token), accountId: account.id,
      purpose: "session", expiresAt: new Date(Date.now() + PORTAL_SESSION_MS) });
    return { token, identity: { id: account.id, name: account.name } };
  });
}
export async function resetPortalPassword(token: string, password: string) {
  const hash = portalTokenHash(token);
  const passwordHash = await hashPassword(password);
  return db.transaction(async tx => {
    const [observed] = await tx.select().from(tokens).where(and(eq(tokens.hash, hash), eq(tokens.purpose, "reset")));
    if (!observed) return false;
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, observed.accountId)).for("update");
    const [current] = await tx.select().from(tokens).where(and(eq(tokens.hash, hash), eq(tokens.purpose, "reset"), gt(tokens.expiresAt, new Date()))).for("update");
    if (!account?.enabled || !current) return false;
    await tx.update(accounts).set({ passwordHash, failedAttempts: 0, lockedUntil: null }).where(eq(accounts.id, account.id));
    await tx.delete(tokens).where(eq(tokens.accountId, account.id));
    return true;
  });
}
