import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const routeTemplatesTable = pgTable("route_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  stopData: jsonb("stop_data").notNull().default([]),
  vehicleType: text("vehicle_type"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type RouteTemplate = typeof routeTemplatesTable.$inferSelect;
