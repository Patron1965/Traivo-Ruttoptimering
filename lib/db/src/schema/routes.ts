import { pgTable, uuid, text, timestamp, real, integer, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { vehiclesTable } from "./vehicles";

export const routeStatusEnum = pgEnum("route_status", ["draft", "optimized", "in_progress", "completed", "cancelled"]);

export const routesTable = pgTable("routes", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  vehicleId: uuid("vehicle_id").references(() => vehiclesTable.id),
  name: text("name").notNull(),
  status: routeStatusEnum("status").notNull().default("draft"),
  date: timestamp("date").notNull(),
  totalDistanceKm: real("total_distance_km"),
  totalDurationMin: real("total_duration_min"),
  totalStops: integer("total_stops").notNull().default(0),
  co2EmissionsKg: real("co2_emissions_kg"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("routes_organization_id_idx").on(table.organizationId),
  index("routes_status_idx").on(table.status),
  index("routes_date_idx").on(table.date),
  index("routes_org_status_date_idx").on(table.organizationId, table.status, table.date),
]);

export const insertRouteSchema = createInsertSchema(routesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRoute = z.infer<typeof insertRouteSchema>;
export type Route = typeof routesTable.$inferSelect;
