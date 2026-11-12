import { and, eq } from "drizzle-orm";
import { db, supportAccessTable, organizationsTable, usersTable } from "@workspace/db";
import { hashToken } from "./session";

// Separate credential namespace: a read-only support grant can NEVER become
// operational authority, even if its user-supplied reason contains this text.
export const workspaceHash = (token: string) => `workspace:${hashToken(token)}`;

export async function resolveWorkspace(token: string, sessionHash: string, actor: string) {
  const [row] = await db.select({
    grant: supportAccessTable, organization: organizationsTable,
    active: usersTable.isActive, platform: usersTable.isPlatformAdmin,
  }).from(supportAccessTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, supportAccessTable.target))
    .innerJoin(usersTable, eq(usersTable.id, supportAccessTable.actor))
    .where(and(eq(supportAccessTable.tokenHash, workspaceHash(token)),
      eq(supportAccessTable.session, sessionHash), eq(supportAccessTable.actor, actor)));
  if (!row || row.organization.archivedAt || !row.active || !row.platform || row.grant.expires.getTime() <= Date.now()) return null;
  return { organizationId: row.organization.id, organizationName: row.organization.name,
    expiresAt: row.grant.expires.toISOString() };
}