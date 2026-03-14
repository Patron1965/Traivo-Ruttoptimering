import { pgTable, uuid, text, timestamp, real, integer, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { customersTable } from "./customers";

export const stopStatusEnum = pgEnum("stop_status", ["pending", "in_progress", "completed", "failed", "skipped"]);

export const stopsTable = pgTable("stops", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id),
  customerId: uuid("customer_id").references(() => customersTable.id),
  address: text("address").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  timeWindowStart: timestamp("time_window_start"),
  timeWindowEnd: timestamp("time_window_end"),
  serviceDurationMin: integer("service_duration_min").notNull().default(15),
  weightKg: real("weight_kg"),
  volumeM3: real("volume_m3"),
  status: stopStatusEnum("status").notNull().default("pending"),
  sequenceOrder: integer("sequence_order"),
  notes: text("notes"),
  trackingCode: text("tracking_code"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("stops_tracking_code_unique").on(table.trackingCode),
  index("stops_route_id_idx").on(table.routeId),
  index("stops_organization_id_idx").on(table.organizationId),
  index("stops_lat_lng_idx").on(table.latitude, table.longitude),
  index("stops_route_seq_idx").on(table.routeId, table.sequenceOrder),
]);

export const insertStopSchema = createInsertSchema(stopsTable).omit({ id: true, createdAt: true });
export type InsertStop = z.infer<typeof insertStopSchema>;
export type Stop = typeof stopsTable.$inferSelect;
