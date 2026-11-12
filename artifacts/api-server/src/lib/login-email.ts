import { sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** All account writers must reserve the normalized identifier before reading or writing users. */
export async function reserveLoginEmail(tx: Transaction, email: string, exceptUserId?: string): Promise<boolean> {
  const normalized = normalizeLoginEmail(email);
  // Separate namespace from other advisory locks; transaction lock covers the
  // conflict check AND write, including across API instances and tenants.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('users-login-email'), hashtext(${normalized}))`);
  const [existing] = await tx.select({ id: usersTable.id }).from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${normalized} ${exceptUserId ? sql`AND ${usersTable.id} <> ${exceptUserId}` : sql``}`)
    .limit(1);
  return !existing;
}

export async function hasAmbiguousLoginEmail(tx: Transaction, email: string): Promise<boolean> {
  const rows = await tx.select({ id: usersTable.id }).from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${normalizeLoginEmail(email)}`).limit(2);
  return rows.length > 1;
}

export function duplicateLoginEmailError(): Error & { statusCode: number } {
  return Object.assign(new Error("E-postadressen används redan av ett konto"), { statusCode: 409 });
}