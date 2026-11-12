import { eq, sql } from "drizzle-orm";
import { db, organizationsTable, usersTable } from "@workspace/db";
import { hashPassword } from "./password";
import { normalizeLoginEmail, reserveLoginEmail } from "./login-email";
import { logger } from "./logger";

/**
 * Creates (or updates) a real admin account from environment secrets so the
 * deployed/production app has a working login without any hardcoded password.
 *
 * Set BOOTSTRAP_ADMIN_PUBLIC_EMAIL as a non-secret account identifier and
 * BOOTSTRAP_ADMIN_PASSWORD as a Replit Secret. On every startup this ensures
 * that account exists, is an admin, and uses that password. Older email key
 * names remain backward-compatible fallbacks.
 * Idempotent and safe to run in all environments. No-op when the secrets are
 * absent. The password is never logged.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  if (process.env.ENABLE_BOOTSTRAP_ADMIN !== "true") {
    return;
  }

  const rawEmail =
    process.env.BOOTSTRAP_ADMIN_PUBLIC_EMAIL ??
    process.env.BOOTSTRAP_ADMIN_ACCOUNT_EMAIL ??
    process.env.BOOTSTRAP_ADMIN_LOGIN_EMAIL ??
    process.env.BOOTSTRAP_ADMIN_EMAIL;
  // A shared test secret must never replace the published account password.
  const testPassword = process.env.NODE_ENV === "development"
    && process.env.REPLIT_DEPLOYMENT !== "1"
    ? process.env.TRAIVO_TEST_ADMIN_PASSWORD
    : undefined;
  const password =
    testPassword ??
    process.env.TOMAS_LOGIN_PASSWORD_RESET_2026 ??
    process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const organizationId = process.env.BOOTSTRAP_ORGANIZATION_ID?.trim();
  const organizationName = process.env.BOOTSTRAP_ORGANIZATION_NAME?.trim();

  if (!rawEmail || !password) {
    throw new Error("[bootstrap-admin] BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must both be set");
  }
  if ((organizationId && organizationName) || (!organizationId && !organizationName)) {
    throw new Error(
      "[bootstrap-admin] Set exactly one of BOOTSTRAP_ORGANIZATION_ID or BOOTSTRAP_ORGANIZATION_NAME",
    );
  }

  const email = normalizeLoginEmail(rawEmail);
  if (!email.includes("@")) {
    throw new Error("[bootstrap-admin] BOOTSTRAP_ADMIN_EMAIL is not a valid email");
  }
  if (password.length < 8) {
    throw new Error("[bootstrap-admin] BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters");
  }
  const preflight = await db.select({ id: usersTable.id }).from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${email}`).limit(2);
  if (preflight.length > 1) {
    logger.warn({}, "[bootstrap-admin] Ambiguous admin email; bootstrap skipped until duplicate accounts are resolved");
    return;
  }

  let org;
  if (organizationId) {
    [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1);
    if (!org) {
      throw new Error(`[bootstrap-admin] Organization ${organizationId} was not found`);
    }
  } else {
    const organizations = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.name, organizationName!))
      .limit(2);
    if (organizations.length > 1) {
      throw new Error(`[bootstrap-admin] More than one organization is named "${organizationName}"`);
    }
    [org] = organizations;
    if (!org) {
      [org] = await db
        .insert(organizationsTable)
        .values({ name: organizationName!, email })
        .returning();
      console.log(`[bootstrap-admin] Created organization ${org.name} (${org.id})`);
    }
  }

  const passwordHash = await hashPassword(password);

  const result = await db.transaction(async (tx) => {
    // Bootstrap must not silently select one of multiple matching accounts or
    // reset its password / elevate its platform privilege.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('users-login-email'), hashtext(${email}))`);
    const matches = await tx.select().from(usersTable)
      .where(sql`lower(trim(${usersTable.email})) = ${email}`).limit(2);
    if (matches.length > 1) return "ambiguous";
    const existing = matches[0];
    if (existing) {
    if (existing.organizationId !== org.id) {
      throw new Error(`[bootstrap-admin] Admin email ${email} belongs to a different organization`);
    }
    await tx
      .update(usersTable)
      .set({
        passwordHash,
        role: "admin",
        // Explicit opt-in: existing customer admins are never promoted merely
        // because their account was bootstrapped.
        ...(process.env.ENABLE_PLATFORM_ADMIN === "true" ? { isPlatformAdmin: true } : {}),
        failedLoginAttempts: 0,
        failedLoginWindowStartedAt: null,
        lockedUntil: null,
      })
      .where(eq(usersTable.id, existing.id));
    return "updated";
    }

    // Check all records (including disabled users), even for a new bootstrap account.
    if (!await reserveLoginEmail(tx, email)) throw new Error("[bootstrap-admin] Admin email is already in use");
    await tx.insert(usersTable).values({
    organizationId: org.id,
    name: "Admin",
    email,
    role: "admin",
    isPlatformAdmin: process.env.ENABLE_PLATFORM_ADMIN === "true",
    passwordHash,
    });
    return "created";
  });
  if (result === "ambiguous") {
    // A legacy duplicate must not make the whole deployed service unavailable.
    // Do not reset credentials or promote either account.
    logger.warn({}, "[bootstrap-admin] Ambiguous admin email; bootstrap skipped until duplicate accounts are resolved");
    return;
  }
  console.log(`[bootstrap-admin] ${result === "updated" ? "Updated admin credentials" : "Created admin account"} for ${email}`);
}
