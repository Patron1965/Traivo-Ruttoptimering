import { pgTable, uuid, text, timestamp, real, integer, pgEnum, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { customersTable } from "./customers";
import { customerSitesTable } from "./customerSites";

export const stopStatusEnum = pgEnum("stop_status", ["pending", "in_progress", "completed", "failed", "skipped"]);
export const jobTypeEnum = pgEnum("job_type", ["delivery", "pickup_delivery", "field_service"]);

export type StopUnavailablePeriod = {
  start: string;
  end: string;
};

export const stopsTable = pgTable("stops", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  routeId: uuid("route_id").references(() => routesTable.id),
  customerId: uuid("customer_id").references(() => customersTable.id),
  customerSiteId: uuid("customer_site_id").references(() => customerSitesTable.id),
  /** Immutable customer name captured when this stop was created. */
  customerName: text("customer_name"),
  /** Immutable reusable-site name captured when this stop was created. */
  customerSiteName: text("customer_site_name"),
  address: text("address").notNull(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  timeWindowStart: timestamp("time_window_start"),
  timeWindowEnd: timestamp("time_window_end"),
  /** Immutable UTC intervals materialized from the customer's recurring constraints. */
  unavailablePeriods: jsonb("unavailable_periods")
    .$type<StopUnavailablePeriod[]>()
    .notNull()
    .default([]),
  serviceDurationMin: integer("service_duration_min").notNull().default(5),
  weightKg: real("weight_kg"),
  volumeM3: real("volume_m3"),
  status: stopStatusEnum("status").notNull().default("pending"),
  sequenceOrder: integer("sequence_order"),
  notes: text("notes"),
  trackingCode: text("tracking_code"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  externalRef: text("external_ref"),
  shopifyOrderId: text("shopify_order_id"),
  shopifyOrderName: text("shopify_order_name"),
  pickupAddress: text("pickup_address"),
  pickupLatitude: real("pickup_latitude"),
  pickupLongitude: real("pickup_longitude"),
  // Field service extensions (all nullable for backward compat)
  jobType: jobTypeEnum("job_type").notNull().default("delivery"),
  priority: integer("priority").default(0),
  slaDeadline: timestamp("sla_deadline"),
  serviceCategory: text("service_category"),
  serviceInstructions: text("service_instructions"),
  requiredSkills: text("required_skills").array(),
  requiredCertifications: text("required_certifications").array(),
  requiredEquipment: text("required_equipment").array(),
  customFields: jsonb("custom_fields").$type<Record<string, string>>(),
  /** Immutable identity of the source row used for reconciliation and exports. */
  sourceRowNumber: integer("source_row_number"),
  /** Last planning batch that considered this stop, including unassigned outcomes. */
  planningPlanId: uuid("planning_plan_id"),
  planningDate: timestamp("planning_date"),
  unplannedReason: text("unplanned_reason"),
  /** Explicit dispatcher override for soft route-planning conflicts. */
  assignmentOverrideAt: timestamp("assignment_override_at"),
  lockedVehicleId: uuid("locked_vehicle_id"),
  lockedDriverId: uuid("locked_driver_id"),
  lockedServiceStartAt: timestamp("locked_service_start_at", { withTimezone: true }),
  assignmentOverrideReasonCodes: text("assignment_override_reason_codes").array(),
  /** Set when the stop first transitions to a retention-eligible terminal state. */
  terminalAt: timestamp("terminal_at"),
  /**
   * A planning archive marker. Unlike retention deletion this deliberately
   * preserves the stop, its immutable route association, POD, and event log.
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  skipReason: text("skip_reason"),
  skipComment: text("skip_comment"),
  actualDurationMin: integer("actual_duration_min"),
  executionComment: text("execution_comment"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("stops_tracking_code_unique").on(table.trackingCode),
  index("stops_route_id_idx").on(table.routeId),
  index("stops_organization_id_idx").on(table.organizationId),
  index("stops_lat_lng_idx").on(table.latitude, table.longitude),
  index("stops_route_seq_idx").on(table.routeId, table.sequenceOrder),
  index("stops_status_idx").on(table.status),
  index("stops_planning_plan_id_idx").on(table.organizationId, table.planningPlanId),
  index("stops_terminal_retention_idx").on(table.organizationId, table.status, table.terminalAt),
  index("stops_organization_archived_idx").on(table.organizationId, table.archivedAt),
]);

export const insertStopSchema = createInsertSchema(stopsTable).omit({ id: true, createdAt: true });
export type InsertStop = z.infer<typeof insertStopSchema>;
export type Stop = typeof stopsTable.$inferSelect;
