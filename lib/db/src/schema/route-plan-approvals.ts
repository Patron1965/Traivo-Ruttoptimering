import {
  index,
  integer,
  pgTable,
  timestamp,
  text,
  uniqueIndex,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { driversTable } from "./drivers";
import { vehiclesTable } from "./vehicles";
import { usersTable } from "./users";

/**
 * An explicit planner approval for one executable route version and recipient.
 *
 * The route revision, driver, and vehicle are snapshots rather than inferred
 * values.  A later plan revision, resource change, or recipient change
 * therefore cannot reuse this row.  The unique key also makes concurrent
 * approval retries idempotent without allowing two actors to approve the same
 * route version under different resource snapshots.
 */
export const routePlanApprovalsTable = pgTable(
  "route_plan_approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    planId: uuid("plan_id").notNull(),
    routeId: uuid("route_id")
      .references(() => routesTable.id, { onDelete: "cascade" })
      .notNull(),
    planRevision: integer("plan_revision").notNull(),
    driverId: uuid("driver_id")
      .references(() => driversTable.id)
      .notNull(),
    vehicleId: uuid("vehicle_id")
      .references(() => vehiclesTable.id)
      .notNull(),
    approvedByUserId: uuid("approved_by_user_id")
      .references(() => usersTable.id)
      .notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Hash and audit payload of the material route/resource snapshot that was
     * approved.  Revisions alone do not change when a vehicle, driver,
     * certification, or stop requirement is edited, so dispatch compares this
     * snapshot again while holding the canonical planning locks.
     */
    snapshotHash: text("snapshot_hash"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("route_plan_approvals_route_revision_driver_uidx").on(
      table.routeId,
      table.planRevision,
      table.driverId,
    ),
    index("route_plan_approvals_org_plan_idx").on(
      table.organizationId,
      table.planId,
    ),
    index("route_plan_approvals_org_route_idx").on(
      table.organizationId,
      table.routeId,
    ),
  ],
);

export const insertRoutePlanApprovalSchema = createInsertSchema(
  routePlanApprovalsTable,
).omit({ id: true });
export type InsertRoutePlanApproval = z.infer<
  typeof insertRoutePlanApprovalSchema
>;
export type RoutePlanApproval = typeof routePlanApprovalsTable.$inferSelect;