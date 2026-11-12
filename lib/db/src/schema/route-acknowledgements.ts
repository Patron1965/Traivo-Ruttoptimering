import {
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { driversTable } from "./drivers";

export const routeAcknowledgementStatusEnum = pgEnum(
  "route_acknowledgement_status",
  ["sent", "delivered_to_app", "opened", "accepted", "rejected"],
);

export const routeAcknowledgementsTable = pgTable(
  "route_acknowledgements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    routeId: uuid("route_id")
      .references(() => routesTable.id, { onDelete: "cascade" })
      .notNull(),
    driverId: uuid("driver_id")
      .references(() => driversTable.id, { onDelete: "cascade" })
      .notNull(),
    status: routeAcknowledgementStatusEnum("status").notNull().default("sent"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredToAppAt: timestamp("delivered_to_app_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("route_acknowledgements_route_driver_uidx").on(
      table.routeId,
      table.driverId,
    ),
    index("route_acknowledgements_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const insertRouteAcknowledgementSchema = createInsertSchema(
  routeAcknowledgementsTable,
).omit({ id: true, updatedAt: true });
export type InsertRouteAcknowledgement = z.infer<
  typeof insertRouteAcknowledgementSchema
>;
export type RouteAcknowledgement =
  typeof routeAcknowledgementsTable.$inferSelect;