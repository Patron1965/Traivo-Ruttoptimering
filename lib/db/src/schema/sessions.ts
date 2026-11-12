import { pgTable, uuid, text, timestamp, index, integer, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { organizationsTable } from "./organizations";

export const sessionsTable = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => usersTable.id).notNull(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  tokenHash: text("token_hash").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  driverAccess: jsonb("driver_access").$type<{
    driverId: string; vehicleId: string; phoneHash: string; version: number;
  }>(),
  mfaVerifiedAt: timestamp("mfa_verified_at"),
  mfaRecoveryGrantId: uuid("mfa_recovery_grant_id"),
  mfaAttempts: integer("mfa_attempts").notNull().default(0),
  mfaEmailCodeHash: text("mfa_email_code_hash"),
  mfaEmailAddress: text("mfa_email_address"),
  mfaEmailSentAt: timestamp("mfa_email_sent_at"),
  mfaEmailExpiresAt: timestamp("mfa_email_expires_at"),
}, (table) => [
  index("sessions_token_hash_idx").on(table.tokenHash),
  index("sessions_user_id_idx").on(table.userId),
]);

export type Session = typeof sessionsTable.$inferSelect;
export type InsertSession = typeof sessionsTable.$inferInsert;
