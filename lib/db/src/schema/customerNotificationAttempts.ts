import { pgTable, uuid, text, timestamp, uniqueIndex, integer, jsonb } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const customerNotificationAttemptsTable = pgTable("customer_notification_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  stopId: uuid("stop_id").notNull(),
  event: text("event").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  routeId: uuid("route_id"),
  revision: integer("revision").notNull().default(0),
  history: jsonb("history").$type<Array<{ status: string; at: string; actorId?: string }>>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex("customer_notification_once").on(t.organizationId, t.stopId, t.event, t.channel)]);
