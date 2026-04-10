import { pgTable, uuid, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const organizationsTable = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  autoBalance: boolean("auto_balance").default(false),
  snapToRoad: boolean("snap_to_road").default(false),
  defaultRouteType: text("default_route_type").default("delivery"),
  maxDriverOvertimeMin: integer("max_driver_overtime_min").default(0),
  allowLateStopsMin: integer("allow_late_stops_min").default(0),
  defaultServiceDurationMin: integer("default_service_duration_min").default(15),
  customerSupportType: text("customer_support_type").default("customer_service"),
  notifyOrderCreated: boolean("notify_order_created").default(false),
  notifyDriverEnRoute: boolean("notify_driver_en_route").default(true),
  notifyDelivered: boolean("notify_delivered").default(true),
  notifyFailed: boolean("notify_failed").default(true),
  notificationSenderType: text("notification_sender_type").default("customer_service"),
  notificationTemplate: text("notification_template"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({ id: true, createdAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
