import { pgTable, uuid, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const userRoleEnum = pgEnum("user_role", ["admin", "dispatcher", "driver"]);

export const usersTable = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("dispatcher"),
  driverProfileId: uuid("driver_profile_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("users_org_id_idx").on(table.organizationId),
  index("users_email_idx").on(table.email),
  index("users_role_idx").on(table.role),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
