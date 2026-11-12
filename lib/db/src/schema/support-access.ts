import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { usersTable } from "./users";
import { organizationsTable } from "./organizations";

// Shared across autoscale instances. Bearer credentials are never stored.
export const supportAccessTable = pgTable("support_access", {
  tokenHash: text("token_hash").primaryKey(),
  actor: uuid("actor").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  session: text("session_hash").notNull(),
  target: uuid("target").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  expires: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [index("support_access_actor_idx").on(table.actor)]);
export const insertSupportAccessSchema = createInsertSchema(supportAccessTable);
export type SupportAccess = typeof supportAccessTable.$inferSelect;
export type InsertSupportAccess = typeof supportAccessTable.$inferInsert;