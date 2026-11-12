import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { driversTable } from "./drivers";
import { usersTable } from "./users";

export const routeExecutionStatusEnum = pgEnum("route_execution_status", [
  "active",
  "ended",
]);

export type RouteExecutionSummary = {
  totalStops: number;
  completedStops: number;
  failedStops: number;
  skippedStops: number;
  pendingStops: number;
  durationMin: number;
  distanceKm: number | null;
};

/**
 * One authoritative execution lifecycle per route plan version.  The unique
 * route/version key is intentional: a stale mobile retry can only return the
 * already persisted lifecycle and can never create a second start/end pair.
 */
export const routeExecutionsTable = pgTable(
  "route_executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    routeId: uuid("route_id")
      .references(() => routesTable.id, { onDelete: "cascade" })
      .notNull(),
    driverId: uuid("driver_id")
      .references(() => driversTable.id)
      .notNull(),
    planVersion: integer("plan_version").notNull(),
    status: routeExecutionStatusEnum("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    startLatitude: doublePrecision("start_latitude"),
    startLongitude: doublePrecision("start_longitude"),
    endLatitude: doublePrecision("end_latitude"),
    endLongitude: doublePrecision("end_longitude"),
    startClientEventId: text("start_client_event_id").notNull(),
    endClientEventId: text("end_client_event_id"),
    startedByUserId: uuid("started_by_user_id")
      .references(() => usersTable.id)
      .notNull(),
    endedByUserId: uuid("ended_by_user_id").references(() => usersTable.id),
    summary: jsonb("summary").$type<RouteExecutionSummary>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("route_executions_org_route_plan_uidx").on(
      table.organizationId,
      table.routeId,
      table.planVersion,
    ),
    uniqueIndex("route_executions_org_route_start_event_uidx").on(
      table.organizationId,
      table.routeId,
      table.startClientEventId,
    ),
    uniqueIndex("route_executions_org_route_end_event_uidx").on(
      table.organizationId,
      table.routeId,
      table.endClientEventId,
    ),
    index("route_executions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("route_executions_driver_idx").on(table.driverId, table.startedAt),
  ],
);

export const insertRouteExecutionSchema = createInsertSchema(
  routeExecutionsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRouteExecution = z.infer<typeof insertRouteExecutionSchema>;
export type RouteExecution = typeof routeExecutionsTable.$inferSelect;