import { pgTable, uuid, text, timestamp, boolean, pgEnum, index, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";
import { routesTable } from "./routes";

export const notificationTypeEnum = pgEnum("notification_type", [
  "route_started",
  "stop_completed",
  "stop_failed",
  "route_completed",
  "geofence_entry",
  "geofence_exit",
  "route_changed",
  "stop_message",
]);

export const notificationsTable = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  type: notificationTypeEnum("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  relatedEntityId: uuid("related_entity_id"),
  /** Null means a tenant-wide notification; otherwise only this user may read it. */
  recipientUserId: uuid("recipient_user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  routeId: uuid("route_id").references(() => routesTable.id, { onDelete: "cascade" }),
  planVersion: integer("plan_version"),
  eventKey: text("event_key"),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("notifications_org_id_idx").on(table.organizationId),
  index("notifications_is_read_idx").on(table.isRead),
  index("notifications_recipient_idx").on(table.organizationId, table.recipientUserId, table.createdAt),
  uniqueIndex("notifications_event_key_uidx").on(table.organizationId, table.eventKey),
]);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ id: true, createdAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
