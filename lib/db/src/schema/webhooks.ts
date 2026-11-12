import { pgTable, uuid, text, timestamp, boolean, pgEnum, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const webhookEventEnum = pgEnum("webhook_event", [
  "route.created",
  "route.optimized",
  "route.started",
  "route.completed",
  "route.cancelled",
  "stop.completed",
  "stop.failed",
  "stop.skipped",
  "vehicle.position",
  "notification.sent",
]);

export const webhooksTable = pgTable("webhooks", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  url: text("url").notNull(),
  name: text("name").notNull(),
  secret: text("secret"),
  events: text("events").notNull().default("*"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("webhooks_org_id_idx").on(table.organizationId),
  index("webhooks_active_idx").on(table.active),
]);

export type Webhook = typeof webhooksTable.$inferSelect;
