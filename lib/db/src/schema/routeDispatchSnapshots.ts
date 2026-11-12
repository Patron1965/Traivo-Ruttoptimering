import { pgTable, uuid, integer, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { routesTable } from "./routes";
import { organizationsTable } from "./organizations";

/** Captured only inside the canonical approved dispatch transaction. */
export const routeDispatchSnapshotsTable = pgTable("route_dispatch_snapshots", {
  routeId: uuid("route_id").notNull().references(() => routesTable.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  planRevision: integer("plan_revision").notNull(),
  driverId: uuid("driver_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  route: jsonb("route").$type<Record<string, unknown>>().notNull(),
  stops: jsonb("stops").$type<Record<string, unknown>[]>().notNull(),
}, (table) => [primaryKey({ columns: [table.routeId, table.planRevision] })]);

export const insertRouteDispatchSnapshotSchema = createInsertSchema(routeDispatchSnapshotsTable);
export type RouteDispatchSnapshot = typeof routeDispatchSnapshotsTable.$inferSelect;
