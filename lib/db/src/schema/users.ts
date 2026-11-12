import { pgTable, uuid, text, timestamp, pgEnum, index, integer, uniqueIndex, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { sql } from "drizzle-orm";
import { userGroupsTable } from "./user-groups";

export const userRoleEnum = pgEnum("user_role", ["admin", "dispatcher", "driver", "viewer"]);

export const usersTable = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("dispatcher"),
  // Platform access is independent of the organization's admin role.
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  mfaSecret: text("mfa_secret"),
  mfaRecoveryRequired: boolean("mfa_recovery_required").notNull().default(false),
  mfaPendingSecret: text("mfa_pending_secret"),
  mfaPendingSessionId: uuid("mfa_pending_session_id"),
  mfaLastStep: integer("mfa_last_step"),
  mfaRecoveryHashes: jsonb("mfa_recovery_hashes").$type<string[]>(),
  mfaFailedAttempts: integer("mfa_failed_attempts").notNull().default(0),
  mfaFailureWindowStartedAt: timestamp("mfa_failure_window_started_at"),
  mfaLockedUntil: timestamp("mfa_locked_until"),
  driverProfileId: uuid("driver_profile_id"),
  groupId: uuid("group_id").references(() => userGroupsTable.id),
  passwordHash: text("password_hash"),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  failedLoginWindowStartedAt: timestamp("failed_login_window_started_at"),
  lockedUntil: timestamp("locked_until"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("users_org_id_idx").on(table.organizationId),
  index("users_email_idx").on(table.email),
  // Temporarily defer global uniqueness until existing production duplicates
  // are resolved. Application account writers serialize normalized email writes.
  index("users_role_idx").on(table.role),
  // A driver profile may be linked to at most one application account. NULL
  // values remain freely usable for unlinked users in PostgreSQL.
  uniqueIndex("users_driver_profile_id_unique").on(table.driverProfileId),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
