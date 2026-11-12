import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const platformMfaRecoveryGrantsTable = pgTable("platform_mfa_recovery_grants", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  expectedEmail: text("expected_email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  operatorRef: text("operator_ref").notNull(),
  incidentRef: text("incident_ref").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => [index("platform_mfa_recovery_user_idx").on(table.userId)]);