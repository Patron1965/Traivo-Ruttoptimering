import {
  pgTable,
  uuid,
  text,
  timestamp,
  real,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const planningUsageEventsTable = pgTable("planning_usage_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  jobId: text("job_id"),
  category: text("category").notNull(),
  provider: text("provider").notNull(),
  operation: text("operation").notNull(),
  outcome: text("outcome").notNull(),
  units: real("units"),
  durationMs: integer("duration_ms"),
  cacheStatus: text("cache_status"),
  retry: boolean("retry").notNull().default(false),
  stopCount: integer("stop_count"),
  sizeClass: text("size_class"),
  engine: text("engine"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("planning_usage_events_org_event_key_uq").on(table.organizationId, table.eventKey),
  index("planning_usage_events_org_time_idx").on(table.organizationId, table.occurredAt),
  index("planning_usage_events_org_job_idx").on(table.organizationId, table.jobId),
  index("planning_usage_events_month_idx").on(table.occurredAt),
]);

export const planningUsagePoliciesTable = pgTable("planning_usage_policies", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  warnStops: integer("warn_stops"),
  blockStops: integer("block_stops"),
  warnMonthlyRuns: integer("warn_monthly_runs"),
  blockMonthlyRuns: integer("block_monthly_runs"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const planningUsageRevenueTable = pgTable("planning_usage_revenue", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  revenueOre: integer("revenue_ore"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("planning_usage_revenue_org_month_uq").on(table.organizationId, table.month),
]);

export const planningUsageRatesTable = pgTable("planning_usage_rates", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  operation: text("operation").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  unitCostOre: real("unit_cost_ore").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("planning_usage_rates_provider_operation_effective_uq")
    .on(table.provider, table.operation, table.effectiveFrom),
  index("planning_usage_rates_lookup_idx").on(table.provider, table.operation, table.effectiveFrom),
]);