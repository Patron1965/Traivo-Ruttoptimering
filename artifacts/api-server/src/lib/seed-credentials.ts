import { eq, isNull } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hashPassword } from "./password";

const DEFAULT_PASSWORD = "Traivo2026!";

/**
 * Ensures every existing user has a password hash so the new email+password
 * login works for the pre-seeded accounts. Idempotent: only sets a password
 * where one is missing.
 *
 * DEV-ONLY: assigning a shared, known password to real accounts is a security
 * risk, so this is a no-op in production. Production environments must onboard
 * credentials through a real reset/invite flow, never a hardcoded default.
 */
export async function ensureSeedCredentials(): Promise<void> {
  if (process.env.NODE_ENV !== "development" || process.env.ALLOW_DEV_SEED !== "true") return;

  const usersWithoutPassword = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(isNull(usersTable.passwordHash));

  if (usersWithoutPassword.length === 0) return;

  const hash = await hashPassword(DEFAULT_PASSWORD);
  for (const user of usersWithoutPassword) {
    await db
      .update(usersTable)
      .set({ passwordHash: hash })
      .where(eq(usersTable.id, user.id));
  }

  console.log(
    `[auth] Set development seed credentials for ${usersWithoutPassword.length} user(s): ${usersWithoutPassword
      .map((u) => u.email)
      .join(", ")}`,
  );
}
