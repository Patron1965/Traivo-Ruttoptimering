import {
  pgTable,
  uuid,
  text,
  timestamp,
  real,
  integer,
  boolean,
  pgEnum,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { vehiclesTable } from "./vehicles";
import { driversTable } from "./drivers";

export const routeStatusEnum = pgEnum("route_status", [
  "draft",
  "optimized",
  "in_progress",
  "completed",
  "cancelled",
]);

export const routeHandoffStatusEnum = pgEnum("route_handoff_status", [
  "pending",
  "sent",
  "received",
  "opened",
  "accepted",
  "rejected",
]);
export type PlannerItineraryStop = {
  stopId: string;
  sequenceOrder: number;
  estimatedArrival: string;
  distanceFromPreviousKm: number;
  isChargingStop?: boolean;
  chargingStationName?: string;
};
export type GeographicOverlapExplanation = {
  /**
   * Confirmed only after all insertion positions failed in both directions.
   * Unknown and incomplete results deliberately carry no asserted cause.
   */
  status: "confirmed" | "unknown" | "incomplete";
  reasonCode?:
    | "TIME_WINDOW"
    | "CAPACITY"
    | "SKILL"
    | "WORKING_HOURS"
    | "EV_RANGE";
  message: string;
  analyzedPairCount: number;
  scope: {
    vehicleIds: string[];
    stopIds: string[];
  };
};
export type DepotSnapshot = {
  start: {
    address: string;
    latitude: number;
    longitude: number;
    verifiedAt: string;
    verification: unknown;
  };
  end: {
    address: string;
    latitude: number;
    longitude: number;
    verifiedAt: string;
    verification: unknown;
  };
};
export type RouteWorkdayEventType =
  | "depot_start"
  | "driving"
  | "travel_reserve"
  | "waiting"
  | "service"
  | "stop_reserve"
  | "break"
  | "charging"
  | "return"
  | "depot_end";
export type RouteWorkdayEvent = {
  type: RouteWorkdayEventType;
  startAt: string;
  endAt: string;
  durationMin: number;
  stopId?: string;
  distanceKm?: number;
  rawDurationMin?: number;
};
export type RouteWorkdaySummary = {
  shiftMin: number;
  nonReturnDrivingMin: number;
  serviceMin: number;
  waitingMin: number;
  breakMin: number;
  returnMin: number;
  travelReserveMin?: number;
  stopReserveMin?: number;
  totalMin: number;
  marginMin: number;
  overtimeMin: number;
  shiftEndAt: string;
  allowedOvertimeMin?: number;
  allowLateStopsMin?: number;
  warningCodes?: string[];
  lateStopIds?: string[];
};
export type ExecutionProjection = {
  selectionRevision?: string;
  activeStopId?: string | null;
  selectionChangedAt?: string | null;
  etaUnavailableReason?: string | null;
  generatedAt: string;
  deviationMin: number;
  expectedFinishAt: string | null;
  depotReturnAt: string | null;
  overtimeRisk: boolean;
  overtimeMin: number;
  remainingEtas: Array<{ stopId: string; eta: string }>;
};
export type RedistributionSuggestion = {
  status: "pending_approval" | "approved";
  warning: string;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
};
export type PlanningObjective =
  | "balanced"
  | "shortest"
  | "geographic"
  | "areas_worktime"
  | "minimize_vehicles";
export type OptimizationEvidenceSource =
  | "planningInputs"
  | "legacy"
  | "unknown";
export type OptimizationWeightsSnapshot = {
  objectivePriority?: "areas_worktime";
  workloadBalanceWeight?: number;
  distanceWeight: number;
  co2Weight: number;
  etaPrecisionWeight: number;
  driverHappinessWeight: number;
  geographicCohesionWeight: number;
};
/**
 * Immutable evidence of the objective and optimizer configuration that
 * produced a plan revision.  This lives in the existing planning summary
 * JSON so historical route rows remain readable without a schema migration.
 *
 * A null field is deliberate: legacy requests did not carry a named profile,
 * and old rows without this object must never be inferred retroactively.
 */
export type OptimizationEvidence = {
  source: OptimizationEvidenceSource;
  requestedObjective: PlanningObjective | null;
  effectiveObjective: PlanningObjective | null;
  requestedWeights: OptimizationWeightsSnapshot | null;
  effectiveWeights: OptimizationWeightsSnapshot | null;
  vehicleDistributionMode: "balance" | "minimize" | null;
  vehicleSelectionMode: "use_all_selected_pairs" | "minimize_vehicles" | null;
};
export type PlanningInputsSnapshot = {
  version: 1;
  objective: PlanningObjective;
  travelReservePercent: number;
  stopReserveMin: number;
  stopPriorities: Record<string, 0 | 1 | 2>;
  excludedPairValues: string[];
  depotOverride: null | {
    scope: "plan" | "pair";
    vehicleId?: string;
    verifiedDepotId: string;
  };
  vehicleSelectionMode: "use_all_selected_pairs" | "minimize_vehicles";
  maxDriverOvertimeMin?: number;
  allowLateStopsMin?: number;
};
export type PlanningSummary = {
  complete: boolean;
  objective: PlanningObjective;
  travelReservePercent: number;
  stopReserveMin: number;
  mandatoryUnplannedStopIds: string[];
  selectedPairValues: string[];
  usedPairValues: string[];
  unusedPairValues: Array<{ pairValue: string; reason: string }>;
  unplanned: Array<{ stopId: string; priority: 0 | 1 | 2; reason: string }>;
  /** Optional for compatibility with historical summaries written before evidence was persisted. */
  optimizationEvidence?: OptimizationEvidence | null;
};

export const routesTable = pgTable(
  "routes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    planId: uuid("plan_id").defaultRandom().notNull(),
    /**
     * Nullable association to the named planning draft that produced this
     * route.  A route without a draftId is a legacy route and intentionally
     * keeps the pre-draft dispatch contract.
     *
     * This is deliberately not a foreign key: draft rows can be retained or
     * removed independently of historical routes, while the association must
     * remain available for approval and audit checks.
     */
    draftId: uuid("draft_id"),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id)
      .notNull(),
    vehicleId: uuid("vehicle_id").references(() => vehiclesTable.id),
    name: text("name").notNull(),
    status: routeStatusEnum("status").notNull().default("draft"),
    manualReviewRequired: boolean("manual_review_required")
      .notNull()
      .default(false),
    manualReviewedAt: timestamp("manual_reviewed_at"),
    planRevision: integer("plan_revision").notNull().default(0),
    /**
     * Optional customer stop that must remain the first customer job on this
     * route while the plan is reoptimized. Charging itinerary entries may
     * still precede it for EV safety.
     */
    lockedFirstStopId: uuid("locked_first_stop_id"),
    optimizationFrozen: boolean("optimization_frozen").notNull().default(false),
    frozenDriverId: uuid("frozen_driver_id"),
    dispatchSnapshotVersion: integer("dispatch_snapshot_version"),
    handoffStatus: routeHandoffStatusEnum("handoff_status")
      .notNull()
      .default("pending"),
    handoffVersion: integer("handoff_version"),
    handoffDriverId: uuid("handoff_driver_id").references(
      () => driversTable.id,
    ),
    sentAt: timestamp("sent_at"),
    receivedAt: timestamp("received_at"),
    openedAt: timestamp("opened_at"),
    acceptedAt: timestamp("accepted_at"),
    rejectedAt: timestamp("rejected_at"),
    rejectionReason: text("rejection_reason"),
    date: timestamp("date").notNull(),
    totalDistanceKm: real("total_distance_km"),
    totalDurationMin: real("total_duration_min"),
    totalStops: integer("total_stops").notNull().default(0),
    co2EmissionsKg: real("co2_emissions_kg"),
    plannerItinerary:
      jsonb("planner_itinerary").$type<PlannerItineraryStop[]>(),
    geographicOverlapExplanation: jsonb(
      "geographic_overlap_explanation",
    ).$type<GeographicOverlapExplanation>(),
    depotSnapshot: jsonb("depot_snapshot").$type<DepotSnapshot>(),
    workdayTimeline: jsonb("workday_timeline").$type<RouteWorkdayEvent[]>(),
    workdaySummary: jsonb("workday_summary").$type<RouteWorkdaySummary>(),
    /**
     * Immutable-at-optimization material inputs for protected route approval.
     * A later resource edit must trigger reoptimization rather than being
     * silently blessed by taking a fresh snapshot at approval time.
     */
    optimizationResourceSnapshotHash: text(
      "optimization_resource_snapshot_hash",
    ),
    optimizationResourceSnapshot: jsonb("optimization_resource_snapshot").$type<
      Record<string, unknown>
    >(),
    /** Exact v1 planning inputs/material instructions that produced this route. */
    optimizationPlanningSnapshot: jsonb(
      "optimization_planning_snapshot",
    ).$type<PlanningInputsSnapshot>(),
    optimizationPlanningSnapshotHash: text(
      "optimization_planning_snapshot_hash",
    ),
    customerReference: text("customer_reference"),
    sharedInstructions: text("shared_instructions"),
    planningSummary: jsonb("planning_summary").$type<PlanningSummary>(),
    executionProjection: jsonb(
      "execution_projection",
    ).$type<ExecutionProjection>(),
    redistributionSuggestion: jsonb(
      "redistribution_suggestion",
    ).$type<RedistributionSuggestion>(),
    notifyApproaching: boolean("notify_approaching").notNull().default(true),
    notifyDelivered: boolean("notify_delivered").notNull().default(true),
    notifyFailed: boolean("notify_failed").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("routes_plan_id_idx").on(table.planId),
    index("routes_draft_id_idx").on(table.organizationId, table.draftId),
    index("routes_organization_id_idx").on(table.organizationId),
    index("routes_status_idx").on(table.status),
    index("routes_date_idx").on(table.date),
    index("routes_org_status_date_idx").on(
      table.organizationId,
      table.status,
      table.date,
    ),
  ],
);

export const insertRouteSchema = createInsertSchema(routesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertRoute = z.infer<typeof insertRouteSchema>;
export type Route = typeof routesTable.$inferSelect;
