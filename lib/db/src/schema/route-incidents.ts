import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { driversTable } from "./drivers";

export const routeIncidentCategoryEnum = pgEnum("route_incident_category", [
  "traffic",
  "vehicle_issue",
  "accident",
  "customer_unavailable",
  "access_problem",
  "weather",
  "safety",
  "other",
]);

export const routeIncidentsTable = pgTable("route_incidents", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id, { onDelete: "cascade" }).notNull(),
  driverId: uuid("driver_id").references(() => driversTable.id).notNull(),
  category: routeIncidentCategoryEnum("category").notNull(),
  comment: text("comment").notNull(),
  attachmentUrl: text("attachment_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("route_incidents_org_route_idx").on(table.organizationId, table.routeId),
  index("route_incidents_driver_idx").on(table.driverId),
]);

export type RouteIncident = typeof routeIncidentsTable.$inferSelect;