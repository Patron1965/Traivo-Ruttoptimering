import { pgTable, uuid, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { vehiclesTable } from "./vehicles";
import { stopsTable } from "./stops";
import { routesTable } from "./routes";

export const geofenceEventTypeEnum = pgEnum("geofence_event_type", ["entered", "exited"]);

export const geofenceEventsTable = pgTable("geofence_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehiclesTable.id).notNull(),
  stopId: uuid("stop_id").references(() => stopsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id).notNull(),
  eventType: geofenceEventTypeEnum("event_type").notNull(),
  vehicleName: text("vehicle_name").notNull(),
  stopAddress: text("stop_address").notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("geofence_org_id_idx").on(table.organizationId),
  index("geofence_vehicle_id_idx").on(table.vehicleId),
  index("geofence_stop_id_idx").on(table.stopId),
  index("geofence_route_id_idx").on(table.routeId),
]);

export const insertGeofenceEventSchema = createInsertSchema(geofenceEventsTable).omit({ id: true, createdAt: true });
export type InsertGeofenceEvent = z.infer<typeof insertGeofenceEventSchema>;
export type GeofenceEvent = typeof geofenceEventsTable.$inferSelect;
