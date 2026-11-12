import { pgTable, uuid, text, timestamp, doublePrecision, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const vehiclePositionsTable = pgTable(
  "vehicle_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    vehicleId: uuid("vehicle_id").notNull(),
    routeId: uuid("route_id"),
    executionId: uuid("execution_id"),
    startClientEventId: text("start_client_event_id"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    heading: doublePrecision("heading").default(0),
    speedKmh: doublePrecision("speed_kmh").default(0),
    accuracy: doublePrecision("accuracy"),
    source: text("source").default("driver_app"),
    recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  },
  (table) => ({
    vehicleTimeIdx: index("vehicle_positions_vehicle_time_idx").on(
      table.vehicleId,
      table.recordedAt,
    ),
    routeTimeIdx: index("vehicle_positions_route_time_idx").on(
      table.routeId,
      table.recordedAt,
    ),
    orgTimeIdx: index("vehicle_positions_org_time_idx").on(
      table.organizationId,
      table.recordedAt,
    ),
  }),
);

export type VehiclePosition = typeof vehiclePositionsTable.$inferSelect;
export type InsertVehiclePosition = typeof vehiclePositionsTable.$inferInsert;
