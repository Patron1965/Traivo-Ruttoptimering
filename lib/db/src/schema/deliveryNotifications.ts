import { pgTable, uuid, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { stopsTable } from "./stops";
import { routesTable } from "./routes";

export const deliveryNotificationTypeEnum = pgEnum("delivery_notification_type", ["approaching", "delivered", "failed", "delayed"]);

export const deliveryNotificationsTable = pgTable("delivery_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  stopId: uuid("stop_id").references(() => stopsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id),
  type: deliveryNotificationTypeEnum("type").notNull(),
  channel: text("channel").notNull().default("system"),
  message: text("message"),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
}, (table) => [
  index("delivery_notifications_stop_id_idx").on(table.stopId),
  index("delivery_notifications_route_id_idx").on(table.routeId),
]);

export type DeliveryNotification = typeof deliveryNotificationsTable.$inferSelect;
