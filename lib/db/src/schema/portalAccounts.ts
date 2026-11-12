import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { createInsertSchema } from "drizzle-zod";

// Separate principal: a customer account can never be a staff session.
export const portalAccountsTable = pgTable("portal_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  customerIds: uuid("customer_ids").array().notNull().default([]),
  stopIds: uuid("stop_ids").array().notNull().default([]),
  passwordHash: text("password_hash"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("portal_accounts_email_unique").on(t.email)]);
export const insertPortalAccountSchema = createInsertSchema(portalAccountsTable);
export type PortalAccount = typeof portalAccountsTable.$inferSelect;
