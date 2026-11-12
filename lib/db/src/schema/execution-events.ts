import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { stopsTable } from "./stops";
import { usersTable } from "./users";

export const executionEventsTable = pgTable("execution_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id).notNull(),
  stopId: uuid("stop_id").references(() => stopsTable.id).notNull(),
  actorUserId: uuid("actor_user_id").references(() => usersTable.id).notNull(),
  clientEventId: text("client_event_id").notNull(),
  eventType: text("event_type").notNull(),
  planVersion: integer("plan_version").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("execution_events_tenant_client_event_unique")
    .on(table.organizationId, table.clientEventId),
  index("execution_events_route_order_idx")
    .on(table.organizationId, table.routeId, table.occurredAt, table.createdAt),
]);
