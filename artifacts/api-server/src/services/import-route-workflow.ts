import crypto from "crypto";
import { getTableColumns } from "drizzle-orm";
import { ImportStopsBody } from "@workspace/api-zod";
import { geocodeAddress } from "./geocoding";
import { applyVerifiedNavigationDestination, importStopValues, materializeImportedCustomerUnavailablePeriods, validateImportStopCoordinates } from "./stop-service";
import { logger } from "../lib/logger";
import { loadRuntimeState, saveRuntimeState, deleteRuntimeState } from "./planning-runtime-store";
import { recoverPlanningCoverage } from "./planning-coverage-recovery";
import { stockholmPlanningDayBounds } from "./planning-day";
import { withRequiredRoadData, RoadDataUnavailableError, assertOperationalRoadProvider } from "./road-data-policy";
import { preparePersistedRouteRoadData } from "./operational-road-preparation";
import { resolveReoptimizationDepot } from "./route-reoptimization-depot";
import { plannerFactsDigest } from "./planner-stop-facts";
import type { DispatchConsequences, DispatchRouteMetrics } from "./dispatch-preview-contract";
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  db,
  driverCertificationsTable,
  driversTable,
  routesTable,
  stopsTable,
  vehiclesTable,
  organizationsTable,
  planningDraftsTable,
  customersTable,
  driverPreferencesTable,
  importPlanProgressTable,
  type OptimizationEvidence,
  type OptimizationEvidenceSource,
} from "@workspace/db";
import { CHARGING_STATIONS, DEFAULT_WEIGHTS } from "./alns/types";
import {
  cachedDistance,
  computeSolutionCost,
  estimateCo2,
  evaluateRoute,
  explainGeographicRouteOverlapAsync,
  policyToALNSConfig,
  resolveOptimizationPolicy,
  type ALNSNode,
  type ALNSDriverConstraints,
  type ALNSRoute,
  type ALNSResult,
  type ALNSVehicle,
  type OptimizationWeights,
} from "./alns";
import { optimizeWithCanonicalPlanningLocks as optimizeWithALNS, optimizeWithCanonicalAppendPlanningLocks, canonicalFrozenItinerary, loadCanonicalLockInputs } from "./planner-lock-canonical-optimizer";
import { assertPlanningLockOrder, assertPlanningLockTimes } from "./planning-lock-invariants";
import { hasPlanningLock, assertPlanningLockResult, assertFrozenRouteFeasible } from "./alns/planning-locks";
import { chargingStationInsertion } from "./alns/operators/repair";
import { repairFleetCoverage } from "./alns/fleet-coverage";
import { applyDriverRoutingProfile as baseDriverRoutingProfile } from "./driver-routing-profile";
import {
  assertDriverEligibleForFieldService,
  fieldServiceRequirementsFromStop,
} from "./field-service";
import { invalidatedRouteHandoff, workingRouteHandoff } from "./route-acknowledgement-service";
import {
  evaluateRouteWorkday,
  workdayInfeasibilityMessage,
} from "./route-workday";
import {
  payloadIdentityHash,
  PlanningDraftError,
} from "./planning-draft-service";
import {
  materialResourceSnapshot,
  materialResourceSnapshotHash,
  isProtectedImportRoute,
  optimizationDriverIdForRoute,
  resolveDriverForRoute,
} from "./route-plan-approval-service";
import {
  normalizePlanningAllowance,
  organizationPlanningPolicy,
  effectivePlanningPolicy,
  withOrganizationPlanningPolicy,
} from "./planning-policy";
import {
  assertLockedFirstStopOrder,
  RouteFirstStopLockError,
} from "./route-first-stop-lock-service";

export type StopRow = typeof stopsTable.$inferSelect;
type VehicleRow = typeof vehiclesTable.$inferSelect;
type DriverRow = typeof driversTable.$inferSelect;
type DriverCertificationRow = typeof driverCertificationsTable.$inferSelect;
type OrganizationRow = typeof organizationsTable.$inferSelect;
function applyDriverRoutingProfile(vehicle: ALNSVehicle, driver: DriverRow): ALNSVehicle {
  return { ...baseDriverRoutingProfile(vehicle, driver), driverId: driver.id };
}

export type { OptimizationEvidence, OptimizationEvidenceSource };

export type PlanningInputsV1 = {
  version: 1;
  objective: "balanced" | "shortest" | "geographic" | "areas_worktime" | "minimize_vehicles";
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

export const DEFAULT_PLANNING_INPUTS: PlanningInputsV1 = {
  version: 1,
  objective: "balanced",
  travelReservePercent: 0,
  stopReserveMin: 0,
  stopPriorities: {},
  excludedPairValues: [],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs",
  maxDriverOvertimeMin: 0,
  allowLateStopsMin: 0,
};

export function normalizePlanningInputs(value: unknown): PlanningInputsV1 {
  if (value == null)
    return {
      ...DEFAULT_PLANNING_INPUTS,
      stopPriorities: {},
      excludedPairValues: [],
    };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportRouteWorkflowError(
      "Planeringsunderlaget måste vara ett objekt.",
    );
  }
  const input = value as Partial<PlanningInputsV1>;
  const allowed = new Set([
    "version",
    "objective",
    "travelReservePercent",
    "stopReserveMin",
    "stopPriorities",
    "excludedPairValues",
    "depotOverride",
    "vehicleSelectionMode",
    "maxDriverOvertimeMin",
    "allowLateStopsMin",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ImportRouteWorkflowError(
      "Planeringsunderlaget innehåller ett okänt fält.",
    );
  }
  if (
    input.version !== 1 ||
    !["balanced", "shortest", "geographic", "areas_worktime", "minimize_vehicles"].includes(
      input.objective ?? "",
    )
  ) {
    throw new ImportRouteWorkflowError("Planeringsmålet är ogiltigt.");
  }
  if (
    !Number.isFinite(input.travelReservePercent) ||
    input.travelReservePercent! < 0 ||
    input.travelReservePercent! > 100 ||
    !Number.isInteger(input.stopReserveMin) ||
    input.stopReserveMin! < 0 ||
    input.stopReserveMin! > 120
  ) {
    throw new ImportRouteWorkflowError(
      "Reservtid måste vara 0–100 procent körning och 0–120 minuter per stopp.",
    );
  }
  const priorities = input.stopPriorities ?? {};
  if (
    !priorities ||
    typeof priorities !== "object" ||
    Array.isArray(priorities) ||
    Object.values(priorities).some(
      (priority) => priority !== 0 && priority !== 1 && priority !== 2,
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Stoppprioriteter måste vara Normal, Hög eller Måste med.",
    );
  }
  const excluded = input.excludedPairValues ?? [];
  if (
    !Array.isArray(excluded) ||
    excluded.some(
      (pair) =>
        typeof pair !== "string" ||
        !/^[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(pair),
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Undantagna resurser måste vara giltiga bil–chaufförspar.",
    );
  }
  if (
    input.depotOverride !== null &&
    input.depotOverride !== undefined &&
    (!input.depotOverride ||
      !/^(organization-default|route:[0-9a-fA-F-]{36})$/.test(
        input.depotOverride.verifiedDepotId,
      ) ||
      !["plan", "pair"].includes(input.depotOverride.scope) ||
      (input.depotOverride.scope === "pair" && !input.depotOverride.vehicleId))
  ) {
    throw new ImportRouteWorkflowError(
      "Depåundantag måste välja organisationens verifierade depå.",
    );
  }
  return {
    version: 1,
    objective: input.objective!,
    travelReservePercent: input.travelReservePercent!,
    stopReserveMin: input.stopReserveMin!,
    stopPriorities: priorities,
    excludedPairValues: [...new Set(excluded)].sort(),
    depotOverride: input.depotOverride ?? null,
    vehicleSelectionMode:
      input.vehicleSelectionMode === "minimize_vehicles" ||
      input.objective === "minimize_vehicles"
        ? "minimize_vehicles"
        : "use_all_selected_pairs",
    maxDriverOvertimeMin:
      input.maxDriverOvertimeMin == null
        ? 0
        : normalizePlanningAllowance(
            input.maxDriverOvertimeMin,
            "maxDriverOvertimeMin",
          ),
    allowLateStopsMin:
      input.allowLateStopsMin == null
        ? 0
        : normalizePlanningAllowance(
            input.allowLateStopsMin,
            "allowLateStopsMin",
          ),
  };
}

function effectivePlanningInputsForStops(
  value: unknown,
  stops: Array<Pick<StopRow, "id" | "priority">>,
): PlanningInputsV1 {
  const inputs = normalizePlanningInputs(value);
  return {
    ...inputs,
    stopPriorities: Object.fromEntries(
      [...stops]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((stop) => [
          stop.id,
          Object.prototype.hasOwnProperty.call(inputs.stopPriorities, stop.id)
            ? inputs.stopPriorities[stop.id]!
            : stop.priority === 1 || stop.priority === 2
              ? stop.priority
              : 0,
        ]),
    ),
    excludedPairValues: [...inputs.excludedPairValues].sort(),
  };
}

function samePlanningInputsForStops(
  left: unknown,
  right: unknown,
  stops: Array<Pick<StopRow, "id" | "priority">>,
): boolean {
  // Canonicalize jsonb object ordering and sparse priority maps. This makes a
  // browser's `{}` mean the same thing as the persisted effective all-zero map.
  return (
    payloadIdentityHash(effectivePlanningInputsForStops(left, stops)) ===
    payloadIdentityHash(effectivePlanningInputsForStops(right, stops))
  );
}

export function verifiedDepotOverrideSnapshot(
  override: PlanningInputsV1["depotOverride"],
  organization: OrganizationRow | undefined,
  existingRoutes: Array<
    Pick<typeof routesTable.$inferSelect, "id" | "depotSnapshot">
  > = [],
): NonNullable<ReturnType<typeof verifiedDepotSnapshot>> | undefined {
  if (!override) return undefined;
  if (override.verifiedDepotId === "organization-default") {
    return verifiedDepotSnapshot(organization) ?? undefined;
  }
  const routeId = override.verifiedDepotId.slice("route:".length);
  const candidate = existingRoutes.find(
    (route) => route.id === routeId,
  )?.depotSnapshot;
  if (
    !candidate ||
    !candidate.start.verifiedAt ||
    !candidate.end.verifiedAt ||
    Number.isNaN(Date.parse(candidate.start.verifiedAt)) ||
    Number.isNaN(Date.parse(candidate.end.verifiedAt))
  ) {
    return undefined;
  }
  return candidate as NonNullable<ReturnType<typeof verifiedDepotSnapshot>>;
}

export function activeOriginalPairs(
  pairValues: string[],
  planningInputs: PlanningInputsV1,
): Array<{ vehicleId: string; driverId: string }> {
  const pairs = pairValues
    .map((value) => {
      const [vehicleId, driverId, extra] = value.split(":");
      if (!vehicleId || !driverId || extra) {
        throw new ImportRouteWorkflowError(
          "Planens sparade resursurval är ogiltigt.",
          409,
        );
      }
      return { vehicleId, driverId };
    })
    .filter(
      (pair) =>
        !planningInputs.excludedPairValues.includes(
          `${pair.vehicleId}:${pair.driverId}`,
        ),
    );
  if (pairs.length === 0) {
    throw new ImportRouteWorkflowError(
      "Dagens undantag tar bort alla tidigare valda bil–chaufförspar.",
      409,
    );
  }
  return pairs;
}

export function planningWeights(
  inputs: PlanningInputsV1,
): Partial<OptimizationWeights> {
  if (inputs.objective === "areas_worktime")
    return {
      objectivePriority: "areas_worktime",
      workloadBalanceWeight: 1,
      distanceWeight: 0,
      co2Weight: 0,
      etaPrecisionWeight: 0,
      driverHappinessWeight: 0,
      geographicCohesionWeight: 1,
    };
  if (inputs.objective === "shortest")
    return {
      workloadBalanceWeight: 0,
      distanceWeight: 0.8,
      co2Weight: 0.05,
      etaPrecisionWeight: 0.1,
      driverHappinessWeight: 0.05,
      geographicCohesionWeight: 0,
    };
  if (inputs.objective === "geographic")
    return {
      workloadBalanceWeight: 0,
      distanceWeight: 0.25,
      co2Weight: 0.1,
      etaPrecisionWeight: 0.1,
      driverHappinessWeight: 0.05,
      geographicCohesionWeight: 0.5,
    };
  if (inputs.objective === "minimize_vehicles")
    return {
      workloadBalanceWeight: 0,
      distanceWeight: 0.5,
      co2Weight: 0.2,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    };
  return {
    workloadBalanceWeight: 1,
    distanceWeight: 0.35,
    co2Weight: 0.15,
    etaPrecisionWeight: 0.15,
    driverHappinessWeight: 0.35,
    geographicCohesionWeight: 0,
  };
}

function completeOptimizationWeights(
  weights: Partial<OptimizationWeights> | undefined,
  objective?: PlanningInputsV1["objective"] | null,
): OptimizationWeights {
  return {
    ...(weights?.objectivePriority ? { objectivePriority: weights.objectivePriority } : {}),
    workloadBalanceWeight: objective === "geographic" || objective === "shortest" || objective === "minimize_vehicles"
      ? 0 : weights?.workloadBalanceWeight ?? 1,
    distanceWeight: weights?.distanceWeight ?? DEFAULT_WEIGHTS.distanceWeight,
    co2Weight: weights?.co2Weight ?? DEFAULT_WEIGHTS.co2Weight,
    etaPrecisionWeight:
      weights?.etaPrecisionWeight ?? DEFAULT_WEIGHTS.etaPrecisionWeight,
    driverHappinessWeight:
      weights?.driverHappinessWeight ?? DEFAULT_WEIGHTS.driverHappinessWeight,
    geographicCohesionWeight:
      weights?.geographicCohesionWeight ??
      DEFAULT_WEIGHTS.geographicCohesionWeight,
  };
}

/**
 * Keep the optimizer's actual configuration alongside the user-facing
 * profile.  In particular, a legacy request has no named objective and must
 * not be presented as balanced merely because a compatibility snapshot uses
 * the default planning inputs.
 */
export function optimizationEvidenceForConfig(input: {
  source: OptimizationEvidenceSource;
  planningInputs?: PlanningInputsV1 | null;
  requestedWeights?: Partial<OptimizationWeights> | null;
  effectiveWeights: OptimizationWeights;
  vehicleDistributionMode?: "balance" | "minimize" | null;
}): OptimizationEvidence {
  const explicitPlanningInputs =
    input.source === "planningInputs" && input.planningInputs != null;
  return {
    source: input.source,
    requestedObjective: explicitPlanningInputs
      ? input.planningInputs!.objective
      : null,
    effectiveObjective: explicitPlanningInputs
      ? input.planningInputs!.objective
      : null,
    requestedWeights:
      input.requestedWeights == null
        ? null
        : completeOptimizationWeights(input.requestedWeights),
    effectiveWeights: completeOptimizationWeights(input.effectiveWeights, explicitPlanningInputs ? input.planningInputs!.objective : null),
    vehicleDistributionMode: input.vehicleDistributionMode ?? null,
    vehicleSelectionMode: explicitPlanningInputs
      ? input.planningInputs!.vehicleSelectionMode
      : input.vehicleDistributionMode == null
        ? null
        : input.vehicleDistributionMode === "minimize"
          ? "minimize_vehicles"
          : "use_all_selected_pairs",
  };
}

export function unknownOptimizationEvidence(): OptimizationEvidence {
  return {
    source: "unknown",
    requestedObjective: null,
    effectiveObjective: null,
    requestedWeights: null,
    effectiveWeights: null,
    vehicleDistributionMode: null,
    vehicleSelectionMode: null,
  };
}

/** Add an explicit unknown marker only at API boundaries for historical rows. */
export function planningSummaryForResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const summary = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(summary, "optimizationEvidence")
    ? value
    : { ...summary, optimizationEvidence: unknownOptimizationEvidence() };
}

export function verifiedDepotSnapshot(organization?: OrganizationRow) {
  if (
    !organization?.depotStartVerifiedAt ||
    !organization.depotEndVerifiedAt ||
    organization.depotStartLatitude == null ||
    organization.depotStartLongitude == null ||
    organization.depotEndLatitude == null ||
    organization.depotEndLongitude == null
  ) {
    return null;
  }
  return {
    start: {
      address: organization.depotStartAddress ?? "",
      latitude: organization.depotStartLatitude,
      longitude: organization.depotStartLongitude,
      verifiedAt: organization.depotStartVerifiedAt.toISOString(),
      verification: organization.depotStartVerification,
    },
    end: {
      address: organization.depotEndAddress ?? "",
      latitude: organization.depotEndLatitude,
      longitude: organization.depotEndLongitude,
      verifiedAt: organization.depotEndVerifiedAt.toISOString(),
      verification: organization.depotEndVerification,
    },
  };
}

/**
 * A route snapshot records the effective depot of its last optimization and
 * may therefore be a temporary override. Legacy protected plans did not save
 * base evidence separately, so reuse it only when saved planning inputs prove
 * no override applied to this vehicle.
 */
function legacyBaseDepotSnapshot(
  route:
    | Pick<
        typeof routesTable.$inferSelect,
        "vehicleId" | "depotSnapshot" | "optimizationPlanningSnapshot"
      >
    | undefined,
  currentDepotSnapshot: ReturnType<typeof verifiedDepotSnapshot>,
) {
  if (!route?.depotSnapshot || !route.optimizationPlanningSnapshot) {
    return currentDepotSnapshot;
  }
  try {
    const previous = normalizePlanningInputs(
      route.optimizationPlanningSnapshot,
    );
    const wasOverridden =
      previous.depotOverride?.scope === "plan" ||
      (previous.depotOverride?.scope === "pair" &&
        previous.depotOverride.vehicleId === route.vehicleId);
    return wasOverridden ? currentDepotSnapshot : route.depotSnapshot;
  } catch {
    return currentDepotSnapshot;
  }
}

function depotSnapshotForResponse(
  snapshot: typeof routesTable.$inferSelect.depotSnapshot,
) {
  if (!snapshot) return snapshot;
  return {
    start: {
      ...snapshot.start,
      verifiedAt: new Date(snapshot.start.verifiedAt),
    },
    end: {
      ...snapshot.end,
      verifiedAt: new Date(snapshot.end.verifiedAt),
    },
  };
}

function workdayTimelineForResponse(
  timeline: typeof routesTable.$inferSelect.workdayTimeline,
) {
  return (
    timeline?.map((event) => ({
      ...event,
      startAt: new Date(event.startAt),
      endAt: new Date(event.endAt),
    })) ?? timeline
  );
}

function workdaySummaryForResponse(
  summary: typeof routesTable.$inferSelect.workdaySummary,
) {
  return summary
    ? { ...summary, shiftEndAt: new Date(summary.shiftEndAt) }
    : summary;
}

function plannerItineraryForResponse(
  itinerary: NonNullable<typeof routesTable.$inferSelect.plannerItinerary>,
) {
  return itinerary.map((stop) => ({
    ...stop,
    estimatedArrival: new Date(stop.estimatedArrival),
  }));
}

export interface ImportRoutePlanInput {
  progressId?: string;
  stopIds: string[];
  pairs: Array<{ vehicleId: string; driverId: string }>;
  vehicleDistributionMode?: "minimize" | "balance";
  optimizationWeights?: Partial<OptimizationWeights>;
  date: Date;
  depotLatitude: number;
  depotLongitude: number;
  draftId?: string;
  planningInputs?: PlanningInputsV1;
  customerReference?: string | null;
  sharedInstructions?: string | null;
}

type ProposalDiagnostic = {
  stopId: string;
  code:
    | "TIME_WINDOW_UNREACHABLE"
    | "CAPACITY_EXCEEDED"
    | "RANGE_EXCEEDED"
    | "OVERTIME_ALLOWANCE_EXCEEDED"
    | "LATE_TOLERANCE_EXCEEDED"
    | "FIELD_SERVICE_INELIGIBLE"
    | "BREAK_WINDOW_CONFLICT"
    | "STOP_AVAILABILITY_CONFLICT";
  detail: string;
};

export interface RouteAdjustmentInput {
  expectedPreviewDigest?: string;
  planId: string;
  routes: Array<{
    routeId: string;
    driverId: string;
    planRevision: number;
    stopIds: string[];
    plannerItinerary?: Array<{
      stopId: string;
      sequenceOrder: number;
      estimatedArrival: string | Date;
      distanceFromPreviousKm: number;
      isChargingStop?: boolean;
      chargingStationName?: string;
    }>;
  }>;
  depotLatitude: number;
  depotLongitude: number;
}

export interface ImportPlanServiceTimeReoptimizationInput {
  serviceDurationMin: number;
  serviceTimeStrategy:
    | "preserve_individual"
    | "preserve_exact"
    | "replace_all";
  routes: Array<{
    routeId: string;
    driverId: string;
    planRevision: number;
  }>;
  pairs?: Array<{ vehicleId: string; driverId: string }>;
  depotLatitude: number;
  depotLongitude: number;
  /** Internal planning-input reoptimization overlays; raw stop service values stay unchanged. */
  planningInputs?: PlanningInputsV1;
  sharedInstructions?: string | null;
  /**
   * Used by protected planning-input changes. It is checked and written while
   * the route/stops/resource transaction is still open, never afterwards.
   */
  protectedDraftUpdate?: {
    draftId: string;
    expectedRevision: number;
  };
  originalSelectedPairValues?: string[];
  /**
   * Server-derived evidence used only when a protected draft has no live
   * routes left to use as a reoptimization anchor. It is read from the locked
   * draft result, never from an HTTP request.
   */
  recovery?: {
    planDate: Date;
    stopIds: string[];
    selectedPairValues: string[];
    depotLatitude: number;
    depotLongitude: number;
    depotSnapshots: Record<
      string,
      NonNullable<typeof routesTable.$inferSelect.depotSnapshot> | null
    >;
    baseDepotLatitude: number;
    baseDepotLongitude: number;
    baseDepotSnapshots: Record<
      string,
      NonNullable<typeof routesTable.$inferSelect.depotSnapshot> | null
    >;
    customerReference: string | null;
    identityHash: string;
  };
  /**
   * Internal whole-plan preview/apply controls.  They are intentionally not
   * exposed by the legacy service-time endpoint: preview computes and caches
   * the executable result before opening the persistence transaction, while
   * apply consumes that result before any row can be written.
   */
  previewOnly?: boolean;
  expectedProposalHash?: string;
  wholePlanOnly?: boolean;
  expectedWholePlanStateFingerprint?: string;
  /**
   * Internal whole-plan apply path. The preview's fully evaluated ALNS result
   * is held in the bounded server-side proposal cache and supplied here so
   * apply never runs the timed/random optimizer a second time.
   */
  cachedProposalResult?: ALNSResult;
}

export interface RouteScopedReoptimizationInput {
  planRevision: number;
  depotLatitude: number;
  depotLongitude: number;
  optimizedStopIds?: string[];
  /** Internal only: validated, unpersisted append rows. Never accepted by route APIs. */
  appendStops?: StopRow[];
}
let serviceTimeReoptimizationBeforePersistHook:
  | (() => Promise<void>)
  | undefined;

let routeScopedReoptimizationAfterLockHook: (() => Promise<void>) | undefined;
let importPlanBeforePersistHook: (() => Promise<void>) | undefined;
let importPlanBeforeOptimizeHook: (() => Promise<void>) | undefined;
export function setServiceTimeReoptimizationBeforePersistHookForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Service-time reoptimization hooks are only available in tests.",
    );
  }
  serviceTimeReoptimizationBeforePersistHook = hook;
}

export function setRouteScopedReoptimizationAfterLockHookForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "Route-scoped reoptimization hooks are only available in tests.",
    );
  }
  routeScopedReoptimizationAfterLockHook = hook;
}

export function setImportPlanBeforePersistHookForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Import plan hooks are only available in tests.");
  }
  importPlanBeforePersistHook = hook;
}

export function setImportPlanBeforeOptimizeHookForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Import plan hooks are only available in tests.");
  }
  importPlanBeforeOptimizeHook = hook;
}
export class ImportRouteWorkflowError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 | 422 = 400,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ImportRouteWorkflowError";
  }
}

type ImportRouteQueryExecutor = Pick<typeof db, "select" | "selectDistinct">;

type VehicleBookingConflict = {
  vehicleId: string;
  vehicleName: string;
  routeId: string;
  planId: string;
  draftId: string | null;
  draftName: string | null;
  date: string;
};

async function findVehicleBookingConflicts(
  executor: ImportRouteQueryExecutor,
  organizationId: string,
  vehicleIds: string[],
  date: Date,
  vehicleNames: Map<string, string>,
): Promise<VehicleBookingConflict[]> {
  if (vehicleIds.length === 0) return [];
  const { dayStart, dayEnd } = stockholmPlanningDayBounds(date);
  const candidateRoutes = await executor
    .select({
      routeId: routesTable.id,
      vehicleId: routesTable.vehicleId,
      planId: routesTable.planId,
      draftId: routesTable.draftId,
      routeDate: routesTable.date,
      draftName: planningDraftsTable.name,
    })
    .from(routesTable)
    .leftJoin(
      planningDraftsTable,
      and(
        eq(planningDraftsTable.id, routesTable.draftId),
        eq(planningDraftsTable.organizationId, organizationId),
      ),
    )
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.vehicleId, vehicleIds),
        ne(routesTable.status, "cancelled"),
        ne(routesTable.status, "completed"),
        gte(routesTable.date, dayStart),
        lt(routesTable.date, dayEnd),
      ),
    );
  if (candidateRoutes.length === 0) return [];

  const occupiedRouteRows = await executor
    .selectDistinct({ routeId: stopsTable.routeId })
    .from(stopsTable)
    .where(
      and(
        eq(stopsTable.organizationId, organizationId),
        inArray(
          stopsTable.routeId,
          candidateRoutes.map((route) => route.routeId),
        ),
      ),
    );
  const occupiedRouteIds = new Set(
    occupiedRouteRows.flatMap(({ routeId }) => (routeId ? [routeId] : [])),
  );
  const vehicleOrder = new Map(
    vehicleIds.map((vehicleId, index) => [vehicleId, index]),
  );
  return candidateRoutes
    .filter((route) => occupiedRouteIds.has(route.routeId))
    .sort(
      (left, right) =>
        (vehicleOrder.get(left.vehicleId!) ?? Number.MAX_SAFE_INTEGER) -
          (vehicleOrder.get(right.vehicleId!) ?? Number.MAX_SAFE_INTEGER) ||
        left.routeId.localeCompare(right.routeId),
    )
    .map((route) => ({
      vehicleId: route.vehicleId!,
      vehicleName: vehicleNames.get(route.vehicleId!) ?? "",
      routeId: route.routeId,
      planId: route.planId,
      draftId: route.draftId ?? null,
      draftName: route.draftName ?? null,
      date: route.routeDate.toISOString(),
    }));
}

function vehicleAlreadyPlannedError(
  conflicts: VehicleBookingConflict[],
): ImportRouteWorkflowError {
  return new ImportRouteWorkflowError(
    "En vald bil har redan en aktiv rutt på det valda planeringsdatumet.",
    409,
    "VEHICLE_ALREADY_PLANNED",
    { conflicts },
  );
}

async function buildRouteScopedReoptimization(
  ...args: Parameters<typeof buildRouteScopedReoptimizationImpl>
) {
  await preparePersistedRouteRoadData(args[0], {
    routeIds: [args[1]],
    coordinates: (args[2].appendStops ?? []).flatMap(stop => [
      { lat: stop.latitude, lon: stop.longitude },
      ...(stop.pickupLatitude != null && stop.pickupLongitude != null
        ? [{ lat: stop.pickupLatitude, lon: stop.pickupLongitude }] : []),
    ]),
  });
  return withRequiredRoadData(() => buildRouteScopedReoptimizationImpl(...args));
}

async function buildRouteScopedReoptimizationImpl(
  organizationId: string,
  routeId: string,
  input: RouteScopedReoptimizationInput,
  requestedServiceStart?: { stopId: string; instant: Date },
) {
  const [[route], [organization]] = await Promise.all([
    db
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, organizationId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1),
  ]);
  if (!route) throw new ImportRouteWorkflowError("Rutten kunde inte hittas.");
  const sourceRouteSnapshot = structuredClone(route);
  const persistedPlanningSnapshot =
    route.optimizationPlanningSnapshot as Record<string, unknown> | null;
  if (
    !persistedPlanningSnapshot ||
    !Number.isFinite(persistedPlanningSnapshot.travelReservePercent) ||
    !Number.isInteger(persistedPlanningSnapshot.stopReserveMin)
  ) {
    throw new ImportRouteWorkflowError(
      "Rutten saknar sparat depå- eller reservunderlag och kan inte planeras om säkert.",
      409,
    );
  }
  if (route.planRevision !== input.planRevision) {
    throw new ImportRouteWorkflowError(
      "Rutten ändrades av någon annan. Ladda om och försök igen.",
      409,
    );
  }
  if (!route.vehicleId) {
    throw new ImportRouteWorkflowError("Rutten saknar fordon.");
  }
  const [vehicle, driverRows, stops] = await Promise.all([
    db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, route.vehicleId),
          eq(vehiclesTable.organizationId, organizationId),
          eq(vehiclesTable.isActive, true),
        ),
      )
      .limit(1),
    db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.vehicleId, route.vehicleId),
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true),
        ),
      ),
    db
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.routeId, route.id),
          eq(stopsTable.organizationId, organizationId),
          isNull(stopsTable.archivedAt),
        ),
      )
      .orderBy(stopsTable.sequenceOrder),
  ]).then(
    ([vehicles, drivers, routeStops]) =>
      [vehicles[0], drivers, routeStops] as const,
  );
  const driver = resolveDriverForRoute(route, driverRows);
  if (input.appendStops) {
    assertAppendRouteEligible(route, stops);
    stops.push(...input.appendStops.map((stop, index) => ({
      ...stop, routeId, planningPlanId: route.planId, sequenceOrder: stops.length + index + 1,
    })));
  }
  if (!vehicle || !driver) {
    throw new ImportRouteWorkflowError(
      isProtectedImportRoute(route)
        ? "Rutten saknar sin optimeringsvalda aktiva chaufför. Ladda om och välj en explicit resursändring."
        : "Rutten saknar ett aktivt bil–chaufförspar.",
      409,
    );
  }
  const driverCertifications = await db
    .select()
    .from(driverCertificationsTable)
    .where(
      and(
        eq(driverCertificationsTable.organizationId, organizationId),
        eq(driverCertificationsTable.driverId, driver.id),
      ),
    )
    .orderBy(driverCertificationsTable.id);
  const driverPreferences = input.appendStops ? await db.select().from(driverPreferencesTable)
    .where(eq(driverPreferencesTable.driverId, driver.id)).orderBy(driverPreferencesTable.id) : [];
  const pendingStops = stops.filter((stop) => stop.status === "pending");
  const lockedStops = stops.filter((stop) => stop.status !== "pending");
  // A terminal first job has fulfilled the lock's execution constraint. Older
  // clients may have persisted the terminal transition without going through
  // updateStop, so treat that state as authoritative instead of blocking the
  // remaining pending jobs from being rerouted.
  if (
    route.lockedFirstStopId != null
    && stops.some(
      (stop) =>
        stop.id === route.lockedFirstStopId
        && ["completed", "failed", "skipped"].includes(stop.status),
    )
  ) {
    route.lockedFirstStopId = null;
  }
  if (pendingStops.length === 0) {
    throw new ImportRouteWorkflowError(
      "Rutten har inga återstående väntande stopp.",
    );
  }
  for (const stop of stops) {
    if (stop.jobType === "field_service") {
      await assertDriverEligibleForFieldService(
        driver.id,
        vehicle.id,
        fieldServiceRequirementsFromStop(stop),
        route.date,
      );
    }
  }
  const organizationPolicy = effectivePlanningPolicy(organization, route.optimizationPlanningSnapshot);
  const routingVehicle = withOrganizationPlanningPolicy(
    applyDriverRoutingProfile(
      {
        id: vehicle.id,
        vehicleType: vehicle.vehicleType,
        capacityKg: vehicle.capacityKg,
        capacityVolume: vehicle.capacityVolume,
        rangeKm: effectiveRangeKm(vehicle),
      },
      driver,
    ),
    organizationPolicy,
  );
  if (input.appendStops) routingVehicle.driverId = driver.id;
  const currentDepotSnapshot = verifiedDepotSnapshot(organization);
  const authoritativeDepot = route.depotSnapshot ?? currentDepotSnapshot;
  const effectiveDepot = resolveReoptimizationDepot(authoritativeDepot, driver);
  if (!effectiveDepot) {
    throw new ImportRouteWorkflowError(
      "Rutten saknar start- eller slutplats. Ange båda platserna hos resursen innan du ruttar om.",
      409,
    );
  }
  const planningInputs = normalizePlanningInputs(
    route.optimizationPlanningSnapshot,
  );
  planningInputs.maxDriverOvertimeMin = organizationPolicy.maxDriverOvertimeMin;
  planningInputs.allowLateStopsMin = organizationPolicy.allowLateStopsMin;
  const depotLatitude =
    effectiveDepot.start.latitude;
  const depotLongitude =
    effectiveDepot.start.longitude;
  routingVehicle.startLatitude = depotLatitude;
  routingVehicle.startLongitude = depotLongitude;
  routingVehicle.endLatitude =
    effectiveDepot.end.latitude;
  routingVehicle.endLongitude =
    effectiveDepot.end.longitude;
  routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
  const constraints = routingConstraintsForDriver(driver);
  const persistedEvidence = route.planningSummary?.optimizationEvidence ?? null;
  const effectiveWeights = persistedEvidence?.effectiveWeights
    ? completeOptimizationWeights(persistedEvidence.effectiveWeights, persistedEvidence.effectiveObjective)
    : completeOptimizationWeights(planningWeights(planningInputs));
  const optimizationEvidence = optimizationEvidenceForConfig({
    source:
      persistedEvidence && persistedEvidence.source !== "unknown"
        ? persistedEvidence.source
        : "legacy",
    planningInputs:
      persistedEvidence?.source === "planningInputs"
        ? planningInputs
        : undefined,
    requestedWeights:
      persistedEvidence?.requestedWeights ??
      (persistedEvidence?.source === "planningInputs"
        ? planningWeights(planningInputs)
        : null),
    effectiveWeights,
    // Route-scoped recovery intentionally optimizes only this route's
    // remaining stops, so the invocation always uses the minimize-vehicles
    // distribution regardless of the previous route-level mode.
    vehicleDistributionMode: "minimize",
  });
  let pendingOrder: string[];
  if (route.optimizationFrozen) {
    pendingOrder = pendingStops.map(stop => stop.id);
    if (input.optimizedStopIds && JSON.stringify(input.optimizedStopIds) !== JSON.stringify(pendingOrder)) {
      throw new ImportRouteWorkflowError("Den frysta ruttens ordning får inte ändras.", 409);
    }
  } else if (input.optimizedStopIds) {
    if (
      input.optimizedStopIds.length !== pendingStops.length ||
      new Set(input.optimizedStopIds).size !== pendingStops.length ||
      input.optimizedStopIds.some(
        (id) => !pendingStops.some((stop) => stop.id === id),
      )
    ) {
      throw new ImportRouteWorkflowError(
        "Den tillämpade förhandsvisningen innehåller inte exakt ruttens väntande stopp.",
        409,
      );
    }
    pendingOrder = input.optimizedStopIds;
  } else {
    const optimizer = input.appendStops
      ? optimizeWithCanonicalAppendPlanningLocks.bind(null, stops.filter(stop => input.appendStops!.some(row => row.id === stop.id)))
      : optimizeWithALNS;
    const result = await optimizer(
      pendingStops.map((stop) => toAlnsNode(stop, planningInputs)),
      [routingVehicle],
      depotLatitude,
      depotLongitude,
      route.date,
      {
        ...policyToALNSConfig(
          resolveOptimizationPolicy(pendingStops.length, 8_000),
        ),
        timeLimitMs: 8_000,
        weights: effectiveWeights,
        vehicleDistributionMode: "minimize",
        driverConstraints: [constraints],
      },
    );
    reinsertUnassignedNodes(
      result,
      [routingVehicle],
      new Map([[vehicle.id, constraints]]),
      depotLatitude,
      depotLongitude,
      route.date,
      {
        weights: effectiveWeights,
        vehicleDistributionMode: "minimize",
      },
    );
    const optimized = result.routes.find(
      (candidate) => candidate.vehicleId === vehicle.id,
    );
    pendingOrder =
      optimized?.nodes
        .filter((node) => !node.isChargingStation)
        .map((node) => node.id) ?? [];
    if (
      result.unassigned.some((node) => !node.isChargingStation) ||
      pendingOrder.length !== pendingStops.length
    ) {
      throw new ImportRouteWorkflowError(
        "Alla återstående stopp kan inte planeras inom ruttens hårda villkor.",
      );
    }
  }
  if (route.lockedFirstStopId != null) {
    if (!pendingStops.some((stop) => stop.id === route.lockedFirstStopId)) {
      throw new ImportRouteWorkflowError(
        "Rutten har ett låst första kundstopp som inte längre är väntande. Lås upp rutten och försök igen.",
        409,
      );
    }
    pendingOrder = [
      route.lockedFirstStopId,
      ...pendingOrder.filter((stopId) => stopId !== route.lockedFirstStopId),
    ];
  }
  // The canonical optimizer enriches its mutable vehicle argument. A shared
  // vehicle's other locked routes must not replace this route's depot in the
  // final evaluation (the apply path does not run that search again).
  routingVehicle.startLatitude = depotLatitude;
  routingVehicle.startLongitude = depotLongitude;
  routingVehicle.endLatitude = effectiveDepot.end.latitude;
  routingVehicle.endLongitude = effectiveDepot.end.longitude;
  const pendingById = new Map(pendingStops.map((stop) => [stop.id, stop]));
  let pendingIndex = 0;
  const mergedStops = stops.map((stop) =>
    stop.status === "pending"
      ? pendingById.get(pendingOrder[pendingIndex++])!
      : stop,
  );
  const customerNodes = mergedStops.map(stop => toAlnsNode(stop, planningInputs));
  const nodes = route.optimizationFrozen || requestedServiceStart
    ? canonicalFrozenItinerary(route, stops, customerNodes).nodes : customerNodes;
  if (requestedServiceStart) {
    const requestedNode = nodes.find(node => node.id === requestedServiceStart.stopId);
    if (!requestedNode) throw new ImportRouteWorkflowError("Uppdraget saknas i ruttens auktoritativa resväg.", 409);
    requestedNode.lockedServiceStartAt = requestedServiceStart.instant;
  }
  const candidate: ALNSRoute = {
    vehicleId: vehicle.id,
    nodes,
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
  if (
    candidate.totalWeight > routingVehicle.capacityKg ||
    candidate.totalVolume > routingVehicle.capacityVolume
  ) {
    throw new ImportRouteWorkflowError(
      "Rutten överskrider bilens vikt- eller volymkapacitet.",
    );
  }
  let evaluation = evaluateRoute(
    candidate,
    routingVehicle,
    depotLatitude,
    depotLongitude,
    route.date,
    constraints,
  );
  if (route.optimizationFrozen && !evaluation.feasible) {
    throw new ImportRouteWorkflowError("Den frysta rutten är inte längre genomförbar med aktuellt underlag.", 409);
  }
  if (
    !evaluation.feasible &&
    vehicle.vehicleType === "electric" &&
    routingVehicle.rangeKm != null
  ) {
    chargingStationInsertion(
      {
        routes: [candidate],
        unassigned: [],
        cost: 0,
        costBreakdown: {
          distanceCost: 0,
          co2Cost: 0,
          etaPrecisionCost: 0,
          driverPenaltyCost: 0,
          geographicCohesionCost: 0,
          totalDistanceKm: 0,
          totalCo2Kg: 0,
          totalTimeWindowSlackMin: 0,
          totalDriverPenalty: 0,
        },
      },
      [routingVehicle],
      depotLatitude,
      depotLongitude,
      route.date,
      new Map([[vehicle.id, constraints]]),
    );
    evaluation = evaluateRoute(
      candidate,
      routingVehicle,
      depotLatitude,
      depotLongitude,
      route.date,
      constraints,
    );
  }
  if (!evaluation.feasible) {
    throw new ImportRouteWorkflowError(
      "Rutten bryter mot tidsfönster, arbetstid, rast eller tillgänglig energi.",
    );
  }
  const itinerary = route.optimizationFrozen ? route.plannerItinerary! : itineraryForNodes(
    candidate.nodes,
    routingVehicle,
    driver,
    depotLatitude,
    depotLongitude,
    route.date,
  );
  const workday = evaluateRouteWorkday(
    candidate.nodes,
    routingVehicle,
    depotLatitude,
    depotLongitude,
    route.date,
    constraints,
  );
  const sequencedStops = mergedStops.map((stop, index) => ({ ...stop, sequenceOrder: stops[index].sequenceOrder }));
  assertPlanningLockOrder(route, stops, sequencedStops);
  assertPlanningLockTimes(route, mergedStops, workday.events);
  return {
    route,
    sourceRouteSnapshot,
    organization,
    currentDepotSnapshot,
    authoritativeDepot,
    vehicle,
    driver,
    driverCertifications,
    driverPreferences,
    stops,
    lockedStops,
    pendingStops,
    pendingOrder,
    planningInputs,
    itinerary,
    workday,
    distanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
    durationMin: Math.round(workday.summary.totalMin * 100) / 100,
    totalWeight: candidate.totalWeight,
    routingVehicle,
    optimizationEvidence,
  };
}

/** Arbitrary-time acquisition uses the same hard route evaluator, not arrival.
 * The caller must atomically compare every returned snapshot before writing. */
export async function evaluateRequestedRouteServiceStart(
  organizationId: string, routeId: string, planRevision: number, stopId: string, instant: Date,
) {
  const [route] = await db.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), eq(routesTable.id, routeId),
  ));
  if (!route?.depotSnapshot) throw new ImportRouteWorkflowError("Rutten saknar sparat depåunderlag för ett nytt tidslås.", 409);
  if (route.optimizationFrozen) throw new ImportRouteWorkflowError("Lås upp den frysta rutten innan servicestarten ändras.", 409);
  const stops = await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId), eq(stopsTable.routeId, routeId), isNull(stopsTable.archivedAt),
  )).orderBy(stopsTable.sequenceOrder);
  await preparePersistedRouteRoadData(organizationId, { routeIds: [routeId] });
  return withRequiredRoadData(() => buildRouteScopedReoptimization(organizationId, routeId, {
    planRevision, depotLatitude: route.depotSnapshot!.start.latitude,
    depotLongitude: route.depotSnapshot!.start.longitude,
    optimizedStopIds: stops.filter(stop => stop.status === "pending").map(stop => stop.id),
  }, { stopId, instant }));
}
function sameOptimizationVehicle(left: VehicleRow, right: VehicleRow): boolean {
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.vehicleType === right.vehicleType &&
    left.capacityKg === right.capacityKg &&
    left.capacityVolume === right.capacityVolume &&
    left.currentBatteryPercent === right.currentBatteryPercent &&
    left.rangeKm === right.rangeKm &&
    left.isActive === right.isActive &&
    JSON.stringify(left.equipmentInventory ?? []) ===
      JSON.stringify(right.equipmentInventory ?? [])
  );
}

function sameOptimizationDriver(left: DriverRow, right: DriverRow): boolean {
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.vehicleId === right.vehicleId &&
    left.isActive === right.isActive &&
    left.workStartTime === right.workStartTime &&
    left.workEndTime === right.workEndTime &&
    left.breakStartTime === right.breakStartTime &&
    left.breakEndTime === right.breakEndTime &&
    left.tempo === right.tempo &&
    left.capacityKg === right.capacityKg &&
    left.capacityVolume === right.capacityVolume &&
    left.startLatitude === right.startLatitude &&
    left.startLongitude === right.startLongitude &&
    left.endLatitude === right.endLatitude &&
    left.endLongitude === right.endLongitude &&
    left.driverRole === right.driverRole &&
    JSON.stringify(left.skills ?? []) === JSON.stringify(right.skills ?? [])
  );
}

function sameOptimizationStop(left: StopRow, right: StopRow): boolean {
  const sameDate = (a: Date | null, b: Date | null) =>
    a?.getTime() === b?.getTime();
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.routeId === right.routeId &&
    left.sequenceOrder === right.sequenceOrder &&
    left.status === right.status &&
    left.lockedVehicleId === right.lockedVehicleId &&
    left.lockedDriverId === right.lockedDriverId &&
    sameDate(left.lockedServiceStartAt, right.lockedServiceStartAt) &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    sameDate(left.timeWindowStart, right.timeWindowStart) &&
    sameDate(left.timeWindowEnd, right.timeWindowEnd) &&
    left.serviceDurationMin === right.serviceDurationMin &&
    left.weightKg === right.weightKg &&
    left.volumeM3 === right.volumeM3 &&
    left.pickupAddress === right.pickupAddress &&
    left.pickupLatitude === right.pickupLatitude &&
    left.pickupLongitude === right.pickupLongitude &&
    left.jobType === right.jobType &&
    left.priority === right.priority &&
    left.slaDeadline?.getTime() === right.slaDeadline?.getTime() &&
    JSON.stringify(left.requiredSkills ?? []) ===
      JSON.stringify(right.requiredSkills ?? []) &&
    JSON.stringify(left.requiredCertifications ?? []) ===
      JSON.stringify(right.requiredCertifications ?? []) &&
    JSON.stringify(left.requiredEquipment ?? []) ===
      JSON.stringify(right.requiredEquipment ?? [])
  );
}

function sameDriverCertification(
  left: DriverCertificationRow,
  right: DriverCertificationRow,
): boolean {
  return (
    left.id === right.id &&
    left.driverId === right.driverId &&
    left.organizationId === right.organizationId &&
    left.certificationCode === right.certificationCode &&
    left.issuedAt.getTime() === right.issuedAt.getTime() &&
    left.expiresAt?.getTime() === right.expiresAt?.getTime()
  );
}

function sameInitialPlanningRow(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePlanningDepot(
  left: OrganizationRow | undefined,
  right: OrganizationRow | undefined,
): boolean {
  if (!left || !right) return left === right;
  return sameInitialPlanningRow(
    {
      startAddress: left.depotStartAddress,
      startLatitude: left.depotStartLatitude,
      startLongitude: left.depotStartLongitude,
      startVerification: left.depotStartVerification,
      startVerifiedAt: left.depotStartVerifiedAt,
      endAddress: left.depotEndAddress,
      endLatitude: left.depotEndLatitude,
      endLongitude: left.depotEndLongitude,
      endVerification: left.depotEndVerification,
      endVerifiedAt: left.depotEndVerifiedAt,
    },
    {
      startAddress: right.depotStartAddress,
      startLatitude: right.depotStartLatitude,
      startLongitude: right.depotStartLongitude,
      startVerification: right.depotStartVerification,
      startVerifiedAt: right.depotStartVerifiedAt,
      endAddress: right.depotEndAddress,
      endLatitude: right.depotEndLatitude,
      endLongitude: right.depotEndLongitude,
      endVerification: right.depotEndVerification,
      endVerifiedAt: right.depotEndVerifiedAt,
    },
  );
}

function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function toAlnsNode(
  stop: StopRow,
  planningInputs: PlanningInputsV1 = DEFAULT_PLANNING_INPUTS,
): ALNSNode {
  // Keep this structural until the stop schema migration adds the JSONB
  // snapshot to StopRow.  Invalid snapshots are intentionally passed through
  // so the canonical workday evaluator can reject them rather than silently
  // making the delivery serviceable.
  const unavailablePeriods = (stop as StopRow & {
    unavailablePeriods?: unknown;
  }).unavailablePeriods;
  if (!isValidCoordinate(stop.latitude, stop.longitude)) {
    throw new ImportRouteWorkflowError(
      `Stoppet "${stop.address}" har ogiltiga koordinater.`,
    );
  }
  if (
    stop.pickupAddress &&
    (stop.pickupLatitude == null ||
      stop.pickupLongitude == null ||
      !isValidCoordinate(stop.pickupLatitude, stop.pickupLongitude))
  ) {
    throw new ImportRouteWorkflowError(
      `Upphämtningsadressen för "${stop.address}" saknar giltiga koordinater.`,
    );
  }

  return {
    id: stop.id,
    lockedVehicleId: stop.lockedVehicleId,
    lockedDriverId: stop.lockedDriverId,
    lockedServiceStartAt: stop.lockedServiceStartAt,
    jobType: stop.jobType ?? "delivery",
    latitude: stop.latitude,
    longitude: stop.longitude,
    timeWindowStart: stop.timeWindowStart,
    timeWindowEnd: stop.timeWindowEnd,
    serviceDurationMin: stop.serviceDurationMin,
    ...(unavailablePeriods != null
      ? {
          unavailablePeriods: unavailablePeriods as Array<{
            start: string;
            end: string;
          }>,
        }
      : {}),
    weightKg: Number(stop.weightKg) || 0,
    volumeM3: Number(stop.volumeM3) || 0,
    planningPriority:
      planningInputs.stopPriorities[stop.id] ??
      (stop.priority === 2 ? 2 : stop.priority === 1 ? 1 : 0),
    stopReserveMin: planningInputs.stopReserveMin,
    travelReservePercent: planningInputs.travelReservePercent,
    ...(stop.requiredSkills?.length
      ? { requiredSkills: stop.requiredSkills }
      : {}),
    ...(stop.requiredCertifications?.length
      ? { requiredCertifications: stop.requiredCertifications }
      : {}),
    ...(stop.requiredEquipment?.length
      ? { requiredEquipment: stop.requiredEquipment }
      : {}),
    ...(stop.pickupAddress &&
    stop.pickupLatitude != null &&
    stop.pickupLongitude != null
      ? {
          pickupLat: stop.pickupLatitude,
          pickupLon: stop.pickupLongitude,
          pickupServiceMin: stop.serviceDurationMin,
        }
      : {}),
    ...(stop.requiredSkills?.length
      ? { requiredSkills: stop.requiredSkills }
      : {}),
    ...(stop.requiredCertifications?.length
      ? { requiredCertifications: stop.requiredCertifications }
      : {}),
    ...(stop.requiredEquipment?.length
      ? { requiredEquipment: stop.requiredEquipment }
      : {}),
  };
}

function calculateRouteMetrics(
  nodes: ALNSNode[],
  vehicle: ALNSVehicle,
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
  driverConstraints?: ALNSDriverConstraints,
) {
  const route: ALNSRoute = {
    vehicleId: vehicle.id,
    nodes,
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
  const evaluation = evaluateRoute(
    route,
    { ...vehicle, rangeKm: null },
    depotLatitude,
    depotLongitude,
    startTime,
    driverConstraints,
  );
  const totalDistanceKm = evaluation.totalDistanceKm;
  const workday = evaluateRouteWorkday(
    nodes,
    vehicle,
    depotLatitude,
    depotLongitude,
    startTime,
    driverConstraints,
  );

  return {
    feasible: evaluation.feasible,
    totalDistanceKm,
    totalDurationMin: workday.summary.totalMin,
    reasonCode: workday.reasonCode,
    workdayReasonCode: workday.reasonCode,
    totalWeightKg: route.totalWeight,
    totalVolumeM3: route.totalVolume,
  };
}

type DiagnosticResource = {
  vehicle: VehicleRow;
  driver: DriverRow;
  routingVehicle: ALNSVehicle;
};

export type RefreshedPlanningSummary = {
  complete: boolean;
  objective: PlanningInputsV1["objective"];
  travelReservePercent: number;
  stopReserveMin: number;
  mandatoryUnplannedStopIds: string[];
  selectedPairValues: string[];
  usedPairValues: string[];
  unusedPairValues: Array<{ pairValue: string; reason: string }>;
  unplanned: Array<{ stopId: string; priority: 0 | 1 | 2; reason: string }>;
  optimizationEvidence?: OptimizationEvidence | null;
};
export function routingConstraintsForDriver(
  driver: typeof driversTable.$inferSelect,
): ALNSDriverConstraints {
  return {
    vehicleId: driver.vehicleId!,
    driverName: driver.name,
    preferredStartTime: driver.workStartTime ?? "07:00:00",
    preferredEndTime: driver.workEndTime ?? "16:00:00",
    maxDrivingHoursPerDay: 8,
    avoidNightDriving: false,
    breakFrequencyMinutes: 120,
    preferredBreakDurationMin: 15,
    breakStartTime: driver.breakStartTime,
    breakEndTime: driver.breakEndTime,
  };
}

export function itineraryForNodes(
  nodes: ALNSNode[],
  vehicle: ALNSVehicle,
  driver: typeof driversTable.$inferSelect,
  depotLatitude: number,
  depotLongitude: number,
  date: Date,
) {
  const stationById = new Map(
    CHARGING_STATIONS.map((station) => [station.id, station]),
  );
  const workday = evaluateRouteWorkday(
    nodes,
    vehicle,
    depotLatitude,
    depotLongitude,
    date,
    routingConstraintsForDriver(driver),
  );
  const scheduledAtByStopId = new Map<string, string>();
  for (const event of workday.events) {
    if (
      event.stopId &&
      (event.type === "service" || event.type === "charging")
    ) {
      // Pickup-and-delivery nodes emit two service events with the same ID.
      // The final event is the delivery represented by the itinerary row.
      scheduledAtByStopId.set(event.stopId, event.startAt);
    }
  }
  let previousLatitude = vehicle.startLatitude ?? depotLatitude;
  let previousLongitude = vehicle.startLongitude ?? depotLongitude;

  return nodes.map((node, index) => {
    const distanceFromPreviousKm = cachedDistance(
      previousLatitude,
      previousLongitude,
      node.latitude,
      node.longitude,
    );
    previousLatitude = node.latitude;
    previousLongitude = node.longitude;
    const station = node.isChargingStation
      ? stationById.get(node.id)
      : undefined;
    if (node.isChargingStation && !station) {
      throw new ImportRouteWorkflowError(
        "Optimeraren returnerade ett okänt laddstopp.",
      );
    }
    const itineraryEntry = {
      stopId: node.id,
      sequenceOrder: index + 1,
      estimatedArrival:
        scheduledAtByStopId.get(node.id) ?? workday.events[0].startAt,
      distanceFromPreviousKm: Math.round(distanceFromPreviousKm * 100) / 100,
      ...(node.isChargingStation
        ? {
            isChargingStop: true,
            chargingStationName: station!.chargingStationName,
          }
        : {}),
    };
    return itineraryEntry;
  });
}

/**
 * ALNS can discard a whole candidate route during its final validation. Before
 * declaring those customer nodes blocked, deterministically try every actual
 * resource and every insertion position under the same hard evaluator.
 */
const UNPLANNED_SEARCH_EXPLANATION =
  "Optimeringen hittade ingen plats för stoppet i den här körningen. Exakt begränsning är inte fastställd. Prova att omfördela stopp eller välja fler resurser.";

export type RoutingObjectiveOptions = {
  /**
   * These are the effective weights used by the ALNS invocation, not the
   * profile/requested weights.  Reinsertion is part of the same optimization
   * and must not silently fall back to the generic ALNS defaults.
   */
  weights?: Partial<OptimizationWeights>;
  /** Alias kept explicit for callers that already name the persisted field. */
  effectiveWeights?: Partial<OptimizationWeights>;
  vehicleDistributionMode?: "balance" | "minimize";
};
function mutateOnlyUnfrozenRoutes<T>(
  result: ReinsertionResult, vehicles: ALNSVehicle[], operation: (fleet: ALNSVehicle[]) => T,
): T {
  const frozen = result.routes.filter(route => route.optimizationFrozen);
  const reserved = new Set(frozen.map(route => route.vehicleId));
  result.routes = result.routes.filter(route => !route.optimizationFrozen);
  try { return operation(vehicles.filter(vehicle => !reserved.has(vehicle.id))); }
  finally { result.routes = [...result.routes, ...frozen]; }
}

export function reinsertUnassignedNodes(...args: Parameters<typeof reinsertUnassignedNodesMutable>): void {
  mutateOnlyUnfrozenRoutes(args[0], args[1], fleet => reinsertUnassignedNodesMutable(
    args[0], fleet, args[2], args[3], args[4], args[5], args[6],
  ));
}
export function admitPrioritizedUnassignedNodes(...args: Parameters<typeof admitPrioritizedUnassignedNodesMutable>): void {
  mutateOnlyUnfrozenRoutes(args[0], args[1], fleet => admitPrioritizedUnassignedNodesMutable(
    args[0], fleet, args[2], args[3], args[4], args[5], args[6],
  ));
}
export function fillExplicitlySelectedEmptyRoutes(...args: Parameters<typeof fillExplicitlySelectedEmptyRoutesMutable>): boolean {
  return mutateOnlyUnfrozenRoutes(args[0], args[1], fleet => fillExplicitlySelectedEmptyRoutesMutable(
    args[0], fleet, args[2], args[3], args[4], args[5], args[6],
  ));
}

function reinsertUnassignedNodesMutable(
  result: ReinsertionResult,
  vehicles: ALNSVehicle[],
  driverConstraints: Map<string, ALNSDriverConstraints>,
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
  options: RoutingObjectiveOptions = {},
): void {
  const weights = completeOptimizationWeights(
    options.weights ?? options.effectiveWeights,
  );
  const vehicleDistributionMode = options.vehicleDistributionMode ?? "minimize";
  const routeByVehicle = new Map(
    result.routes.map((route) => [route.vehicleId, route]),
  );
  for (const vehicle of vehicles) {
    if (!routeByVehicle.has(vehicle.id)) {
      const route = {
        vehicleId: vehicle.id,
        nodes: [],
        totalWeight: 0,
        totalVolume: 0,
      };
      result.routes.push(route);
      routeByVehicle.set(vehicle.id, route);
    }
  }

  const stillUnassigned: ALNSNode[] = [];
  for (const node of [...result.unassigned]
    .filter((item) => !item.isChargingStation)
    .sort(
      (a, b) =>
        (b.planningPriority ?? 0) - (a.planningPriority ?? 0) ||
        a.id.localeCompare(b.id),
    )) {
    let best:
      | {
          route: ALNSRoute;
          nodes: ALNSNode[];
          evaluation: ReturnType<typeof evaluateRoute>;
            objectiveCost: number;
            position: number;
        }
      | undefined;
    for (const vehicle of vehicles) {
      if (vehicle.ineligibleStopIds?.has(node.id)) continue;
      const route = routeByVehicle.get(vehicle.id)!;
      for (let position = 0; position <= route.nodes.length; position++) {
        // A pickup-delivery job is one ALNS node, so this always inserts it
        // atomically and never separates its pickup from its delivery.
        const nodes = [...route.nodes];
        nodes.splice(position, 0, node);
        const totalWeight = nodes.reduce((sum, item) => sum + item.weightKg, 0);
        const totalVolume = nodes.reduce((sum, item) => sum + item.volumeM3, 0);
        if (
          totalWeight > vehicle.capacityKg ||
          totalVolume > vehicle.capacityVolume
        )
          continue;
        const candidate = {
          vehicleId: vehicle.id,
          nodes,
          totalWeight,
          totalVolume,
        };
        let evaluation = evaluateRoute(
          candidate,
          vehicle,
          depotLatitude,
          depotLongitude,
          startTime,
          driverConstraints.get(vehicle.id),
        );
        if (
          !evaluation.feasible &&
          vehicle.vehicleType === "electric" &&
          vehicle.rangeKm != null
        ) {
          // Use ALNS's canonical EV repair on an isolated candidate. The
          // candidate owns its node array, so failed repairs cannot mutate the
          // current accepted route.
          chargingStationInsertion(
            {
              routes: [candidate],
              unassigned: [],
              cost: 0,
              costBreakdown: {
                distanceCost: 0,
                co2Cost: 0,
                etaPrecisionCost: 0,
                driverPenaltyCost: 0,
                geographicCohesionCost: 0,
                totalDistanceKm: 0,
                totalCo2Kg: 0,
                totalTimeWindowSlackMin: 0,
                totalDriverPenalty: 0,
              },
            },
            [vehicle],
            depotLatitude,
            depotLongitude,
            startTime,
            driverConstraints,
          );
          evaluation = evaluateRoute(
            candidate,
            vehicle,
            depotLatitude,
            depotLongitude,
            startTime,
            driverConstraints.get(vehicle.id),
          );
        }
        if (!evaluation.feasible) continue;
        const candidateRoutes = result.routes.map((existingRoute) =>
          existingRoute === route
            ? {
                ...candidate,
                nodes: candidate.nodes,
              }
            : {
                ...existingRoute,
                nodes: [...existingRoute.nodes],
              },
        );
        const candidateCost = objectiveCostForCandidate(
          {
            routes: candidateRoutes,
            unassigned: result.unassigned.filter((item) => item.id !== node.id),
          },
          vehicles,
          driverConstraints,
          depotLatitude,
          depotLongitude,
          startTime,
          weights,
          vehicleDistributionMode,
        );
        if (
          !best ||
          candidateCost < best.objectiveCost ||
          (candidateCost === best.objectiveCost &&
            (evaluation.totalDistanceKm < best.evaluation.totalDistanceKm ||
              (evaluation.totalDistanceKm === best.evaluation.totalDistanceKm &&
                (vehicle.id < best.route.vehicleId ||
                  (vehicle.id === best.route.vehicleId &&
                    position < best.position)))))
        ) {
          best = {
            route,
            nodes: candidate.nodes,
            evaluation,
            objectiveCost: candidateCost,
            position,
          };
        }
      }
    }
    if (!best) {
      stillUnassigned.push(node);
      continue;
    }
    best.route.nodes = best.nodes;
    best.route.totalWeight = best.nodes.reduce(
      (sum, item) => sum + item.weightKg,
      0,
    );
    best.route.totalVolume = best.nodes.reduce(
      (sum, item) => sum + item.volumeM3,
      0,
    );
    result.routeEvaluations.set(best.route.vehicleId, best.evaluation);
  }
  result.unassigned = stillUnassigned;
  repairFleetCoverage(
    result, vehicles, depotLatitude, depotLongitude, startTime, driverConstraints, 750,
  );
  if (result.costBreakdown) {
    refreshOptimizationResult(
      result,
      vehicles,
      driverConstraints,
      depotLatitude,
      depotLongitude,
      startTime,
      options,
    );
  }
}

/**
 * Priority is an admission policy, not merely a cost coefficient. When a
 * Must/High node remains unassigned, deterministically try replacing a lower
 * priority assigned customer and validate the replacement with the same hard
 * insertion evaluator. This is intentionally a one-for-one displacement:
 * capacity, time windows, shift limits and EV feasibility remain hard.
 */
function admitPrioritizedUnassignedNodesMutable(
  result: ReinsertionResult,
  vehicles: ALNSVehicle[],
  driverConstraints: Map<string, ALNSDriverConstraints>,
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
  options: RoutingObjectiveOptions = {},
): void {
  const candidates = [...result.unassigned]
    .filter(
      (node) => !node.isChargingStation && (node.planningPriority ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        (b.planningPriority ?? 0) - (a.planningPriority ?? 0) ||
        a.id.localeCompare(b.id),
    );
  for (const candidate of candidates) {
    if (!result.unassigned.some((node) => node.id === candidate.id)) continue;
    const otherUnassigned = result.unassigned.filter(
      (node) => node.id !== candidate.id,
    );
    const displacedOptions = result.routes
      .flatMap((route) =>
        route.nodes
          .filter(
            (node) =>
              !node.isChargingStation &&
              !hasPlanningLock(node) &&
              (node.planningPriority ?? 0) < (candidate.planningPriority ?? 0),
          )
          .map((node) => ({ route, node })),
      )
      .sort(
        (left, right) =>
          (left.node.planningPriority ?? 0) -
            (right.node.planningPriority ?? 0) ||
          left.node.id.localeCompare(right.node.id) ||
          left.route.vehicleId.localeCompare(right.route.vehicleId),
      );
    for (const { route, node: displaced } of displacedOptions) {
      const originalNodes = route.nodes;
      route.nodes = originalNodes.filter((node) => node !== displaced);
      route.totalWeight = route.nodes.reduce(
        (sum, node) => sum + node.weightKg,
        0,
      );
      route.totalVolume = route.nodes.reduce(
        (sum, node) => sum + node.volumeM3,
        0,
      );
      result.unassigned = [candidate];
      reinsertUnassignedNodes(
        result,
        vehicles,
        driverConstraints,
        depotLatitude,
        depotLongitude,
        startTime,
        options,
      );
      if (!result.unassigned.some((node) => node.id === candidate.id)) {
        result.unassigned = [...otherUnassigned, displaced];
        break;
      }
      route.nodes = originalNodes;
      route.totalWeight = originalNodes.reduce(
        (sum, item) => sum + item.weightKg,
        0,
      );
      route.totalVolume = originalNodes.reduce(
        (sum, item) => sum + item.volumeM3,
        0,
      );
      result.unassigned = [...otherUnassigned, candidate];
    }
  }
}

/**
 * Balance is a preference in ALNS, not an occupancy invariant. For an explicit
 * resource selection, repair empty routes by moving one customer node only when
 * both resulting full routes still pass the canonical hard evaluator. Charging
 * nodes remain with their original route, so this never duplicates or detaches
 * a customer stop from the persisted optimizer itinerary.
 */
function fillExplicitlySelectedEmptyRoutesMutable(
  result: ReinsertionResult,
  vehicles: ALNSVehicle[],
  driverConstraints: Map<string, ALNSDriverConstraints>,
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
  options: RoutingObjectiveOptions = {},
): boolean {
  const weights = completeOptimizationWeights(
    options.weights ?? options.effectiveWeights,
  );
  const vehicleDistributionMode = options.vehicleDistributionMode ?? "balance";
  const routeByVehicle = new Map(
    result.routes.map((route) => [route.vehicleId, route]),
  );
  // ALNS may omit an unused vehicle entirely. Explicitly selected resources
  // are a planning commitment in the default mode, so give the deterministic
  // repair an empty route to fill rather than silently treating that vehicle
  // as unavailable.
  for (const vehicle of vehicles) {
    if (!routeByVehicle.has(vehicle.id)) {
      const route: ALNSRoute = {
        vehicleId: vehicle.id,
        nodes: [],
        totalWeight: 0,
        totalVolume: 0,
      };
      result.routes.push(route);
      routeByVehicle.set(vehicle.id, route);
    }
  }
  for (const targetVehicle of [...vehicles].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const target = routeByVehicle.get(targetVehicle.id);
    if (!target || target.nodes.some((node) => !node.isChargingStation))
      continue;
    let bestMove:
      | {
          donor: ALNSRoute;
          node: ALNSNode;
          targetNodes: ALNSNode[];
          donorNodes: ALNSNode[];
          targetEvaluation: ReturnType<typeof evaluateRoute>;
          donorEvaluation: ReturnType<typeof evaluateRoute>;
          objectiveCost: number;
          distanceKm: number;
          position: number;
        }
      | undefined;
    for (const donorVehicle of [...vehicles].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const donor = routeByVehicle.get(donorVehicle.id);
      if (!donor || donor.vehicleId === target.vehicleId) continue;
      const donorCustomers = donor.nodes.filter(
        (node) => !node.isChargingStation,
      );
      if (donorCustomers.length < 2) continue;
      for (const node of donorCustomers.sort((a, b) =>
        a.id.localeCompare(b.id),
      )) {
        const donorNodes = donor.nodes.filter(
          (candidate) => candidate !== node,
        );
        const donorCandidate = {
          vehicleId: donor.vehicleId,
          nodes: donorNodes,
          totalWeight: donorNodes.reduce((sum, item) => sum + item.weightKg, 0),
          totalVolume: donorNodes.reduce((sum, item) => sum + item.volumeM3, 0),
        };
        const donorEvaluation = evaluateRoute(
          donorCandidate,
          donorVehicle,
          depotLatitude,
          depotLongitude,
          startTime,
          driverConstraints.get(donorVehicle.id),
        );
        if (!donorEvaluation.feasible) continue;
        for (let position = 0; position <= target.nodes.length; position++) {
          const targetNodes = [...target.nodes];
          targetNodes.splice(position, 0, node);
          const targetCandidate = {
            vehicleId: target.vehicleId,
            nodes: targetNodes,
            totalWeight: targetNodes.reduce(
              (sum, item) => sum + item.weightKg,
              0,
            ),
            totalVolume: targetNodes.reduce(
              (sum, item) => sum + item.volumeM3,
              0,
            ),
          };
          const targetEvaluation = evaluateRoute(
            targetCandidate,
            targetVehicle,
            depotLatitude,
            depotLongitude,
            startTime,
            driverConstraints.get(targetVehicle.id),
          );
          if (!targetEvaluation.feasible) continue;
          const candidateRoutes = result.routes.map((existingRoute) =>
            existingRoute === target
              ? targetCandidate
              : existingRoute === donor
                ? donorCandidate
                : {
                    ...existingRoute,
                    nodes: [...existingRoute.nodes],
                  },
          );
          const objectiveCost = objectiveCostForCandidate(
            {
              routes: candidateRoutes,
              unassigned: result.unassigned,
            },
            vehicles,
            driverConstraints,
            depotLatitude,
            depotLongitude,
            startTime,
            weights,
            vehicleDistributionMode,
          );
          const distanceKm =
            targetEvaluation.totalDistanceKm + donorEvaluation.totalDistanceKm;
          if (
            !bestMove ||
            objectiveCost < bestMove.objectiveCost ||
            (objectiveCost === bestMove.objectiveCost &&
              (distanceKm < bestMove.distanceKm ||
                (distanceKm === bestMove.distanceKm &&
                  (donor.vehicleId < bestMove.donor.vehicleId ||
                    (donor.vehicleId === bestMove.donor.vehicleId &&
                      (node.id < bestMove.node.id ||
                        (node.id === bestMove.node.id &&
                          position < bestMove.position)))))))
          ) {
            bestMove = {
              donor,
              node,
              targetNodes,
              donorNodes,
              targetEvaluation,
              donorEvaluation,
              objectiveCost,
              distanceKm,
              position,
            };
          }
        }
      }
    }
    if (!bestMove) return false;
    target.nodes = bestMove.targetNodes;
    target.totalWeight = bestMove.targetNodes.reduce(
      (sum, item) => sum + item.weightKg,
      0,
    );
    target.totalVolume = bestMove.targetNodes.reduce(
      (sum, item) => sum + item.volumeM3,
      0,
    );
    bestMove.donor.nodes = bestMove.donorNodes;
    bestMove.donor.totalWeight = bestMove.donorNodes.reduce(
      (sum, item) => sum + item.weightKg,
      0,
    );
    bestMove.donor.totalVolume = bestMove.donorNodes.reduce(
      (sum, item) => sum + item.volumeM3,
      0,
    );
    result.routeEvaluations.set(target.vehicleId, bestMove.targetEvaluation);
    result.routeEvaluations.set(
      bestMove.donor.vehicleId,
      bestMove.donorEvaluation,
    );
  }
  if (result.costBreakdown) {
    refreshOptimizationResult(
      result,
      vehicles,
      driverConstraints,
      depotLatitude,
      depotLongitude,
      startTime,
      options,
    );
  }
  return true;
}

async function loadAvailableStops(
  organizationId: string,
  stopIds: string[],
): Promise<StopRow[]> {
  const stops = await db
    .select()
    .from(stopsTable)
    .where(
      and(
        inArray(stopsTable.id, stopIds),
        eq(stopsTable.organizationId, organizationId),
      ),
    );

  if (stops.length !== stopIds.length) {
    throw new ImportRouteWorkflowError(
      "Ett eller flera stopp saknas eller tillhör en annan organisation.",
    );
  }
  const archivedStop = stops.find((stop) => stop.archivedAt !== null);
  if (archivedStop) {
    throw new ImportRouteWorkflowError(
      `Stoppet "${archivedStop.address}" är arkiverat och kan inte optimeras.`,
      409,
    );
  }
  const alreadyAssigned = stops.find((stop) => stop.routeId != null);
  if (alreadyAssigned) {
    throw new ImportRouteWorkflowError(
      `Stoppet "${alreadyAssigned.address}" är redan tilldelat till en rutt.`,
    );
  }
  return stops;
}

function trackingCode(): string {
  return `RT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function draftRouteStartAtLabel(startAt: Date): string {
  return startAt.toLocaleString("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function importPlanPayloadIdentity(input: ImportRoutePlanInput): string {
  return payloadIdentityHash({
    stopIds: input.stopIds,
    pairs: input.pairs,
    vehicleDistributionMode: input.vehicleDistributionMode ?? "balance",
    optimizationWeights: input.optimizationWeights ?? null,
    date: input.date.toISOString(),
    depotLatitude: input.depotLatitude,
    depotLongitude: input.depotLongitude,
    planningInputs: input.planningInputs ?? DEFAULT_PLANNING_INPUTS,
    customerReference: input.customerReference ?? null,
    sharedInstructions: input.sharedInstructions ?? null,
  });
}

function reviveStoredPlanResult(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(value)) as Record<string, any>;
  for (const route of result.routes ?? []) {
    if (route.depotSnapshot) {
      route.depotSnapshot.start.verifiedAt = new Date(
        route.depotSnapshot.start.verifiedAt,
      );
      route.depotSnapshot.end.verifiedAt = new Date(
        route.depotSnapshot.end.verifiedAt,
      );
    }
    for (const event of route.workdayTimeline ?? []) {
      event.startAt = new Date(event.startAt);
      event.endAt = new Date(event.endAt);
    }
    if (route.workdaySummary?.shiftEndAt) {
      route.workdaySummary.shiftEndAt = new Date(
        route.workdaySummary.shiftEndAt,
      );
    }
  }
  return result;
}

type StoredPlanRecovery = Omit<
  NonNullable<ImportPlanServiceTimeReoptimizationInput["recovery"]>,
  "planDate" | "identityHash"
> & {
  planDate: Date;
};

function recoveryFromStoredPlanResult(
  value: Record<string, unknown> | null | undefined,
): StoredPlanRecovery {
  const candidate = value?.recovery;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ImportRouteWorkflowError(
      "Planen saknar ett verifierbart återställningsunderlag.",
      409,
    );
  }
  const recovery = candidate as Record<string, unknown>;
  const planDate =
    typeof recovery.planDate === "string" ? new Date(recovery.planDate) : null;
  const pairValue = /^[0-9a-f-]{36}:[0-9a-f-]{36}$/i;
  const stopId = /^[0-9a-f-]{36}$/i;
  if (
    !planDate ||
    Number.isNaN(planDate.getTime()) ||
    !Array.isArray(recovery.selectedPairValues) ||
    recovery.selectedPairValues.length === 0 ||
    recovery.selectedPairValues.some(
      (value) => typeof value !== "string" || !pairValue.test(value),
    ) ||
    new Set(recovery.selectedPairValues).size !==
      recovery.selectedPairValues.length ||
    !Array.isArray(recovery.stopIds) ||
    recovery.stopIds.length === 0 ||
    recovery.stopIds.some(
      (value) => typeof value !== "string" || !stopId.test(value),
    ) ||
    new Set(recovery.stopIds).size !== recovery.stopIds.length ||
    !Number.isFinite(recovery.depotLatitude) ||
    !Number.isFinite(recovery.depotLongitude) ||
    !isValidCoordinate(
      recovery.depotLatitude as number,
      recovery.depotLongitude as number,
    ) ||
    !Number.isFinite(recovery.baseDepotLatitude) ||
    !Number.isFinite(recovery.baseDepotLongitude) ||
    !isValidCoordinate(
      recovery.baseDepotLatitude as number,
      recovery.baseDepotLongitude as number,
    ) ||
    !recovery.depotSnapshots ||
    typeof recovery.depotSnapshots !== "object" ||
    Array.isArray(recovery.depotSnapshots) ||
    recovery.selectedPairValues.some(
      (value) =>
        !Object.prototype.hasOwnProperty.call(recovery.depotSnapshots, value),
    ) ||
    Object.keys(recovery.depotSnapshots).some(
      (key) =>
        !pairValue.test(key) ||
        !isStoredDepotSnapshot(
          (recovery.depotSnapshots as Record<string, unknown>)[key],
        ),
    ) ||
    !recovery.baseDepotSnapshots ||
    typeof recovery.baseDepotSnapshots !== "object" ||
    Array.isArray(recovery.baseDepotSnapshots) ||
    recovery.selectedPairValues.some(
      (value) =>
        !Object.prototype.hasOwnProperty.call(
          recovery.baseDepotSnapshots,
          value,
        ),
    ) ||
    Object.keys(recovery.baseDepotSnapshots).some(
      (key) =>
        !pairValue.test(key) ||
        !isStoredDepotSnapshot(
          (recovery.baseDepotSnapshots as Record<string, unknown>)[key],
        ),
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Planens sparade återställningsunderlag är ogiltigt.",
      409,
    );
  }
  return {
    planDate,
    stopIds: [...recovery.stopIds] as string[],
    selectedPairValues: [...recovery.selectedPairValues] as string[],
    depotLatitude: recovery.depotLatitude as number,
    depotLongitude: recovery.depotLongitude as number,
    depotSnapshots:
      recovery.depotSnapshots as StoredPlanRecovery["depotSnapshots"],
    baseDepotLatitude: recovery.baseDepotLatitude as number,
    baseDepotLongitude: recovery.baseDepotLongitude as number,
    baseDepotSnapshots:
      recovery.baseDepotSnapshots as StoredPlanRecovery["baseDepotSnapshots"],
    customerReference:
      typeof recovery.customerReference === "string"
        ? recovery.customerReference
        : null,
  };
}

function isStoredDepotSnapshot(
  value: unknown,
): value is NonNullable<typeof routesTable.$inferSelect.depotSnapshot> | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const validPoint = (point: unknown) => {
    if (!point || typeof point !== "object" || Array.isArray(point))
      return false;
    const candidate = point as Record<string, unknown>;
    return (
      typeof candidate.address === "string" &&
      typeof candidate.latitude === "number" &&
      typeof candidate.longitude === "number" &&
      isValidCoordinate(candidate.latitude, candidate.longitude) &&
      typeof candidate.verifiedAt === "string" &&
      !Number.isNaN(Date.parse(candidate.verifiedAt))
    );
  };
  return validPoint(snapshot.start) && validPoint(snapshot.end);
}

async function currentPlanResult(
  organizationId: string,
  planId: string,
  storedResult: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [routes, stops] = await Promise.all([
    db
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.planId, planId),
          ne(routesTable.status, "cancelled"),
        ),
      )
      .orderBy(routesTable.id),
    db
      .select({
        id: stopsTable.id,
        routeId: stopsTable.routeId,
        unplannedReason: stopsTable.unplannedReason,
        archivedAt: stopsTable.archivedAt,
      })
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.planningPlanId, planId),
        ),
      ),
  ]);
  // A draft replay must hydrate the plan's live route set, not historical
  // route rows retained by resource replanning.
  if (stops.some((stop) => stop.archivedAt !== null)) {
    throw new ImportRouteWorkflowError(
      "The stored plan references archived stops and must be reconciled before replay.",
      409,
    );
  }
  const currentRoutes = routes.filter((route) => route.status !== "cancelled");
  const vehicleIds = currentRoutes
    .map((route) => route.vehicleId)
    .filter((id): id is string => Boolean(id));
  const drivers =
    vehicleIds.length === 0
      ? []
      : await db
          .select({
            id: driversTable.id,
            vehicleId: driversTable.vehicleId,
            isActive: driversTable.isActive,
          })
          .from(driversTable)
          .where(
            and(
              eq(driversTable.organizationId, organizationId),
              inArray(driversTable.vehicleId, vehicleIds),
            ),
          );
  const stored = reviveStoredPlanResult(storedResult);
  const storedRoutes = new Map(
    ((stored.routes as Array<Record<string, any>> | undefined) ?? []).map(
      (route) => [route.routeId, route],
    ),
  );
  const releasedStopIds = Array.isArray(stored.releasedStopIds)
    ? stored.releasedStopIds.filter(
        (stopId): stopId is string => typeof stopId === "string",
      )
    : [];
  return {
    ...stored,
    planId,
    planningSummary: planningSummaryForResponse(
      currentRoutes[0]?.planningSummary ?? stored.planningSummary,
    ),
    routes: currentRoutes.map((route) => {
      const fallback = storedRoutes.get(route.id);
      const routeDrivers = drivers.filter(
        (driver) => driver.vehicleId === route.vehicleId,
      );
      const resolvedDriver = resolveDriverForRoute(
        route,
        routeDrivers,
        optimizationDriverIdForRoute(route) ? undefined : fallback?.driverId,
      );
      const driverId = resolvedDriver?.id;
      if (route.draftId) {
        if (!resolvedDriver?.isActive) {
          throw new ImportRouteWorkflowError(
            `The protected route ${route.id} no longer has its optimization-selected driver.`,
            409,
          );
        }
      }
      return {
        routeId: route.id,
        planId: route.planId,
        name: route.name,
        vehicleId: route.vehicleId,
        driverId,
        stopCount: route.totalStops,
        totalDistanceKm: route.totalDistanceKm ?? 0,
        totalDurationMin: route.totalDurationMin ?? 0,
        planRevision: route.planRevision,
        status: "optimized" as const,
        depotSnapshot: depotSnapshotForResponse(route.depotSnapshot),
        workdayTimeline: workdayTimelineForResponse(route.workdayTimeline),
        workdaySummary: workdaySummaryForResponse(route.workdaySummary),
        geographicOverlapExplanation: route.geographicOverlapExplanation,
      };
    }),
    unassignedStopIds: [
      ...new Set([
        ...stops.filter((stop) => stop.routeId == null).map((stop) => stop.id),
        ...releasedStopIds,
      ]),
    ],
    diagnostics: stored.diagnostics ?? [],
  };
}

function effectiveRangeKm(vehicle: VehicleRow): number | null {
  if (vehicle.vehicleType !== "electric" || vehicle.rangeKm == null)
    return null;
  const batteryFactor =
    vehicle.currentBatteryPercent == null
      ? 1
      : Math.max(0, Math.min(100, vehicle.currentBatteryPercent)) / 100;
  return vehicle.rangeKm * batteryFactor;
}

type ImportProgressPhase =
  | "preparing"
  | "distance_matrix"
  | "clustering"
  | "optimizing"
  | "merging"
  | "saving"
  | "complete";
type ImportProgressStatus = "running" | "complete" | "error";

type ImportProgressReporter = {
  phase: (phase: ImportProgressPhase) => Promise<void>;
  completeInPersistence: (
    executor: any,
    result: Record<string, unknown>,
  ) => Promise<void>;
  reportOptimization: (value: {
    totalClusters: number;
    completedClusters: number;
    phase: ImportProgressPhase;
    elapsedMs: number;
    iterations: number;
    improvements: number;
    stopReason: string | null;
    clusterStopReasons: Record<string, number>;
  }) => void;
};

const importProgressPhaseRank: Record<ImportProgressPhase, number> = {
  preparing: 0,
  distance_matrix: 1,
  clustering: 2,
  optimizing: 3,
  merging: 4,
  saving: 5,
  complete: 6,
};

function createImportProgressReporter(
  progressId: string,
  organizationId: string,
): ImportProgressReporter & {
  complete: (result: Record<string, unknown>) => Promise<void>;
  fail: (error: unknown) => Promise<void>;
} {
  const startedAt = new Date();
  let currentPhase: ImportProgressPhase = "preparing";
  let currentPhaseRank = importProgressPhaseRank.preparing;
  let latestProgress: Record<string, unknown> = {
    phaseUpdatedAt: startedAt.toISOString(),
  };
  let lastSample:
    | { phase: ImportProgressPhase; totalClusters: number; fraction: number; at: number }
    | undefined;
  let estimatedRemainingMs: number | null = null;
  let terminal = false;
  let queue = Promise.resolve();
  const enqueue = (operation: () => Promise<void>, wait = false) => {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return wait ? next : Promise.resolve();
  };
  const write = (values: Record<string, unknown>) =>
    enqueue(async () => {
      if (terminal && values.status !== "complete" && values.status !== "error")
        return;
      await db
        .update(importPlanProgressTable)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(importPlanProgressTable.id, progressId),
            eq(importPlanProgressTable.organizationId, organizationId),
            eq(importPlanProgressTable.status, "running"),
          ),
        );
    });
  const phase = async (nextPhase: ImportProgressPhase) => {
    if (terminal) return;
    if (importProgressPhaseRank[nextPhase] < currentPhaseRank) return;
    currentPhaseRank = importProgressPhaseRank[nextPhase];
    currentPhase = nextPhase;
    estimatedRemainingMs = null;
    latestProgress = {
      ...latestProgress,
      phaseUpdatedAt: new Date().toISOString(),
    };
    await write({
      phase: nextPhase,
      progress: latestProgress,
      estimatedRemainingMs: null,
    });
  };
  const reportOptimization = (value: {
    totalClusters: number;
    completedClusters: number;
    phase: ImportProgressPhase;
    elapsedMs: number;
    iterations: number;
    improvements: number;
    stopReason: string | null;
    clusterStopReasons: Record<string, number>;
  }) => {
    if (terminal) return;
    if (importProgressPhaseRank[value.phase] < currentPhaseRank) return;
    currentPhaseRank = importProgressPhaseRank[value.phase];
    currentPhase = value.phase;
    latestProgress = {
      ...value,
      phaseUpdatedAt: new Date().toISOString(),
    };
    // Heartbeats are never samples. An ETA is emitted only after two measured
    // cluster advances, and is capped to a conservative bounded search window.
    if (
      value.phase === "optimizing" &&
      value.totalClusters > 0 &&
      value.completedClusters < value.totalClusters
    ) {
      const fraction = value.completedClusters / value.totalClusters;
      const now = Date.now();
      if (lastSample?.totalClusters !== value.totalClusters) {
        lastSample = undefined;
      }
      // ALNS reports iterations frequently while a cluster is being searched.
      // Do not replace the timing baseline for those unchanged-fraction
      // samples: ETA is based on actual completed-cluster advances only.
      if (!lastSample) {
        lastSample = {
          phase: value.phase,
          totalClusters: value.totalClusters,
          fraction,
          at: now,
        };
      } else if (
        fraction > lastSample.fraction &&
        now - lastSample.at >= 1000
      ) {
        const rate = (fraction - lastSample.fraction) / (now - lastSample.at);
        estimatedRemainingMs = Math.min(
          30 * 60_000,
          Math.max(1000, Math.ceil((1 - fraction) / rate)),
        );
        lastSample = {
          phase: value.phase,
          totalClusters: value.totalClusters,
          fraction,
          at: now,
        };
      } else if (fraction > lastSample.fraction) {
        lastSample = {
          phase: value.phase,
          totalClusters: value.totalClusters,
          fraction,
          at: now,
        };
      }
    } else {
      estimatedRemainingMs = null;
      lastSample = undefined;
    }
    void write({
      phase: value.phase,
      progress: latestProgress,
      estimatedRemainingMs,
    });
  };
  const heartbeat = setInterval(() => {
    if (!terminal)
      void write({
        phase: currentPhase,
        progress: latestProgress,
        estimatedRemainingMs,
      });
  }, 5000);
  heartbeat.unref?.();
  return {
    phase,
    reportOptimization,
    completeInPersistence: async (executor: any, result) => {
      await executor
        .update(importPlanProgressTable)
        .set({
          status: "complete",
          phase: "complete",
          progress: latestProgress,
          estimatedRemainingMs: null,
          planId: typeof result.planId === "string" ? result.planId : null,
          result,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(importPlanProgressTable.id, progressId),
            eq(importPlanProgressTable.organizationId, organizationId),
            eq(importPlanProgressTable.status, "running"),
          ),
        );
    },
    complete: async (result) => {
      if (terminal) return;
      terminal = true;
      clearInterval(heartbeat);
      await enqueue(
        async () => {
          await db
            .update(importPlanProgressTable)
            .set({
              status: "complete",
              phase: "complete",
              progress: latestProgress,
              estimatedRemainingMs: null,
              planId: typeof result.planId === "string" ? result.planId : null,
              result,
              error: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(importPlanProgressTable.id, progressId),
                eq(importPlanProgressTable.organizationId, organizationId),
                eq(importPlanProgressTable.status, "running"),
              ),
            );
        },
        true,
      );
    },
    fail: async (failure) => {
      if (terminal) return;
      terminal = true;
      clearInterval(heartbeat);
      const workflowError =
        failure instanceof ImportRouteWorkflowError ? failure : undefined;
      const error = {
        code: workflowError?.code ?? (failure instanceof RoadDataUnavailableError
          ? failure.code : "IMPORT_ROUTE_PLAN_FAILED"),
        message:
          failure instanceof Error ? failure.message : "Importen misslyckades.",
        ...(workflowError?.details !== undefined
          ? { details: workflowError.details }
          : {}),
      };
      await enqueue(
        async () => {
          await db
            .update(importPlanProgressTable)
            .set({
              status: "error",
              error,
              estimatedRemainingMs: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(importPlanProgressTable.id, progressId),
                eq(importPlanProgressTable.organizationId, organizationId),
                eq(importPlanProgressTable.status, "running"),
              ),
            );
        },
        true,
      );
    },
  };
}

export function createImportProgressReporterForTest(
  progressId: string,
  organizationId: string,
) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Import progress test helper is only available in tests.");
  }
  return createImportProgressReporter(progressId, organizationId);
}

async function registerImportProgress(
  organizationId: string,
  progressId: string,
  draftId?: string,
) {
  // Terminal telemetry is intentionally short-lived: it exists to recover a
  // lost POST response, not to become a second copy of every plan forever.
  // Never delete running rows here; a slow optimizer must remain observable.
  void db
    .delete(importPlanProgressTable)
    .where(
      and(
        ne(importPlanProgressTable.status, "running"),
        lt(importPlanProgressTable.updatedAt, new Date(Date.now() - 7 * 86400000)),
      ),
    )
    .catch(() => undefined);
  const [existing] = await db
    .select({ id: importPlanProgressTable.id })
    .from(importPlanProgressTable)
    .where(eq(importPlanProgressTable.id, progressId))
    .limit(1);
  if (existing) {
    throw new ImportRouteWorkflowError(
      "Det angivna progressId används redan.",
      409,
      "PROGRESS_ID_ALREADY_USED",
    );
  }
  const [draft] = draftId
    ? await db
        .select({ id: planningDraftsTable.id })
        .from(planningDraftsTable)
        .where(
          and(
            eq(planningDraftsTable.id, draftId),
            eq(planningDraftsTable.organizationId, organizationId),
          ),
        )
        .limit(1)
    : [];
  const startedAt = new Date();
  const [inserted] = await db
    .insert(importPlanProgressTable)
    .values({
    id: progressId,
    organizationId,
    draftId: draft?.id ?? null,
    status: "running",
    phase: "preparing",
    startedAt,
    updatedAt: startedAt,
    progress: { phaseUpdatedAt: startedAt.toISOString() },
    estimatedRemainingMs: null,
    planId: null,
    error: null,
    result: null,
    })
    .onConflictDoNothing({ target: importPlanProgressTable.id })
    .returning({ id: importPlanProgressTable.id });
  if (!inserted) {
    throw new ImportRouteWorkflowError(
      "Det angivna progressId används redan.",
      409,
      "PROGRESS_ID_ALREADY_USED",
    );
  }
}

export async function getImportRoutePlanProgress(
  organizationId: string,
  progressId: string,
) {
  const [row] = await db
    .select()
    .from(importPlanProgressTable)
    .where(
      and(
        eq(importPlanProgressTable.id, progressId),
        eq(importPlanProgressTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (
    row.status !== "running" &&
    row.updatedAt.getTime() < Date.now() - 7 * 86400000
  ) {
    void db
      .delete(importPlanProgressTable)
      .where(
        and(
          eq(importPlanProgressTable.id, progressId),
          eq(importPlanProgressTable.organizationId, organizationId),
          ne(importPlanProgressTable.status, "running"),
        ),
      )
      .catch(() => undefined);
    return null;
  }
  const serverNow = new Date();
  const interrupted = row.status === "running" &&
    serverNow.getTime() - row.updatedAt.getTime() > 120_000;
  const elapsedEnd =
    row.status === "running" ? serverNow.getTime() : row.updatedAt.getTime();
  return {
    progressId: row.id,
    draftId: row.draftId,
    status: (interrupted ? "error" : row.status) as ImportProgressStatus,
    phase: row.phase as ImportProgressPhase,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    serverNow,
    elapsedMs: Math.max(0, elapsedEnd - row.startedAt.getTime()),
    progress: row.progress,
    estimatedRemainingMs: row.estimatedRemainingMs,
    planId: row.planId,
    error: interrupted ? {
      code: "PLANNING_INTERRUPTED",
      message: "Planeringen avbröts eller tappade kontakten med servern. Ladda om och kontrollera sparade rutter innan du startar en ny planering.",
    } : row.error,
    result: row.result ? reviveStoredPlanResult(row.result) : null,
  };
}

  /**
   * The combined import endpoint intentionally does not accept geographic proposal
   * IDs or signed proposal tokens. It plans the requested, still-unplanned stops
   * against the actual selected resources in one operation.
   */
async function createImportRoutePlanCore(
    organizationId: string,
    input: ImportRoutePlanInput,
    progress?: ImportProgressReporter,
  ) {
    assertOperationalRoadProvider();
    const hasExplicitPlanningInputs = input.planningInputs != null;
    const planningInputs = normalizePlanningInputs(input.planningInputs);
    const originallySelectedPairValues = input.pairs.map(
      (pair) => `${pair.vehicleId}:${pair.driverId}`,
    );
    if (
      input.customerReference != null &&
      (typeof input.customerReference !== "string" ||
        input.customerReference.trim().length > 200)
    ) {
      throw new ImportRouteWorkflowError(
        "Kund- eller uppdragsreferensen får vara högst 200 tecken.",
      );
    }
    if (
      input.sharedInstructions != null &&
      (typeof input.sharedInstructions !== "string" ||
        input.sharedInstructions.trim().length > 4000)
    ) {
      throw new ImportRouteWorkflowError(
        "Gemensam chaufförsinstruktion får vara högst 4000 tecken.",
      );
    }
    input.customerReference = input.customerReference?.trim() || null;
    input.sharedInstructions = input.sharedInstructions?.trim() || null;
    input.planningInputs = planningInputs;
    if (
      Object.keys(planningInputs.stopPriorities).some(
        (stopId) => !input.stopIds.includes(stopId),
      )
    ) {
      throw new ImportRouteWorkflowError(
        "En stoppprioritet avser inte ett valt stopp.",
      );
    }
    input.pairs = input.pairs.filter(
      (pair) =>
        !planningInputs.excludedPairValues.includes(
          `${pair.vehicleId}:${pair.driverId}`,
        ),
    );
    if (input.pairs.length === 0) {
      throw new ImportRouteWorkflowError(
        "Minst ett aktivt bil–chaufförspar måste återstå efter dagens undantag.",
      );
    }
    if (
      planningInputs.depotOverride?.scope === "pair" &&
      !input.pairs.some(
        (pair) => pair.vehicleId === planningInputs.depotOverride?.vehicleId,
      )
    ) {
      throw new ImportRouteWorkflowError(
        "Depåundantaget måste peka på ett aktivt valt fordon.",
      );
    }
    input.vehicleDistributionMode =
      planningInputs.vehicleSelectionMode === "minimize_vehicles"
        ? "minimize"
        : "balance";
    if (new Set(input.stopIds).size !== input.stopIds.length) {
      throw new ImportRouteWorkflowError(
        "Ett stopp får bara förekomma en gång i planeringsunderlaget.",
      );
    }
    const vehicleIds = input.pairs.map((pair) => pair.vehicleId);
    const driverIds = input.pairs.map((pair) => pair.driverId);
    if (new Set(vehicleIds).size !== vehicleIds.length) {
      throw new ImportRouteWorkflowError(
        "Samma bil kan inte användas i flera valda bil–chaufförspar.",
      );
    }
    if (new Set(driverIds).size !== driverIds.length) {
      throw new ImportRouteWorkflowError(
        "Samma chaufför kan inte användas i flera valda bil–chaufförspar.",
      );
    }

    // Capture the request intent before applying any organization-owned depot
    // override. A retry after a lost response must identify the same request
    // even when the provider or current depot settings have changed.
    const planPayloadHash = input.draftId
      ? importPlanPayloadIdentity(input)
      : null;
    if (input.draftId) {
      const [identityOrganization] = await db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId));
      if (
        identityOrganization?.depotStartVerifiedAt &&
        identityOrganization.depotEndVerifiedAt &&
        identityOrganization.depotStartLatitude != null &&
        identityOrganization.depotStartLongitude != null &&
        identityOrganization.depotEndLatitude != null &&
        identityOrganization.depotEndLongitude != null
      ) {
        input.depotLatitude = identityOrganization.depotStartLatitude;
        input.depotLongitude = identityOrganization.depotStartLongitude;
      }
    }
    if (input.draftId) {
      const [draft] = await db
        .select()
        .from(planningDraftsTable)
        .where(
          and(
            eq(planningDraftsTable.id, input.draftId),
            eq(planningDraftsTable.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!draft) {
        throw new PlanningDraftError(
          "Planning draft not found.",
          404,
          "DRAFT_NOT_FOUND",
        );
      }
      if (draft.startAt.getTime() !== input.date.getTime()) {
        throw new PlanningDraftError(
          "The route plan date must match the planning draft startAt.",
          409,
          "DRAFT_START_AT_CONFLICT",
        );
      }
      if (draft.planPayloadHash) {
        if (draft.planPayloadHash !== planPayloadHash) {
          throw new PlanningDraftError(
            "This planning draft already has a different route plan request.",
            409,
            "DRAFT_PLAN_CONFLICT",
          );
        }
        if (!draft.planResult) {
          throw new PlanningDraftError(
            "The planning draft has an incomplete route plan result. Try again.",
            409,
            "DRAFT_PLAN_INCOMPLETE",
          );
        }
        if (!draft.planId) {
          throw new PlanningDraftError(
            "The planning draft has an incomplete route plan identity. Try again.",
            409,
            "DRAFT_PLAN_INCOMPLETE",
          );
        }
        return currentPlanResult(
          organizationId,
          draft.planId,
          draft.planResult,
        );
      }
      if (draft.planId) {
        throw new PlanningDraftError(
          "This planning draft already has a route plan.",
          409,
          "DRAFT_PLAN_INCOMPLETE",
        );
      }
    }

    const [stops, vehicles, drivers, organizations, driverCertifications] =
      await Promise.all([
        loadAvailableStops(organizationId, input.stopIds),
        db
          .select()
          .from(vehiclesTable)
          .where(
            and(
              inArray(vehiclesTable.id, vehicleIds),
              eq(vehiclesTable.organizationId, organizationId),
            ),
          ),
        db
          .select()
          .from(driversTable)
          .where(
            and(
              inArray(driversTable.id, driverIds),
              eq(driversTable.organizationId, organizationId),
            ),
          ),
        db
          .select()
          .from(organizationsTable)
          .where(eq(organizationsTable.id, organizationId)),
        db
          .select()
          .from(driverCertificationsTable)
          .where(
            and(
              eq(driverCertificationsTable.organizationId, organizationId),
              inArray(driverCertificationsTable.driverId, driverIds),
            ),
          )
          .orderBy(driverCertificationsTable.id),
      ]);
    const organization = organizations[0];
    // Persist a complete effective priority map. An omitted request value means
    // the stop's existing priority; an explicit 0 remains an explicit Normal.
    Object.assign(
      planningInputs,
      effectivePlanningInputsForStops(planningInputs, stops),
    );
    const orgDepotConfigured =
      organization?.depotStartVerifiedAt &&
      organization.depotEndVerifiedAt &&
      organization.depotStartLatitude != null &&
      organization.depotStartLongitude != null &&
      organization.depotEndLatitude != null &&
      organization.depotEndLongitude != null;
    // Keep the unmodified operational base separately from any temporary
    // planning override. `input.depotLatitude` is later changed for a plan
    // override and route.depotSnapshot stores the effective value.
    const baseDepotSnapshot = orgDepotConfigured
      ? verifiedDepotSnapshot(organization)
      : null;
    const baseDepotLatitude =
      baseDepotSnapshot?.start.latitude ?? input.depotLatitude;
    const baseDepotLongitude =
      baseDepotSnapshot?.start.longitude ?? input.depotLongitude;
    const overrideSourceRoutes =
      planningInputs.depotOverride?.verifiedDepotId.startsWith("route:")
        ? await db
            .select({
              id: routesTable.id,
              depotSnapshot: routesTable.depotSnapshot,
            })
            .from(routesTable)
            .where(
              and(
                eq(routesTable.organizationId, organizationId),
                eq(
                  routesTable.id,
                  planningInputs.depotOverride.verifiedDepotId.slice(
                    "route:".length,
                  ),
                ),
              ),
            )
        : [];
    const overrideDepotSnapshot = verifiedDepotOverrideSnapshot(
      planningInputs.depotOverride,
      organization,
      overrideSourceRoutes,
    );
    if (planningInputs.depotOverride && !overrideDepotSnapshot) {
      throw new ImportRouteWorkflowError(
        "Dagens depåundantag måste välja en verifierad depå som tillhör organisationen.",
      );
    }
    if (
      planningInputs.depotOverride?.scope === "plan" &&
      overrideDepotSnapshot
    ) {
      input.depotLatitude = overrideDepotSnapshot.start.latitude;
      input.depotLongitude = overrideDepotSnapshot.start.longitude;
    } else if (orgDepotConfigured) {
      // Never allow an import caller or driver profile to substitute an
      // organization-verified operational depot.
      input.depotLatitude = organization.depotStartLatitude!;
      input.depotLongitude = organization.depotStartLongitude!;
    }
    if (
      vehicles.length !== vehicleIds.length ||
      drivers.length !== driverIds.length
    ) {
      throw new ImportRouteWorkflowError(
        "En vald bil eller chaufför saknas eller tillhör en annan organisation.",
      );
    }

    const vehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle]),
    );
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
    const resources = input.pairs.map((pair) => {
      const vehicle = vehicleById.get(pair.vehicleId);
      const driver = driverById.get(pair.driverId);
      if (!vehicle || !driver || !vehicle.isActive || !driver.isActive) {
        throw new ImportRouteWorkflowError(
          "Alla valda bilar och chaufförer måste vara aktiva.",
        );
      }
      if (driver.vehicleId !== vehicle.id) {
        throw new ImportRouteWorkflowError(
          `${driver.name} är inte kopplad till bilen ${vehicle.name}.`,
        );
      }
      const appliesDepotOverride =
        planningInputs.depotOverride?.scope === "plan" ||
        (planningInputs.depotOverride?.scope === "pair" &&
          planningInputs.depotOverride.vehicleId === vehicle.id);
      const resourceDepot = appliesDepotOverride
        ? overrideDepotSnapshot
        : orgDepotConfigured
          ? verifiedDepotSnapshot(organization)
          : undefined;
      const routingVehicle = applyDriverRoutingProfile(
        {
          id: vehicle.id,
          vehicleType: vehicle.vehicleType,
          capacityKg: vehicle.capacityKg,
          capacityVolume: vehicle.capacityVolume,
          rangeKm: effectiveRangeKm(vehicle),
          ...(resourceDepot
            ? {
                startLatitude: resourceDepot.start.latitude,
                startLongitude: resourceDepot.start.longitude,
                endLatitude: resourceDepot.end.latitude,
                endLongitude: resourceDepot.end.longitude,
              }
            : {}),
        },
        driver,
      );
      if (resourceDepot) {
        routingVehicle.startLatitude = resourceDepot.start.latitude;
        routingVehicle.startLongitude = resourceDepot.start.longitude;
        routingVehicle.endLatitude = resourceDepot.end.latitude;
        routingVehicle.endLongitude = resourceDepot.end.longitude;
      }
      routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
      return {
        vehicle,
        driver,
        routingVehicle,
        depotSnapshot: resourceDepot ?? null,
      };
    });

    // Reject an already-booked vehicle before any routing/optimization work.
    // This is deliberately organization-scoped and only considers routes that
    // have stops; empty orphan routes remain the transaction's responsibility.
    const earlyBookingConflicts = await findVehicleBookingConflicts(
      db,
      organizationId,
      vehicleIds,
      input.date,
      new Map(resources.map(({ vehicle }) => [vehicle.id, vehicle.name])),
    );
    if (earlyBookingConflicts.length > 0) {
      throw vehicleAlreadyPlannedError(earlyBookingConflicts);
    }

    // Make field-service eligibility a hard optimizer constraint for every real
    // pair, rather than discovering an invalid assignment after optimization.
    await Promise.all(
      resources.map(async (resource) => {
        const ineligibleStopIds = new Set<string>();
        for (const stop of stops) {
          if (stop.jobType !== "field_service") continue;
          try {
            await assertDriverEligibleForFieldService(
              resource.driver.id,
              resource.vehicle.id,
              fieldServiceRequirementsFromStop(stop),
              input.date,
            );
          } catch {
            ineligibleStopIds.add(stop.id);
          }
        }
        resource.routingVehicle.ineligibleStopIds = ineligibleStopIds;
      }),
    );

    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    const planningNodes = stops.map((stop) => toAlnsNode(stop, planningInputs));
    const routingObjective = {
      weights: {
        ...DEFAULT_WEIGHTS,
        ...planningWeights(planningInputs),
        ...input.optimizationWeights,
        ...(hasExplicitPlanningInputs ? planningWeights(planningInputs) : {}),
      },
      vehicleDistributionMode: hasExplicitPlanningInputs
        ? (planningInputs.vehicleSelectionMode === "minimize_vehicles" ? "minimize" : "balance")
        : (input.vehicleDistributionMode ?? "balance"),
    } as const;
    await importPlanBeforeOptimizeHook?.();
    let result = await optimizeWithALNS(
      planningNodes,
      resources.map((resource) => resource.routingVehicle),
      input.depotLatitude,
      input.depotLongitude,
      input.date,
      {
        ...policyToALNSConfig(resolveOptimizationPolicy(stops.length, 12_000)),
        timeLimitMs: 12_000,
        ...routingObjective,
        driverConstraints: resources.map((resource) =>
          routingConstraintsForDriver(resource.driver),
        ),
      },
      progress
        ? (value) =>
            progress.reportOptimization({
              ...value,
              phase: value.phase === "complete" ? "merging" : value.phase,
              clusterStopReasons: value.clusterStopReasons as Record<
                string,
                number
              >,
            })
        : undefined,
    );
    const constraintsByVehicle = new Map(
      resources.map((resource) => [
        resource.routingVehicle.id,
        routingConstraintsForDriver(resource.driver),
      ]),
    );
    reinsertUnassignedNodes(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraintsByVehicle,
      input.depotLatitude,
      input.depotLongitude,
      input.date,
      routingObjective,
    );
    admitPrioritizedUnassignedNodes(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraintsByVehicle,
      input.depotLatitude,
      input.depotLongitude,
      input.date,
      routingObjective,
    );
    // Selected pairs are commitments by default. The deterministic repair uses
    // the same hard evaluator; when a pair cannot be given work it remains
    // visible as unused rather than silently becoming an optimizer candidate.
    if (planningInputs.vehicleSelectionMode === "use_all_selected_pairs") {
      fillExplicitlySelectedEmptyRoutes(
        result,
        resources.map((resource) => resource.routingVehicle),
        constraintsByVehicle,
        input.depotLatitude,
        input.depotLongitude,
        input.date,
        routingObjective,
      );
    }

    result = result.routes.some(route => route.optimizationFrozen || route.nodes.some(hasPlanningLock))
      ? result : await recoverPlanningCoverage(result, {
      organizationId, nodes: planningNodes,
      vehicles: resources.map(resource => resource.routingVehicle),
      constraints: constraintsByVehicle,
      depotLatitude: input.depotLatitude, depotLongitude: input.depotLongitude,
      start: input.date, ...routingObjective,
      repairIncumbent: candidate => {
        const fleet = resources.map(resource => resource.routingVehicle);
        reinsertUnassignedNodes(candidate, fleet, constraintsByVehicle, input.depotLatitude, input.depotLongitude, input.date, routingObjective);
        admitPrioritizedUnassignedNodes(candidate, fleet, constraintsByVehicle, input.depotLatitude, input.depotLongitude, input.date, routingObjective);
        if (planningInputs.vehicleSelectionMode === "use_all_selected_pairs") {
          fillExplicitlySelectedEmptyRoutes(candidate, fleet, constraintsByVehicle, input.depotLatitude, input.depotLongitude, input.date, routingObjective);
        }
      },
    });

    const unassignedStopIds = Array.from(
      new Set(
        result.unassigned
          .filter((node) => !node.isChargingStation)
          .map((node) => node.id),
      ),
    );
    const usedPairValues = result.routes
      .filter((route) => route.nodes.some((node) => !node.isChargingStation))
      .map((route) => {
        const resource = resources.find(
          (candidate) => candidate.vehicle.id === route.vehicleId,
        )!;
        return `${resource.vehicle.id}:${resource.driver.id}`;
      });
    const planningSummary = {
      optimizationEvidence: optimizationEvidenceForConfig({
        source: hasExplicitPlanningInputs ? "planningInputs" : "legacy",
        planningInputs: hasExplicitPlanningInputs ? planningInputs : undefined,
        requestedWeights: hasExplicitPlanningInputs ? planningWeights(planningInputs) : input.optimizationWeights,
        effectiveWeights: routingObjective.weights,
        vehicleDistributionMode: routingObjective.vehicleDistributionMode,
      }),
      complete: !unassignedStopIds.some(
        (stopId) => (planningInputs.stopPriorities[stopId] ?? 0) === 2,
      ),
      objective: planningInputs.objective,
      travelReservePercent: planningInputs.travelReservePercent,
      stopReserveMin: planningInputs.stopReserveMin,
      mandatoryUnplannedStopIds: unassignedStopIds.filter(
        (stopId) => (planningInputs.stopPriorities[stopId] ?? 0) === 2,
      ),
      selectedPairValues: originallySelectedPairValues,
      usedPairValues,
      unusedPairValues: originallySelectedPairValues
        .filter((pairValue) => !usedPairValues.includes(pairValue))
        .map((pairValue) => ({
          pairValue,
          reason: planningInputs.excludedPairValues.includes(pairValue)
            ? "Undantaget från dagens planering."
            : planningInputs.vehicleSelectionMode === "minimize_vehicles"
              ? "Inte aktivt eftersom målet är färre fordon."
              : "Kunde inte få ett kundstopp utan att bryta hårda planeringsvillkor.",
        })),
      unplanned: unassignedStopIds.map((stopId) => ({
        stopId,
        priority: planningInputs.stopPriorities[stopId] ?? 0,
        reason:
          UNPLANNED_SEARCH_EXPLANATION,
      })),
    };
    const planningNodeById = new Map(
      planningNodes.map((node) => [node.id, node]),
    );
    const diagnostics = classifyUnplannedNodes(
      unassignedStopIds
        .map((stopId) => planningNodeById.get(stopId))
        .filter((node): node is ALNSNode => node != null),
      stopById,
      resources,
      input.depotLatitude,
      input.depotLongitude,
      input.date,
    );
    const diagnosticByStopId = new Map(
      diagnostics.map((diagnostic) => [diagnostic.stopId, diagnostic.detail]),
    );
    planningSummary.unplanned = planningSummary.unplanned.map((item) => ({
      ...item,
      reason: diagnosticByStopId.get(item.stopId) ?? item.reason,
    }));

    const planId = crypto.randomUUID();
    await importPlanBeforePersistHook?.();
    await progress?.phase("saving");
    const transactionResult = await db.transaction(async (tx) => {
      let lockedDraft: typeof planningDraftsTable.$inferSelect | undefined;
      if (input.draftId) {
        const [draft] = await tx
          .select()
          .from(planningDraftsTable)
          .where(
            and(
              eq(planningDraftsTable.id, input.draftId),
              eq(planningDraftsTable.organizationId, organizationId),
            ),
          )
          .limit(1)
          .for("update");
        if (!draft) {
          throw new PlanningDraftError(
            "Planning draft not found.",
            404,
            "DRAFT_NOT_FOUND",
          );
        }
        if (draft.startAt.getTime() !== input.date.getTime()) {
          throw new PlanningDraftError(
            "The route plan date must match the planning draft startAt.",
            409,
            "DRAFT_START_AT_CONFLICT",
          );
        }
        if (draft.planPayloadHash) {
          if (draft.planPayloadHash !== planPayloadHash) {
            throw new PlanningDraftError(
              "This planning draft already has a different route plan request.",
              409,
              "DRAFT_PLAN_CONFLICT",
            );
          }
          if (!draft.planResult) {
            throw new PlanningDraftError(
              "The planning draft has an incomplete route plan result. Try again.",
              409,
              "DRAFT_PLAN_INCOMPLETE",
            );
          }
          if (!draft.planId) {
            throw new PlanningDraftError(
              "The planning draft has an incomplete route plan identity. Try again.",
              409,
              "DRAFT_PLAN_INCOMPLETE",
            );
          }
          await progress?.completeInPersistence(
            tx,
            draft.planResult as Record<string, unknown>,
          );
          return {
            replayed: true as const,
            planId: draft.planId,
            storedResult: draft.planResult,
          };
        }
        if (draft.planId) {
          throw new PlanningDraftError(
            "This planning draft already has a route plan.",
            409,
            "DRAFT_PLAN_INCOMPLETE",
          );
        }
        lockedDraft = draft;
      }
      // Lock every planning input in the same order used by route mutations:
      // vehicles, drivers, certifications, stops, then the depot owner row.
      // The optimizer ran against the rows read above; every row is compared
      // before the first planning write so a concurrent edit fails atomically.
      const lockedVehicles = await tx
        .select()
        .from(vehiclesTable)
        .where(
          and(
            inArray(vehiclesTable.id, vehicleIds),
            eq(vehiclesTable.organizationId, organizationId),
          ),
        )
        .orderBy(vehiclesTable.id)
        .for("update");
      const lockedDrivers = await tx
        .select()
        .from(driversTable)
        .where(
          and(
            inArray(driversTable.id, driverIds),
            eq(driversTable.organizationId, organizationId),
          ),
        )
        .orderBy(driversTable.id)
        .for("update");
      const lockedCertifications = await tx
        .select()
        .from(driverCertificationsTable)
        .where(
          and(
            eq(driverCertificationsTable.organizationId, organizationId),
            inArray(driverCertificationsTable.driverId, driverIds),
          ),
        )
        .orderBy(driverCertificationsTable.id)
        .for("update");
      const lockedStops = await tx
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.organizationId, organizationId),
            inArray(stopsTable.id, input.stopIds),
            isNull(stopsTable.archivedAt),
          ),
        )
        .orderBy(stopsTable.id)
        .for("update");
      const [lockedOrganization] = await tx
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId))
        .for("update");
      const originalVehicleById = new Map(
        vehicles.map((vehicle) => [vehicle.id, vehicle]),
      );
      const originalDriverById = new Map(
        drivers.map((driver) => [driver.id, driver]),
      );
      const originalStopById = new Map(stops.map((stop) => [stop.id, stop]));
      const originalCertificationById = new Map(
        driverCertifications.map((certification) => [
          certification.id,
          certification,
        ]),
      );
      const planningSnapshotChanged =
        lockedVehicles.length !== vehicles.length ||
        lockedDrivers.length !== drivers.length ||
        lockedCertifications.length !== driverCertifications.length ||
        lockedStops.length !== stops.length ||
        lockedVehicles.some(
          (vehicle) =>
            !sameInitialPlanningRow(
              originalVehicleById.get(vehicle.id),
              vehicle,
            ),
        ) ||
        lockedDrivers.some(
          (driver) =>
            !sameInitialPlanningRow(originalDriverById.get(driver.id), driver),
        ) ||
        lockedCertifications.some(
          (certification) =>
            !sameInitialPlanningRow(
              originalCertificationById.get(certification.id),
              certification,
            ),
        ) ||
        lockedStops.some(
          (stop) =>
            !sameInitialPlanningRow(originalStopById.get(stop.id), stop),
        ) ||
        !samePlanningDepot(organization, lockedOrganization);
      if (planningSnapshotChanged) {
        throw new ImportRouteWorkflowError(
          "Planeringsunderlaget ändrades under optimeringen. Ladda om och försök igen.",
          409,
        );
      }
      if (
        lockedVehicles.some((vehicle) => !vehicle.isActive) ||
        lockedDrivers.some((driver) => !driver.isActive)
      ) {
        throw new ImportRouteWorkflowError(
          "En vald bil eller chaufför är inte längre aktiv.",
        );
      }
      const { dayStart, dayEnd } = stockholmPlanningDayBounds(input.date);
      const sameDateRoutes = await tx
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            inArray(routesTable.vehicleId, vehicleIds),
            ne(routesTable.status, "cancelled"),
            ne(routesTable.status, "completed"),
            gte(routesTable.date, dayStart),
            lt(routesTable.date, dayEnd),
          ),
        );
      const occupiedRouteIds =
        sameDateRoutes.length > 0
          ? await tx
              .selectDistinct({ routeId: stopsTable.routeId })
              .from(stopsTable)
              .where(
                and(
                  eq(stopsTable.organizationId, organizationId),
                  inArray(
                    stopsTable.routeId,
                    sameDateRoutes.map((route) => route.id),
                  ),
                ),
              )
          : [];
      const occupied = new Set(
        occupiedRouteIds.flatMap(({ routeId }) => (routeId ? [routeId] : [])),
      );
      const orphanRouteIds = sameDateRoutes
        .map((route) => route.id)
        .filter((routeId) => !occupied.has(routeId));
      if (orphanRouteIds.length > 0) {
        await tx
          .update(routesTable)
          .set({
            status: "cancelled",
            totalStops: 0,
            plannerItinerary: [],
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routesTable.organizationId, organizationId),
              inArray(routesTable.id, orphanRouteIds),
            ),
          );
      }
      const lateBookingConflicts = await findVehicleBookingConflicts(
        tx,
        organizationId,
        vehicleIds,
        input.date,
        new Map(
          lockedVehicles.map((vehicle) => [vehicle.id, vehicle.name]),
        ),
      );
      if (lateBookingConflicts.length > 0) {
        throw vehicleAlreadyPlannedError(lateBookingConflicts);
      }
      for (const stop of stops) {
        const [tagged] = await tx
          .update(stopsTable)
          .set({
            planningPlanId: planId,
            planningDate: input.date,
            unplannedReason: diagnosticByStopId.get(stop.id) ?? null,
          })
          .where(
            and(
              eq(stopsTable.id, stop.id),
              eq(stopsTable.organizationId, organizationId),
              isNull(stopsTable.routeId),
              isNull(stopsTable.archivedAt),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!tagged) {
          throw new ImportRouteWorkflowError(
            "Ett stopp tilldelades av någon annan. Försök igen.",
          );
        }
      }
      const created = [];
      for (const optimizedRoute of result.routes) {
        const nodes = optimizedRoute.nodes.filter(
          (node) => !node.isChargingStation,
        );
        if (nodes.length === 0) continue;
        const resource = resources.find(
          (item) => item.vehicle.id === optimizedRoute.vehicleId,
        );
        const evaluation = result.routeEvaluations.get(
          optimizedRoute.vehicleId,
        );
        if (!resource || !evaluation?.feasible) {
          throw new ImportRouteWorkflowError(
            "Optimeraren returnerade en ogiltig rutt.",
          );
        }
        const routeStops = nodes
          .map((node, index) => {
            const stop = lockedStops.find(
              (candidate) => candidate.id === node.id,
            );
            return stop
              ? {
                  ...stop,
                  routeId: "optimization-pending",
                  sequenceOrder: index + 1,
                }
              : null;
          })
          .filter((stop): stop is NonNullable<typeof stop> => stop != null);
        // The route id is not known until insert(). Keep the material snapshot
        // deterministic by replacing the temporary route marker below.
        const workday = evaluateRouteWorkday(
          optimizedRoute.nodes,
          resource.routingVehicle,
          input.depotLatitude,
          input.depotLongitude,
          input.date,
          routingConstraintsForDriver(resource.driver),
        );
        const [route] = await tx
          .insert(routesTable)
          .values({
            planId,
            draftId: input.draftId ?? null,
            organizationId,
            vehicleId: resource.vehicle.id,
            name: lockedDraft
              ? `${lockedDraft.name} – ${resource.vehicle.name} – ${draftRouteStartAtLabel(input.date)}`
              : `${resource.vehicle.name} – ${input.date.toLocaleDateString("sv-SE")}`,
            status: "optimized",
            manualReviewRequired: true,
            manualReviewedAt: null,
            planRevision: 0,
            date: input.date,
            totalStops: nodes.length,
            plannerItinerary: itineraryForNodes(
              optimizedRoute.nodes,
              resource.routingVehicle,
              resource.driver,
              input.depotLatitude,
              input.depotLongitude,
              input.date,
            ),
            totalDistanceKm: Math.round(evaluation.totalDistanceKm * 100) / 100,
            totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
            co2EmissionsKg:
              Math.round(
                estimateCo2(
                  evaluation.totalDistanceKm,
                  resource.vehicle.vehicleType,
                  optimizedRoute.totalWeight,
                  resource.routingVehicle.capacityKg,
                ) * 100,
              ) / 100,
            workdayTimeline: workday.events,
            workdaySummary: workday.summary,
            optimizationPlanningSnapshot: planningInputs,
            optimizationPlanningSnapshotHash:
              payloadIdentityHash(planningInputs),
            customerReference: input.customerReference,
            sharedInstructions: input.sharedInstructions,
            planningSummary,
            depotSnapshot: resource.depotSnapshot,
          })
          .returning();
        // routeId participates in the material stop snapshot, so rewrite the
        // baseline with the persisted route id after the insert.
        const persistedRouteStops = routeStops.map((stop) => ({
          ...stop,
          routeId: route.id,
        }));
        await tx
          .update(routesTable)
          .set({
            optimizationResourceSnapshot: materialResourceSnapshot(
              resource.vehicle,
              resource.driver,
              persistedRouteStops,
              lockedCertifications.filter(
                (certification) =>
                  certification.driverId === resource.driver.id,
              ),
            ),
            optimizationResourceSnapshotHash: materialResourceSnapshotHash(
              resource.vehicle,
              resource.driver,
              persistedRouteStops,
              lockedCertifications.filter(
                (certification) =>
                  certification.driverId === resource.driver.id,
              ),
            ),
          })
          .where(
            and(
              eq(routesTable.id, route.id),
              eq(routesTable.organizationId, organizationId),
            ),
          );
        for (let index = 0; index < nodes.length; index++) {
          const [updated] = await tx
            .update(stopsTable)
            .set({
              routeId: route.id,
              sequenceOrder: index + 1,
              trackingCode: trackingCode(),
            })
            .where(
              and(
                eq(stopsTable.id, nodes[index].id),
                eq(stopsTable.organizationId, organizationId),
                isNull(stopsTable.routeId),
              ),
            )
            .returning({ id: stopsTable.id });
          if (!updated)
            throw new ImportRouteWorkflowError(
              "Ett stopp tilldelades av någon annan. Försök igen.",
            );
        }
        created.push({
          routeId: route.id,
          planId: route.planId,
          name: route.name,
          vehicleId: resource.vehicle.id,
          driverId: resource.driver.id,
          stopCount: nodes.length,
          totalDistanceKm: route.totalDistanceKm ?? 0,
          totalDurationMin: route.totalDurationMin ?? 0,
          planRevision: route.planRevision,
          status: "optimized" as const,
          depotSnapshot: depotSnapshotForResponse(route.depotSnapshot),
          workdayTimeline: workdayTimelineForResponse(workday.events),
          workdaySummary: workdaySummaryForResponse(workday.summary),
        });
      }
      // Calculate only after every valid route and stop assignment has been
      // persisted in this transaction. The bounded evaluator sees the same
      // final ALNS routes that passed the hard-route validity check above.
      const overlapExplanations = await explainGeographicRouteOverlapAsync(
        result.routes,
        resources.map((resource) => resource.routingVehicle),
        input.depotLatitude,
        input.depotLongitude,
        input.date,
        resources.map((resource) => routingConstraintsForDriver(resource.driver)),
      );
      for (const createdRoute of created) {
        const geographicOverlapExplanation =
          overlapExplanations.get(createdRoute.vehicleId) ?? null;
        await tx
          .update(routesTable)
          .set({ geographicOverlapExplanation })
          .where(
            and(
              eq(routesTable.id, createdRoute.routeId),
              eq(routesTable.organizationId, organizationId),
            ),
          );
        Object.assign(createdRoute, { geographicOverlapExplanation });
      }
      const recoveryDepotSnapshots = Object.fromEntries(
        originallySelectedPairValues.map((pairValue) => {
          const [vehicleId] = pairValue.split(":");
          const resource = resources.find(
            (candidate) => candidate.vehicle.id === vehicleId,
          );
          return [pairValue, resource?.depotSnapshot ?? null];
        }),
      );
      const recoveryBaseDepotSnapshots = Object.fromEntries(
        originallySelectedPairValues.map((pairValue) => [
          pairValue,
          baseDepotSnapshot,
        ]),
      );
      const planResult = {
        planId,
        routes: created,
        unassignedStopIds,
        diagnostics,
        planningSummary,
        planningInputs,
        customerReference: input.customerReference,
        sharedInstructions: input.sharedInstructions,
        // This is server-owned recovery evidence for a valid zero-route plan.
        // It deliberately records all plan-owned customer identities, not just
        // the currently unassigned subset, so a later all-route cancellation can
        // be recovered under the same draft CAS.
        recovery: {
          planDate: input.date.toISOString(),
          stopIds: input.stopIds,
          selectedPairValues: originallySelectedPairValues,
          depotLatitude: input.depotLatitude,
          depotLongitude: input.depotLongitude,
          depotSnapshots: recoveryDepotSnapshots,
          baseDepotLatitude,
          baseDepotLongitude,
          baseDepotSnapshots: recoveryBaseDepotSnapshots,
          customerReference: input.customerReference,
        },
      };
      if (input.draftId) {
        await tx
          .update(planningDraftsTable)
          .set({
            planId,
            planPayloadHash,
            planResult: JSON.parse(JSON.stringify(planResult)),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(planningDraftsTable.id, input.draftId),
              eq(planningDraftsTable.organizationId, organizationId),
            ),
          );
      }
      await progress?.completeInPersistence(
        tx,
        planResult as Record<string, unknown>,
      );
      return { replayed: false as const, result: planResult };
    });
    if (transactionResult.replayed) {
      return currentPlanResult(
        organizationId,
        transactionResult.planId,
        transactionResult.storedResult,
      );
    }
    return transactionResult.result;
  }

export function createImportRoutePlan(...args: Parameters<typeof createImportRoutePlanImpl>) {
  return withRequiredRoadData(() => createImportRoutePlanImpl(...args));
}

async function createImportRoutePlanImpl(
  organizationId: string,
  input: ImportRoutePlanInput,
) {
  if (!input.progressId) {
    return createImportRoutePlanCore(organizationId, input);
  }
  await registerImportProgress(organizationId, input.progressId, input.draftId);
  const progress = createImportProgressReporter(
    input.progressId,
    organizationId,
  );
  try {
    await progress.phase("preparing");
    const result = await createImportRoutePlanCore(organizationId, input, progress);
    await progress.complete(result as Record<string, unknown>);
    return result;
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
}
if (false) {
  /**
   * The combined import endpoint intentionally does not accept geographic proposal
   * IDs or signed proposal tokens. It plans the requested, still-unplanned stops
   * against the actual selected resources in one operation.
   */
  async function createImportRoutePlan(
    organizationId: string,
    input: ImportRoutePlanInput,
  ) {
    const planningInputs = normalizePlanningInputs(input.planningInputs);
    const originallySelectedPairValues = input.pairs.map(
      (pair) => `${pair.vehicleId}:${pair.driverId}`,
    );
    if (
      input.customerReference != null &&
      (typeof input.customerReference !== "string" ||
        input.customerReference.trim().length > 200)
    ) {
      throw new ImportRouteWorkflowError(
        "Kund- eller uppdragsreferensen får vara högst 200 tecken.",
      );
    }
    if (
      input.sharedInstructions != null &&
      (typeof input.sharedInstructions !== "string" ||
        input.sharedInstructions.trim().length > 4000)
    ) {
      throw new ImportRouteWorkflowError(
        "Gemensam chaufförsinstruktion får vara högst 4000 tecken.",
      );
    }
    input.customerReference = input.customerReference?.trim() || null;
    input.sharedInstructions = input.sharedInstructions?.trim() || null;
    input.planningInputs = planningInputs;
    if (
      Object.keys(planningInputs.stopPriorities).some(
        (stopId) => !input.stopIds.includes(stopId),
      )
    ) {
      throw new ImportRouteWorkflowError(
        "En stoppprioritet avser inte ett valt stopp.",
      );
    }
    input.pairs = input.pairs.filter(
      (pair) =>
        !planningInputs.excludedPairValues.includes(
          `${pair.vehicleId}:${pair.driverId}`,
        ),
    );
    if (input.pairs.length === 0) {
      throw new ImportRouteWorkflowError(
        "Minst ett aktivt bil–chaufförspar måste återstå efter dagens undantag.",
      );
    }
    if (
      planningInputs.depotOverride?.scope === "pair" &&
      !input.pairs.some(
        (pair) => pair.vehicleId === planningInputs.depotOverride?.vehicleId,
      )
    ) {
      throw new ImportRouteWorkflowError(
        "Depåundantaget måste peka på ett aktivt valt fordon.",
      );
    }
    input.vehicleDistributionMode =
      planningInputs.vehicleSelectionMode === "minimize_vehicles"
        ? "minimize"
        : "balance";
    if (new Set(input.stopIds).size !== input.stopIds.length) {
      throw new ImportRouteWorkflowError(
        "Ett stopp får bara förekomma en gång i planeringsunderlaget.",
      );
    }
    const vehicleIds = input.pairs.map((pair) => pair.vehicleId);
    const driverIds = input.pairs.map((pair) => pair.driverId);
    if (new Set(vehicleIds).size !== vehicleIds.length) {
      throw new ImportRouteWorkflowError(
        "Samma bil kan inte användas i flera valda bil–chaufförspar.",
      );
    }
    if (new Set(driverIds).size !== driverIds.length) {
      throw new ImportRouteWorkflowError(
        "Samma chaufför kan inte användas i flera valda bil–chaufförspar.",
      );
    }

    // Capture the request intent before applying any organization-owned depot
    // override. A retry after a lost response must identify the same request
    // even when the provider or current depot settings have changed.
    const planPayloadHash = input.draftId
      ? importPlanPayloadIdentity(input)
      : null;
    if (input.draftId) {
      const [identityOrganization] = await db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId));
      if (
        identityOrganization?.depotStartVerifiedAt &&
        identityOrganization.depotEndVerifiedAt &&
        identityOrganization.depotStartLatitude != null &&
        identityOrganization.depotStartLongitude != null &&
        identityOrganization.depotEndLatitude != null &&
        identityOrganization.depotEndLongitude != null
      ) {
        input.depotLatitude = identityOrganization.depotStartLatitude;
        input.depotLongitude = identityOrganization.depotStartLongitude;
      }
    }
    if (input.draftId) {
      const [draft] = await db
        .select()
        .from(planningDraftsTable)
        .where(
          and(
            eq(planningDraftsTable.id, input.draftId),
            eq(planningDraftsTable.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!draft) {
        throw new PlanningDraftError(
          "Planning draft not found.",
          404,
          "DRAFT_NOT_FOUND",
        );
      }
      if (draft.startAt.getTime() !== input.date.getTime()) {
        throw new PlanningDraftError(
          "The route plan date must match the planning draft startAt.",
          409,
          "DRAFT_START_AT_CONFLICT",
        );
      }
      if (draft.planPayloadHash) {
        if (draft.planPayloadHash !== planPayloadHash) {
          throw new PlanningDraftError(
            "This planning draft already has a different route plan request.",
            409,
            "DRAFT_PLAN_CONFLICT",
          );
        }
        if (!draft.planResult) {
          throw new PlanningDraftError(
            "The planning draft has an incomplete route plan result. Try again.",
            409,
            "DRAFT_PLAN_INCOMPLETE",
          );
        }
        if (!draft.planId) {
          throw new PlanningDraftError(
            "The planning draft has an incomplete route plan identity. Try again.",
            409,
            "DRAFT_PLAN_INCOMPLETE",
          );
        }
        return currentPlanResult(
          organizationId,
          draft.planId,
          draft.planResult,
        );
      }
      if (draft.planId) {
        throw new PlanningDraftError(
          "This planning draft already has a route plan.",
          409,
          "DRAFT_PLAN_INCOMPLETE",
        );
      }
    }

    const [stops, vehicles, drivers, organizations, driverCertifications] =
      await Promise.all([
        loadAvailableStops(organizationId, input.stopIds),
        db
          .select()
          .from(vehiclesTable)
          .where(
            and(
              inArray(vehiclesTable.id, vehicleIds),
              eq(vehiclesTable.organizationId, organizationId),
            ),
          ),
        db
          .select()
          .from(driversTable)
          .where(
            and(
              inArray(driversTable.id, driverIds),
              eq(driversTable.organizationId, organizationId),
            ),
          ),
        db
          .select()
          .from(organizationsTable)
          .where(eq(organizationsTable.id, organizationId)),
        db
          .select()
          .from(driverCertificationsTable)
          .where(
            and(
              eq(driverCertificationsTable.organizationId, organizationId),
              inArray(driverCertificationsTable.driverId, driverIds),
            ),
          )
          .orderBy(driverCertificationsTable.id),
      ]);
    const organization = organizations[0];
    // Persist a complete effective priority map. An omitted request value means
    // the stop's existing priority; an explicit 0 remains an explicit Normal.
    Object.assign(
      planningInputs,
      effectivePlanningInputsForStops(planningInputs, stops),
    );
    const orgDepotConfigured =
      organization?.depotStartVerifiedAt &&
      organization.depotEndVerifiedAt &&
      organization.depotStartLatitude != null &&
      organization.depotStartLongitude != null &&
      organization.depotEndLatitude != null &&
      organization.depotEndLongitude != null;
    // Keep the unmodified operational base separately from any temporary
    // planning override. `input.depotLatitude` is later changed for a plan
    // override and route.depotSnapshot stores the effective value.
    const baseDepotSnapshot = orgDepotConfigured
      ? verifiedDepotSnapshot(organization)
      : null;
    const baseDepotLatitude =
      baseDepotSnapshot?.start.latitude ?? input.depotLatitude;
    const baseDepotLongitude =
      baseDepotSnapshot?.start.longitude ?? input.depotLongitude;
    const overrideSourceRoutes =
      planningInputs.depotOverride?.verifiedDepotId.startsWith("route:")
        ? await db
            .select({
              id: routesTable.id,
              depotSnapshot: routesTable.depotSnapshot,
            })
            .from(routesTable)
            .where(
              and(
                eq(routesTable.organizationId, organizationId),
                eq(
                  routesTable.id,
                  planningInputs.depotOverride.verifiedDepotId.slice(
                    "route:".length,
                  ),
                ),
              ),
            )
        : [];
    const overrideDepotSnapshot = verifiedDepotOverrideSnapshot(
      planningInputs.depotOverride,
      organization,
      overrideSourceRoutes,
    );
    if (planningInputs.depotOverride && !overrideDepotSnapshot) {
      throw new ImportRouteWorkflowError(
        "Dagens depåundantag måste välja en verifierad depå som tillhör organisationen.",
      );
    }
    if (
      planningInputs.depotOverride?.scope === "plan" &&
      overrideDepotSnapshot
    ) {
      input.depotLatitude = overrideDepotSnapshot.start.latitude;
      input.depotLongitude = overrideDepotSnapshot.start.longitude;
    } else if (orgDepotConfigured) {
      // Never allow an import caller or driver profile to substitute an
      // organization-verified operational depot.
      input.depotLatitude = organization.depotStartLatitude!;
      input.depotLongitude = organization.depotStartLongitude!;
    }
    if (
      vehicles.length !== vehicleIds.length ||
      drivers.length !== driverIds.length
    ) {
      throw new ImportRouteWorkflowError(
        "En vald bil eller chaufför saknas eller tillhör en annan organisation.",
      );
    }

    const vehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle]),
    );
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
    const resources = input.pairs.map((pair) => {
      const vehicle = vehicleById.get(pair.vehicleId);
      const driver = driverById.get(pair.driverId);
      if (!vehicle || !driver || !vehicle.isActive || !driver.isActive) {
        throw new ImportRouteWorkflowError(
          "Alla valda bilar och chaufförer måste vara aktiva.",
        );
      }
      if (driver.vehicleId !== vehicle.id) {
        throw new ImportRouteWorkflowError(
          `${driver.name} är inte kopplad till bilen ${vehicle.name}.`,
        );
      }
      const appliesDepotOverride =
        planningInputs.depotOverride?.scope === "plan" ||
        (planningInputs.depotOverride?.scope === "pair" &&
          planningInputs.depotOverride.vehicleId === vehicle.id);
      const resourceDepot = appliesDepotOverride
        ? overrideDepotSnapshot
        : orgDepotConfigured
          ? verifiedDepotSnapshot(organization)
          : undefined;
      const routingVehicle = applyDriverRoutingProfile(
        {
          id: vehicle.id,
          vehicleType: vehicle.vehicleType,
          capacityKg: vehicle.capacityKg,
          capacityVolume: vehicle.capacityVolume,
          rangeKm: effectiveRangeKm(vehicle),
          ...(resourceDepot
            ? {
                startLatitude: resourceDepot.start.latitude,
                startLongitude: resourceDepot.start.longitude,
                endLatitude: resourceDepot.end.latitude,
                endLongitude: resourceDepot.end.longitude,
              }
            : {}),
        },
        driver,
      );
      if (resourceDepot) {
        routingVehicle.startLatitude = resourceDepot.start.latitude;
        routingVehicle.startLongitude = resourceDepot.start.longitude;
        routingVehicle.endLatitude = resourceDepot.end.latitude;
        routingVehicle.endLongitude = resourceDepot.end.longitude;
      }
      routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
      return {
        vehicle,
        driver,
        routingVehicle,
        depotSnapshot: resourceDepot ?? null,
      };
    });

    // Make field-service eligibility a hard optimizer constraint for every real
    // pair, rather than discovering an invalid assignment after optimization.
    await Promise.all(
      resources.map(async (resource) => {
        const ineligibleStopIds = new Set<string>();
        for (const stop of stops) {
          if (stop.jobType !== "field_service") continue;
          try {
            await assertDriverEligibleForFieldService(
              resource.driver.id,
              resource.vehicle.id,
              fieldServiceRequirementsFromStop(stop),
              input.date,
            );
          } catch {
            ineligibleStopIds.add(stop.id);
          }
        }
        resource.routingVehicle.ineligibleStopIds = ineligibleStopIds;
      }),
    );

    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    const planningNodes = stops.map((stop) => toAlnsNode(stop, planningInputs));
    const result = await optimizeWithALNS(
      planningNodes,
      resources.map((resource) => resource.routingVehicle),
      input.depotLatitude,
      input.depotLongitude,
      input.date,
      {
        ...policyToALNSConfig(resolveOptimizationPolicy(stops.length, 12_000)),
        timeLimitMs: 12_000,
        weights: {
          ...DEFAULT_WEIGHTS,
          ...planningWeights(planningInputs),
          ...input.optimizationWeights,
        },
        vehicleDistributionMode: input.vehicleDistributionMode ?? "balance",
        driverConstraints: resources.map((resource) =>
          routingConstraintsForDriver(resource.driver),
        ),
      },
    );
    const constraintsByVehicle = new Map(
      resources.map((resource) => [
        resource.routingVehicle.id,
        routingConstraintsForDriver(resource.driver),
      ]),
    );
    reinsertUnassignedNodes(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraintsByVehicle,
      input.depotLatitude,
      input.depotLongitude,
      input.date,
    );
    admitPrioritizedUnassignedNodes(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraintsByVehicle,
      input.depotLatitude,
      input.depotLongitude,
      input.date,
    );
    // Selected pairs are commitments by default. The deterministic repair uses
    // the same hard evaluator; when a pair cannot be given work it remains
    // visible as unused rather than silently becoming an optimizer candidate.
    if (planningInputs.vehicleSelectionMode === "use_all_selected_pairs") {
      fillExplicitlySelectedEmptyRoutes(
        result,
        resources.map((resource) => resource.routingVehicle),
        constraintsByVehicle,
        input.depotLatitude,
        input.depotLongitude,
        input.date,
      );
    }

    const unassignedStopIds = Array.from(
      new Set(
        result.unassigned
          .filter((node) => !node.isChargingStation)
          .map((node) => node.id),
      ),
    );
    const usedPairValues = result.routes
      .filter((route) => route.nodes.some((node) => !node.isChargingStation))
      .map((route) => {
        const resource = resources.find(
          (candidate) => candidate.vehicle.id === route.vehicleId,
        )!;
        return `${resource.vehicle.id}:${resource.driver.id}`;
      });
    const planningSummary = {
      complete: !unassignedStopIds.some(
        (stopId) => (planningInputs.stopPriorities[stopId] ?? 0) === 2,
      ),
      objective: planningInputs.objective,
      travelReservePercent: planningInputs.travelReservePercent,
      stopReserveMin: planningInputs.stopReserveMin,
      mandatoryUnplannedStopIds: unassignedStopIds.filter(
        (stopId) => (planningInputs.stopPriorities[stopId] ?? 0) === 2,
      ),
      selectedPairValues: originallySelectedPairValues,
      usedPairValues,
      unusedPairValues: originallySelectedPairValues
        .filter((pairValue) => !usedPairValues.includes(pairValue))
        .map((pairValue) => ({
          pairValue,
          reason: planningInputs.excludedPairValues.includes(pairValue)
            ? "Undantaget från dagens planering."
            : planningInputs.vehicleSelectionMode === "minimize_vehicles"
              ? "Inte aktivt eftersom målet är färre fordon."
              : "Kunde inte få ett kundstopp utan att bryta hårda planeringsvillkor.",
        })),
      unplanned: unassignedStopIds.map((stopId) => ({
        stopId,
        priority: planningInputs.stopPriorities[stopId] ?? 0,
        reason:
          UNPLANNED_SEARCH_EXPLANATION,
      })),
    };
    const planningNodeById = new Map(
      planningNodes.map((node) => [node.id, node]),
    );
    const diagnostics = classifyUnplannedNodes(
      unassignedStopIds
        .map((stopId) => planningNodeById.get(stopId))
        .filter((node): node is ALNSNode => node != null),
      stopById,
      resources,
      input.depotLatitude,
      input.depotLongitude,
      input.date,
    );
    const diagnosticByStopId = new Map(
      diagnostics.map((diagnostic) => [diagnostic.stopId, diagnostic.detail]),
    );
    planningSummary.unplanned = planningSummary.unplanned.map((item) => ({
      ...item,
      reason: diagnosticByStopId.get(item.stopId) ?? item.reason,
    }));

    const planId = crypto.randomUUID();
    await importPlanBeforePersistHook?.();
    const transactionResult = await db.transaction(async (tx) => {
      let lockedDraft: typeof planningDraftsTable.$inferSelect | undefined;
      if (input.draftId) {
        const [draft] = await tx
          .select()
          .from(planningDraftsTable)
          .where(
            and(
              eq(planningDraftsTable.id, input.draftId),
              eq(planningDraftsTable.organizationId, organizationId),
            ),
          )
          .limit(1)
          .for("update");
        if (!draft) {
          throw new PlanningDraftError(
            "Planning draft not found.",
            404,
            "DRAFT_NOT_FOUND",
          );
        }
        if (draft.startAt.getTime() !== input.date.getTime()) {
          throw new PlanningDraftError(
            "The route plan date must match the planning draft startAt.",
            409,
            "DRAFT_START_AT_CONFLICT",
          );
        }
        if (draft.planPayloadHash) {
          if (draft.planPayloadHash !== planPayloadHash) {
            throw new PlanningDraftError(
              "This planning draft already has a different route plan request.",
              409,
              "DRAFT_PLAN_CONFLICT",
            );
          }
          if (!draft.planResult) {
            throw new PlanningDraftError(
              "The planning draft has an incomplete route plan result. Try again.",
              409,
              "DRAFT_PLAN_INCOMPLETE",
            );
          }
          if (!draft.planId) {
            throw new PlanningDraftError(
              "The planning draft has an incomplete route plan identity. Try again.",
              409,
              "DRAFT_PLAN_INCOMPLETE",
            );
          }
          return {
            replayed: true as const,
            planId: draft.planId,
            storedResult: draft.planResult,
          };
        }
        if (draft.planId) {
          throw new PlanningDraftError(
            "This planning draft already has a route plan.",
            409,
            "DRAFT_PLAN_INCOMPLETE",
          );
        }
        lockedDraft = draft;
      }
      // Lock every planning input in the same order used by route mutations:
      // vehicles, drivers, certifications, stops, then the depot owner row.
      // The optimizer ran against the rows read above; every row is compared
      // before the first planning write so a concurrent edit fails atomically.
      const lockedVehicles = await tx
        .select()
        .from(vehiclesTable)
        .where(
          and(
            inArray(vehiclesTable.id, vehicleIds),
            eq(vehiclesTable.organizationId, organizationId),
          ),
        )
        .orderBy(vehiclesTable.id)
        .for("update");
      const lockedDrivers = await tx
        .select()
        .from(driversTable)
        .where(
          and(
            inArray(driversTable.id, driverIds),
            eq(driversTable.organizationId, organizationId),
          ),
        )
        .orderBy(driversTable.id)
        .for("update");
      const lockedCertifications = await tx
        .select()
        .from(driverCertificationsTable)
        .where(
          and(
            eq(driverCertificationsTable.organizationId, organizationId),
            inArray(driverCertificationsTable.driverId, driverIds),
          ),
        )
        .orderBy(driverCertificationsTable.id)
        .for("update");
      const lockedStops = await tx
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.organizationId, organizationId),
            inArray(stopsTable.id, input.stopIds),
          ),
        )
        .orderBy(stopsTable.id)
        .for("update");
      const [lockedOrganization] = await tx
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId))
        .for("update");
      const originalVehicleById = new Map(
        vehicles.map((vehicle) => [vehicle.id, vehicle]),
      );
      const originalDriverById = new Map(
        drivers.map((driver) => [driver.id, driver]),
      );
      const originalStopById = new Map(stops.map((stop) => [stop.id, stop]));
      const originalCertificationById = new Map(
        driverCertifications.map((certification) => [
          certification.id,
          certification,
        ]),
      );
      const planningSnapshotChanged =
        lockedVehicles.length !== vehicles.length ||
        lockedDrivers.length !== drivers.length ||
        lockedCertifications.length !== driverCertifications.length ||
        lockedStops.length !== stops.length ||
        lockedVehicles.some(
          (vehicle) =>
            !sameInitialPlanningRow(
              originalVehicleById.get(vehicle.id),
              vehicle,
            ),
        ) ||
        lockedDrivers.some(
          (driver) =>
            !sameInitialPlanningRow(originalDriverById.get(driver.id), driver),
        ) ||
        lockedCertifications.some(
          (certification) =>
            !sameInitialPlanningRow(
              originalCertificationById.get(certification.id),
              certification,
            ),
        ) ||
        lockedStops.some(
          (stop) =>
            !sameInitialPlanningRow(originalStopById.get(stop.id), stop),
        ) ||
        !samePlanningDepot(organization, lockedOrganization);
      if (planningSnapshotChanged) {
        throw new ImportRouteWorkflowError(
          "Planeringsunderlaget ändrades under optimeringen. Ladda om och försök igen.",
          409,
        );
      }
      if (
        lockedVehicles.some((vehicle) => !vehicle.isActive) ||
        lockedDrivers.some((driver) => !driver.isActive)
      ) {
        throw new ImportRouteWorkflowError(
          "En vald bil eller chaufför är inte längre aktiv.",
        );
      }
      const { dayStart, dayEnd } = stockholmPlanningDayBounds(input.date);
      const sameDateRoutes = await tx
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            inArray(routesTable.vehicleId, vehicleIds),
            ne(routesTable.status, "cancelled"),
            ne(routesTable.status, "completed"),
            gte(routesTable.date, dayStart),
            lt(routesTable.date, dayEnd),
          ),
        );
      const occupiedRouteIds =
        sameDateRoutes.length > 0
          ? await tx
              .selectDistinct({ routeId: stopsTable.routeId })
              .from(stopsTable)
              .where(
                and(
                  eq(stopsTable.organizationId, organizationId),
                  inArray(
                    stopsTable.routeId,
                    sameDateRoutes.map((route) => route.id),
                  ),
                ),
              )
          : [];
      const occupied = new Set(
        occupiedRouteIds.flatMap(({ routeId }) => (routeId ? [routeId] : [])),
      );
      const orphanRouteIds = sameDateRoutes
        .map((route) => route.id)
        .filter((routeId) => !occupied.has(routeId));
      if (orphanRouteIds.length > 0) {
        await tx
          .update(routesTable)
          .set({
            status: "cancelled",
            totalStops: 0,
            plannerItinerary: [],
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routesTable.organizationId, organizationId),
              inArray(routesTable.id, orphanRouteIds),
            ),
          );
      }
      if (occupied.size > 0) {
        throw new ImportRouteWorkflowError(
          "En vald bil har redan en aktiv rutt på det valda planeringsdatumet.",
          409,
        );
      }
      for (const stop of stops) {
        const [tagged] = await tx
          .update(stopsTable)
          .set({
            planningPlanId: planId,
            planningDate: input.date,
            unplannedReason: diagnosticByStopId.get(stop.id) ?? null,
          })
          .where(
            and(
              eq(stopsTable.id, stop.id),
              eq(stopsTable.organizationId, organizationId),
              isNull(stopsTable.routeId),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!tagged) {
          throw new ImportRouteWorkflowError(
            "Ett stopp tilldelades av någon annan. Försök igen.",
          );
        }
      }
      const created = [];
      for (const optimizedRoute of result.routes) {
        const nodes = optimizedRoute.nodes.filter(
          (node) => !node.isChargingStation,
        );
        if (nodes.length === 0) continue;
        const resource = resources.find(
          (item) => item.vehicle.id === optimizedRoute.vehicleId,
        );
        const evaluation = result.routeEvaluations.get(
          optimizedRoute.vehicleId,
        );
        if (!resource || !evaluation?.feasible) {
          throw new ImportRouteWorkflowError(
            "Optimeraren returnerade en ogiltig rutt.",
          );
        }
        const routeStops = nodes
          .map((node, index) => {
            const stop = lockedStops.find(
              (candidate) => candidate.id === node.id,
            );
            return stop
              ? {
                  ...stop,
                  routeId: "optimization-pending",
                  sequenceOrder: index + 1,
                }
              : null;
          })
          .filter((stop): stop is NonNullable<typeof stop> => stop != null);
        // The route id is not known until insert(). Keep the material snapshot
        // deterministic by replacing the temporary route marker below.
        const workday = evaluateRouteWorkday(
          optimizedRoute.nodes,
          resource.routingVehicle,
          input.depotLatitude,
          input.depotLongitude,
          input.date,
          routingConstraintsForDriver(resource.driver),
        );
        const [route] = await tx
          .insert(routesTable)
          .values({
            planId,
            draftId: input.draftId ?? null,
            organizationId,
            vehicleId: resource.vehicle.id,
            name: lockedDraft
              ? `${lockedDraft.name} – ${resource.vehicle.name} – ${draftRouteStartAtLabel(input.date)}`
              : `${resource.vehicle.name} – ${input.date.toLocaleDateString("sv-SE")}`,
            status: "optimized",
            manualReviewRequired: true,
            manualReviewedAt: null,
            planRevision: 0,
            date: input.date,
            totalStops: nodes.length,
            plannerItinerary: itineraryForNodes(
              optimizedRoute.nodes,
              resource.routingVehicle,
              resource.driver,
              input.depotLatitude,
              input.depotLongitude,
              input.date,
            ),
            totalDistanceKm: Math.round(evaluation.totalDistanceKm * 100) / 100,
            totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
            co2EmissionsKg:
              Math.round(
                estimateCo2(
                  evaluation.totalDistanceKm,
                  resource.vehicle.vehicleType,
                  optimizedRoute.totalWeight,
                  resource.routingVehicle.capacityKg,
                ) * 100,
              ) / 100,
            workdayTimeline: workday.events,
            workdaySummary: workday.summary,
            optimizationPlanningSnapshot: planningInputs,
            optimizationPlanningSnapshotHash:
              payloadIdentityHash(planningInputs),
            customerReference: input.customerReference,
            sharedInstructions: input.sharedInstructions,
            planningSummary,
            depotSnapshot: resource.depotSnapshot,
          })
          .returning();
        // routeId participates in the material stop snapshot, so rewrite the
        // baseline with the persisted route id after the insert.
        const persistedRouteStops = routeStops.map((stop) => ({
          ...stop,
          routeId: route.id,
        }));
        await tx
          .update(routesTable)
          .set({
            optimizationResourceSnapshot: materialResourceSnapshot(
              resource.vehicle,
              resource.driver,
              persistedRouteStops,
              lockedCertifications.filter(
                (certification) =>
                  certification.driverId === resource.driver.id,
              ),
            ),
            optimizationResourceSnapshotHash: materialResourceSnapshotHash(
              resource.vehicle,
              resource.driver,
              persistedRouteStops,
              lockedCertifications.filter(
                (certification) =>
                  certification.driverId === resource.driver.id,
              ),
            ),
          })
          .where(
            and(
              eq(routesTable.id, route.id),
              eq(routesTable.organizationId, organizationId),
            ),
          );
        for (let index = 0; index < nodes.length; index++) {
          const [updated] = await tx
            .update(stopsTable)
            .set({
              routeId: route.id,
              sequenceOrder: index + 1,
              trackingCode: trackingCode(),
            })
            .where(
              and(
                eq(stopsTable.id, nodes[index].id),
                eq(stopsTable.organizationId, organizationId),
                isNull(stopsTable.routeId),
              ),
            )
            .returning({ id: stopsTable.id });
          if (!updated)
            throw new ImportRouteWorkflowError(
              "Ett stopp tilldelades av någon annan. Försök igen.",
            );
        }
        created.push({
          routeId: route.id,
          planId: route.planId,
          name: route.name,
          vehicleId: resource.vehicle.id,
          driverId: resource.driver.id,
          stopCount: nodes.length,
          totalDistanceKm: route.totalDistanceKm ?? 0,
          totalDurationMin: route.totalDurationMin ?? 0,
          planRevision: route.planRevision,
          status: "optimized" as const,
          depotSnapshot: depotSnapshotForResponse(route.depotSnapshot),
          workdayTimeline: workdayTimelineForResponse(workday.events),
          workdaySummary: workdaySummaryForResponse(workday.summary),
        });
      }
      const recoveryDepotSnapshots = Object.fromEntries(
        originallySelectedPairValues.map((pairValue) => {
          const [vehicleId] = pairValue.split(":");
          const resource = resources.find(
            (candidate) => candidate.vehicle.id === vehicleId,
          );
          return [pairValue, resource?.depotSnapshot ?? null];
        }),
      );
      const recoveryBaseDepotSnapshots = Object.fromEntries(
        originallySelectedPairValues.map((pairValue) => [
          pairValue,
          baseDepotSnapshot,
        ]),
      );
      const planResult = {
        planId,
        routes: created,
        unassignedStopIds,
        diagnostics,
        planningSummary,
        planningInputs,
        customerReference: input.customerReference,
        sharedInstructions: input.sharedInstructions,
        // This is server-owned recovery evidence for a valid zero-route plan.
        // It deliberately records all plan-owned customer identities, not just
        // the currently unassigned subset, so a later all-route cancellation can
        // be recovered under the same draft CAS.
        recovery: {
          planDate: input.date.toISOString(),
          stopIds: input.stopIds,
          selectedPairValues: originallySelectedPairValues,
          depotLatitude: input.depotLatitude,
          depotLongitude: input.depotLongitude,
          depotSnapshots: recoveryDepotSnapshots,
          baseDepotLatitude,
          baseDepotLongitude,
          baseDepotSnapshots: recoveryBaseDepotSnapshots,
          customerReference: input.customerReference,
        },
      };
      if (input.draftId) {
        await tx
          .update(planningDraftsTable)
          .set({
            planId,
            planPayloadHash,
            planResult: JSON.parse(JSON.stringify(planResult)),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(planningDraftsTable.id, input.draftId),
              eq(planningDraftsTable.organizationId, organizationId),
            ),
          );
      }
      return { replayed: false as const, result: planResult };
    });
    if (transactionResult.replayed) {
      return currentPlanResult(
        organizationId,
        transactionResult.planId,
        transactionResult.storedResult,
      );
    }
    return transactionResult.result;
  }
}

async function runAssignedRouteAdjustment(
  organizationId: string, input: RouteAdjustmentInput, previewOnly = false,
) {
  return withRequiredRoadData(async () => {
    await preparePersistedRouteRoadData(organizationId, {
      routeIds: input.routes.map(route => route.routeId),
      stopIds: input.routes.flatMap(route => route.stopIds),
      driverIds: input.routes.map(route => route.driverId),
      chargingStationIds: input.routes.flatMap(route => (route.plannerItinerary ?? []).filter(stop => stop.isChargingStop).map(stop => stop.stopId)),
      coordinates: [{ lat: input.depotLatitude, lon: input.depotLongitude }],
    });
    return adjustAssignedRoutesImpl(organizationId, input, previewOnly);
  });
}

export async function adjustAssignedRoutes(organizationId: string, input: RouteAdjustmentInput) {
  const result = await runAssignedRouteAdjustment(organizationId, input);
  if (result.routes) return { routes: result.routes };
  throw new ImportRouteWorkflowError("En förhandsgranskning kan inte användas som ett sparresultat.", 409);
}
export async function previewAssignedRouteAdjustments(organizationId: string, input: RouteAdjustmentInput) {
  const result = await runAssignedRouteAdjustment(organizationId, input, true);
  if (result.previewDigest) return { kind: result.kind, canApply: result.canApply,
    previewDigest: result.previewDigest, consequences: result.consequences };
  throw new ImportRouteWorkflowError("Förhandsgranskningen kunde inte beräknas.", 409);
}

async function adjustAssignedRoutesImpl(
  organizationId: string,
  input: RouteAdjustmentInput,
  previewOnly = false,
) {
  const routeIds = input.routes.map((route) => route.routeId);
  const driverIds = input.routes.map((route) => route.driverId);
  const allStopIds = input.routes.flatMap((route) => route.stopIds);

  if (new Set(routeIds).size !== routeIds.length) {
    throw new ImportRouteWorkflowError(
      "Varje rutt får bara förekomma en gång.",
    );
  }
  if (new Set(driverIds).size !== driverIds.length) {
    throw new ImportRouteWorkflowError(
      "Samma chaufför kan inte tilldelas till flera rutter samtidigt.",
    );
  }
  if (new Set(allStopIds).size !== allStopIds.length) {
    throw new ImportRouteWorkflowError(
      "Ett stopp får bara förekomma på en rutt.",
    );
  }

  const [routes, planRoutes, currentStops, drivers, organizations] =
    await Promise.all([
      db
        .select()
        .from(routesTable)
        .where(
          and(
            inArray(routesTable.id, routeIds),
            eq(routesTable.organizationId, organizationId),
          ),
        ),
      db
        .select()
        .from(routesTable)
        .where(
          and(
            eq(routesTable.planId, input.planId),
            eq(routesTable.organizationId, organizationId),
            ne(routesTable.status, "cancelled"),
          ),
        ),
      db
        .select()
        .from(stopsTable)
        .where(
          and(
            inArray(stopsTable.routeId, routeIds),
            eq(stopsTable.organizationId, organizationId),
          ),
        ),
      db
        .select()
        .from(driversTable)
        .where(
          and(
            inArray(driversTable.id, driverIds),
            eq(driversTable.organizationId, organizationId),
          ),
        ),
      db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId)),
    ]);
  const organization = organizations[0];
  const organizationPolicy = organizationPlanningPolicy(organization);
  const currentDepotSnapshot = verifiedDepotSnapshot(organization);

  if (routes.length !== routeIds.length) {
    throw new ImportRouteWorkflowError(
      "En eller flera rutter saknas eller tillhör en annan organisation.",
    );
  }
  const requestedRouteIds = new Set(routeIds);
  if (
    planRoutes.length !== routeIds.length ||
    planRoutes.some((route) => !requestedRouteIds.has(route.id))
  ) {
    throw new ImportRouteWorkflowError(
      "Alla aktuella rutter i den valda planen måste skickas med vid justering.",
      409,
    );
  }
  if (drivers.length !== driverIds.length) {
    throw new ImportRouteWorkflowError(
      "En vald chaufför saknas eller tillhör en annan organisation.",
    );
  }
  if (routes.some((route) => route.status !== "optimized")) {
    throw new ImportRouteWorkflowError(
      "Endast optimerade, ännu ej publicerade rutter kan justeras.",
    );
  }
  if (routes.some((route) => route.planId !== input.planId)) {
    throw new ImportRouteWorkflowError(
      "Alla justerade rutter måste tillhöra samma valda plan.",
      409,
    );
  }

  for (const adjustment of input.routes) {
    const route = routes.find((candidate) => candidate.id === adjustment.routeId);
    if (!route) continue;
    try {
      assertLockedFirstStopOrder(route, adjustment.stopIds);
    } catch (error) {
      if (error instanceof RouteFirstStopLockError) {
        throw new ImportRouteWorkflowError(error.message, 409);
      }
      throw error;
    }
  }

  const currentStopIds = new Set(currentStops.map((stop) => stop.id));
  if (
    currentStopIds.size !== allStopIds.length ||
    !allStopIds.every((stopId) => currentStopIds.has(stopId))
  ) {
    throw new ImportRouteWorkflowError(
      "Alla befintliga stopp måste finnas med exakt en gång i den justerade planen.",
    );
  }
  const submittedPositionByStopId = new Map(
    input.routes.flatMap((route) =>
      route.stopIds.map(
        (stopId, index) =>
          [
            stopId,
            { routeId: route.routeId, sequenceOrder: index + 1 },
          ] as const,
      ),
    ),
  );
  const lifecycleLockedStop = currentStops.find((stop) => {
    if (stop.status === "pending") return false;
    const submitted = submittedPositionByStopId.get(stop.id);
    return (
      !submitted ||
      submitted.routeId !== stop.routeId ||
      submitted.sequenceOrder !== stop.sequenceOrder
    );
  });
  if (lifecycleLockedStop) {
    throw new ImportRouteWorkflowError(
      "Slutförda, pågående, misslyckade och överhoppade stopp är låsta och måste behålla sin rutt och position.",
      409,
    );
  }

  const vehicleIds = routes.flatMap((route) =>
    route.vehicleId ? [route.vehicleId] : [],
  );
  if (vehicleIds.length !== routes.length) {
    throw new ImportRouteWorkflowError(
      "Alla rutter måste ha en tilldelad bil före manuell justering.",
    );
  }
  if (new Set(vehicleIds).size !== vehicleIds.length) {
    throw new ImportRouteWorkflowError(
      "Samma bil kan inte tilldelas till flera rutter samtidigt.",
    );
  }

  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(
      and(
        inArray(vehiclesTable.id, vehicleIds),
        eq(vehiclesTable.organizationId, organizationId),
      ),
    );
  if (vehicles.length !== vehicleIds.length) {
    throw new ImportRouteWorkflowError(
      "En tilldelad bil saknas eller tillhör en annan organisation.",
    );
  }
  const driverCertifications = await db
    .select()
    .from(driverCertificationsTable)
    .where(
      and(
        eq(driverCertificationsTable.organizationId, organizationId),
        inArray(driverCertificationsTable.driverId, driverIds),
      ),
    );

  const routeById = new Map(routes.map((route) => [route.id, route]));
  const stopById = new Map(currentStops.map((stop) => [stop.id, stop]));
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));

  for (const adjustment of input.routes) {
    const route = routeById.get(adjustment.routeId);
    if (!route) {
      throw new ImportRouteWorkflowError("Rutten kunde inte hittas.");
    }
    if (route.planRevision !== adjustment.planRevision) {
      throw new ImportRouteWorkflowError(
        "Ruttplanen ändrades av någon annan. Ladda om och försök igen.",
        409,
      );
    }
  }

  const validated = await Promise.all(
    input.routes.map(async (adjustment) => {
      const route = routeById.get(adjustment.routeId);
      const vehicle = route?.vehicleId
        ? vehicleById.get(route.vehicleId)
        : undefined;
      const driver = driverById.get(adjustment.driverId);

      if (!route || !vehicle || !driver) {
        throw new ImportRouteWorkflowError(
          "Rutten, bilen eller chauffören kunde inte hittas.",
        );
      }
      const persistedPlanningSnapshot =
        route.optimizationPlanningSnapshot as Record<string, unknown> | null;
      if (
        !persistedPlanningSnapshot ||
        !Number.isFinite(persistedPlanningSnapshot.travelReservePercent) ||
        !Number.isInteger(persistedPlanningSnapshot.stopReserveMin)
      ) {
        throw new ImportRouteWorkflowError(
          "Rutten saknar sparat depå- eller reservunderlag och kan inte justeras säkert.",
          409,
        );
      }
      const planningInputs = normalizePlanningInputs(
        route.optimizationPlanningSnapshot,
      );
      const routePolicy = effectivePlanningPolicy(organization, route.optimizationPlanningSnapshot);
      planningInputs.maxDriverOvertimeMin =
        routePolicy.maxDriverOvertimeMin;
      planningInputs.allowLateStopsMin = routePolicy.allowLateStopsMin;
      const planningSnapshot = { ...planningInputs };
      if (
        organizationPolicy.maxDriverOvertimeMin === 0 &&
        !Object.prototype.hasOwnProperty.call(
          persistedPlanningSnapshot,
          "maxDriverOvertimeMin",
        )
      ) {
        delete planningSnapshot.maxDriverOvertimeMin;
      }
      if (
        organizationPolicy.allowLateStopsMin === 0 &&
        !Object.prototype.hasOwnProperty.call(
          persistedPlanningSnapshot,
          "allowLateStopsMin",
        )
      ) {
        delete planningSnapshot.allowLateStopsMin;
      }
      if (!vehicle.isActive || !driver.isActive) {
        throw new ImportRouteWorkflowError(
          "Alla valda bilar och chaufförer måste vara aktiva.",
        );
      }
      if (driver.vehicleId !== vehicle.id) {
        throw new ImportRouteWorkflowError(
          `${driver.name} är inte kopplad till bilen ${vehicle.name}.`,
        );
      }

      const assignedStops = adjustment.stopIds.map((stopId) => {
        const stop = stopById.get(stopId);
        if (!stop) {
          throw new ImportRouteWorkflowError(
            "Den justerade rutten innehåller ett okänt stopp.",
          );
        }
        return stop;
      });
      const originalStops = currentStops.filter(stop => stop.routeId === route.id);
      const savedDriverId = route.frozenDriverId ?? optimizationDriverIdForRoute(route);
      if (route.lockedFirstStopId && (assignedStops[0]?.id !== route.lockedFirstStopId
        || (savedDriverId != null && savedDriverId !== driver.id))) {
        throw new ImportRouteWorkflowError("Förstastoppets ordning och resurs måste behållas. Lås upp först.", 409);
      }
      if (route.optimizationFrozen && savedDriverId !== driver.id) {
        throw new ImportRouteWorkflowError("Ruttens resurser är frysta. Lås upp först.", 409);
      }
      try {
        assertPlanningLockOrder(route, originalStops,
          assignedStops.map((stop, index) => ({ ...stop, routeId: route.id, sequenceOrder: index + 1 })));
      } catch (error) {
        throw new ImportRouteWorkflowError((error as Error).message, 409);
      }
      const chargingStationById = new Map(
        CHARGING_STATIONS.map((station) => [station.id, station]),
      );
      // Older review clients submit only customer stop IDs. Retain the
      // server-generated charging itinerary rather than silently removing the
      // charge stops that made an EV route feasible.
      const submittedItinerary =
        adjustment.plannerItinerary ??
        (route.plannerItinerary
          ? (() => {
              let nextStop = 0;
              const rebuilt = route.plannerItinerary.flatMap((entry) => {
                if (entry.isChargingStop) return [entry];
                const stopId = adjustment.stopIds[nextStop++];
                return stopId ? [{ ...entry, stopId }] : [];
              });
              while (nextStop < adjustment.stopIds.length) {
                rebuilt.push({
                  stopId: adjustment.stopIds[nextStop++],
                  sequenceOrder: rebuilt.length + 1,
                  estimatedArrival: route.date.toISOString(),
                  distanceFromPreviousKm: 0,
                });
              }
              return rebuilt;
            })()
          : undefined);
      const plannerItinerary = submittedItinerary?.map((entry, index) => {
        const estimatedArrival =
          entry.estimatedArrival instanceof Date
            ? entry.estimatedArrival.toISOString()
            : entry.estimatedArrival;
        if (entry.isChargingStop) {
          const station = chargingStationById.get(entry.stopId);
          if (!station) {
            throw new ImportRouteWorkflowError(
              "Ruttplanen innehåller ett okänt laddstopp.",
            );
          }
          return {
            ...entry,
            estimatedArrival,
            sequenceOrder: index + 1,
            isChargingStop: true,
            chargingStationName: station.chargingStationName,
          };
        }
        return {
          ...entry,
          estimatedArrival,
          sequenceOrder: index + 1,
          isChargingStop: false,
        };
      });
      if (plannerItinerary) {
        const itineraryStopIds = plannerItinerary
          .filter((entry) => !entry.isChargingStop)
          .map((entry) => entry.stopId);
        if (
          itineraryStopIds.length !== adjustment.stopIds.length ||
          itineraryStopIds.some(
            (stopId, index) => stopId !== adjustment.stopIds[index],
          )
        ) {
          throw new ImportRouteWorkflowError(
            "Ruttplanens körordning stämmer inte med dess stopp.",
          );
        }
      }
      for (const stop of assignedStops) {
        if (stop.jobType === "field_service") {
          await assertDriverEligibleForFieldService(
            driver.id,
            vehicle.id,
            fieldServiceRequirementsFromStop(stop),
            route.date,
          );
        }
      }
      const nodes = route.optimizationFrozen
        ? canonicalFrozenItinerary(route, originalStops, assignedStops.map(stop => toAlnsNode(stop, planningInputs))).nodes
        : plannerItinerary
        ? plannerItinerary.map((entry) => {
            if (entry.isChargingStop) {
              const station = chargingStationById.get(entry.stopId);
              if (!station) {
                throw new ImportRouteWorkflowError(
                  "Ruttplanen innehåller ett okänt laddstopp.",
                );
              }
              return { ...station };
            }
            const stop = stopById.get(entry.stopId);
            if (!stop) {
              throw new ImportRouteWorkflowError(
                "Ruttplanen innehåller ett okänt stopp.",
              );
            }
            return toAlnsNode(stop, planningInputs);
          })
        : assignedStops.map((stop) => toAlnsNode(stop, planningInputs));
      const routingVehicle = withOrganizationPlanningPolicy(
        applyDriverRoutingProfile(
          {
            id: vehicle.id,
            vehicleType: vehicle.vehicleType,
            capacityKg: vehicle.capacityKg,
            capacityVolume: vehicle.capacityVolume,
            rangeKm: effectiveRangeKm(vehicle),
          },
          driver,
        ),
        routePolicy,
      );
      routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
      const authoritativeDepot = route.depotSnapshot ?? currentDepotSnapshot;
      if (authoritativeDepot) {
        routingVehicle.startLatitude = authoritativeDepot.start.latitude;
        routingVehicle.startLongitude = authoritativeDepot.start.longitude;
        routingVehicle.endLatitude = authoritativeDepot.end.latitude;
        routingVehicle.endLongitude = authoritativeDepot.end.longitude;
      }
      const depotLatitude =
        authoritativeDepot?.start.latitude ??
        routingVehicle.startLatitude ??
        input.depotLatitude;
      const depotLongitude =
        authoritativeDepot?.start.longitude ??
        routingVehicle.startLongitude ??
        input.depotLongitude;
      const metrics = calculateRouteMetrics(
        nodes,
        routingVehicle,
        depotLatitude,
        depotLongitude,
        route.date,
        routingConstraintsForDriver(driver),
      );
      const workday = evaluateRouteWorkday(
        nodes,
        routingVehicle,
        depotLatitude,
        depotLongitude,
        route.date,
        routingConstraintsForDriver(driver),
      );
      try { assertPlanningLockTimes(route, assignedStops, workday.events); }
      catch (error) { throw new ImportRouteWorkflowError((error as Error).message, 409); }
      const hasChargingStop = nodes.some((node) => node.isChargingStation);
      const routeEvaluation = evaluateRoute(
        {
          vehicleId: routingVehicle.id,
          nodes,
          totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
          totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
        },
        routingVehicle,
        depotLatitude,
        depotLongitude,
        route.date,
        routingConstraintsForDriver(driver),
      );
      if (!workday.feasible) {
        throw new ImportRouteWorkflowError(
          workdayInfeasibilityMessage(workday, {
            vehicleName: vehicle.name,
            breakStartTime: driver.breakStartTime,
            breakEndTime: driver.breakEndTime,
          }),
        );
      }
      if (metrics.totalWeightKg > routingVehicle.capacityKg) {
        throw new ImportRouteWorkflowError(
          `${vehicle.name} och chauffören klarar ${routingVehicle.capacityKg} kg men rutten kräver ${Math.round(metrics.totalWeightKg)} kg.`,
        );
      }
      if (metrics.totalVolumeM3 > routingVehicle.capacityVolume) {
        throw new ImportRouteWorkflowError(
          `${vehicle.name} och chauffören klarar ${routingVehicle.capacityVolume} m³ men rutten kräver ${metrics.totalVolumeM3.toFixed(1)} m³.`,
        );
      }
      const availableRange = effectiveRangeKm(vehicle);
      if (
        availableRange != null &&
        !hasChargingStop &&
        metrics.totalDistanceKm > availableRange * 0.95
      ) {
        throw new ImportRouteWorkflowError(
          `${vehicle.name} har cirka ${Math.round(availableRange)} km tillgänglig räckvidd men rutten kräver ${Math.round(metrics.totalDistanceKm)} km.`,
        );
      }
      if (hasChargingStop && !routeEvaluation.feasible) {
        throw new ImportRouteWorkflowError(
          `Rutten för ${vehicle.name} är inte säker med de sparade laddstoppen. Justera rutt eller laddning.`,
        );
      }
      if (!metrics.feasible || !routeEvaluation.feasible) {
        throw new ImportRouteWorkflowError(
          `Rutten för ${vehicle.name} bryter mot ett kundtidsfönster. Flytta stoppet närmare sitt tidsfönster eller välj en annan rutt.`,
        );
      }

      const refreshedPlannerItinerary = plannerItinerary
        ? itineraryForNodes(
            nodes,
            routingVehicle,
            driver,
            depotLatitude,
            depotLongitude,
            route.date,
          )
        : undefined;

      return {
        adjustment,
        route,
        vehicle,
        routingVehicle,
        driver,
        nodes,
        planningInputs,
        planningSnapshot,
        metrics,
        plannerItinerary: refreshedPlannerItinerary,
        workday,
      };
    }),
  );

  const sorted = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const { expectedPreviewDigest: _expected, ...reviewedInput } = input;
  const unknownMetrics = (stopCount: number): DispatchRouteMetrics => ({
    driveMin: null, workMin: null, endAt: null, windowViolations: null, stopCount,
  });
  const consequences: DispatchConsequences = {
    status: routes.every(route => route.workdaySummary && route.workdayTimeline?.length) ? "verified" : "unknown",
    unplanned: { before: 0, after: 0 },
    routes: validated.map(item => {
      const summary = item.route.workdaySummary;
      return {
        routeId: item.route.id, routeName: item.route.name,
        before: summary && item.route.workdayTimeline?.length ? {
          driveMin: summary.nonReturnDrivingMin + summary.returnMin,
          workMin: summary.totalMin, endAt: item.route.workdayTimeline.at(-1)?.endAt ?? null,
          windowViolations: summary.lateStopIds?.length ?? 0,
          stopCount: currentStops.filter(stop => stop.routeId === item.route.id).length,
        } : unknownMetrics(currentStops.filter(stop => stop.routeId === item.route.id).length),
        after: {
          driveMin: item.workday.summary.nonReturnDrivingMin + item.workday.summary.returnMin,
          workMin: item.workday.summary.totalMin, endAt: item.workday.events.at(-1)?.endAt ?? null,
          windowViolations: item.workday.summary.lateStopIds?.length ?? 0,
          stopCount: item.adjustment.stopIds.length,
        },
      };
    }),
    ...(!routes.every(route => route.workdaySummary && route.workdayTimeline?.length)
      ? { reason: "Vissa före-mått saknar sparad auktoritativ tidslinje; dessa visas som okända." } : {}),
  };
  const calculation = validated.map(item => ({
    routeId: item.route.id, workday: item.workday, itinerary: item.plannerItinerary ?? null,
    planningSnapshot: item.planningSnapshot,
  }));
  const digestFor = (facts: {
    routes: typeof routes; planRoutes: typeof planRoutes; stops: typeof currentStops;
    vehicles: typeof vehicles; drivers: typeof drivers; certifications: typeof driverCertifications;
    organization: typeof organization;
  }) => plannerFactsDigest({
    organizationId, input: reviewedInput,
    routes: sorted(facts.routes), planRoutes: sorted(facts.planRoutes), stops: sorted(facts.stops),
    vehicles: sorted(facts.vehicles), drivers: sorted(facts.drivers), certifications: sorted(facts.certifications),
    organization: facts.organization, consequences, calculation,
  });
  const previewDigest = digestFor({ routes, planRoutes, stops: currentStops, vehicles, drivers,
    certifications: driverCertifications, organization });
  if (previewOnly) return { kind: "preview" as const, canApply: true, previewDigest, consequences };

  const updatedRoutes = await db.transaction(async (tx) => {
    for (const routeId of [...routeIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }
    const lockedRoutes = await tx
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          inArray(routesTable.id, routeIds),
        ),
      )
      .orderBy(routesTable.id)
      .for("update");
    const lockedStops = await tx
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.organizationId, organizationId),
          inArray(stopsTable.routeId, routeIds),
        ),
      )
      .orderBy(stopsTable.id)
      .for("update");
    const [lockedOrganization] = await tx.select().from(organizationsTable).where(
      eq(organizationsTable.id, organizationId),
    ).for("update");
    const lockedVehicles = await tx
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.organizationId, organizationId),
          inArray(vehiclesTable.id, vehicleIds),
        ),
      )
      .orderBy(vehiclesTable.id)
      .for("update");
    const lockedDrivers = await tx
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          inArray(driversTable.id, driverIds),
        ),
      )
      .orderBy(driversTable.id)
      .for("update");
    const lockedCertifications = await tx
      .select()
      .from(driverCertificationsTable)
      .where(
        and(
          eq(driverCertificationsTable.organizationId, organizationId),
          inArray(driverCertificationsTable.driverId, driverIds),
        ),
      )
      .orderBy(driverCertificationsTable.id)
      .for("update");
    const lockedPlanRoutes = await tx.select().from(routesTable).where(and(
      eq(routesTable.organizationId, organizationId), eq(routesTable.planId, input.planId),
      ne(routesTable.status, "cancelled"),
    )).orderBy(routesTable.id).for("update");
    if (input.expectedPreviewDigest && (previewDigest !== input.expectedPreviewDigest
      || digestFor({ routes: lockedRoutes, planRoutes: lockedPlanRoutes, stops: lockedStops,
        vehicles: lockedVehicles, drivers: lockedDrivers, certifications: lockedCertifications,
        organization: lockedOrganization }) !== input.expectedPreviewDigest)) {
      throw new ImportRouteWorkflowError("Förhandsgranskningen har ändrats. Lokala ändringar är inte sparade; granska ett nytt förslag.", 409);
    }
    const originalRouteById = new Map(routes.map((route) => [route.id, route]));
    const originalStopById = new Map(
      currentStops.map((stop) => [stop.id, stop]),
    );
    const originalVehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle]),
    );
    const originalDriverById = new Map(
      drivers.map((driver) => [driver.id, driver]),
    );
    const originalCertificationById = new Map(
      driverCertifications.map((certification) => [
        certification.id,
        certification,
      ]),
    );
    if (
      lockedRoutes.length !== routes.length ||
      lockedStops.length !== currentStops.length ||
      lockedVehicles.length !== vehicles.length ||
      lockedDrivers.length !== drivers.length ||
      lockedCertifications.length !== driverCertifications.length ||
      lockedRoutes.some((route) => {
        const original = originalRouteById.get(route.id);
        return (
          !original ||
          route.planRevision !== original.planRevision ||
          route.status !== original.status ||
          route.vehicleId !== original.vehicleId ||
          route.planId !== original.planId ||
          route.lockedFirstStopId !== original.lockedFirstStopId
        );
      }) ||
      lockedStops.some((stop) => {
        const original = originalStopById.get(stop.id);
        return !original || !sameOptimizationStop(original, stop);
      }) ||
      lockedVehicles.some((vehicle) => {
        const original = originalVehicleById.get(vehicle.id);
        return !original || !sameOptimizationVehicle(original, vehicle);
      }) ||
      lockedDrivers.some((driver) => {
        const original = originalDriverById.get(driver.id);
        return !original || !sameOptimizationDriver(original, driver);
      }) ||
      lockedCertifications.some((certification) => {
        const original = originalCertificationById.get(certification.id);
        return !original || !sameDriverCertification(original, certification);
      })
    ) {
      throw new ImportRouteWorkflowError(
        "Ruttplanen eller dess resurser ändrades av någon annan. Ladda om och försök igen.",
        409,
      );
    }
    const updated = [];

    for (const item of validated) {
      if (item.route.optimizationFrozen) {
        const route = item.route;
        updated.push({
          routeId: route.id, planId: route.planId, name: route.name,
          vehicleId: item.vehicle.id, driverId: item.driver.id,
          stopCount: item.adjustment.stopIds.length,
          totalDistanceKm: route.totalDistanceKm ?? 0, totalDurationMin: route.totalDurationMin ?? 0,
          planRevision: route.planRevision, status: "optimized" as const,
          depotSnapshot: depotSnapshotForResponse(route.depotSnapshot),
          workdayTimeline: workdayTimelineForResponse(route.workdayTimeline),
          workdaySummary: workdaySummaryForResponse(route.workdaySummary),
          geographicOverlapExplanation: route.geographicOverlapExplanation,
        });
        continue;
      }
      for (let index = 0; index < item.adjustment.stopIds.length; index++) {
        const stopId = item.adjustment.stopIds[index];
        const originalStop = stopById.get(stopId);
        if (!originalStop?.routeId) {
          throw new ImportRouteWorkflowError(
            "Ruttplanen ändrades av någon annan. Ladda om och försök igen.",
            409,
          );
        }
        const [savedStop] = await tx
          .update(stopsTable)
          .set({
            routeId: item.route.id,
            sequenceOrder: index + 1,
          })
          .where(
            and(
              eq(stopsTable.id, stopId),
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.routeId, originalStop.routeId),
              eq(stopsTable.status, originalStop.status),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!savedStop) {
          throw new ImportRouteWorkflowError(
            "Ruttplanen ändrades av någon annan. Ladda om och försök igen.",
            409,
          );
        }
      }

      const roundedDistance =
        Math.round(item.metrics.totalDistanceKm * 100) / 100;
      const roundedDuration =
        Math.round(item.workday.summary.totalMin * 100) / 100;
      const optimizedStopsForSnapshot = item.adjustment.stopIds
        .map((stopId, index) => {
          const stop = stopById.get(stopId);
          return stop
            ? { ...stop, routeId: item.route.id, sequenceOrder: index + 1 }
            : null;
        })
        .filter((stop): stop is NonNullable<typeof stop> => stop != null);
      const certificationsForDriver = driverCertifications.filter(
        (certification) => certification.driverId === item.driver.id,
      );
      const [savedRoute] = await tx
        .update(routesTable)
        .set({
          totalStops: item.adjustment.stopIds.length,
          totalDistanceKm: roundedDistance,
          totalDurationMin: roundedDuration,
          co2EmissionsKg:
            Math.round(
              estimateCo2(
                item.metrics.totalDistanceKm,
                item.vehicle.vehicleType,
                item.metrics.totalWeightKg,
                item.routingVehicle.capacityKg,
              ) * 100,
            ) / 100,
          plannerItinerary: item.plannerItinerary ?? null,
          workdayTimeline: item.workday.events,
          workdaySummary: item.workday.summary,
          optimizationPlanningSnapshot: item.planningSnapshot,
          optimizationPlanningSnapshotHash: payloadIdentityHash(
            item.planningSnapshot,
          ),
          // Keep the original plan's depot history through adjustments. Legacy
          // routes receive a snapshot only when they first become editable.
          depotSnapshot: item.route.depotSnapshot ?? currentDepotSnapshot,
          optimizationResourceSnapshot: materialResourceSnapshot(
            item.vehicle,
            item.driver,
            optimizedStopsForSnapshot,
            certificationsForDriver,
          ),
          optimizationResourceSnapshotHash: materialResourceSnapshotHash(
            item.vehicle,
            item.driver,
            optimizedStopsForSnapshot,
            certificationsForDriver,
          ),
          geographicOverlapExplanation: null,
          manualReviewedAt: new Date(),
          planRevision: item.route.planRevision + 1,
          ...workingRouteHandoff(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(routesTable.id, item.route.id),
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.status, "optimized"),
            eq(routesTable.planRevision, item.route.planRevision),
          ),
        )
        .returning();
      if (!savedRoute) {
        throw new ImportRouteWorkflowError(
          "Rutten publicerades eller ändrades av någon annan. Ladda om och försök igen.",
          409,
        );
      }

      updated.push({
        routeId: savedRoute.id,
        planId: savedRoute.planId,
        name: savedRoute.name,
        vehicleId: item.vehicle.id,
        driverId: item.driver.id,
        stopCount: item.nodes.length,
        totalDistanceKm: roundedDistance,
        totalDurationMin: roundedDuration,
        planRevision: savedRoute.planRevision,
        status: "optimized" as const,
        depotSnapshot: depotSnapshotForResponse(savedRoute.depotSnapshot),
        workdayTimeline: workdayTimelineForResponse(savedRoute.workdayTimeline),
        workdaySummary: workdaySummaryForResponse(savedRoute.workdaySummary),
      });
    }
    // The submitted route set has passed the same hard evaluator used by the
    // adjustment flow. Rebuild bounded, pair-scoped evidence from that final
    // state instead of retaining evidence for the previous stop allocation.
    const overlapExplanations = await explainGeographicRouteOverlapAsync(
      validated.map((item) => ({
        vehicleId: item.vehicle.id,
        nodes: item.nodes,
        totalWeight: item.nodes.reduce((total, node) => total + node.weightKg, 0),
        totalVolume: item.nodes.reduce((total, node) => total + node.volumeM3, 0),
      })),
      validated.map((item) => item.routingVehicle),
      validated[0]?.routingVehicle.startLatitude ?? input.depotLatitude,
      validated[0]?.routingVehicle.startLongitude ?? input.depotLongitude,
      validated[0]?.route.date ?? routes[0]!.date,
      validated.map((item) => routingConstraintsForDriver(item.driver)),
    );
    for (const updatedRoute of updated) {
      if (validated.find(item => item.route.id === updatedRoute.routeId)?.route.optimizationFrozen) continue;
      const geographicOverlapExplanation =
        overlapExplanations.get(updatedRoute.vehicleId) ?? null;
      await tx
        .update(routesTable)
        .set({ geographicOverlapExplanation })
        .where(
          and(
            eq(routesTable.id, updatedRoute.routeId),
            eq(routesTable.organizationId, organizationId),
          ),
        );
      Object.assign(updatedRoute, { geographicOverlapExplanation });
    }
    for (const planId of [
      ...new Set(lockedRoutes.map((route) => route.planId)),
    ]) {
      const [planRoutes, planStops] = await Promise.all([
        tx
          .select()
          .from(routesTable)
          .where(
            and(
              eq(routesTable.organizationId, organizationId),
              eq(routesTable.planId, planId),
              ne(routesTable.status, "cancelled"),
            ),
          ),
        tx
          .select()
          .from(stopsTable)
          .where(
            and(
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.planningPlanId, planId),
          isNull(stopsTable.archivedAt),
            ),
          ),
      ]);
      const snapshot = normalizePlanningInputs(
        planRoutes[0]?.optimizationPlanningSnapshot,
      );
      const liveRouteIds = new Set(planRoutes.map((route) => route.id));
      const unplanned = planStops.filter(
        (stop) => !stop.routeId || !liveRouteIds.has(stop.routeId),
      );
      const previousSummary = planRoutes[0]?.planningSummary as Record<
        string,
        unknown
      > | null;
      const selectedPairValues = Array.isArray(
        previousSummary?.selectedPairValues,
      )
        ? previousSummary.selectedPairValues.filter(
            (value): value is string => typeof value === "string",
          )
        : planRoutes.flatMap((route) => {
            const driverId = optimizationDriverIdForRoute(route);
            return route.vehicleId && driverId
              ? [`${route.vehicleId}:${driverId}`]
              : [];
          });
      const usedPairValues = planRoutes.flatMap((route) => {
        const driverId = optimizationDriverIdForRoute(route);
        return route.vehicleId && driverId && route.totalStops > 0
          ? [`${route.vehicleId}:${driverId}`]
          : [];
      });
      const planningSummary = {
        complete: !unplanned.some(
          (stop) =>
            (snapshot.stopPriorities[stop.id] ?? stop.priority ?? 0) === 2,
        ),
        objective: snapshot.objective,
        travelReservePercent: snapshot.travelReservePercent,
        stopReserveMin: snapshot.stopReserveMin,
        mandatoryUnplannedStopIds: unplanned
          .filter(
            (stop) =>
              (snapshot.stopPriorities[stop.id] ?? stop.priority ?? 0) === 2,
          )
          .map((stop) => stop.id),
        selectedPairValues,
        usedPairValues,
        unusedPairValues: selectedPairValues
          .filter((value) => !usedPairValues.includes(value))
          .map((pairValue) => ({
            pairValue,
            reason:
              "Kunde inte få ett kundstopp utan att bryta hårda planeringsvillkor.",
          })),
        unplanned: unplanned.map((stop) => ({
          stopId: stop.id,
          priority: (snapshot.stopPriorities[stop.id] ?? stop.priority ?? 0) as
            | 0
            | 1
            | 2,
          reason:
            stop.unplannedReason ?? "Stoppet är inte tilldelat en aktiv rutt.",
        })),
      };
      await tx
        .update(routesTable)
        .set({ planningSummary })
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.planId, planId),
            eq(routesTable.optimizationFrozen, false),
          ),
        );
    }

    return updated;
  });

  return { routes: updatedRoutes };
}

export function reorderAssignedRouteStops(...args: Parameters<typeof reorderAssignedRouteStopsImpl>) {
  return withRequiredRoadData(async () => {
    await preparePersistedRouteRoadData(args[0], { routeIds: [args[1]], stopIds: args[2] });
    return reorderAssignedRouteStopsImpl(...args);
  });
}

async function reorderAssignedRouteStopsImpl(
  organizationId: string,
  routeId: string,
  stopIds: string[],
  expectedPlanRevision: number,
) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.id, routeId),
        eq(routesTable.organizationId, organizationId),
      ),
    );
  if (!route) return { error: "Rutten kunde inte hittas.", status: 404 };
  if (route.planRevision !== expectedPlanRevision) {
    return {
      error: "Rutten ändrades av någon annan. Ladda om och försök igen.",
      status: 409,
    };
  }
  if (route.status === "cancelled") {
    return { error: "En avbruten rutt kan inte ändras.", status: 409 };
  }
  try {
    assertLockedFirstStopOrder(route, stopIds);
  } catch (error) {
    if (error instanceof RouteFirstStopLockError) {
      return { error: error.message, status: error.statusCode };
    }
    throw error;
  }

  const uniqueIds = new Set(stopIds);
  if (uniqueIds.size !== stopIds.length) {
    return { error: "Stopplistan får inte innehålla dubbletter.", status: 400 };
  }

  const [existingStops, vehicles, drivers, organizations] = await Promise.all([
    db
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.routeId, routeId),
          eq(stopsTable.organizationId, organizationId),
          isNull(stopsTable.archivedAt),
        ),
      ),
    route.vehicleId
      ? db
          .select()
          .from(vehiclesTable)
          .where(
            and(
              eq(vehiclesTable.id, route.vehicleId),
              eq(vehiclesTable.organizationId, organizationId),
            ),
          )
      : Promise.resolve([]),
    route.vehicleId
      ? db
          .select()
          .from(driversTable)
          .where(
            and(
              eq(driversTable.vehicleId, route.vehicleId),
              eq(driversTable.organizationId, organizationId),
              eq(driversTable.isActive, true),
            ),
          )
      : Promise.resolve([]),
    db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)),
  ]);
  const existingIds = new Set(existingStops.map((stop) => stop.id));
  if (
    uniqueIds.size !== existingIds.size ||
    !stopIds.every((stopId) => existingIds.has(stopId))
  ) {
    return {
      error:
        "Stopplistan måste innehålla ruttens samtliga kundstopp exakt en gång.",
      status: 400,
    };
  }
  const desiredSequenceById = new Map(
    stopIds.map((stopId, index) => [stopId, index + 1]),
  );
  if (
    existingStops.some(
      (stop) =>
        stop.status !== "pending" &&
        desiredSequenceById.get(stop.id) !== stop.sequenceOrder,
    )
  ) {
    return {
      error:
        "Avslutade och pågående stopp är låsta och måste behålla sin position.",
      status: 409,
    };
  }
  const vehicle = vehicles[0];
  const driver = resolveDriverForRoute(route, drivers);
  if (!vehicle || !driver) {
    return {
      error: isProtectedImportRoute(route)
        ? "Rutten saknar sin optimeringsvalda aktiva chaufför. Välj en explicit resursändring."
        : "Rutten måste ha en aktiv bil och chaufför innan stoppen kan flyttas.",
      status: 409,
    };
  }
  const driverCertifications = await db
    .select()
    .from(driverCertificationsTable)
    .where(
      and(
        eq(driverCertificationsTable.organizationId, organizationId),
        eq(driverCertificationsTable.driverId, driver.id),
      ),
    )
    .orderBy(driverCertificationsTable.id);

  const currentDepotSnapshot = verifiedDepotSnapshot(organizations[0]);
  const organizationPolicy = effectivePlanningPolicy(organizations[0], route.optimizationPlanningSnapshot);
  const authoritativeDepot = route.depotSnapshot ?? currentDepotSnapshot;
  const planningInputs = normalizePlanningInputs(
    route.optimizationPlanningSnapshot,
  );
  const persistedPlanningSnapshot =
    route.optimizationPlanningSnapshot as Record<string, unknown> | null;
  if (
    !persistedPlanningSnapshot ||
    !Number.isFinite(persistedPlanningSnapshot.travelReservePercent) ||
    !Number.isInteger(persistedPlanningSnapshot.stopReserveMin)
  ) {
    return {
      error:
        "Rutten saknar sparat depå- eller reservunderlag och kan inte ändras säkert.",
      status: 409,
    };
  }
  planningInputs.maxDriverOvertimeMin = organizationPolicy.maxDriverOvertimeMin;
  planningInputs.allowLateStopsMin = organizationPolicy.allowLateStopsMin;
  const planningSnapshot = { ...planningInputs };
  if (
    organizationPolicy.maxDriverOvertimeMin === 0 &&
    !Object.prototype.hasOwnProperty.call(
      persistedPlanningSnapshot,
      "maxDriverOvertimeMin",
    )
  ) {
    delete planningSnapshot.maxDriverOvertimeMin;
  }
  if (
    organizationPolicy.allowLateStopsMin === 0 &&
    !Object.prototype.hasOwnProperty.call(
      persistedPlanningSnapshot,
      "allowLateStopsMin",
    )
  ) {
    delete planningSnapshot.allowLateStopsMin;
  }
  const routingVehicle = withOrganizationPlanningPolicy(
    applyDriverRoutingProfile(
      {
        id: vehicle.id,
        vehicleType: vehicle.vehicleType,
        capacityKg: vehicle.capacityKg,
        capacityVolume: vehicle.capacityVolume,
        rangeKm: effectiveRangeKm(vehicle),
      },
      driver,
    ),
    organizationPolicy,
  );
  routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
  if (authoritativeDepot) {
    routingVehicle.startLatitude = authoritativeDepot.start.latitude;
    routingVehicle.startLongitude = authoritativeDepot.start.longitude;
    routingVehicle.endLatitude = authoritativeDepot.end.latitude;
    routingVehicle.endLongitude = authoritativeDepot.end.longitude;
  }
  const depotLatitude = routingVehicle.startLatitude;
  const depotLongitude = routingVehicle.startLongitude;
  if (depotLatitude == null || depotLongitude == null) {
    return {
      error:
        "Verifiera organisationens depå eller ange chaufförens startkoordinater innan rutten ändras.",
      status: 409,
    };
  }

  const stopById = new Map(existingStops.map((stop) => [stop.id, stop]));
  const customerNodes = stopIds.map((stopId) =>
    toAlnsNode(stopById.get(stopId)!, planningInputs),
  );
  const stationById = new Map(
    CHARGING_STATIONS.map((station) => [station.id, station]),
  );
  let customerIndex = 0;
  const nodes: ALNSNode[] = [];
  for (const entry of route.plannerItinerary ?? []) {
    if (entry.isChargingStop) {
      const station = stationById.get(entry.stopId);
      if (!station) {
        return {
          error:
            "Rutten innehåller ett okänt laddstopp och kan inte ändras säkert.",
          status: 409,
        };
      }
      nodes.push({ ...station });
    } else if (customerNodes[customerIndex]) {
      nodes.push(customerNodes[customerIndex]);
      customerIndex += 1;
    }
  }
  nodes.push(...customerNodes.slice(customerIndex));

  const totalWeight = customerNodes.reduce(
    (sum, node) => sum + node.weightKg,
    0,
  );
  const totalVolume = customerNodes.reduce(
    (sum, node) => sum + node.volumeM3,
    0,
  );
  if (totalWeight > routingVehicle.capacityKg) {
    return {
      error: `${vehicle.name} och chauffören klarar ${routingVehicle.capacityKg} kg men rutten kräver ${Math.round(totalWeight)} kg.`,
      status: 409,
    };
  }
  if (totalVolume > routingVehicle.capacityVolume) {
    return {
      error: `${vehicle.name} och chauffören klarar ${routingVehicle.capacityVolume} m³ men rutten kräver ${totalVolume.toFixed(1)} m³.`,
      status: 409,
    };
  }

  const constraints = routingConstraintsForDriver(driver);
  const workday = evaluateRouteWorkday(
    nodes,
    routingVehicle,
    depotLatitude,
    depotLongitude,
    route.date,
    constraints,
  );
  if (!workday.feasible) {
    return {
      error: workdayInfeasibilityMessage(workday, {
        vehicleName: vehicle.name,
        breakStartTime: driver.breakStartTime,
        breakEndTime: driver.breakEndTime,
      }),
      status: 409,
    };
  }
  const plannerItinerary = itineraryForNodes(
    nodes,
    routingVehicle,
    driver,
    depotLatitude,
    depotLongitude,
    route.date,
  );
  const roundedDistance = Math.round(workday.totalDistanceKm * 100) / 100;
  const roundedDuration = Math.round(workday.summary.totalMin * 100) / 100;

  try {
    const updatedStops = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
      const [lockedVehicle] = await tx
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.organizationId, organizationId),
            eq(vehiclesTable.id, vehicle.id),
          ),
        )
        .for("update");
      const [lockedDriver] = await tx
        .select()
        .from(driversTable)
        .where(
          and(
            eq(driversTable.organizationId, organizationId),
            eq(driversTable.id, driver.id),
          ),
        )
        .for("update");
      const lockedCertifications = await tx
        .select()
        .from(driverCertificationsTable)
        .where(
          and(
            eq(driverCertificationsTable.organizationId, organizationId),
            eq(driverCertificationsTable.driverId, driver.id),
          ),
        )
        .orderBy(driverCertificationsTable.id)
        .for("update");
      if (
        !lockedVehicle ||
        !lockedDriver ||
        !sameOptimizationVehicle(vehicle, lockedVehicle) ||
        !sameOptimizationDriver(driver, lockedDriver) ||
        lockedCertifications.length !== driverCertifications.length ||
        lockedCertifications.some((certification) => {
          const original = driverCertifications.find(
            (candidate) => candidate.id === certification.id,
          );
          return !original || !sameDriverCertification(original, certification);
        })
      ) {
        throw new ImportRouteWorkflowError(
          "Rutten eller dess resurser ändrades av någon annan. Ladda om och försök igen.",
          409,
        );
      }
      const [lockedRoute] = await tx
        .select()
        .from(routesTable)
        .where(
          and(
            eq(routesTable.id, routeId),
            eq(routesTable.organizationId, organizationId),
          ),
        )
        .for("update");
      if (!lockedRoute || lockedRoute.planRevision !== expectedPlanRevision) {
        throw new ImportRouteWorkflowError(
          "Rutten ändrades av någon annan. Ladda om och försök igen.",
          409,
        );
      }
      const lockedStops = await tx
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.routeId, routeId),
            eq(stopsTable.organizationId, organizationId),
            isNull(stopsTable.archivedAt),
          ),
        )
        .orderBy(stopsTable.id)
        .for("update");
      const unchangedStopSnapshot =
        lockedStops.length === existingStops.length &&
        lockedStops.every((lockedStop) => {
          const original = stopById.get(lockedStop.id);
          return (
            original != null &&
            original.routeId === lockedStop.routeId &&
            original.status === lockedStop.status &&
            original.sequenceOrder === lockedStop.sequenceOrder &&
            JSON.stringify(original) === JSON.stringify(lockedStop)
          );
        });
      if (!unchangedStopSnapshot) {
        throw new ImportRouteWorkflowError(
          "Ett stopp ändrades av någon annan. Ladda om och försök igen.",
          409,
        );
      }
      const [updatedRoute] = await tx
        .update(routesTable)
        .set({
          totalStops: customerNodes.length,
          totalDistanceKm: roundedDistance,
          totalDurationMin: roundedDuration,
          co2EmissionsKg:
            Math.round(
              estimateCo2(
                workday.totalDistanceKm,
                vehicle.vehicleType,
                totalWeight,
                routingVehicle.capacityKg,
              ) * 100,
            ) / 100,
          plannerItinerary,
          depotSnapshot: route.depotSnapshot ?? currentDepotSnapshot,
          workdayTimeline: workday.events,
          workdaySummary: workday.summary,
          optimizationPlanningSnapshot: planningSnapshot,
          optimizationPlanningSnapshotHash:
            payloadIdentityHash(planningSnapshot),
          manualReviewedAt: null,
          geographicOverlapExplanation: null,
          planRevision: expectedPlanRevision + 1,
          ...workingRouteHandoff(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(routesTable.id, routeId),
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.planRevision, expectedPlanRevision),
          ),
        )
        .returning({ id: routesTable.id });
      if (!updatedRoute) {
        throw new ImportRouteWorkflowError(
          "Rutten ändrades av någon annan. Ladda om och försök igen.",
          409,
        );
      }
      for (let index = 0; index < stopIds.length; index++) {
        const original = stopById.get(stopIds[index])!;
        if (original.status !== "pending") continue;
        const [savedStop] = await tx
          .update(stopsTable)
          .set({ sequenceOrder: index + 1 })
          .where(
            and(
              eq(stopsTable.id, stopIds[index]),
              eq(stopsTable.routeId, routeId),
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.status, "pending"),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!savedStop) {
          throw new ImportRouteWorkflowError(
            "Ett stopp ändrades av någon annan. Ladda om och försök igen.",
            409,
          );
        }
      }
      const updatedStops = await tx
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.routeId, routeId),
            eq(stopsTable.organizationId, organizationId),
            isNull(stopsTable.archivedAt),
          ),
        )
        .orderBy(stopsTable.sequenceOrder);
      await tx
        .update(routesTable)
        .set({
          optimizationResourceSnapshot: materialResourceSnapshot(
            lockedVehicle,
            lockedDriver,
            updatedStops,
            lockedCertifications,
          ),
          optimizationResourceSnapshotHash: materialResourceSnapshotHash(
            lockedVehicle,
            lockedDriver,
            updatedStops,
            lockedCertifications,
          ),
        })
        .where(
          and(
            eq(routesTable.id, routeId),
            eq(routesTable.organizationId, organizationId),
          ),
        );
      // This route-only reorder can stale nearby-pair evidence retained on an
      // untouched counterpart route. Clear derived evidence only.
      await tx
        .update(routesTable)
        .set({ geographicOverlapExplanation: null })
        .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));
      return updatedStops;
    });
    return { data: updatedStops };
  } catch (error) {
    if (error instanceof ImportRouteWorkflowError) {
      return { error: error.message, status: error.statusCode };
    }
    throw error;
  }
}

export function serviceDurationsForReoptimization(
  durations: number[],
  newCommonDuration: number,
  strategy: "preserve_individual" | "preserve_exact" | "replace_all",
): number[] {
  // Whole-plan reoptimization must be a route-only operation. In particular,
  // do not use the legacy modal-duration replacement below: a plan containing
  // [5, 10, 10] must still contain [5, 10, 10] after it is replanned.
  if (strategy === "preserve_exact") return [...durations];
  if (strategy === "replace_all") return durations.map(() => newCommonDuration);
  const counts = new Map<number, number>();
  for (const duration of durations) {
    counts.set(duration, (counts.get(duration) ?? 0) + 1);
  }
  const oldCommon =
    [...counts.entries()].sort(
      ([durationA, countA], [durationB, countB]) =>
        countB - countA || durationA - durationB,
    )[0]?.[0] ?? newCommonDuration;
  return durations.map((duration) =>
    duration === oldCommon ? newCommonDuration : duration,
  );
}

/**
 * Replans an imported plan atomically. Customer stop identities are retained,
 * while routes are retained, created, or cancelled to match the selected pairs.
 */
export function reoptimizeImportRoutePlanServiceTime(...args: Parameters<typeof reoptimizeImportRoutePlanServiceTimeImpl>) {
  return withRequiredRoadData(() => reoptimizeImportRoutePlanServiceTimeImpl(...args));
}

async function reoptimizeImportRoutePlanServiceTimeImpl(
  organizationId: string,
  planId: string,
  input: ImportPlanServiceTimeReoptimizationInput,
) {
  const routeIds = input.routes.map((route) => route.routeId);
  const recoveringZeroRoutePlan =
    routeIds.length === 0 && input.recovery !== undefined;
  if (new Set(routeIds).size !== routeIds.length) {
    throw new ImportRouteWorkflowError(
      "Varje rutt måste förekomma exakt en gång.",
    );
  }

  const routes = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planId, planId),
        ne(routesTable.status, "cancelled"),
      ),
    )
    .orderBy(routesTable.id);
  if (
    !input.planningInputs &&
    routes.some((route) => {
      const snapshot = route.optimizationPlanningSnapshot as Record<
        string,
        unknown
      > | null;
      return (
        !snapshot ||
        !Number.isFinite(snapshot.travelReservePercent) ||
        !Number.isInteger(snapshot.stopReserveMin)
      );
    })
  ) {
    throw new ImportRouteWorkflowError(
      "Planen saknar sparat depå- eller reservunderlag och kan inte planeras om säkert.",
      409,
    );
  }
  const submittedByRoute = new Map(
    input.routes.map((route) => [route.routeId, route]),
  );
  if (
    (!recoveringZeroRoutePlan && routes.length !== input.routes.length) ||
    routes.some((route) => !submittedByRoute.has(route.id))
  ) {
    throw new ImportRouteWorkflowError(
      "Planens fullständiga ruttuppsättning måste skickas med.",
      409,
    );
  }
  if (
    !recoveringZeroRoutePlan &&
    routes.some((route) => route.status !== "optimized")
  ) {
    throw new ImportRouteWorkflowError(
      "Endast optimerade, ännu ej publicerade planer kan planeras om.",
    );
  }
  if (
    !recoveringZeroRoutePlan &&
    routes.some(
      (route) =>
        route.planRevision !== submittedByRoute.get(route.id)?.planRevision,
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Ruttplanen ändrades av någon annan. Ladda om och försök igen.",
      409,
    );
  }
  // Service-time and reorder flows must retain the plan's persisted planning
  // contract. Only the protected planning-input operation may overlay it.
  const planningInputs = normalizePlanningInputs(
    input.planningInputs ?? routes[0]?.optimizationPlanningSnapshot,
  );

  const selectedPairs =
    input.pairs ??
    routes.map((route) => {
      const submitted = submittedByRoute.get(route.id)!;
      const driverId = isProtectedImportRoute(route)
        ? optimizationDriverIdForRoute(route)
        : submitted.driverId;
      if (!driverId) {
        throw new ImportRouteWorkflowError(
          "En skyddad rutt saknar sin optimeringsvalda chaufför. Välj en explicit resursändring.",
          409,
        );
      }
      return {
        vehicleId: route.vehicleId!,
        driverId,
      };
    });
  const vehicleIds = selectedPairs.map((pair) => pair.vehicleId);
  const driverIds = selectedPairs.map((pair) => pair.driverId);
  if (
    planningInputs.depotOverride?.scope === "pair" &&
    !selectedPairs.some(
      (pair) => pair.vehicleId === planningInputs.depotOverride?.vehicleId,
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Depåundantaget måste peka på ett aktivt valt fordon.",
      409,
    );
  }
  if (
    selectedPairs.length === 0 ||
    vehicleIds.some((id) => id == null) ||
    new Set(vehicleIds).size !== vehicleIds.length ||
    new Set(driverIds).size !== driverIds.length ||
    new Set(selectedPairs.map((pair) => `${pair.vehicleId}:${pair.driverId}`))
      .size !== selectedPairs.length
  ) {
    throw new ImportRouteWorkflowError(
      "Valda resurser måste vara unika bil–chaufförspar utan återanvänd bil eller chaufför.",
    );
  }
  const concreteVehicleIds = vehicleIds as string[];
  const stopScope =
    input.wholePlanOnly
      ? eq(stopsTable.planningPlanId, planId)
      : routeIds.length > 0
      ? or(
          inArray(stopsTable.routeId, routeIds),
          and(
            eq(stopsTable.planningPlanId, planId),
            isNull(stopsTable.routeId),
          ),
        )
      : and(eq(stopsTable.planningPlanId, planId), isNull(stopsTable.routeId));
  const [
    stops,
    vehicles,
    drivers,
    driverCertifications,
    organizations,
    expectedDraftRows,
  ] =
    await Promise.all([
      db
        .select()
        .from(stopsTable)
        .where(and(
          eq(stopsTable.organizationId, organizationId),
          stopScope,
          isNull(stopsTable.archivedAt),
        ))
        .orderBy(stopsTable.id),
      db
        .select()
        .from(vehiclesTable)
        .where(
          and(
            eq(vehiclesTable.organizationId, organizationId),
            inArray(vehiclesTable.id, concreteVehicleIds),
          ),
        )
        .orderBy(vehiclesTable.id),
      db
        .select()
        .from(driversTable)
        .where(
          and(
            eq(driversTable.organizationId, organizationId),
            inArray(driversTable.id, driverIds),
            eq(driversTable.isActive, true),
          ),
        )
        .orderBy(driversTable.id),
      db
        .select()
        .from(driverCertificationsTable)
        .where(
          and(
            eq(driverCertificationsTable.organizationId, organizationId),
            inArray(driverCertificationsTable.driverId, driverIds),
          ),
        )
        .orderBy(driverCertificationsTable.id),
      db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId)),
      input.protectedDraftUpdate
        ? db
            .select()
            .from(planningDraftsTable)
            .where(
              and(
                eq(
                  planningDraftsTable.id,
                  input.protectedDraftUpdate.draftId,
                ),
                eq(planningDraftsTable.organizationId, organizationId),
                eq(planningDraftsTable.planId, planId),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);
  if (
    recoveringZeroRoutePlan &&
    (stops.length !== input.recovery!.stopIds.length ||
      stops.some((stop) => !input.recovery!.stopIds.includes(stop.id)))
  ) {
    throw new ImportRouteWorkflowError(
      "Planens återställningsstopp ändrades av någon annan. Ladda om och försök igen.",
      409,
    );
  }
  const organization = organizations[0];
  if (input.expectedWholePlanStateFingerprint) {
    const expectedDraft = expectedDraftRows[0] ?? null;
    const stateFingerprint = payloadIdentityHash({
      organization,
      routes,
      stops,
      draft: expectedDraft,
      vehicles,
      drivers,
      certifications: driverCertifications,
      planningInputs: input.planningInputs ?? DEFAULT_PLANNING_INPUTS,
      pairs: selectedPairs,
    });
    if (stateFingerprint !== input.expectedWholePlanStateFingerprint) {
      throw new ImportRouteWorkflowError(
        "Planens eller resursernas underlag ändrades efter förhandsvisningen. Ladda om och förhandsgranska igen.",
        409,
      );
    }
  }
  const organizationPolicy = effectivePlanningPolicy(organization, input.planningInputs);
  planningInputs.maxDriverOvertimeMin = organizationPolicy.maxDriverOvertimeMin;
  planningInputs.allowLateStopsMin = organizationPolicy.allowLateStopsMin;
  const currentDepotSnapshot = verifiedDepotSnapshot(organization);
  const overrideSourceRoutes =
    planningInputs.depotOverride?.verifiedDepotId.startsWith("route:")
      ? await db
          .select({
            id: routesTable.id,
            depotSnapshot: routesTable.depotSnapshot,
          })
          .from(routesTable)
          .where(
            and(
              eq(routesTable.organizationId, organizationId),
              eq(
                routesTable.id,
                planningInputs.depotOverride.verifiedDepotId.slice(
                  "route:".length,
                ),
              ),
            ),
          )
      : [];
  const overrideDepotSnapshot = verifiedDepotOverrideSnapshot(
    planningInputs.depotOverride,
    organization,
    [...routes, ...overrideSourceRoutes],
  );
  const baseDepotForPair = (pair: { vehicleId: string; driverId: string }) => {
    const pairValue = `${pair.vehicleId}:${pair.driverId}`;
    if (input.recovery) return input.recovery.baseDepotSnapshots[pairValue];
    // The public legacy service-time API intentionally keeps its established
    // route-snapshot behavior. Base/effective transition semantics belong to
    // the protected planning-input transaction below.
    if (!input.protectedDraftUpdate) {
      return (
        routes.find((route) => route.vehicleId === pair.vehicleId)
          ?.depotSnapshot ?? currentDepotSnapshot
      );
    }
    return legacyBaseDepotSnapshot(
      routes.find((route) => route.vehicleId === pair.vehicleId),
      currentDepotSnapshot,
    );
  };
  const planDepotSnapshot =
    (planningInputs.depotOverride?.scope === "plan"
      ? overrideDepotSnapshot
      : undefined) ??
    selectedPairs.map(baseDepotForPair).find((snapshot) => snapshot != null) ??
    currentDepotSnapshot;
  if (planningInputs.depotOverride && !overrideDepotSnapshot) {
    throw new ImportRouteWorkflowError(
      "Dagens depåundantag kräver organisationens redan verifierade start- och slutdepå.",
    );
  }
  const depotLatitude =
    planDepotSnapshot?.start.latitude ??
    input.recovery?.baseDepotLatitude ??
    input.depotLatitude;
  const depotLongitude =
    planDepotSnapshot?.start.longitude ??
    input.recovery?.baseDepotLongitude ??
    input.depotLongitude;
  if (stops.length === 0) {
    throw new ImportRouteWorkflowError("Planen innehåller inga stopp.");
  }
  if (stops.some((stop) => stop.status !== "pending")) {
    throw new ImportRouteWorkflowError(
      "Planer med pågående eller avslutade stopp kan inte planeras om via servicetidsflödet. Använd säker omoptimering av återstående rutt.",
      409,
    );
  }
  // The legacy service-time endpoint has always represented a full replan of
  // existing routes. It cannot retain an extra, selected resource with no
  // customer stop; only the protected planning-input path may deliberately
  // report an unused selected pair.
  if (!input.protectedDraftUpdate && selectedPairs.length > stops.length) {
    throw new ImportRouteWorkflowError(
      "Fler bil–chaufförspar än stopp kan inte användas vid servicetidsomplanering.",
    );
  }
  if (
    vehicles.length !== selectedPairs.length ||
    drivers.length !== selectedPairs.length
  ) {
    throw new ImportRouteWorkflowError(
      "Varje vald bil måste ha exakt en vald aktiv chaufför.",
    );
  }

  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
  const adjustedDurations = serviceDurationsForReoptimization(
    stops.map((stop) => stop.serviceDurationMin),
    input.serviceDurationMin,
    input.serviceTimeStrategy,
  );
  const plannedStops = stops.map((stop, index) => ({
    ...stop,
    serviceDurationMin: adjustedDurations[index],
  }));
  const resources = selectedPairs.map((pair) => {
    const vehicle = vehicleById.get(pair.vehicleId);
    const driver = driverById.get(pair.driverId);
    if (
      !vehicle ||
      !driver ||
      !vehicle.isActive ||
      !driver.isActive ||
      driver.vehicleId !== vehicle.id
    ) {
      throw new ImportRouteWorkflowError(
        "Planens befintliga bil–chaufförspar är inte längre giltigt.",
      );
    }
    const route = routes.find(
      (candidate) => candidate.vehicleId === pair.vehicleId,
    );
    const appliesDepotOverride =
      planningInputs.depotOverride?.scope === "plan" ||
      (planningInputs.depotOverride?.scope === "pair" &&
        planningInputs.depotOverride.vehicleId === pair.vehicleId);
    const authoritativeDepot = appliesDepotOverride
      ? overrideDepotSnapshot
      : baseDepotForPair(pair);
    const routingVehicle = withOrganizationPlanningPolicy(
      applyDriverRoutingProfile(
        {
          id: vehicle.id,
          vehicleType: vehicle.vehicleType,
          capacityKg: vehicle.capacityKg,
          capacityVolume: vehicle.capacityVolume,
          rangeKm: effectiveRangeKm(vehicle),
        },
        driver,
      ),
      organizationPolicy,
    );
    if (authoritativeDepot) {
      routingVehicle.startLatitude = authoritativeDepot.start.latitude;
      routingVehicle.startLongitude = authoritativeDepot.start.longitude;
      routingVehicle.endLatitude = authoritativeDepot.end.latitude;
      routingVehicle.endLongitude = authoritativeDepot.end.longitude;
    }
    routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
    return {
      route,
      authoritativeDepot,
      vehicle,
      driver,
      routingVehicle,
    };
  });
  if (
    resources.some(
      (resource) =>
        !resource.authoritativeDepot &&
        !input.protectedDraftUpdate &&
        (resource.driver.startLatitude == null ||
          resource.driver.startLongitude == null ||
          !isValidCoordinate(
            resource.driver.startLatitude,
            resource.driver.startLongitude,
          )),
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Alla planens befintliga fordon måste ha giltiga startkoordinater.",
    );
  }
  await Promise.all(
    resources.map(async (resource) => {
      const ineligibleStopIds = new Set<string>();
      for (const stop of plannedStops) {
        if (stop.jobType !== "field_service") continue;
        try {
          await assertDriverEligibleForFieldService(
            resource.driver.id,
            resource.vehicle.id,
            fieldServiceRequirementsFromStop(stop),
            input.recovery?.planDate ?? routes[0]!.date,
          );
        } catch {
          ineligibleStopIds.add(stop.id);
        }
      }
      resource.routingVehicle.ineligibleStopIds = ineligibleStopIds;
    }),
  );

  const planDate = input.recovery?.planDate ?? routes[0]!.date;
  const planningNodes = plannedStops.map((stop) =>
    toAlnsNode(stop, planningInputs),
  );
  const persistedEvidence =
    routes[0]?.planningSummary?.optimizationEvidence ?? null;
  const effectiveWeights = input.planningInputs
    ? completeOptimizationWeights(planningWeights(planningInputs))
    : persistedEvidence?.effectiveWeights
      ? completeOptimizationWeights(persistedEvidence.effectiveWeights, persistedEvidence.effectiveObjective)
      : completeOptimizationWeights(undefined);
  const optimizationEvidence = input.planningInputs
    ? optimizationEvidenceForConfig({
        source: "planningInputs",
        planningInputs,
        requestedWeights: planningWeights(planningInputs),
        effectiveWeights,
        vehicleDistributionMode:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "minimize"
            : "balance",
      })
    : optimizationEvidenceForConfig({
        source:
          persistedEvidence && persistedEvidence.source !== "unknown"
            ? persistedEvidence.source
            : "legacy",
        planningInputs:
          persistedEvidence?.source === "planningInputs"
            ? planningInputs
            : undefined,
        requestedWeights:
          persistedEvidence?.requestedWeights ??
          (persistedEvidence?.source === "planningInputs"
            ? planningWeights(planningInputs)
            : null),
        effectiveWeights,
        vehicleDistributionMode:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "minimize"
            : "balance",
      });
  let result =
    input.cachedProposalResult ??
    (await optimizeWithALNS(
      planningNodes,
      resources.map((resource) => resource.routingVehicle),
      depotLatitude,
      depotLongitude,
      planDate,
      {
        ...policyToALNSConfig(
          resolveOptimizationPolicy(plannedStops.length, 12_000),
        ),
        timeLimitMs: 12_000,
        weights: effectiveWeights,
        vehicleDistributionMode:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "minimize"
            : "balance",
        driverConstraints: resources.map((resource) =>
          routingConstraintsForDriver(resource.driver),
        ),
      },
    ));
  const constraints = new Map(
    resources.map((resource) => [
      resource.vehicle.id,
      routingConstraintsForDriver(resource.driver),
    ]),
  );
  // These repair passes are part of the executable proposal. They are
  // intentionally skipped on apply because apply receives the exact result
  // produced by preview from the proposal cache.
  if (input.cachedProposalResult) {
    const currentLocks = await loadCanonicalLockInputs(planningNodes,
      resources.map(resource => resource.routingVehicle), depotLatitude, depotLongitude, planDate,
      { driverConstraints: resources.map(resource => routingConstraintsForDriver(resource.driver)) }, routeIds);
    const currentConstraints = new Map((currentLocks.config.driverConstraints ?? []).map(item => [item.vehicleId, item]));
    for (const frozen of currentLocks.input.currentRoutes ?? []) {
      assertFrozenRouteFeasible(frozen, currentLocks.input.routingVehicles.find(vehicle => vehicle.id === frozen.vehicleId),
        depotLatitude, depotLongitude, planDate, currentConstraints.get(frozen.vehicleId));
      const cached = result.routes.find(route => route.sourceRouteId === frozen.sourceRouteId);
      if (!cached?.optimizationFrozen || JSON.stringify(cached.nodes) !== JSON.stringify(frozen.nodes)) {
        throw new ImportRouteWorkflowError("Den frysta ruttens sparade förslag är inte längre aktuellt.", 409);
      }
    }
  }
  if (!input.cachedProposalResult) {
    reinsertUnassignedNodes(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraints,
      depotLatitude,
      depotLongitude,
      planDate,
      {
        weights: effectiveWeights,
        vehicleDistributionMode:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "minimize"
            : "balance",
      },
    );
    admitPrioritizedUnassignedNodes(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraints,
      depotLatitude,
      depotLongitude,
      planDate,
      {
        weights: effectiveWeights,
        vehicleDistributionMode:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "minimize"
            : "balance",
      },
    );
    if (planningInputs.vehicleSelectionMode === "use_all_selected_pairs") {
      fillExplicitlySelectedEmptyRoutes(
        result,
        resources.map((resource) => resource.routingVehicle),
        constraints,
        depotLatitude,
        depotLongitude,
        planDate,
        {
          weights: effectiveWeights,
          vehicleDistributionMode: "balance",
        },
      );
    }
    refreshOptimizationResult(
      result,
      resources.map((resource) => resource.routingVehicle),
      constraints,
      depotLatitude,
      depotLongitude,
      planDate,
      {
        weights: effectiveWeights,
        vehicleDistributionMode:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "minimize"
            : "balance",
      },
    );
  }
  // The protected planning-input path may deliberately leave selected pairs
  // unused (for example two pairs and one stop). Legacy service-time callers
  // are rejected above before that ambiguous partial replan can be persisted.
  if (!input.cachedProposalResult) {
    result = result.routes.some(route => route.optimizationFrozen || route.nodes.some(hasPlanningLock))
      ? result : await recoverPlanningCoverage(result, {
      organizationId, nodes: planningNodes,
      vehicles: resources.map(resource => resource.routingVehicle), constraints,
      depotLatitude, depotLongitude, start: planDate, weights: effectiveWeights,
      vehicleDistributionMode: planningInputs.vehicleSelectionMode === "minimize_vehicles" ? "minimize" : "balance",
      repairIncumbent: candidate => {
        const fleet = resources.map(resource => resource.routingVehicle);
        const objective = {
          weights: effectiveWeights,
          vehicleDistributionMode: (planningInputs.vehicleSelectionMode === "minimize_vehicles" ? "minimize" : "balance") as "minimize" | "balance",
        };
        reinsertUnassignedNodes(candidate, fleet, constraints, depotLatitude, depotLongitude, planDate, objective);
        admitPrioritizedUnassignedNodes(candidate, fleet, constraints, depotLatitude, depotLongitude, planDate, objective);
        if (planningInputs.vehicleSelectionMode === "use_all_selected_pairs") {
          fillExplicitlySelectedEmptyRoutes(candidate, fleet, constraints, depotLatitude, depotLongitude, planDate, objective);
        }
      },
    });
  }
  const optimizedByVehicle = new Map(
    result.routes.map((route) => [route.vehicleId, route]),
  );
  assertPlanningLockResult(planningNodes, result.routes, result.unassigned,
    resources.map(resource => resource.routingVehicle), depotLatitude, depotLongitude, planDate, constraints);
  const optimizedCustomerIds = result.routes.flatMap((route) =>
    route.nodes
      .filter((node) => !node.isChargingStation)
      .map((node) => node.id),
  );
  if (
    optimizedCustomerIds.length !== new Set(optimizedCustomerIds).size ||
    optimizedCustomerIds.some(
      (stopId) => !plannedStops.some((stop) => stop.id === stopId),
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Optimeraren returnerade inte planens exakta, unika stoppuppsättning.",
    );
  }
  const unplannedNodes = result.unassigned.filter(
    (node) => !node.isChargingStation,
  );
  const optimizedStopIdSet = new Set(optimizedCustomerIds);
  const unplannedStopIdSet = new Set(unplannedNodes.map((node) => node.id));
  if (
    optimizedStopIdSet.size !== optimizedCustomerIds.length ||
    unplannedStopIdSet.size !== unplannedNodes.length ||
    [...optimizedStopIdSet].some((stopId) => unplannedStopIdSet.has(stopId)) ||
    [...optimizedStopIdSet, ...unplannedStopIdSet].some(
      (stopId) => !plannedStops.some((stop) => stop.id === stopId),
    ) ||
    optimizedStopIdSet.size + unplannedStopIdSet.size !== plannedStops.length
  ) {
    throw new ImportRouteWorkflowError(
      "Optimeraren returnerade inte planens exakta stoppuppsättning.",
      409,
    );
  }
  const stopById = new Map(plannedStops.map((stop) => [stop.id, stop]));
  const diagnostics = classifyUnplannedNodes(
    unplannedNodes,
    stopById,
    resources,
    depotLatitude,
    depotLongitude,
    planDate,
  );
  const diagnosticByStopId = new Map(
    diagnostics.map((diagnostic) => [diagnostic.stopId, diagnostic.detail]),
  );
  if (
    !input.protectedDraftUpdate &&
    (unplannedNodes.length > 0 ||
      optimizedCustomerIds.length !== plannedStops.length)
  ) {
    throw new ImportRouteWorkflowError(
      "Alla stopp måste få plats vid ändring av servicetid. Ändra resurser eller använd planeringsunderlaget för att granska ej planerade stopp.",
      409,
    );
  }
  const usedPairValues = result.routes
    .filter((route) => route.nodes.some((node) => !node.isChargingStation))
    .map((route) => {
      const resource = resources.find(
        (candidate) => candidate.vehicle.id === route.vehicleId,
      )!;
      return `${resource.vehicle.id}:${resource.driver.id}`;
    });
  const planningSummary = {
    complete: !unplannedNodes.some(
      (node) => (node.planningPriority ?? 0) === 2,
    ),
    objective: planningInputs.objective,
    travelReservePercent: planningInputs.travelReservePercent,
    stopReserveMin: planningInputs.stopReserveMin,
    mandatoryUnplannedStopIds: unplannedNodes
      .filter((node) => (node.planningPriority ?? 0) === 2)
      .map((node) => node.id),
    selectedPairValues:
      input.originalSelectedPairValues ??
      selectedPairs.map((pair) => `${pair.vehicleId}:${pair.driverId}`),
    usedPairValues,
    unusedPairValues: resources
      .filter(
        (resource) =>
          !usedPairValues.includes(
            `${resource.vehicle.id}:${resource.driver.id}`,
          ),
      )
      .map((resource) => ({
        pairValue: `${resource.vehicle.id}:${resource.driver.id}`,
        reason:
          planningInputs.vehicleSelectionMode === "minimize_vehicles"
            ? "Inte aktivt eftersom målet är färre fordon."
            : "Kunde inte få ett kundstopp utan att bryta hårda planeringsvillkor.",
      })),
    unplanned: unplannedNodes.map((node) => ({
      stopId: node.id,
      priority: node.planningPriority ?? 0,
      reason:
        diagnosticByStopId.get(node.id) ??
        UNPLANNED_SEARCH_EXPLANATION,
    })),
    optimizationEvidence,
  };

  /**
   * This is deliberately built before the persistence transaction.  Whole
   * plan preview and apply use the same projection: preview returns it without
   * writing, while apply hashes it and compares the caller's preview token
   * before locking and mutating routes/stops.
   */
  const proposedRoutes = resources.flatMap((resource) => {
    const optimized = optimizedByVehicle.get(resource.vehicle.id);
    if (!optimized) return [];
    if (optimized.optimizationFrozen) {
      const saved = routes.find(route => route.id === optimized.sourceRouteId);
      if (!saved?.workdayTimeline || !saved.workdaySummary || !saved.depotSnapshot) {
        throw new ImportRouteWorkflowError("Den frysta ruttens sparade underlag saknas.", 409);
      }
      return [{
        routeId: saved.id as string | null, vehicleId: resource.vehicle.id, driverId: resource.driver.id,
        planRevision: saved.planRevision, nextPlanRevision: saved.planRevision, status: saved.status,
        stopIds: optimized.nodes.filter(node => !node.isChargingStation).map(node => node.id),
        totalDistanceKm: saved.totalDistanceKm ?? 0, totalDurationMin: saved.totalDurationMin ?? 0,
        plannerItinerary: saved.plannerItinerary!, depotSnapshot: saved.depotSnapshot as typeof resource.authoritativeDepot,
        workdaySummary: saved.workdaySummary, workdayTimeline: saved.workdayTimeline,
      }];
    }
    const customerNodes = optimized.nodes.filter(
      (node) => !node.isChargingStation,
    );
    if (customerNodes.length === 0) return [];
    const evaluation = evaluateRoute(
      optimized,
      resource.routingVehicle,
      depotLatitude,
      depotLongitude,
      planDate,
      constraints.get(resource.vehicle.id),
    );
    if (!evaluation.feasible) {
      throw new ImportRouteWorkflowError(
        "Optimeraren returnerade en ogiltig rutt.",
      );
    }
    const workday = evaluateRouteWorkday(
      optimized.nodes,
      resource.routingVehicle,
      depotLatitude,
      depotLongitude,
      planDate,
      constraints.get(resource.vehicle.id),
    );
    if (!workday.feasible) {
      throw new ImportRouteWorkflowError(
        workdayInfeasibilityMessage(workday, {
          vehicleName: resource.vehicle.name,
          breakStartTime: resource.driver.breakStartTime,
          breakEndTime: resource.driver.breakEndTime,
        }),
      );
    }
    const itinerary = itineraryForNodes(
      optimized.nodes,
      resource.routingVehicle,
      resource.driver,
      depotLatitude,
      depotLongitude,
      planDate,
    );
    return [{
      routeId: resource.route?.id ?? null,
      vehicleId: resource.vehicle.id,
      driverId: resource.driver.id,
      planRevision: resource.route?.planRevision ?? 0,
      nextPlanRevision: (resource.route?.planRevision ?? 0) + 1,
      status: resource.route?.status ?? "optimized",
      stopIds: customerNodes.map((node) => node.id),
      totalDistanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
      totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
      plannerItinerary: itinerary,
      depotSnapshot: resource.authoritativeDepot,
      workdaySummary: workday.summary,
      workdayTimeline: workday.events,
    }];
  });
  const proposalHash = payloadIdentityHash({
    planId,
    routes: input.routes
      .map((route) => ({
        routeId: route.routeId,
        planRevision: route.planRevision,
        driverId: route.driverId,
      }))
      .sort((left, right) => left.routeId.localeCompare(right.routeId)),
    pairs: selectedPairs
      .map((pair) => `${pair.vehicleId}:${pair.driverId}`)
      .sort(),
    planningInputs,
    unplannedStopIds: unplannedNodes
      .filter((node) => !node.isChargingStation)
      .map((node) => node.id)
      .sort(),
    routesAfter: proposedRoutes.map((route) => ({
      routeId: route.routeId,
      vehicleId: route.vehicleId,
      driverId: route.driverId,
      stopIds: route.stopIds,
      totalDistanceKm: route.totalDistanceKm,
      totalDurationMin: route.totalDurationMin,
      plannerItinerary: route.plannerItinerary,
      depotSnapshot: route.depotSnapshot,
      workdaySummary: route.workdaySummary,
      workdayTimeline: route.workdayTimeline,
    })),
  });
  if (
    input.expectedProposalHash != null &&
    input.expectedProposalHash !== proposalHash
  ) {
    throw new ImportRouteWorkflowError(
      "Förhandsvisningen är inte längre aktuell. Ladda om och förhandsgranska igen.",
      409,
    );
  }
  if (input.previewOnly) {
    return {
      routes: proposedRoutes,
      planningSummary,
      proposalHash,
      draftRevision: input.protectedDraftUpdate
        ? input.protectedDraftUpdate.expectedRevision + 1
        : undefined,
      unplannedStopIds: unplannedNodes
        .filter((node) => !node.isChargingStation)
        .map((node) => node.id),
      proposalResult: result,
    };
  }

  await serviceTimeReoptimizationBeforePersistHook?.();

  return db.transaction(async (tx) => {
    for (const routeId of [...routeIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }
    // Resource rows are part of the optimization snapshot. Lock and compare
    // them before writing so a concurrent fleet edit cannot make the computed
    // plan stale without also changing a route revision.
    const lockedVehicles = await tx
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.organizationId, organizationId),
          inArray(vehiclesTable.id, concreteVehicleIds),
        ),
      )
      .orderBy(vehiclesTable.id)
      .for("update");
    const lockedDrivers = await tx
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          inArray(driversTable.id, driverIds),
        ),
      )
      .orderBy(driversTable.id)
      .for("update");
    const lockedCertifications = await tx
      .select()
      .from(driverCertificationsTable)
      .where(
        and(
          eq(driverCertificationsTable.organizationId, organizationId),
          inArray(driverCertificationsTable.driverId, driverIds),
        ),
      )
      .orderBy(driverCertificationsTable.id)
      .for("update");
    const [lockedOrganization] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .for("update");
    const originalVehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle]),
    );
    const originalDriverById = new Map(
      drivers.map((driver) => [driver.id, driver]),
    );
    const originalCertificationById = new Map(
      driverCertifications.map((certification) => [
        certification.id,
        certification,
      ]),
    );
    const originalRouteById = new Map(routes.map((route) => [route.id, route]));
    if (
      lockedVehicles.length !== vehicles.length ||
      lockedDrivers.length !== drivers.length ||
      lockedCertifications.length !== driverCertifications.length ||
      lockedVehicles.some((vehicle) => {
        const original = originalVehicleById.get(vehicle.id);
        return !original || !sameOptimizationVehicle(original, vehicle);
      }) ||
      lockedDrivers.some((driver) => {
        const original = originalDriverById.get(driver.id);
        return !original || !sameOptimizationDriver(original, driver);
      }) ||
      lockedCertifications.some((certification) => {
        const original = originalCertificationById.get(certification.id);
        return !original || !sameDriverCertification(original, certification);
      }) ||
      !lockedOrganization ||
      !samePlanningDepot(lockedOrganization, organization) ||
      effectivePlanningPolicy(lockedOrganization, input.planningInputs).maxDriverOvertimeMin !==
        planningInputs.maxDriverOvertimeMin ||
      effectivePlanningPolicy(lockedOrganization, input.planningInputs).allowLateStopsMin !==
        planningInputs.allowLateStopsMin
    ) {
      throw new ImportRouteWorkflowError(
        "Planens bil- eller chaufförsresurser ändrades under omplaneringen. Ladda om och försök igen.",
        409,
      );
    }

    const lockedRoutes = await tx
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.planId, planId),
          ne(routesTable.status, "cancelled"),
        ),
      )
      .orderBy(routesTable.id)
      .for("update");
    if (
      lockedRoutes.length !== routes.length ||
      lockedRoutes.some(
        (route) => {
          const original = originalRouteById.get(route.id);
          return (
            route.status !== "optimized" ||
            route.planRevision !== submittedByRoute.get(route.id)?.planRevision ||
            route.vehicleId !== original?.vehicleId ||
            route.draftId !== original?.draftId ||
            (optimizationDriverIdForRoute(original) != null &&
              submittedByRoute.get(route.id)?.driverId !==
                optimizationDriverIdForRoute(original)) ||
            route.handoffStatus !== original?.handoffStatus ||
            route.handoffVersion !== original?.handoffVersion ||
            route.lockedFirstStopId !== original?.lockedFirstStopId ||
            route.optimizationFrozen !== original?.optimizationFrozen ||
            (input.wholePlanOnly &&
              (route.handoffStatus === "sent" ||
                route.handoffStatus === "received" ||
                route.handoffStatus === "opened" ||
                route.handoffStatus === "accepted")) ||
            route.date.getTime() !== original?.date.getTime() ||
            payloadIdentityHash(route.depotSnapshot ?? null) !==
              payloadIdentityHash(original?.depotSnapshot ?? null) ||
            payloadIdentityHash(route.optimizationPlanningSnapshot ?? null) !==
              payloadIdentityHash(original?.optimizationPlanningSnapshot ?? null) ||
            payloadIdentityHash(route.planningSummary?.optimizationEvidence ?? null) !==
              payloadIdentityHash(original?.planningSummary?.optimizationEvidence ?? null)
          );
        },
      )
    ) {
      throw new ImportRouteWorkflowError(
        "Ruttplanen ändrades eller publicerades av någon annan. Ladda om och försök igen.",
        409,
      );
    }
    const associatedDraftIds = [
      ...new Set(
        lockedRoutes
          .map((route) => route.draftId)
          .filter((draftId): draftId is string => Boolean(draftId)),
      ),
    ];
    if (associatedDraftIds.length > 1) {
      throw new ImportRouteWorkflowError(
        "Ruttplanen är kopplad till flera planeringsutkast.",
        409,
      );
    }
    const associatedDraftId =
      associatedDraftIds[0] ??
      (recoveringZeroRoutePlan
        ? (input.protectedDraftUpdate?.draftId ?? null)
        : null);
    const [associatedDraft] = associatedDraftId
      ? await tx
          .select()
          .from(planningDraftsTable)
          .where(
            and(
              eq(planningDraftsTable.id, associatedDraftId),
              eq(planningDraftsTable.organizationId, organizationId),
            ),
          )
          .limit(1)
          .for("update")
      : [];
    if (
      input.protectedDraftUpdate &&
      (!associatedDraft ||
        associatedDraft.id !== input.protectedDraftUpdate.draftId ||
        associatedDraft.planId !== planId ||
        associatedDraft.revision !==
          input.protectedDraftUpdate.expectedRevision)
    ) {
      throw new ImportRouteWorkflowError(
        "Planeringsutkastet ändrades under omoptimeringen. Ladda om och försök igen.",
        409,
      );
    }
    if (input.recovery) {
      if (
        !associatedDraft ||
        payloadIdentityHash(
          recoveryFromStoredPlanResult(associatedDraft.planResult),
        ) !== input.recovery.identityHash
      ) {
        throw new ImportRouteWorkflowError(
          "Planens återställningsunderlag ändrades under omoptimeringen. Ladda om och försök igen.",
          409,
        );
      }
    }
    const lockedStopScope =
      input.wholePlanOnly
        ? eq(stopsTable.planningPlanId, planId)
        : routeIds.length > 0
        ? or(
            inArray(stopsTable.routeId, routeIds),
            and(
              eq(stopsTable.planningPlanId, planId),
              isNull(stopsTable.routeId),
            ),
          )
        : and(
            eq(stopsTable.planningPlanId, planId),
            isNull(stopsTable.routeId),
          );
    const lockedStops = await tx
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.organizationId, organizationId),
          lockedStopScope,
          isNull(stopsTable.archivedAt),
        ),
      )
      .for("update");
    const expectedStopIds = new Set(stops.map((stop) => stop.id));
    if (
      lockedStops.length !== expectedStopIds.size ||
      lockedStops.some((stop) => {
        const original = stops.find((candidate) => candidate.id === stop.id);
        return (
          !expectedStopIds.has(stop.id) ||
          !original ||
          !sameOptimizationStop(original, stop)
        );
      })
    ) {
      throw new ImportRouteWorkflowError(
        "Planens stoppuppsättning ändrades av någon annan. Ladda om och försök igen.",
        409,
      );
    }

    const { dayStart, dayEnd } = stockholmPlanningDayBounds(planDate);
    const calendarRoutes = await tx
      .select({
        id: routesTable.id,
        planId: routesTable.planId,
      })
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          inArray(routesTable.vehicleId, concreteVehicleIds),
          ne(routesTable.status, "cancelled"),
          ne(routesTable.status, "completed"),
          gte(routesTable.date, dayStart),
          lt(routesTable.date, dayEnd),
        ),
      );
    const foreignCalendarRouteIds = calendarRoutes
      .filter((route) => route.planId !== planId)
      .map((route) => route.id);
    if (foreignCalendarRouteIds.length > 0) {
      const occupied = await tx
        .select({ id: stopsTable.id })
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.organizationId, organizationId),
            inArray(stopsTable.routeId, foreignCalendarRouteIds),
          ),
        );
      if (occupied.length > 0) {
        throw new ImportRouteWorkflowError(
          "En vald bil har redan en aktiv rutt på planeringsdatumet.",
          409,
        );
      }
      await tx
        .update(routesTable)
        .set({
          status: "cancelled",
          totalStops: 0,
          plannerItinerary: [],
          ...invalidatedRouteHandoff(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            inArray(routesTable.id, foreignCalendarRouteIds),
          ),
        );
    }

    const updatedRoutes = [];
    const retainedRouteIds = new Set<string>();
    if (unplannedNodes.length > 0) {
      for (const node of unplannedNodes) {
        await tx
          .update(stopsTable)
          .set({
            routeId: null,
            sequenceOrder: null,
            planningPlanId: planId,
            planningDate: planDate,
            unplannedReason:
              diagnosticByStopId.get(node.id) ??
              UNPLANNED_SEARCH_EXPLANATION,
          })
          .where(
            and(
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.id, node.id),
            ),
          );
      }
    }
    for (const resource of resources) {
      const optimized = optimizedByVehicle.get(resource.vehicle.id)!;
      if (!optimized) continue;
      if (optimized.optimizationFrozen) {
        const saved = routes.find(route => route.id === optimized.sourceRouteId);
        if (!saved?.optimizationFrozen || !saved.workdayTimeline || !saved.workdaySummary) {
          throw new ImportRouteWorkflowError("Den frysta ruttens sparade underlag saknas.", 409);
        }
        retainedRouteIds.add(saved.id);
        updatedRoutes.push({
          routeId: saved.id, vehicleId: resource.vehicle.id, driverId: resource.driver.id,
          stopCount: saved.totalStops, planRevision: saved.planRevision,
          distanceKm: saved.totalDistanceKm ?? 0, durationMin: saved.totalDurationMin ?? 0,
          co2EmissionsKg: saved.co2EmissionsKg ?? 0, status: saved.status,
          depotSnapshot: depotSnapshotForResponse(saved.depotSnapshot),
          workdayTimeline: workdayTimelineForResponse(saved.workdayTimeline),
          workdaySummary: workdaySummaryForResponse(saved.workdaySummary),
        });
        continue;
      }
      const customerNodes = optimized.nodes.filter(
        (node) => !node.isChargingStation,
      );
      if (customerNodes.length === 0) continue;
      const evaluation = evaluateRoute(
        optimized,
        resource.routingVehicle,
        depotLatitude,
        depotLongitude,
        planDate,
        constraints.get(resource.vehicle.id),
      );
      if (!evaluation.feasible) {
        throw new ImportRouteWorkflowError(
          "Optimeraren returnerade en ogiltig rutt.",
        );
      }
      let targetRoute = resource.route;
      if (optimized.sourceRouteId && targetRoute?.id !== optimized.sourceRouteId) {
        throw new ImportRouteWorkflowError("Ett låst uppdrag måste behålla sin ursprungliga ruttidentitet.", 409);
      }
      if (!targetRoute) {
        [targetRoute] = await tx
          .insert(routesTable)
          .values({
            planId,
            draftId: associatedDraftId,
            organizationId,
            vehicleId: resource.vehicle.id,
            name: associatedDraft
              ? `${associatedDraft.name} – ${resource.vehicle.name} – ${draftRouteStartAtLabel(planDate)}`
              : `${resource.vehicle.name} – ${planDate.toLocaleDateString("sv-SE")}`,
            status: "optimized",
            manualReviewRequired: true,
            manualReviewedAt: null,
            planRevision: 0,
            date: planDate,
            totalStops: 0,
            plannerItinerary: [],
            customerReference:
              routes[0]?.customerReference ??
              input.recovery?.customerReference ??
              null,
            depotSnapshot: resource.authoritativeDepot ?? null,
            ...invalidatedRouteHandoff(),
          })
          .returning();
      }
      retainedRouteIds.add(targetRoute.id);
      for (let index = 0; index < customerNodes.length; index++) {
        const plannedStop = plannedStops.find(
          (stop) => stop.id === customerNodes[index].id,
        )!;
        const [saved] = await tx
          .update(stopsTable)
          .set({
            routeId: targetRoute.id,
            sequenceOrder: index + 1,
            serviceDurationMin: plannedStop.serviceDurationMin,
            unplannedReason: null,
          })
          .where(
            and(
              eq(stopsTable.id, plannedStop.id),
              eq(stopsTable.organizationId, organizationId),
              input.wholePlanOnly
                ? eq(stopsTable.planningPlanId, planId)
                : or(
                    inArray(stopsTable.routeId, routeIds),
                    and(
                      eq(stopsTable.planningPlanId, planId),
                      isNull(stopsTable.routeId),
                    ),
                  ),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!saved) {
          throw new ImportRouteWorkflowError(
            "Planens stopp ändrades under omplaneringen.",
            409,
          );
        }
      }
      const workday = evaluateRouteWorkday(
        optimized.nodes,
        resource.routingVehicle,
        depotLatitude,
        depotLongitude,
        planDate,
        constraints.get(resource.vehicle.id),
      );
      if (!workday.feasible) {
        throw new ImportRouteWorkflowError(
          workdayInfeasibilityMessage(workday, {
            vehicleName: resource.vehicle.name,
            breakStartTime: resource.driver.breakStartTime,
            breakEndTime: resource.driver.breakEndTime,
          }),
        );
      }
      const itinerary = itineraryForNodes(
        optimized.nodes,
        resource.routingVehicle,
        resource.driver,
        depotLatitude,
        depotLongitude,
        planDate,
      );
      const roundedDistance = Math.round(workday.totalDistanceKm * 100) / 100;
      const roundedDuration = Math.round(workday.summary.totalMin * 100) / 100;
      const optimizedStopsForSnapshot = customerNodes
        .map((node, index) => {
          const stop = plannedStops.find(
            (candidate) => candidate.id === node.id,
          );
          return stop
            ? { ...stop, routeId: targetRoute.id, sequenceOrder: index + 1 }
            : null;
        })
        .filter((stop): stop is NonNullable<typeof stop> => stop != null);
      if (resource.route) {
        assertPlanningLockOrder(resource.route, stops.filter(stop => stop.routeId === resource.route!.id), optimizedStopsForSnapshot);
        assertPlanningLockTimes(resource.route, optimizedStopsForSnapshot, workday.events);
      }
      const certificationsForDriver = lockedCertifications.filter(
        (certification) => certification.driverId === resource.driver.id,
      );
      const [savedRoute] = await tx
        .update(routesTable)
        .set({
          totalStops: customerNodes.length,
          totalDistanceKm: roundedDistance,
          totalDurationMin: roundedDuration,
          co2EmissionsKg:
            Math.round(
              estimateCo2(
                workday.totalDistanceKm,
                resource.vehicle.vehicleType,
                optimized.totalWeight,
                resource.routingVehicle.capacityKg,
              ) * 100,
            ) / 100,
          plannerItinerary: itinerary,
          // Write the newly resolved base/effective depot even when it is null:
          // retaining the old value here would resurrect a cleared override.
          depotSnapshot: resource.authoritativeDepot ?? null,
          workdayTimeline: workday.events,
          workdaySummary: workday.summary,
          optimizationPlanningSnapshot: planningInputs,
          optimizationPlanningSnapshotHash: payloadIdentityHash(planningInputs),
          sharedInstructions:
            input.sharedInstructions === undefined
              ? targetRoute.sharedInstructions
              : input.sharedInstructions,
          planningSummary,
          optimizationResourceSnapshot: materialResourceSnapshot(
            resource.vehicle,
            resource.driver,
            optimizedStopsForSnapshot,
            certificationsForDriver,
          ),
          optimizationResourceSnapshotHash: materialResourceSnapshotHash(
            resource.vehicle,
            resource.driver,
            optimizedStopsForSnapshot,
            certificationsForDriver,
          ),
          geographicOverlapExplanation: null,
          manualReviewedAt: null,
          planRevision: targetRoute.planRevision + 1,
          ...workingRouteHandoff(),
        })
        .where(
          and(
            eq(routesTable.id, targetRoute.id),
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.status, "optimized"),
            eq(routesTable.planRevision, targetRoute.planRevision),
          ),
        )
        .returning();
      if (!savedRoute) {
        throw new ImportRouteWorkflowError(
          "Planen ändrades under omplaneringen.",
          409,
        );
      }
      updatedRoutes.push({
        routeId: savedRoute.id,
        planId: savedRoute.planId,
        name: savedRoute.name,
        vehicleId: resource.vehicle.id,
        driverId: resource.driver.id,
        stopCount: customerNodes.length,
        totalDistanceKm: roundedDistance,
        totalDurationMin: roundedDuration,
        planRevision: savedRoute.planRevision,
        status: "optimized" as const,
        depotSnapshot: depotSnapshotForResponse(savedRoute.depotSnapshot),
        workdayTimeline: workdayTimelineForResponse(savedRoute.workdayTimeline),
        workdaySummary: workdaySummaryForResponse(savedRoute.workdaySummary),
      });
    }
    // Persist bounded overlap evidence for the final, valid routes rather than
    // erasing it during reoptimization. A cancelled/unused route is excluded.
    const overlapExplanations = await explainGeographicRouteOverlapAsync(
      result.routes,
      resources.map((resource) => resource.routingVehicle),
      depotLatitude,
      depotLongitude,
      planDate,
      resources.map((resource) => routingConstraintsForDriver(resource.driver)),
    );
    for (const updatedRoute of updatedRoutes) {
      if (routes.some(route => route.id === updatedRoute.routeId && route.optimizationFrozen)) continue;
      const geographicOverlapExplanation =
        overlapExplanations.get(updatedRoute.vehicleId) ?? null;
      await tx
        .update(routesTable)
        .set({ geographicOverlapExplanation })
        .where(
          and(
            eq(routesTable.id, updatedRoute.routeId),
            eq(routesTable.organizationId, organizationId),
          ),
        );
      Object.assign(updatedRoute, { geographicOverlapExplanation });
    }
    const cancelledRouteIds = routes
      .map((route) => route.id)
      .filter((routeId) => !retainedRouteIds.has(routeId));
    if (cancelledRouteIds.length > 0) {
      await tx
        .update(routesTable)
        .set({
          status: "cancelled",
          totalStops: 0,
          totalDistanceKm: 0,
          totalDurationMin: 0,
          plannerItinerary: [],
          geographicOverlapExplanation: null,
          planningSummary,
          manualReviewedAt: null,
          ...invalidatedRouteHandoff(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            inArray(routesTable.id, cancelledRouteIds),
          ),
        );
    }
    if (associatedDraftId) {
      await tx
        .update(routesTable)
        .set({ draftId: associatedDraftId })
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.planId, planId),
          ),
        );
    }
    let draftRevision: number | undefined;
    if (input.protectedDraftUpdate && associatedDraft) {
      const storedSharedInstructions = (
        associatedDraft.state.planningMetadata as
          | Record<string, unknown>
          | undefined
      )?.sharedInstructions;
      const nextSharedInstructions: string | null =
        input.sharedInstructions === undefined
          ? typeof storedSharedInstructions === "string"
            ? storedSharedInstructions
            : null
          : input.sharedInstructions;
      const releasedStopIds = Array.isArray(
        associatedDraft.planResult?.releasedStopIds,
      )
        ? associatedDraft.planResult.releasedStopIds.filter(
            (stopId): stopId is string => typeof stopId === "string",
          )
        : [];
      const nextUnassignedStopIds = [
        ...new Set([
          ...unplannedNodes.map((node) => node.id),
          ...releasedStopIds,
        ]),
      ];
      const [savedDraft] = await tx
        .update(planningDraftsTable)
        .set({
          state: {
            ...associatedDraft.state,
            planningInputs,
            planningMetadata: {
              ...(associatedDraft.state.planningMetadata &&
              typeof associatedDraft.state.planningMetadata === "object"
                ? associatedDraft.state.planningMetadata
                : {}),
              sharedInstructions: nextSharedInstructions,
            },
          },
          planResult: {
            ...(associatedDraft.planResult ?? {}),
            planId,
            routes: updatedRoutes,
            planningSummary:
              releasedStopIds.length > 0
                ? {
                    ...planningSummary,
                    complete: false,
                    unassignedStopIds: nextUnassignedStopIds,
                  }
                : planningSummary,
            planningInputs,
            unassignedStopIds: nextUnassignedStopIds,
            releasedStopIds,
            customerReference:
              routes[0]?.customerReference ??
              input.recovery?.customerReference ??
              null,
            sharedInstructions: nextSharedInstructions,
          },
          revision: associatedDraft.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(planningDraftsTable.id, associatedDraft.id),
            eq(planningDraftsTable.organizationId, organizationId),
            eq(
              planningDraftsTable.revision,
              input.protectedDraftUpdate.expectedRevision,
            ),
          ),
        )
        .returning({ revision: planningDraftsTable.revision });
      if (!savedDraft) {
        throw new ImportRouteWorkflowError(
          "Planeringsutkastet ändrades under omoptimeringen. Ladda om och försök igen.",
          409,
        );
      }
      draftRevision = savedDraft.revision;
    }
    return {
      routes: updatedRoutes,
      planningSummary,
      draftRevision,
      proposalHash,
      proposalResult: undefined,
    };
  });
}

export type WholePlanReoptimizationInput = {
  draftId?: string | null;
  draftRevision?: number | null;
  routes: Array<{
    routeId: string;
    driverId: string;
    planRevision: number;
  }>;
  pairs?: Array<{ vehicleId: string; driverId: string }>;
  depotLatitude: number;
  depotLongitude: number;
  proposalHash?: string;
};

const WHOLE_PLAN_PROPOSAL_TTL_MS = 10 * 60_000;

type CachedWholePlanProposal = {
  organizationId: string;
  planId: string;
  proposalHash: string;
  createdAt: number;
  expiresAt: number;
  requestFingerprint: string;
  stateFingerprint: string;
  result: ALNSResult;
};

// Preserve the exact executable result across process restarts/instances.
// Atomic route-input CAS remains authoritative at apply time.
async function cacheWholePlanProposal(proposal: CachedWholePlanProposal): Promise<void> {
  await saveRuntimeState(proposal.organizationId, "whole-plan-proposal",
    `${proposal.planId}:${proposal.proposalHash}`, proposal, WHOLE_PLAN_PROPOSAL_TTL_MS);
}

async function getCachedWholePlanProposal(
  organizationId: string,
  planId: string,
  proposalHash: string,
): Promise<CachedWholePlanProposal> {
  const stored = await loadRuntimeState<CachedWholePlanProposal>(
    organizationId, "whole-plan-proposal", `${planId}:${proposalHash}`,
  );
  const proposal = stored?.value;
  if (!proposal) {
    throw new ImportRouteWorkflowError(
      "Förhandsvisningen har gått ut eller finns inte längre. Förhandsgranska planen igen.",
      409,
    );
  }
  return proposal;
}

type WholePlanBeforeState = {
  routes: Array<typeof routesTable.$inferSelect>;
  stops: Array<typeof stopsTable.$inferSelect>;
  draft: typeof planningDraftsTable.$inferSelect | null;
  pairs: Array<{ vehicleId: string; driverId: string }>;
  planningInputs: PlanningInputsV1;
  stateFingerprint: string;
};

type WholePlanAfterState = {
  routeId: string | null;
  vehicleId: string;
  driverId: string;
  planRevision: number;
  nextPlanRevision: number;
  status: "draft" | "optimized" | "in_progress" | "completed" | "cancelled";
  stopIds: string[];
  totalDistanceKm: number | null;
  totalDurationMin: number | null;
};

async function loadWholePlanReoptimizationState(
  organizationId: string,
  planId: string,
  input: WholePlanReoptimizationInput,
): Promise<WholePlanBeforeState> {
  const routes = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planId, planId),
        ne(routesTable.status, "cancelled"),
      ),
    )
    .orderBy(routesTable.id);
  if (routes.length === 0) {
    throw new ImportRouteWorkflowError("Ruttplanen saknas.", 409);
  }
  const requestedRoutes = new Map(
    input.routes.map((route) => [route.routeId, route]),
  );
  if (
    routes.some((route) => {
      const requested = requestedRoutes.get(route.id);
      const currentDriverId = optimizationDriverIdForRoute(route);
      return (
        !requested ||
        (currentDriverId != null && requested.driverId !== currentDriverId)
      );
    }) ||
    input.routes.length !== routes.length
  ) {
    throw new ImportRouteWorkflowError(
      "Ruttens chaufför eller urval ändrades. Ladda om och förhandsgranska igen.",
      409,
    );
  }
  if (
    routes.some(
      (route) =>
        route.status !== "optimized" ||
        route.handoffStatus === "sent" ||
        route.handoffStatus === "received" ||
        route.handoffStatus === "opened" ||
        route.handoffStatus === "accepted",
    )
  ) {
    throw new ImportRouteWorkflowError(
      "En hel plan kan bara optimeras om innan körningen har startat. Välj rutt för att optimera återstående stopp.",
      409,
    );
  }

  const stops = await db
    .select()
    .from(stopsTable)
    .where(
      and(
        eq(stopsTable.organizationId, organizationId),
        eq(stopsTable.planningPlanId, planId),
        isNull(stopsTable.archivedAt),
      ),
    )
    .orderBy(stopsTable.id);
  if (stops.length === 0) {
    throw new ImportRouteWorkflowError("Planen innehåller inga stopp.", 409);
  }
  if (stops.some((stop) => stop.status !== "pending")) {
    throw new ImportRouteWorkflowError(
      "En hel plan kan inte optimeras om efter att ett stopp har påbörjats eller avslutats. Välj rutt för att optimera återstående stopp.",
      409,
    );
  }

  const draftIds = [...new Set(
    routes
      .map((route) => route.draftId)
      .filter((draftId): draftId is string => draftId != null),
  )];
  if (draftIds.length > 1) {
    throw new ImportRouteWorkflowError(
      "Ruttplanen är kopplad till flera planeringsutkast.",
      409,
    );
  }
  const routeDraftId = draftIds[0] ?? null;
  const requestedDraftId = input.draftId ?? null;
  if (routeDraftId !== requestedDraftId) {
    throw new ImportRouteWorkflowError(
      routeDraftId
        ? "Det namngivna planeringsutkastet måste följa med vid omoptimering."
        : "Planen saknar det begärda planeringsutkastet.",
      409,
    );
  }
  let draft: typeof planningDraftsTable.$inferSelect | null = null;
  if (routeDraftId) {
    [draft] = await db
      .select()
      .from(planningDraftsTable)
      .where(
        and(
          eq(planningDraftsTable.id, routeDraftId),
          eq(planningDraftsTable.organizationId, organizationId),
          eq(planningDraftsTable.planId, planId),
        ),
      )
      .limit(1);
    if (!draft || input.draftRevision == null || draft.revision !== input.draftRevision) {
      throw new ImportRouteWorkflowError(
        "Planeringsutkastet ändrades. Ladda om och förhandsgranska igen.",
        409,
      );
    }
  } else if (input.draftRevision != null) {
    throw new ImportRouteWorkflowError(
      "Planeringsutkastets revision saknas för planen.",
      409,
    );
  }

  // A named draft is the source of truth for the protected planning contract.
  // Route snapshots are intentionally not used here: older routes can contain
  // sparse snapshots from before the draft was canonicalized.
  const draftState =
    draft?.state && typeof draft.state === "object" && !Array.isArray(draft.state)
      ? (draft.state as Record<string, unknown>)
      : null;
  const draftPlanningInputs = draftState?.planningInputs;
  if (draft && draftPlanningInputs == null) {
    throw new ImportRouteWorkflowError(
      "Det namngivna planeringsutkastet saknar sitt kanoniska planeringsunderlag.",
      409,
    );
  }
  const persistedInputs = normalizePlanningInputs(
    draftPlanningInputs ?? routes[0].optimizationPlanningSnapshot,
  );
  if (
    Object.keys(persistedInputs.stopPriorities).some(
      (stopId) => !stops.some((stop) => stop.id === stopId),
    )
  ) {
    throw new ImportRouteWorkflowError(
      "Planeringsunderlaget innehåller en prioritet för ett stopp som inte finns i planen.",
      409,
    );
  }
  const planningInputs = effectivePlanningInputsForStops(
    persistedInputs,
    stops,
  );
  const storedPairValues = (
    routes[0].planningSummary?.selectedPairValues ??
    routes
      .map((route) => {
        const driverId = optimizationDriverIdForRoute(route);
        return route.vehicleId && driverId
          ? `${route.vehicleId}:${driverId}`
          : null;
      })
      .filter((value): value is string => value != null)
  );
  const pairs = input.pairs
    ? input.pairs
    : activeOriginalPairs(storedPairValues, persistedInputs);
  if (pairs.some((pair) =>
    persistedInputs.excludedPairValues.includes(`${pair.vehicleId}:${pair.driverId}`),
  )) {
    throw new ImportRouteWorkflowError(
      "Det valda resursurvalet innehåller en resurs som är undantagen i planeringsunderlaget.",
      409,
    );
  }

  const vehicleIds = [...new Set(pairs.map((pair) => pair.vehicleId))];
  const driverIds = [...new Set(pairs.map((pair) => pair.driverId))];
  const [[organization], vehicles, drivers, certifications] = await Promise.all([
    db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1),
    db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.organizationId, organizationId),
          inArray(vehiclesTable.id, vehicleIds),
        ),
      )
      .orderBy(vehiclesTable.id),
    db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          inArray(driversTable.id, driverIds),
        ),
      )
      .orderBy(driversTable.id),
    db
      .select()
      .from(driverCertificationsTable)
      .where(
        and(
          eq(driverCertificationsTable.organizationId, organizationId),
          inArray(driverCertificationsTable.driverId, driverIds),
        ),
      )
      .orderBy(driverCertificationsTable.id),
  ]);
  if (!organization || vehicles.length !== vehicleIds.length || drivers.length !== driverIds.length) {
    throw new ImportRouteWorkflowError(
      "Planens bil- eller chaufförsresurser saknas. Ladda om och försök igen.",
      409,
    );
  }
  return {
    routes,
    stops,
    draft,
    pairs,
    planningInputs,
    stateFingerprint: payloadIdentityHash({
      organization,
      routes,
      stops,
      draft,
      vehicles,
      drivers,
      certifications,
      planningInputs,
      pairs,
    }),
  };
}

function wholePlanAfterFromPreview(
  previewRoutes: Array<{
    routeId: string | null;
    vehicleId: string;
    driverId: string;
    planRevision: number;
    nextPlanRevision: number;
    status: string;
    stopIds: string[];
    totalDistanceKm: number;
    totalDurationMin: number;
  }>,
): WholePlanAfterState[] {
  return previewRoutes.map((route) => ({
    routeId: route.routeId,
    vehicleId: route.vehicleId,
    driverId: route.driverId,
    planRevision: route.planRevision,
    nextPlanRevision: route.nextPlanRevision,
    status: route.status as WholePlanAfterState["status"],
    stopIds: route.stopIds,
    totalDistanceKm: route.totalDistanceKm,
    totalDurationMin: route.totalDurationMin,
  }));
}

async function wholePlanAfterFromDatabase(
  organizationId: string,
  planId: string,
  before: WholePlanBeforeState,
  pairs: Array<{ vehicleId: string; driverId: string }>,
): Promise<WholePlanAfterState[]> {
  const routes = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planId, planId),
      ),
    )
    .orderBy(routesTable.id);
  const relevantIds = new Set(before.routes.map((route) => route.id));
  const activeOrHistorical = routes.filter(
    (route) => route.status !== "cancelled" || relevantIds.has(route.id),
  );
  const routeIds = activeOrHistorical.map((route) => route.id);
  const stops = routeIds.length === 0
    ? []
    : await db
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.organizationId, organizationId),
          inArray(stopsTable.routeId, routeIds),
        ),
      )
      .orderBy(stopsTable.sequenceOrder);
  const driverByVehicle = new Map(pairs.map((pair) => [pair.vehicleId, pair.driverId]));
  return activeOrHistorical.map((route) => ({
    routeId: route.id,
    vehicleId: route.vehicleId ?? driverByVehicle.keys().next().value ?? "",
    driverId:
      optimizationDriverIdForRoute(route) ??
      (route.vehicleId ? driverByVehicle.get(route.vehicleId) : undefined) ??
      "",
    planRevision: route.planRevision,
    nextPlanRevision: route.planRevision,
    status: route.status,
    stopIds: stops
      .filter((stop) => stop.routeId === route.id)
      .sort((left, right) => (left.sequenceOrder ?? 0) - (right.sequenceOrder ?? 0))
      .map((stop) => stop.id),
    totalDistanceKm: route.totalDistanceKm,
    totalDurationMin: route.totalDurationMin,
  }));
}

function wholePlanReoptimizationResult(
  planId: string,
  before: WholePlanBeforeState,
  after: WholePlanAfterState[],
  proposalHash: string,
): {
  planId: string;
  draftId: string | null;
  draftRevision: number | null;
  proposalHash: string;
  lockedStopCount: number;
  movedStopCount: number;
  routes: Array<{
    routeId: string | null;
    vehicleId: string;
    driverId: string;
    planRevision: number;
    nextPlanRevision: number;
    status: WholePlanAfterState["status"];
    lockedStopIds: string[];
    pendingStopIds: string[];
    optimizedStopIds: string[];
    movedStopCount: number;
    before: {
      stopCount: number;
      distanceKm: number | null;
      durationMin: number | null;
    };
    after: {
      stopCount: number;
      distanceKm: number | null;
      durationMin: number | null;
    };
  }>;
} {
  const beforeByRouteId = new Map(before.routes.map((route) => [route.id, route]));
  const beforePlacement = new Map(
    before.stops.map((stop) => [
      stop.id,
      { routeId: stop.routeId, sequenceOrder: stop.sequenceOrder },
    ]),
  );
  const afterPlacement = new Map(
    after.flatMap((route) =>
      route.stopIds.map((stopId, index) => [
        stopId,
        { routeId: route.routeId ?? `vehicle:${route.vehicleId}`, sequenceOrder: index + 1 },
      ] as const),
    ),
  );
  const movedStopIds = new Set(
    before.stops
      .filter((stop) => {
        const previous = beforePlacement.get(stop.id);
        const next = afterPlacement.get(stop.id);
        return !next ||
          previous?.routeId !== next.routeId ||
          previous?.sequenceOrder !== next.sequenceOrder;
      })
      .map((stop) => stop.id),
  );
  const afterByRouteId = new Map(
    after
      .filter((route) => route.routeId != null)
      .map((route) => [route.routeId!, route]),
  );
  const allRouteIds = [
    ...before.routes.map((route) => route.id),
    ...after.filter((route) => route.routeId == null).map((route) => `vehicle:${route.vehicleId}`),
  ];
  const routes = allRouteIds.map((routeKey) => {
    const current = beforeByRouteId.get(routeKey);
    const next = afterByRouteId.get(routeKey) ??
      after.find((route) => route.routeId == null && `vehicle:${route.vehicleId}` === routeKey);
    const vehicleId = next?.vehicleId ?? current?.vehicleId ?? "";
    const driverId = next?.driverId ??
      (current ? optimizationDriverIdForRoute(current) : null) ??
      "";
    const pendingStopIds = next?.stopIds ?? [];
    const routeMoved = pendingStopIds.filter((stopId) => movedStopIds.has(stopId)).length;
    return {
      routeId: current?.id ?? next?.routeId ?? null,
      vehicleId,
      driverId,
      planRevision: current?.planRevision ?? next?.planRevision ?? 0,
      nextPlanRevision: next?.nextPlanRevision ??
        (current ? current.planRevision + 1 : 1),
      status: next?.status ?? "cancelled",
      lockedStopIds: [],
      pendingStopIds,
      optimizedStopIds: pendingStopIds,
      movedStopCount: routeMoved,
      before: {
        stopCount: before?.stops.filter((stop) => stop.routeId === current?.id).length ?? 0,
        distanceKm: current?.totalDistanceKm ?? null,
        durationMin: current?.totalDurationMin ?? null,
      },
      after: {
        stopCount: pendingStopIds.length,
        distanceKm: next?.totalDistanceKm ?? 0,
        durationMin: next?.totalDurationMin ?? 0,
      },
    };
  });
  return {
    planId,
    draftId: before.draft?.id ?? null,
    draftRevision: before.draft ? before.draft.revision + 1 : null,
    proposalHash,
    lockedStopCount: 0,
    movedStopCount: movedStopIds.size,
    routes,
  };
}

function wholePlanRequestFingerprint(
  planId: string,
  input: WholePlanReoptimizationInput,
  before: WholePlanBeforeState,
): string {
  return payloadIdentityHash({
    planId,
    draftId: before.draft?.id ?? null,
    draftRevision: before.draft?.revision ?? null,
    routes: input.routes
      .map((route) => ({ ...route }))
      .sort((left, right) => left.routeId.localeCompare(right.routeId)),
    pairs: before.pairs
      .map((pair) => ({ ...pair }))
      .sort((left, right) =>
        `${left.vehicleId}:${left.driverId}`.localeCompare(
          `${right.vehicleId}:${right.driverId}`,
        ),
      ),
    depotLatitude: input.depotLatitude,
    depotLongitude: input.depotLongitude,
    planningInputs: before.planningInputs,
  });
}

/**
 * Whole-plan entry point used by the in-place planner/dispatch actions.  It
 * delegates route construction and atomic persistence to the existing import
 * reoptimizer. Preview stores the complete executable result in a bounded,
 * tenant/plan-bound cache. Apply consumes that result and never re-runs ALNS.
 */
export async function previewWholePlanReoptimization(
  organizationId: string,
  planId: string,
  input: WholePlanReoptimizationInput,
) {
  const before = await loadWholePlanReoptimizationState(organizationId, planId, input);
  const requestFingerprint = wholePlanRequestFingerprint(planId, input, before);
  const result = await reoptimizeImportRoutePlanServiceTime(
    organizationId,
    planId,
    {
      serviceDurationMin: 0,
      serviceTimeStrategy: "preserve_exact",
      routes: input.routes,
      pairs: before.pairs,
      depotLatitude: input.depotLatitude,
      depotLongitude: input.depotLongitude,
      planningInputs: before.planningInputs,
      originalSelectedPairValues: before.pairs.map(
        (pair) => `${pair.vehicleId}:${pair.driverId}`,
      ),
      ...(before.draft
        ? {
            protectedDraftUpdate: {
              draftId: before.draft.id,
              expectedRevision: before.draft.revision,
            },
          }
        : {}),
      previewOnly: true,
      wholePlanOnly: true,
      expectedWholePlanStateFingerprint: before.stateFingerprint,
    },
  );
  if (!result.proposalResult) {
    throw new ImportRouteWorkflowError(
      "Förhandsvisningen saknar ett körbart optimeringsförslag.",
      409,
    );
  }
  const cachedAt = Date.now();
  await cacheWholePlanProposal({
    organizationId,
    planId,
    proposalHash: result.proposalHash,
    createdAt: cachedAt,
    expiresAt: cachedAt + WHOLE_PLAN_PROPOSAL_TTL_MS,
    requestFingerprint,
    stateFingerprint: before.stateFingerprint,
    result: result.proposalResult,
  });
  const after = wholePlanAfterFromPreview(
    result.routes as Parameters<typeof wholePlanAfterFromPreview>[0],
  );
  return wholePlanReoptimizationResult(
    planId,
    before,
    after,
    result.proposalHash,
  );
}

export async function applyWholePlanReoptimization(
  organizationId: string,
  planId: string,
  input: WholePlanReoptimizationInput & { proposalHash: string },
) {
  const cached = await getCachedWholePlanProposal(
    organizationId,
    planId,
    input.proposalHash,
  );
  const before = await loadWholePlanReoptimizationState(organizationId, planId, input);
  if (
    cached.requestFingerprint !==
      wholePlanRequestFingerprint(planId, input, before) ||
    cached.stateFingerprint !== before.stateFingerprint
  ) {
    throw new ImportRouteWorkflowError(
      "Planens eller resursernas underlag ändrades efter förhandsvisningen. Ladda om och förhandsgranska igen.",
      409,
    );
  }
  const result = await reoptimizeImportRoutePlanServiceTime(
    organizationId,
    planId,
    {
      serviceDurationMin: 0,
      serviceTimeStrategy: "preserve_exact",
      routes: input.routes,
      pairs: before.pairs,
      depotLatitude: input.depotLatitude,
      depotLongitude: input.depotLongitude,
      planningInputs: before.planningInputs,
      originalSelectedPairValues: before.pairs.map(
        (pair) => `${pair.vehicleId}:${pair.driverId}`,
      ),
      ...(before.draft
        ? {
            protectedDraftUpdate: {
              draftId: before.draft.id,
              expectedRevision: before.draft.revision,
            },
          }
        : {}),
      expectedProposalHash: input.proposalHash,
      wholePlanOnly: true,
      cachedProposalResult: cached.result,
      expectedWholePlanStateFingerprint: before.stateFingerprint,
    },
  );
  await deleteRuntimeState(organizationId, "whole-plan-proposal", `${planId}:${input.proposalHash}`).catch(() => {
    logger.warn({ event: "applied_proposal_cleanup_failed" }, "Applied proposal will expire by retention");
  });
  const after = await wholePlanAfterFromDatabase(
    organizationId,
    planId,
    before,
    before.pairs,
  );
  return wholePlanReoptimizationResult(
    planId,
    before,
    after,
    result.proposalHash,
  );
}

/**
 * Protected v1 planning-input recalculation.  It deliberately delegates route
 * construction to the existing all-route atomic reoptimizer, which locks
 * resources/routes/stops and validates the same workday evaluator used on
 * initial planning.  The draft revision is an optimistic guard around that
 * protected plan; normal draft writes reject material state changes after a
 * plan exists, so no generic write can silently race this operation.
 */
export async function reoptimizeImportRoutePlanPlanningInputs(
  organizationId: string,
  planId: string,
  input: {
    draftId: string;
    draftRevision: number;
    planningInputs: PlanningInputsV1;
    sharedInstructions?: string | null;
  },
) {
  const planningInputs = normalizePlanningInputs(input.planningInputs);
  const [draftRows, routes] = await Promise.all([
    db
      .select()
      .from(planningDraftsTable)
      .where(
        and(
          eq(planningDraftsTable.id, input.draftId),
          eq(planningDraftsTable.organizationId, organizationId),
          eq(planningDraftsTable.planId, planId),
        ),
      )
      .limit(1),
    db
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.planId, planId),
          ne(routesTable.status, "cancelled"),
        ),
      )
      .orderBy(routesTable.id),
  ]);
  const draft = draftRows[0];
  if (!draft)
    throw new ImportRouteWorkflowError(
      "Planeringsutkastet saknas eller tillhör inte planen.",
      409,
    );
  if (draft.revision !== input.draftRevision) {
    throw new ImportRouteWorkflowError(
      "Planeringsutkastet ändrades. Ladda om innan omoptimering.",
      409,
    );
  }
  const recoveringZeroRoutePlan = routes.length === 0;
  if (
    !recoveringZeroRoutePlan &&
    routes.some((route) => route.status !== "optimized")
  ) {
    throw new ImportRouteWorkflowError(
      "Endast en optimerad, ännu ej utskickad plan kan beräknas om.",
      409,
    );
  }
  if (
    input.sharedInstructions != null &&
    (typeof input.sharedInstructions !== "string" ||
      input.sharedInstructions.trim().length > 4000)
  ) {
    throw new ImportRouteWorkflowError(
      "Gemensam chaufförsinstruktion får vara högst 4000 tecken.",
    );
  }
  const allStops = await db
    .select()
    .from(stopsTable)
    .where(
      and(
        eq(stopsTable.organizationId, organizationId),
        eq(stopsTable.planningPlanId, planId),
        isNull(stopsTable.archivedAt),
      ),
    );
  const recovery = draft.planResult?.recovery
    ? recoveryFromStoredPlanResult(draft.planResult)
    : recoveringZeroRoutePlan
      ? recoveryFromStoredPlanResult(draft.planResult)
      : undefined;
  if (
    recoveringZeroRoutePlan &&
    recovery &&
    (allStops.length !== recovery.stopIds.length ||
      allStops.some(
        (stop) => stop.routeId != null || !recovery.stopIds.includes(stop.id),
      ))
  ) {
    throw new ImportRouteWorkflowError(
      "Planens återställningsstopp är inte längre oförändrade och otilldelade.",
      409,
    );
  }
  const knownStopIds = new Set(allStops.map((stop) => stop.id));
  if (
    Object.keys(planningInputs.stopPriorities).some(
      (stopId) => !knownStopIds.has(stopId),
    )
  ) {
    throw new ImportRouteWorkflowError(
      "En stoppprioritet avser inte ett stopp i den skyddade planen.",
      409,
    );
  }
  Object.assign(
    planningInputs,
    effectivePlanningInputsForStops(planningInputs, allStops),
  );
  const commonDuration =
    [...allStops].sort(
      (left, right) => left.serviceDurationMin - right.serviceDurationMin,
    )[0]?.serviceDurationMin ?? 0;
  const storedSummary = routes[0]?.planningSummary as Record<
    string,
    unknown
  > | null;
  const storedPairValues =
    recovery?.selectedPairValues ??
    (Array.isArray(storedSummary?.selectedPairValues)
      ? storedSummary.selectedPairValues.filter(
          (value): value is string => typeof value === "string",
        )
      : routes
          .map((route) => {
            const driverId = optimizationDriverIdForRoute(route);
            return driverId && route.vehicleId
              ? `${route.vehicleId}:${driverId}`
              : null;
          })
          .filter((value): value is string => value != null));
  const pairs = activeOriginalPairs(storedPairValues, planningInputs);
  const result = await reoptimizeImportRoutePlanServiceTime(
    organizationId,
    planId,
    {
      serviceDurationMin: commonDuration,
      serviceTimeStrategy: "preserve_individual",
      routes: routes.map((route) => {
        const driverId = optimizationDriverIdForRoute(route);
        if (!driverId)
          throw new ImportRouteWorkflowError(
            "En skyddad rutt saknar optimeringsvald chaufför.",
            409,
          );
        return {
          routeId: route.id,
          driverId,
          planRevision: route.planRevision,
        };
      }),
      pairs,
      originalSelectedPairValues: storedPairValues,
      // The core resolves an effective depot from immutable base evidence (or
      // the current verified organization default for legacy plans). Never feed
      // a previous route's potentially overridden effective snapshot back in as
      // a base fallback.
      depotLatitude: recovery?.baseDepotLatitude ?? 0,
      depotLongitude: recovery?.baseDepotLongitude ?? 0,
      planningInputs,
      sharedInstructions:
        input.sharedInstructions === undefined
          ? undefined
          : input.sharedInstructions?.trim() || null,
      protectedDraftUpdate: {
        draftId: input.draftId,
        expectedRevision: input.draftRevision,
      },
      ...(recovery
        ? {
            recovery: {
              ...recovery,
              identityHash: payloadIdentityHash(recovery),
            },
          }
        : {}),
    },
  );
  if (result.draftRevision == null) {
    throw new ImportRouteWorkflowError(
      "Planeringsutkastet kunde inte låsas för omoptimering.",
      409,
    );
  }
  return {
    planId,
    draftRevision: result.draftRevision,
    routes: result.routes,
    planningSummary: result.planningSummary,
  };
}

/** Instruction-only edit is material even after dispatch: invalidate the exact
 * recipient handoff and make the next dispatch/reapproval explicit; no SMS is
 * sent here. */
export async function updatePlanSharedInstructions(
  organizationId: string,
  planId: string,
  draftId: string,
  draftRevision: number,
  sharedInstructions: string | null,
  requestedPlanningInputs: PlanningInputsV1,
) {
  if (
    sharedInstructions != null &&
    (typeof sharedInstructions !== "string" ||
      sharedInstructions.trim().length > 4000)
  ) {
    throw new ImportRouteWorkflowError(
      "Gemensam chaufförsinstruktion får vara högst 4000 tecken.",
    );
  }
  return db.transaction(async (tx) => {
    const routeIds = (
      await tx
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.planId, planId),
            ne(routesTable.status, "cancelled"),
          ),
        )
    )
      .map((route) => route.id)
      .sort();
    for (const routeId of routeIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }
    const routes = await tx
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.planId, planId),
          ne(routesTable.status, "cancelled"),
        ),
      )
      .for("update");
    if (routes.length === 0)
      throw new ImportRouteWorkflowError("Ruttplanen saknas.", 409);
    const [draft] = await tx
      .select()
      .from(planningDraftsTable)
      .where(
        and(
          eq(planningDraftsTable.id, draftId),
          eq(planningDraftsTable.organizationId, organizationId),
          eq(planningDraftsTable.planId, planId),
        ),
      )
      .limit(1)
      .for("update");
    if (!draft || draft.revision !== draftRevision)
      throw new ImportRouteWorkflowError(
        "Planeringsutkastet ändrades. Ladda om.",
        409,
      );
    if (routes.some((route) => route.status === "completed")) {
      throw new ImportRouteWorkflowError(
        "Avslutade rutter kan inte få ändrade gemensamma instruktioner.",
        409,
      );
    }
    const routeStops = await tx
      .select({ id: stopsTable.id, status: stopsTable.status })
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.organizationId, organizationId),
          inArray(
            stopsTable.routeId,
            routes.map((route) => route.id),
          ),
        ),
      )
      .for("update");
    if (routeStops.some((stop) => stop.status !== "pending")) {
      throw new ImportRouteWorkflowError(
        "Instruktioner kan inte ändras efter att ett stopp har påbörjats.",
        409,
      );
    }
    const planStops = await tx
      .select({ id: stopsTable.id, priority: stopsTable.priority })
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.planningPlanId, planId),
          isNull(stopsTable.archivedAt),
        ),
      )
      .for("update");
    if (
      routes.some(route => !samePlanningInputsForStops(
        route.optimizationPlanningSnapshot,
        requestedPlanningInputs,
        planStops,
      )) ||
      (draft.state.planningInputs != null && !samePlanningInputsForStops(
        draft.state.planningInputs,
        requestedPlanningInputs,
        planStops,
      ))
    ) {
      return { planId, draftRevision, needsReoptimization: true as const };
    }
    const next = sharedInstructions?.trim() || null;
    const updatedRoutes = [];
    for (const route of routes) {
      const [updatedRoute] = await tx
        .update(routesTable)
        .set({
          sharedInstructions: next,
          planRevision: route.planRevision + 1,
          status: route.status === "in_progress" ? "optimized" : route.status,
          manualReviewedAt: null,
          ...workingRouteHandoff(),
        })
        .where(
          and(
            eq(routesTable.id, route.id),
            eq(routesTable.planRevision, route.planRevision),
          ),
        )
        .returning();
      if (!updatedRoute)
        throw new ImportRouteWorkflowError(
          "Rutten ändrades under instruktionuppdateringen.",
          409,
        );
      updatedRoutes.push(updatedRoute);
    }
    const [updated] = await tx
      .update(planningDraftsTable)
      .set({
        state: {
          ...draft.state,
          planningMetadata: {
            ...(draft.state.planningMetadata &&
            typeof draft.state.planningMetadata === "object"
              ? draft.state.planningMetadata
              : {}),
            sharedInstructions: next,
          },
        },
        planResult: {
          ...(draft.planResult ?? {}),
          planId,
          routes: updatedRoutes,
          planningSummary: updatedRoutes[0]?.planningSummary ?? null,
          sharedInstructions: next,
        },
        revision: draft.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(planningDraftsTable.id, draft.id),
          eq(planningDraftsTable.revision, draft.revision),
        ),
      )
      .returning();
    if (!updated)
      throw new ImportRouteWorkflowError(
        "Planeringsutkastet ändrades under instruktionuppdateringen.",
        409,
      );
    return {
      planId,
      draftRevision: updated.revision,
      routes: updatedRoutes,
      planningSummary: updatedRoutes[0]?.planningSummary ?? null,
      needsReoptimization: false as const,
    };
  });
}

export function assertAppendRouteEligible(
  route: typeof routesTable.$inferSelect | undefined,
  stops: StopRow[],
): void {
  if (!route || !["draft", "optimized"].includes(route.status)
    || route.handoffStatus !== "pending" || route.sentAt || route.acceptedAt || route.optimizationFrozen
    || stops.some(stop => stop.status !== "pending")) {
    throw new ImportRouteWorkflowError("Import kräver en ej utskickad, öppen rutt med endast väntande stopp.", 409);
  }
}

export function appendImportDuplicates(rows: Array<{ sourceRowNumber?: number | null; address: string; externalRef?: string | null }>, existing: Array<{ id: string; address: string; externalRef?: string | null }>) {
  const normalize = (value: string) => value.trim().toLocaleLowerCase("sv").replace(/\s+/g, " ");
  const matches = (a: typeof rows[number], b: typeof rows[number]) =>
    (!!a.externalRef?.trim() && !!b.externalRef?.trim() && normalize(a.externalRef) === normalize(b.externalRef))
    || normalize(a.address) === normalize(b.address);
  return rows.flatMap((row, index) => {
    const matchingStopIds = existing.filter(stop => matches(row, stop)).map(stop => stop.id);
    const matchingSourceRowNumbers = rows.flatMap((other, otherIndex) =>
      otherIndex !== index && matches(row, other) ? [other.sourceRowNumber ?? otherIndex + 1] : []);
    return matchingStopIds.length || matchingSourceRowNumbers.length
      ? [{ sourceRowNumber: row.sourceRowNumber ?? index + 1, matchingStopIds, matchingSourceRowNumbers }] : [];
  });
}

type AppendImportProposal = {
  routeId: string;
  planRevision: number;
  digest: string;
  expiresAt: string;
  preview: Awaited<ReturnType<typeof buildRouteScopedReoptimization>>;
  newStopIds: string[];
  customers: Array<typeof customersTable.$inferSelect>;
  duplicates: ReturnType<typeof appendImportDuplicates>;
  counts: { expected: number; received: number; existing: number; added: number; total: number };
};

let appendImportGeocodeForTest: typeof geocodeAddress | undefined;
let appendImportBeforeCommitForTest: (() => Promise<void>) | undefined;
export function setAppendImportBeforeCommitForTest(hook: (() => Promise<void>) | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test hooks are only available in tests.");
  appendImportBeforeCommitForTest = hook;
}
export function setAppendImportGeocodeForTest(geocode: typeof geocodeAddress | undefined): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Test geocoder is only available in tests.");
  appendImportGeocodeForTest = geocode;
}

export async function previewRouteAppendImport(
  organizationId: string, routeId: string,
  input: { planRevision: number; expectedRowCount: number; stops: Array<unknown> },
) {
  const parsed = ImportStopsBody.parse({ organizationId, expectedRowCount: input.expectedRowCount, stops: input.stops });
  if (parsed.expectedRowCount !== parsed.stops.length || !parsed.stops.length) {
    throw new ImportRouteWorkflowError("Antalet källrader stämmer inte. Inga stopp sparades.", 400);
  }
  const [[route], [organization], existing] = await Promise.all([
    db.select().from(routesTable).where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId))),
    db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)),
    db.select().from(stopsTable).where(and(eq(stopsTable.routeId, routeId), eq(stopsTable.organizationId, organizationId), isNull(stopsTable.archivedAt))),
  ]);
  assertAppendRouteEligible(route, existing);
  if (route.planRevision !== input.planRevision) throw new ImportRouteWorkflowError("Rutten ändrades. Förhandsgranska igen.", 409);
  const depot = route.depotSnapshot ?? verifiedDepotSnapshot(organization);
  if (!depot) throw new ImportRouteWorkflowError("Rutten saknar verifierad depå.", 409);
  const sourceRows = new Set<number>();
  const rows = [];
  const rowResults: Array<{ sourceRowNumber: number; status: "rejected"; reasons: string[] }> = [];
  for (const [index, row] of parsed.stops.entries()) {
    const sourceRowNumber = row.sourceRowNumber ?? index + 1;
    if (sourceRows.has(sourceRowNumber)) {
      rowResults.push({ sourceRowNumber, status: "rejected", reasons: ["Källradens identitet förekommer flera gånger."] });
      continue;
    }
    sourceRows.add(sourceRowNumber);
    if (!row.address.trim() || (row.serviceDurationMin != null && row.serviceDurationMin < 0)
      || (row.weightKg != null && row.weightKg < 0) || (row.volumeM3 != null && row.volumeM3 < 0)
      || (row.timeWindowStart && row.timeWindowEnd && new Date(row.timeWindowStart) >= new Date(row.timeWindowEnd))
      || (row.jobType === "pickup_delivery" && !row.pickupAddress?.trim())) {
      rowResults.push({ sourceRowNumber, status: "rejected", reasons: ["Ogiltig adress, negativ mängd/servicetid, omvänt tidsfönster eller saknad pickupadress."] });
      continue;
    }
    // Coordinates from an uploaded file are not proof. Canonical matching must
    // establish an unambiguous address; ambiguous results fail closed.
    const geocode = appendImportGeocodeForTest ?? geocodeAddress;
    const delivery = await geocode(row.address);
    const pickup = row.pickupAddress?.trim() ? await geocode(row.pickupAddress) : null;
    if (!delivery || (row.pickupAddress?.trim() && !pickup)) {
      rowResults.push({ sourceRowNumber, status: "rejected", reasons: [
        ...(!delivery ? [`Leveransadressen "${row.address}" måste verifieras.`] : []),
        ...(row.pickupAddress?.trim() && !pickup ? [`Pickupadressen "${row.pickupAddress}" måste verifieras.`] : []),
      ] });
      continue;
    }
    const resolved = {
      ...row, sourceRowNumber, latitude: delivery.latitude, longitude: delivery.longitude,
      pickupLatitude: pickup?.latitude ?? null, pickupLongitude: pickup?.longitude ?? null,
      planningDate: route.date,
    };
    applyVerifiedNavigationDestination(resolved, delivery);
    const reasons = validateImportStopCoordinates(resolved);
    if (reasons.length) {
      rowResults.push({ sourceRowNumber, status: "rejected", reasons });
      continue;
    }
    rows.push(resolved);
  }
  if (rowResults.length) throw new ImportRouteWorkflowError(
    "En eller flera källrader är ogiltiga. Inga stopp sparades.", 422, "INVALID_IMPORT_ROWS",
    { expectedRowCount: input.expectedRowCount, receivedRowCount: parsed.stops.length, savedRowCount: 0, rowResults },
  );
  const values: Array<ReturnType<typeof importStopValues>[number] & { unavailablePeriods?: StopRow["unavailablePeriods"] }> =
    importStopValues(organizationId, rows, organization?.defaultServiceDurationMin ?? 5);
  const customerIds = [...new Set(values.flatMap(row => row.customerId ? [row.customerId as string] : []))];
  const customers = await db.transaction(async tx => {
    const customers = customerIds.length ? await tx.select().from(customersTable).where(and(
      eq(customersTable.organizationId, organizationId), inArray(customersTable.id, customerIds),
    )).orderBy(customersTable.id).for("update") : [];
    await materializeImportedCustomerUnavailablePeriods(tx, organizationId, values);
    return customers;
  });
  const defaults = Object.fromEntries(Object.keys(getTableColumns(stopsTable)).map(key => [key, null]));
  const appendStops = values.map(row => ({
    ...defaults, ...row, id: crypto.randomUUID(), status: "pending", createdAt: new Date(),
    unavailablePeriods: row.unavailablePeriods ?? [],
    routeId, planningPlanId: route.planId,
  } as StopRow));
  const preview = await buildRouteScopedReoptimization(organizationId, routeId, {
    planRevision: input.planRevision, depotLatitude: depot.start.latitude, depotLongitude: depot.start.longitude, appendStops,
  }).catch(error => {
    if (error instanceof ImportRouteWorkflowError && error.statusCode === 400) {
      throw new ImportRouteWorkflowError(error.message, 422, "IMPORT_ROUTE_INFEASIBLE");
    }
    throw error;
  });
  if (payloadIdentityHash(route) !== payloadIdentityHash(preview.sourceRouteSnapshot)
    || payloadIdentityHash(organization) !== payloadIdentityHash(preview.organization)) {
    throw new ImportRouteWorkflowError("Planeringsunderlaget ändrades under förhandsvisningen.", 409);
  }
  const newStopIds = appendStops.map(stop => stop.id);
  const oldStops = preview.stops.filter(stop => !newStopIds.includes(stop.id));
  const duplicates = appendImportDuplicates(rows, oldStops);
  const counts = { expected: input.expectedRowCount, received: rows.length, existing: oldStops.length, added: rows.length, total: preview.stops.length };
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const proposalId = crypto.randomUUID();
  const digest = payloadIdentityHash({ routeId, preview, newStopIds, counts, duplicates, expiresAt, customers });
  const proposal: AppendImportProposal = { routeId, planRevision: input.planRevision, digest, preview, newStopIds, counts, duplicates, expiresAt, customers };
  await saveRuntimeState(organizationId, "route-append-import", proposalId, proposal, 15 * 60_000);
  return { proposalId, digest, routeId, planRevision: input.planRevision, expiresAt, counts, duplicates,
    consequences: { optimizedStopIds: preview.pendingOrder, totalStops: counts.total, totalDistanceKm: preview.distanceKm, totalDurationMin: preview.durationMin } };
}

export async function applyRouteAppendImport(organizationId: string, routeId: string,
  input: { planRevision: number; proposalId: string; digest: string; acknowledgeDuplicates: boolean },
) {
  const stored = await loadRuntimeState<AppendImportProposal>(organizationId, "route-append-import", input.proposalId);
  const proposal = stored?.value;
  if (!proposal || proposal.routeId !== routeId || proposal.digest !== input.digest || proposal.planRevision !== input.planRevision) {
    throw new ImportRouteWorkflowError("Förhandsvisningen är inaktuell eller saknas. Förhandsgranska igen.", 409);
  }
  if (proposal.duplicates.length && !input.acknowledgeDuplicates) {
    throw new ImportRouteWorkflowError("Granska och bekräfta dubbletterna innan importen sparas.", 409);
  }
  const result = await applyRouteScopedReoptimization(organizationId, routeId, {
    planRevision: input.planRevision, depotLatitude: proposal.preview.authoritativeDepot!.start.latitude,
    depotLongitude: proposal.preview.authoritativeDepot!.start.longitude, optimizedStopIds: proposal.preview.pendingOrder,
  }, proposal);
  return { ...result, importedStopIds: proposal.newStopIds,
    counts: { expected: proposal.counts.expected, received: proposal.counts.received, saved: proposal.newStopIds.length } };
}

export async function applyRouteScopedReoptimization(
  organizationId: string,
  routeId: string,
  input: RouteScopedReoptimizationInput & { optimizedStopIds: string[] },
  appendProposal?: {
    preview: Awaited<ReturnType<typeof buildRouteScopedReoptimization>>;
    newStopIds: string[];
    expiresAt: string;
    customers: Array<typeof customersTable.$inferSelect>;
  },
) {
  const preview = appendProposal?.preview ?? await buildRouteScopedReoptimization(
    organizationId,
    routeId,
    input,
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
    );
    await routeScopedReoptimizationAfterLockHook?.();
    let [lockedRoute] = await tx
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, organizationId),
        ),
      )
      .for("update");
    const lockedStops = await tx
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.routeId, routeId),
          eq(stopsTable.organizationId, organizationId),
          isNull(stopsTable.archivedAt),
        ),
      )
      .orderBy(stopsTable.id)
      .for("update");
    if (appendProposal) {
      if (Date.now() >= Date.parse(appendProposal.expiresAt)) {
        throw new ImportRouteWorkflowError("Förhandsvisningen har gått ut. Förhandsgranska igen.", 409);
      }
      assertAppendRouteEligible(lockedRoute, lockedStops);
      if (payloadIdentityHash(lockedRoute) !== payloadIdentityHash(preview.sourceRouteSnapshot)) {
        throw new ImportRouteWorkflowError("Rutten ändrades efter förhandsvisningen.", 409);
      }
      const customerIds = appendProposal.customers.map(customer => customer.id);
      const customers = customerIds.length ? await tx.select().from(customersTable).where(and(
        eq(customersTable.organizationId, organizationId), inArray(customersTable.id, customerIds),
      )).orderBy(customersTable.id).for("update") : [];
      if (payloadIdentityHash(customers) !== payloadIdentityHash(appendProposal.customers)) {
        throw new ImportRouteWorkflowError("Kundernas planeringsvillkor ändrades.", 409);
      }
    }
    const [lockedVehicle] = await tx
      .select()
      .from(vehiclesTable)
      .where(
        and(
          eq(vehiclesTable.id, preview.vehicle.id),
          eq(vehiclesTable.organizationId, organizationId),
        ),
      )
      .for("update");
    const [lockedDriver] = await tx
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.id, preview.driver.id),
          eq(driversTable.organizationId, organizationId),
        ),
      )
      .for("update");
    const [lockedOrganization] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .for("update");
    if (appendProposal && payloadIdentityHash(lockedOrganization) !== payloadIdentityHash(preview.organization)) {
      throw new ImportRouteWorkflowError("Organisationens planeringsvillkor ändrades.", 409);
    }
    if (
      lockedRoute?.lockedFirstStopId != null
      && lockedStops.some(
        (stop) =>
          stop.id === lockedRoute!.lockedFirstStopId
          && ["completed", "failed", "skipped"].includes(stop.status),
      )
    ) {
      const [clearedRoute] = await tx
        .update(routesTable)
        .set({ lockedFirstStopId: null, updatedAt: new Date() })
        .where(and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.lockedFirstStopId, lockedRoute.lockedFirstStopId),
        ))
        .returning();
      lockedRoute = clearedRoute ?? lockedRoute;
    }
    const lockedCertifications = await tx
      .select()
      .from(driverCertificationsTable)
      .where(
        and(
          eq(driverCertificationsTable.organizationId, organizationId),
          eq(driverCertificationsTable.driverId, preview.driver.id),
        ),
      )
      .orderBy(driverCertificationsTable.id)
      .for("update");
    const newStopIds = new Set(appendProposal?.newStopIds ?? []);
    if (appendProposal) {
      const preferences = await tx.select().from(driverPreferencesTable)
        .where(eq(driverPreferencesTable.driverId, preview.driver.id)).orderBy(driverPreferencesTable.id).for("update");
      if (payloadIdentityHash(preferences) !== payloadIdentityHash(preview.driverPreferences)) {
        throw new ImportRouteWorkflowError("Chaufförens arbetstidsregler ändrades.", 409);
      }
    }
    const persistedStops = preview.stops.filter(stop => !newStopIds.has(stop.id));
    const originalById = new Map(persistedStops.map((stop) => [stop.id, stop]));
    const originalCertificationById = new Map(
      preview.driverCertifications.map((certification) => [
        certification.id,
        certification,
      ]),
    );
    if (
      !lockedRoute ||
      lockedRoute.planRevision !== input.planRevision ||
      lockedRoute.lockedFirstStopId !== preview.route.lockedFirstStopId ||
      payloadIdentityHash(lockedRoute.optimizationPlanningSnapshot ?? null) !==
        payloadIdentityHash(preview.route.optimizationPlanningSnapshot ?? null) ||
      payloadIdentityHash(lockedRoute.planningSummary?.optimizationEvidence ?? null) !==
        payloadIdentityHash(preview.route.planningSummary?.optimizationEvidence ?? null) ||
      lockedRoute.date.getTime() !== preview.route.date.getTime() ||
      JSON.stringify(lockedRoute.depotSnapshot) !==
        JSON.stringify(preview.route.depotSnapshot) ||
      JSON.stringify(verifiedDepotSnapshot(lockedOrganization)) !==
        JSON.stringify(preview.currentDepotSnapshot) ||
      !lockedOrganization ||
      effectivePlanningPolicy(lockedOrganization, preview.route.optimizationPlanningSnapshot).maxDriverOvertimeMin !==
        preview.planningInputs.maxDriverOvertimeMin ||
      effectivePlanningPolicy(lockedOrganization, preview.route.optimizationPlanningSnapshot).allowLateStopsMin !==
        preview.planningInputs.allowLateStopsMin ||
      lockedRoute.vehicleId !== preview.vehicle.id ||
      !lockedVehicle ||
      !sameOptimizationVehicle(preview.vehicle, lockedVehicle) ||
      !lockedDriver ||
      !sameOptimizationDriver(preview.driver, lockedDriver) ||
      lockedCertifications.length !== preview.driverCertifications.length ||
      lockedCertifications.some((certification) => {
        const original = originalCertificationById.get(certification.id);
        return !original || !sameDriverCertification(original, certification);
      }) ||
      lockedStops.length !== persistedStops.length ||
      lockedStops.some((stop) => {
        const original = originalById.get(stop.id);
        return !original || !sameOptimizationStop(original, stop)
          || (!!appendProposal && payloadIdentityHash(original) !== payloadIdentityHash(stop));
      })
    ) {
      throw new ImportRouteWorkflowError(
        "Rutten, dess stopp eller tilldelade resurser ändrades efter förhandsvisningen. Ladda om och försök igen.",
        409,
      );
    }
    if (lockedRoute.optimizationFrozen) {
      return {
        routeId, planRevision: lockedRoute.planRevision, vehicleId: preview.vehicle.id,
        lockedStopIds: preview.lockedStops.map(stop => stop.id),
        pendingStopIds: preview.pendingStops.map(stop => stop.id), optimizedStopIds: preview.pendingOrder,
        plannerItinerary: plannerItineraryForResponse(lockedRoute.plannerItinerary ?? []),
        totalStops: lockedRoute.totalStops, totalDistanceKm: lockedRoute.totalDistanceKm ?? 0,
        totalDurationMin: lockedRoute.totalDurationMin ?? 0, co2EmissionsKg: lockedRoute.co2EmissionsKg ?? 0,
        depotSnapshot: depotSnapshotForResponse(lockedRoute.depotSnapshot),
        workdayTimeline: workdayTimelineForResponse(lockedRoute.workdayTimeline),
        workdaySummary: workdaySummaryForResponse(lockedRoute.workdaySummary),
      };
    }
    const pendingSlots = preview.stops
      .map((candidate, index) =>
        candidate.status === "pending" ? index + 1 : null,
      )
      .filter((index): index is number => index != null);
    const pendingSequenceById = new Map(
      preview.pendingOrder.map((stopId, index) => [
        stopId,
        pendingSlots[index],
      ]),
    );
    const optimizedStopsForSnapshot = preview.stops.map((stop) => {
      const sequenceOrder = pendingSequenceById.get(stop.id);
      return sequenceOrder == null ? stop : { ...stop, sequenceOrder };
    });
    const certificationsForDriver = preview.driverCertifications.filter(
      (certification) => certification.driverId === preview.driver.id,
    );
    const planningSummary = preview.route.planningSummary
      ? {
          ...preview.route.planningSummary,
          optimizationEvidence: preview.optimizationEvidence,
        }
      : {
          complete: true,
          objective: preview.planningInputs.objective,
          travelReservePercent: preview.planningInputs.travelReservePercent,
          stopReserveMin: preview.planningInputs.stopReserveMin,
          mandatoryUnplannedStopIds: [],
          selectedPairValues: [],
          usedPairValues: [],
          unusedPairValues: [],
          unplanned: [],
          optimizationEvidence: preview.optimizationEvidence,
        };
    if (appendProposal) {
      let lockedDraft: typeof planningDraftsTable.$inferSelect | undefined;
      if (lockedRoute.draftId) {
        const [draft] = await tx.select().from(planningDraftsTable).where(and(
          eq(planningDraftsTable.organizationId, organizationId),
          eq(planningDraftsTable.id, lockedRoute.draftId),
        )).for("update");
        if (!draft || draft.planId !== lockedRoute.planId) {
          throw new ImportRouteWorkflowError("Planutkastets medlemskap ändrades.", 409);
        }
        lockedDraft = draft;
      }
      // Every authoritative input is locked and compared before the first write.
      const rows = preview.stops.filter(stop => newStopIds.has(stop.id));
      await tx.insert(stopsTable).values(rows.map(stop => ({
        ...stop, sequenceOrder: pendingSequenceById.get(stop.id),
      })));
      if (lockedDraft) {
        const previous = Array.isArray(lockedDraft.state.appendedStopIds) ? lockedDraft.state.appendedStopIds : [];
        await tx.update(planningDraftsTable).set({
          state: { ...lockedDraft.state, appendedStopIds: [...previous, ...newStopIds] },
          revision: sql`${planningDraftsTable.revision} + 1`, updatedAt: new Date(),
        }).where(eq(planningDraftsTable.id, lockedDraft.id));
      }
    }
    for (const stop of preview.pendingStops.filter(stop => !newStopIds.has(stop.id))) {
      const sequenceOrder = preview.pendingOrder.indexOf(stop.id);
      const [saved] = await tx
        .update(stopsTable)
        .set({
          sequenceOrder: pendingSlots[sequenceOrder],
        })
        .where(
          and(
            eq(stopsTable.id, stop.id),
            eq(stopsTable.routeId, routeId),
            eq(stopsTable.organizationId, organizationId),
            eq(stopsTable.status, "pending"),
          ),
        )
        .returning({ id: stopsTable.id });
      if (!saved) {
        throw new ImportRouteWorkflowError(
          "Ett väntande stopp ändrades efter förhandsvisningen. Ladda om och försök igen.",
          409,
        );
      }
    }
    const co2EmissionsKg =
      Math.round(
        estimateCo2(
          preview.distanceKm,
          preview.vehicle.vehicleType,
          preview.totalWeight,
          preview.routingVehicle.capacityKg,
        ) * 100,
      ) / 100;
    const [savedRoute] = await tx
      .update(routesTable)
      .set({
        totalStops: preview.stops.length,
        totalDistanceKm: preview.distanceKm,
        totalDurationMin: preview.durationMin,
        co2EmissionsKg,
        plannerItinerary: preview.itinerary,
        depotSnapshot: preview.authoritativeDepot,
        workdayTimeline: preview.workday.events,
        workdaySummary: preview.workday.summary,
        optimizationPlanningSnapshot: preview.planningInputs,
        optimizationPlanningSnapshotHash: payloadIdentityHash(
          preview.planningInputs,
        ),
        optimizationResourceSnapshot: materialResourceSnapshot(
          preview.vehicle,
          preview.driver,
          optimizedStopsForSnapshot,
          certificationsForDriver,
        ),
        optimizationResourceSnapshotHash: materialResourceSnapshotHash(
          preview.vehicle,
          preview.driver,
          optimizedStopsForSnapshot,
          certificationsForDriver,
        ),
           planningSummary,
        planRevision: sql`${routesTable.planRevision} + 1`,
        geographicOverlapExplanation: null,
        manualReviewedAt: null,
        ...workingRouteHandoff(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.planRevision, input.planRevision),
        ),
      )
      .returning();
    if (!savedRoute) {
      throw new ImportRouteWorkflowError(
        "Rutten ändrades medan förhandsvisningen tillämpades. Ladda om och försök igen.",
        409,
      );
    }
    // Route-scoped reoptimization does not evaluate the sibling routes needed
    // to rebuild overlap evidence. Clear tenant-derived evidence rather than
    // retaining stale counterpart claims.
    if (appendProposal) await appendImportBeforeCommitForTest?.();
    if (!appendProposal) await tx
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));
    return {
      routeId,
      planRevision: savedRoute.planRevision,
      vehicleId: preview.vehicle.id,
      lockedStopIds: preview.lockedStops.map((stop) => stop.id),
      pendingStopIds: preview.pendingStops.map((stop) => stop.id),
      optimizedStopIds: preview.pendingOrder,
      plannerItinerary: plannerItineraryForResponse(preview.itinerary),
      totalStops: savedRoute.totalStops,
      totalDistanceKm: preview.distanceKm,
      totalDurationMin: preview.durationMin,
      co2EmissionsKg,
      depotSnapshot: depotSnapshotForResponse(savedRoute.depotSnapshot),
      workdayTimeline: workdayTimelineForResponse(savedRoute.workdayTimeline),
      workdaySummary: workdaySummaryForResponse(savedRoute.workdaySummary),
    };
  });
}

export async function previewRouteScopedReoptimization(
  organizationId: string,
  routeId: string,
  input: RouteScopedReoptimizationInput,
) {
  const preview = await buildRouteScopedReoptimization(
    organizationId,
    routeId,
    input,
  );
  return {
    routeId,
    planRevision: preview.route.planRevision,
    vehicleId: preview.vehicle.id,
    lockedStopIds: preview.lockedStops.map((stop) => stop.id),
    pendingStopIds: preview.pendingStops.map((stop) => stop.id),
    optimizedStopIds: preview.pendingOrder,
    plannerItinerary: plannerItineraryForResponse(preview.itinerary),
    totalStops: preview.stops.length,
    totalDistanceKm: preview.distanceKm,
    totalDurationMin: preview.durationMin,
    co2EmissionsKg:
      Math.round(
        estimateCo2(
          preview.distanceKm,
          preview.vehicle.vehicleType,
          preview.totalWeight,
          preview.routingVehicle.capacityKg,
        ) * 100,
      ) / 100,
    depotSnapshot: depotSnapshotForResponse(preview.authoritativeDepot),
    workdayTimeline: workdayTimelineForResponse(preview.workday.events),
    workdaySummary: workdaySummaryForResponse(preview.workday.summary),
  };
}

export function classifyUnplannedNodes(
  unplannedNodes: ALNSNode[],
  stopById: Map<string, StopRow>,
  resources: DiagnosticResource[],
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
): ProposalDiagnostic[] {
  const diagnostics: ProposalDiagnostic[] = [];
  for (const node of unplannedNodes) {
    const stop = stopById.get(node.id);
    if (!stop) continue;
    const eligibleResources = resources.filter(
      (resource) => !resource.routingVehicle.ineligibleStopIds?.has(node.id),
    );
    if (
      stop.jobType === "field_service" &&
      resources.length > 0 &&
      eligibleResources.length === 0
    ) {
      diagnostics.push({
        stopId: node.id,
        code: "FIELD_SERVICE_INELIGIBLE",
        detail:
          "Inget valt bil–chaufförspar klarade behörighetskontrollen för det här fältservicestoppet. Kontrollen omfattar roll, kompetens, certifiering och nödvändig utrustning.",
      });
      continue;
    }
    const singleStopMetrics = eligibleResources.map((resource) => ({
      resource,
      metrics: calculateRouteMetrics(
        [node],
        resource.routingVehicle,
        depotLatitude,
        depotLongitude,
        startTime,
        routingConstraintsForDriver(resource.driver),
      ),
    }));
    if (
      singleStopMetrics.length > 0 &&
      singleStopMetrics.every(
        ({ resource, metrics }) =>
          metrics.totalWeightKg > resource.routingVehicle.capacityKg ||
          metrics.totalVolumeM3 > resource.routingVehicle.capacityVolume,
      )
    ) {
      diagnostics.push({
        stopId: node.id,
        code: "CAPACITY_EXCEEDED",
        detail: `Stoppets behov (${Math.round(node.weightKg)} kg och ${node.volumeM3.toFixed(1)} m³) överskrider kapaciteten hos samtliga behöriga valda fordon.`,
      });
    } else if (
      singleStopMetrics.length > 0 &&
      singleStopMetrics.every(
        ({ metrics }) => metrics.workdayReasonCode === "EV_RETURN_RANGE",
      )
    ) {
      diagnostics.push({
        stopId: node.id,
        code: "RANGE_EXCEEDED",
        detail:
          "Enstoppstestet visar att inget av de behöriga valda elfordonen klarar räckviddskontrollen för stoppet och återresan.",
      });
    } else if (
      singleStopMetrics.length > 0 &&
      singleStopMetrics.every(
        ({ metrics }) => metrics.workdayReasonCode === "TIME_WINDOW",
      )
    ) {
      const allAllowLateArrival = singleStopMetrics.every(
        ({ resource }) =>
          (resource.routingVehicle.allowLateStopsMin ?? 0) > 0,
      );
      diagnostics.push({
        stopId: node.id,
        code: allAllowLateArrival
          ? "LATE_TOLERANCE_EXCEEDED"
          : "TIME_WINDOW_UNREACHABLE",
        detail: allAllowLateArrival
          ? "Enstoppstestet visar att stoppets tidsfönster överskrids även med den sena ankomstmarginal som gäller för samtliga behöriga valda par."
          : "Enstoppstestet visar att stoppets tidsfönster inte kan hållas med något av de behöriga valda paren.",
      });
    } else if (
      singleStopMetrics.length > 0 &&
      singleStopMetrics.every(
        ({ metrics }) =>
          metrics.workdayReasonCode === "SHIFT_END" ||
          metrics.workdayReasonCode === "OVERTIME",
      )
    ) {
      diagnostics.push({
        stopId: node.id,
        code: "OVERTIME_ALLOWANCE_EXCEEDED",
        detail:
          "Enstoppstestet visar att stoppet och återresan inte ryms inom arbetstiden och den tillåtna övertiden för något av de behöriga valda paren.",
      });
    } else if (
      singleStopMetrics.length > 0 &&
      singleStopMetrics.every(
        ({ metrics }) => metrics.workdayReasonCode === "BREAK_WINDOW",
      )
    ) {
      diagnostics.push({
        stopId: node.id,
        code: "BREAK_WINDOW_CONFLICT",
        detail:
          "Enstoppstestet visar att rastfönstret inte kan hållas för något av de behöriga valda paren med stoppet inplanerat.",
      });
    } else if (
      singleStopMetrics.length > 0 &&
      singleStopMetrics.every(
        ({ metrics }) => metrics.workdayReasonCode === "UNAVAILABLE_PERIOD",
      )
    ) {
      diagnostics.push({
        stopId: node.id,
        code: "STOP_AVAILABILITY_CONFLICT",
        detail:
          "Enstoppstestet visar att stoppets sparade stängda intervall eller tillgänglighetsdata hindrar servicetillfället för samtliga behöriga valda par.",
      });
    }
  }
  return diagnostics;
}

export function refreshedPlanningSummary(
  previousSummary: unknown,
  planningInputs: PlanningInputsV1,
  unplannedNodes: ALNSNode[],
  diagnosticByStopId: ReadonlyMap<string, string>,
  optimizationEvidence?: OptimizationEvidence | null,
): RefreshedPlanningSummary {
  const previous =
    previousSummary && typeof previousSummary === "object"
      ? (previousSummary as Record<string, unknown>)
      : {};
  const selectedPairValues = Array.isArray(previous.selectedPairValues)
    ? previous.selectedPairValues.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const usedPairValues = Array.isArray(previous.usedPairValues)
    ? previous.usedPairValues.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const unusedPairValues = Array.isArray(previous.unusedPairValues)
    ? previous.unusedPairValues.filter(
        (value): value is { pairValue: string; reason: string } =>
          typeof value === "object" &&
          value != null &&
          typeof (value as { pairValue?: unknown }).pairValue === "string" &&
          typeof (value as { reason?: unknown }).reason === "string",
      )
    : [];
  return {
    complete: !unplannedNodes.some(
      (node) => (node.planningPriority ?? 0) === 2,
    ),
    objective: planningInputs.objective,
    travelReservePercent: planningInputs.travelReservePercent,
    stopReserveMin: planningInputs.stopReserveMin,
    mandatoryUnplannedStopIds: unplannedNodes
      .filter((node) => (node.planningPriority ?? 0) === 2)
      .map((node) => node.id),
    selectedPairValues,
    usedPairValues,
    unusedPairValues,
    unplanned: unplannedNodes.map((node) => ({
      stopId: node.id,
      priority: node.planningPriority ?? 0,
      reason:
        diagnosticByStopId.get(node.id) ??
        UNPLANNED_SEARCH_EXPLANATION,
    })),
    optimizationEvidence:
      optimizationEvidence !== undefined
        ? optimizationEvidence
        : (previous.optimizationEvidence as
            | OptimizationEvidence
            | null
            | undefined),
  };
}

/**
 * Recompute the objective and every route evaluation after workflow repairs.
 * ALNS returns its final report before workflow reinsertion/priority admission,
 * so retaining that report would describe a different solution than the one
 * persisted by this service.
 */
function refreshOptimizationResult(
  result: ReinsertionResult,
  vehicles: ALNSVehicle[],
  driverConstraints: Map<string, ALNSDriverConstraints>,
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
  options: RoutingObjectiveOptions = {},
): void {
  const weights = completeOptimizationWeights(
    options.weights ?? options.effectiveWeights,
  );
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const routeEvaluations = new Map<string, ReturnType<typeof evaluateRoute>>();
  for (const route of result.routes) {
    const vehicle = vehicleById.get(route.vehicleId);
    if (!vehicle || route.nodes.length === 0) continue;
    routeEvaluations.set(
      route.vehicleId,
      evaluateRoute(
        route,
        vehicle,
        depotLatitude,
        depotLongitude,
        startTime,
        driverConstraints.get(route.vehicleId),
      ),
    );
  }
  result.routeEvaluations = routeEvaluations;
  if (result.costBreakdown) {
    result.costBreakdown = computeSolutionCost(
      {
        routes: result.routes,
        unassigned: result.unassigned,
        cost: 0,
        costBreakdown: result.costBreakdown,
      },
      vehicles,
      depotLatitude,
      depotLongitude,
      startTime,
      weights,
      driverConstraints,
      options.vehicleDistributionMode ?? "minimize",
    ).breakdown;
  }
}

type ALNSResultCostBreakdown = {
  distanceCost: number;
  co2Cost: number;
  etaPrecisionCost: number;
  driverPenaltyCost: number;
  geographicCohesionCost: number;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalTimeWindowSlackMin: number;
  totalDriverPenalty: number;
};

type ReinsertionResult = {
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  routeEvaluations: Map<string, ReturnType<typeof evaluateRoute>>;
  costBreakdown?: ALNSResultCostBreakdown;
};

function objectiveCostForCandidate(
  result: Pick<ReinsertionResult, "routes" | "unassigned">,
  vehicles: ALNSVehicle[],
  driverConstraints: Map<string, ALNSDriverConstraints>,
  depotLatitude: number,
  depotLongitude: number,
  startTime: Date,
  weights: OptimizationWeights,
  vehicleDistributionMode: "balance" | "minimize",
): number {
  return computeSolutionCost(
    {
      routes: result.routes,
      unassigned: result.unassigned,
      cost: 0,
      costBreakdown: EMPTY_COST_BREAKDOWN,
    },
    vehicles,
    depotLatitude,
    depotLongitude,
    startTime,
    weights,
    driverConstraints,
    vehicleDistributionMode,
  ).cost;
}

const EMPTY_COST_BREAKDOWN: ALNSResultCostBreakdown = {
  distanceCost: 0,
  co2Cost: 0,
  etaPrecisionCost: 0,
  driverPenaltyCost: 0,
  geographicCohesionCost: 0,
  totalDistanceKm: 0,
  totalCo2Kg: 0,
  totalTimeWindowSlackMin: 0,
  totalDriverPenalty: 0,
};
