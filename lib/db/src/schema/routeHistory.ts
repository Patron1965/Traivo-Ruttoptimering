import { pgTable, uuid, text, timestamp, real, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";

export const routeHistoryTable = pgTable("route_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id).notNull(),
  vehicleName: text("vehicle_name").notNull(),
  driverName: text("driver_name"),
  date: timestamp("date").notNull(),
  totalDistanceKm: real("total_distance_km"),
  totalDurationMin: real("total_duration_min"),
  totalStops: integer("total_stops").notNull().default(0),
  co2EmissionsKg: real("co2_emissions_kg"),
  stopsSnapshot: jsonb("stops_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("route_history_org_id_idx").on(table.organizationId),
  index("route_history_route_id_idx").on(table.routeId),
]);

export const insertRouteHistorySchema = createInsertSchema(routeHistoryTable).omit({ id: true, createdAt: true });
export type InsertRouteHistory = z.infer<typeof insertRouteHistorySchema>;
export type RouteHistory = typeof routeHistoryTable.$inferSelect;
