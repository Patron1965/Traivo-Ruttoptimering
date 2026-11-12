import { eq, and, inArray, sql, lt, isNotNull, isNull, gte, ilike, or, desc, exists, not, ne } from "drizzle-orm";
import { optimizeDispatchTarget, DispatchTargetOptimizationError } from "./dispatch-target-optimizer";
import { loadRuntimeState, saveRuntimeState } from "./planning-runtime-store";
import { hasBlockingPlanningConflicts } from "./planning-conflict-policy";
import { plannerStopDigest, plannerFactsDigest } from "./planner-stop-facts";
import type { DispatchConsequences, DispatchRouteMetrics } from "./dispatch-preview-contract";
import { withRequiredRoadData, RoadDataUnavailableError } from "./road-data-policy";
import { outgoingStopContext } from "./outgoing-route-service";
import { lockDispatchBindingFacts } from "./dispatch-binding-facts";
import { canonicalFrozenItinerary, nodeWithCanonicalPlanningLocks } from "./planner-lock-canonical-optimizer";
import { preparePersistedRouteRoadData } from "./operational-road-preparation";
import { assertPlanningLockOrder, assertPlanningLockTimes } from "./planning-lock-invariants";
import {
  db,
  stopsTable,
  notificationsTable,
  customersTable,
  vehiclesTable,
  routesTable,
  driversTable,
  organizationsTable,
  auditLogTable,
  deliveryNotificationsTable,
  deliveryProofsTable,
  executionEventsTable,
  geofenceEventsTable,
  driverCertificationsTable,
  planningDraftsTable,
  routeExecutionsTable,
  routePlanApprovalsTable,
  serviceReportsTable,
  type PlanningDraftState,
} from "@workspace/db";
import { materializeCustomerUnavailablePeriods } from "./customer-register-service";
import { lockPlanStopTarget, registerPlanStopMembership, type PlanStopTarget } from "./plan-stop-membership";
export { PlanStopConflictError } from "./plan-stop-membership";
import { chargingStationInsertion, estimateCo2, getDistanceCache } from "./alns";
import { CHARGING_STATIONS, type ALNSNode, type ALNSRoute, type ALNSSolution } from "./alns/types";
import { sendFailedNotification, sendDeliveredNotification } from "./email";
import { dispatchWebhookEvent } from "./webhooks";
import { workingRouteHandoff } from "./route-acknowledgement-service";
import { broadcastDataChange } from "./realtime";
import {
  payloadIdentityHash,
  PlanningDraftError,
} from "./planning-draft-service";
import type { GeocodeResult } from "./geocoding";
import {
  assertRouteEligibleForFieldService,
  fieldServiceRequirementsFromStop,
  FieldServiceAssignmentError,
} from "./field-service";
import { applyDriverRoutingProfile } from "./driver-routing-profile";
import {
  evaluateRouteWorkday,
  scheduleServiceAroundUnavailable,
  stockholmClock,
  workdayInfeasibilityMessage,
} from "./route-workday";
import {
  normalizePlanningInputs,
  itineraryForNodes,
  routingConstraintsForDriver,
  toAlnsNode,
} from "./import-route-workflow";
import {
  effectivePlanningPolicy,
  withOrganizationPlanningPolicy,
} from "./planning-policy";
import {
  isProtectedImportRoute,
  optimizationDriverIdForRoute,
  materialResourceSnapshot,
  materialResourceSnapshotHash,
} from "./route-plan-approval-service";
import { assertCurrentDriverAssistance } from "../lib/driver-assistance";
import {
  assertLockedFirstStopOrder,
  assertLockedFirstStopNotRemoved,
  RouteFirstStopLockError,
} from "./route-first-stop-lock-service";

export interface StopReadPrincipal {
  role: "admin" | "dispatcher" | "driver" | "viewer";
  organizationId: string;
  driverProfileId: string | null;
}

export const NAVIGATION_VERIFIED_KEY = "_traivoNavigationVerified";
export const NAVIGATION_ADDRESS_KEY = "_traivoNavigationAddress";

export function cleanNavigationVerification(data: Record<string, unknown>): void {
  if (!data.customFields || typeof data.customFields !== "object" || Array.isArray(data.customFields)) return;
  const {
    [NAVIGATION_VERIFIED_KEY]: _verified,
    [NAVIGATION_ADDRESS_KEY]: _address,
    ...customFields
  } = data.customFields as Record<string, string>;
  data.customFields = customFields;
}

export function applyVerifiedNavigationDestination(
  data: Record<string, unknown>,
  result: GeocodeResult,
): void {
  const current = data.customFields && typeof data.customFields === "object" && !Array.isArray(data.customFields)
    ? data.customFields as Record<string, string>
    : {};
  data.latitude = result.latitude;
  data.longitude = result.longitude;
  data.customFields = {
    ...current,
    [NAVIGATION_VERIFIED_KEY]: "true",
    [NAVIGATION_ADDRESS_KEY]: result.displayName,
  };
}

export const CURRENT_STOP_STATUSES = ["pending", "in_progress"] as const;

/** Preserve the chosen import location; provider evidence must match it. */
export function verifyPreservedNavigationDestination(
  data: Record<string, unknown>, result: GeocodeResult | null,
): boolean {
  cleanNavigationVerification(data);
  if (!result || typeof data.latitude !== "number" || typeof data.longitude !== "number"
    || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)
    || Math.abs(data.latitude - result.latitude) > 0.00001
    || Math.abs(data.longitude - result.longitude) > 0.00001) return false;
  const latitude = data.latitude, longitude = data.longitude;
  applyVerifiedNavigationDestination(data, result);
  data.latitude = latitude;
  data.longitude = longitude;
  return true;
}
export const TERMINAL_STOP_STATUSES = ["completed", "failed", "skipped"] as const;
export const RETENTION_ELIGIBLE_STOP_STATUSES = TERMINAL_STOP_STATUSES;

export type OrganizationStopWorkStatus = "current" | "terminal";
export type OrganizationStopDeletionProtection = "protected" | "deletable";

export function isRetentionEligibleStopStatus(status: string): boolean {
  return (RETENTION_ELIGIBLE_STOP_STATUSES as readonly string[]).includes(status);
}

/**
 * Stable machine-readable error information for dispatch moves that would
 * change a stop's lifecycle position. Keep the human-readable error below
 * unchanged: existing dispatch clients display and may match that message.
 */
export const STOP_LIFECYCLE_LOCKED_CODE = "STOP_LIFECYCLE_LOCKED" as const;
export const DISPATCH_DRIVER_UNRESOLVED_CODE = "DISPATCH_DRIVER_UNRESOLVED" as const;
export const DISPATCH_PLANNING_EVIDENCE_MISSING_CODE =
  "DISPATCH_PLANNING_EVIDENCE_MISSING" as const;
export const DISPATCH_PICKUP_COORDINATES_REQUIRED_CODE =
  "DISPATCH_PICKUP_COORDINATES_REQUIRED" as const;
export const DISPATCH_LOCKED_FIRST_STOP_CODE =
  "LOCKED_FIRST_STOP_CONFLICT" as const;
export type DispatchMoveIneligibleCode =
  | typeof STOP_LIFECYCLE_LOCKED_CODE
  | typeof DISPATCH_DRIVER_UNRESOLVED_CODE
  | typeof DISPATCH_PLANNING_EVIDENCE_MISSING_CODE
  | typeof DISPATCH_PICKUP_COORDINATES_REQUIRED_CODE
  | typeof DISPATCH_LOCKED_FIRST_STOP_CODE;
export const STOP_LIFECYCLE_LOCKED_ERROR =
  "Completed, active, failed, and skipped stops are locked and must keep their route position";

export type DispatchLockedStopDetails = {
  stopId: string;
  routeId: string | null;
  sequenceOrder: number | null;
  status: typeof stopsTable.$inferSelect.status;
  address: string;
};

export function getDispatchLockedStopDetails(
  stop: typeof stopsTable.$inferSelect,
): DispatchLockedStopDetails {
  return {
    stopId: stop.id,
    routeId: stop.routeId,
    sequenceOrder: stop.sequenceOrder,
    status: stop.status,
    address: stop.address,
  };
}

/**
 * The one retention policy for any code path that changes stop status.
 * Active statuses intentionally clear a prior terminal timestamp so a reopened
 * stop cannot be collected as historical data.
 */
export function getTerminalTimestampForStopStatus(status: string, now = new Date()): Date | null {
  return isRetentionEligibleStopStatus(status) ? now : null;
}

export function invalidatedRoutePlanningState(totalStops?: number) {
  return {
    ...(totalStops === undefined ? {} : { totalStops }),
    totalDistanceKm: null,
    totalDurationMin: null,
    co2EmissionsKg: null,
    workdayTimeline: null,
    workdaySummary: null,
    manualReviewRequired: true,
    manualReviewedAt: null,
    geographicOverlapExplanation: null,
    plannerItinerary: [],
    planningSummary: null,
    executionProjection: null,
    redistributionSuggestion: null,
    planRevision: sql`${routesTable.planRevision} + 1`,
    ...workingRouteHandoff(),
  };
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Warm canonical routes outside write transactions, including unlocked
 * source routes whose remaining stops need new road legs after removal. */
export async function prepareDispatchLockRoadData(
  organizationId: string, input: { routeIds?: string[]; stopIds?: string[] },
): Promise<boolean> {
  const selected = input.stopIds?.length ? await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, input.stopIds),
  )) : [];
  const ids = [...new Set([...(input.routeIds ?? []), ...selected.flatMap(stop => stop.routeId ? [stop.routeId] : [])])];
  const routes = ids.length ? await db.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), inArray(routesTable.id, ids),
  )) : [];
  const stops = ids.length ? await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId), inArray(stopsTable.routeId, ids), isNull(stopsTable.archivedAt),
  )) : selected;
  const strict = routes.some(route => route.optimizationFrozen)
    || [...stops, ...selected].some(stop => stop.lockedVehicleId || stop.lockedDriverId || stop.lockedServiceStartAt);
  const hasCanonicalRoute = routes.some(route => route.depotSnapshot
    && hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot));
  if (strict || hasCanonicalRoute) {
    await preparePersistedRouteRoadData(organizationId, { routeIds: ids, stopIds: input.stopIds });
  }
  return strict;
}

async function lockRoutesForPlanningMutation(
  tx: DbTransaction,
  organizationId: string,
  routeIds: string[],
) {
  const uniqueRouteIds = Array.from(new Set(routeIds)).sort();
  if (uniqueRouteIds.length === 0) return [];
  return tx
    .select({ id: routesTable.id })
    .from(routesTable)
    .where(and(
      eq(routesTable.organizationId, organizationId),
      inArray(routesTable.id, uniqueRouteIds),
    ))
    .orderBy(routesTable.id)
    .for("update");
}

export function getStopRetentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export function isStopPastRetention(
  status: string,
  terminalAt: Date | null,
  retentionDays: number,
  now = new Date(),
): boolean {
  return Boolean(
    terminalAt
      && isRetentionEligibleStopStatus(status)
      && terminalAt < getStopRetentionCutoff(retentionDays, now),
  );
}

export class StopBulkDeleteNotFoundError extends Error {
  statusCode = 404;

  constructor() {
    super("One or more stops were not found");
    this.name = "StopBulkDeleteNotFoundError";
  }
}

export class StopBulkDeleteConflictError extends Error {
  statusCode = 409;

  constructor(reason: "changed" | "status" | "sequence" | "proof" | "execution" | "serviceReport" | "archived" = "changed") {
    super(reason === "status"
      ? "Only pending stops can be deleted. No stops were deleted."
      : reason === "archived"
        ? "Archived stops are retained historical records and cannot be permanently deleted."
      : reason === "sequence"
        ? "Deletion would reorder active or terminal stops. No stops were deleted."
        : reason === "proof"
          ? "Stops with proof of delivery cannot be deleted. No stops were deleted."
          : reason === "execution"
            ? "Stops with execution history cannot be deleted. No stops were deleted."
            : reason === "serviceReport"
              ? "Stops with service reports cannot be deleted. No stops were deleted."
        : "One or more stops changed while deletion was being prepared. Reload and try again.");
    this.name = "StopBulkDeleteConflictError";
  }
}

/** A selected stop can be removed from planning, never from its evidence. */
export class StopBulkArchiveConfirmationRequiredError extends Error {
  statusCode = 409;
  code = "STOP_ARCHIVE_CONFIRMATION_REQUIRED" as const;

  constructor(readonly affectedRouteIds: string[]) {
    super(
      "Archiving the selected stops cancels an active, sent, accepted, or approved route and releases its other unfinished jobs. Set confirmActiveRoutes to true to continue.",
    );
    this.name = "StopBulkArchiveConfirmationRequiredError";
  }
}

export class StopArchivedError extends Error {
  statusCode = 409;
  code = "STOP_ARCHIVED" as const;

  constructor() {
    super("Archived stops are historical records and cannot be changed, assigned, or executed.");
    this.name = "StopArchivedError";
  }
}

export type StopArchiveActor = {
  userId: string;
  userEmail: string | null;
};

const ARCHIVED_DRAFT_VALUE = Symbol("archived-draft-value");

/**
 * Draft state is intentionally flexible JSON, so archival cannot rely on one
 * schema field. Remove matching IDs, ID-keyed entries, and serialized stop
 * records recursively while retaining every unrelated planning preference.
 */
function reconcileDraftStateForArchivedStops(
  value: unknown,
  archivedIds: Set<string>,
): unknown | typeof ARCHIVED_DRAFT_VALUE {
  if (typeof value === "string") {
    return archivedIds.has(value) ? ARCHIVED_DRAFT_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => reconcileDraftStateForArchivedStops(entry, archivedIds))
      .filter((entry) => entry !== ARCHIVED_DRAFT_VALUE);
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && archivedIds.has(record.id)) {
    return ARCHIVED_DRAFT_VALUE;
  }
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entry]) => {
      if (archivedIds.has(key)) return [];
      const reconciled = reconcileDraftStateForArchivedStops(entry, archivedIds);
      return reconciled === ARCHIVED_DRAFT_VALUE ? [] : [[key, reconciled]];
    }),
  );
}
export class ImportRowCountMismatchError extends Error {
  statusCode = 409;
  constructor(expected: number, received: number) {
    super(`Import row count mismatch: expected ${expected}, received ${received}. No rows were saved.`);
    this.name = "ImportRowCountMismatchError";
  }
}

export function assertImportRowCount(expected: number, received: number): void {
  if (expected !== received) throw new ImportRowCountMismatchError(expected, received);
}

export function validateImportStopCoordinates(stop: {
  latitude?: number;
  longitude?: number;
  pickupAddress?: string | null;
  pickupLatitude?: number | null;
  pickupLongitude?: number | null;
}): string[] {
  const reasons: string[] = [];
  const valid = (latitude: number | null | undefined, longitude: number | null | undefined) =>
    typeof latitude === "number"
    && Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && typeof longitude === "number"
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180;
  if (!valid(stop.latitude, stop.longitude)) {
    reasons.push("Leveransadressen saknar ett giltigt koordinatpar.");
  }
  if (stop.pickupAddress?.trim() && !valid(stop.pickupLatitude, stop.pickupLongitude)) {
    reasons.push("Pickupadressen saknar ett giltigt koordinatpar.");
  }
  return reasons;
}

export function resolveImportedServiceDuration(
  mappedServiceDurationMin: number | null | undefined,
  organizationDefaultServiceDurationMin: number | null | undefined,
): number {
  return mappedServiceDurationMin ?? organizationDefaultServiceDurationMin ?? 5;
}

export function projectStopForReadRole<T extends Record<string, any>>(
  stop: T,
  role: StopReadPrincipal["role"],
): T & { navigationVerified: boolean; navigationAddress: string | null } {
  const projected = {
    ...stop,
    navigationVerified: stop.customFields?.[NAVIGATION_VERIFIED_KEY] === "true",
    navigationAddress: stop.customFields?.[NAVIGATION_ADDRESS_KEY] ?? null,
  };
  if (role !== "viewer") return projected;
  return {
    ...projected,
    customerId: null,
    notes: null,
    trackingCode: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    externalRef: null,
    shopifyOrderId: null,
    shopifyOrderName: null,
    serviceInstructions: null,
    requiredSkills: null,
    requiredCertifications: null,
    requiredEquipment: null,
  };
}

async function assertRouteBelongsToOrganization(
  organizationId: string,
  routeId: string,
): Promise<void> {
  const [route] = await db
    .select({ id: routesTable.id })
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)))
    .limit(1);
  if (!route) {
    throw new FieldServiceAssignmentError("Route not found in organization");
  }
}

async function assertStopRouteAssignment(
  organizationId: string,
  routeId: string,
  stop: {
    jobType?: string | null;
    requiredSkills?: string[] | null;
    requiredCertifications?: string[] | null;
    requiredEquipment?: string[] | null;
  },
): Promise<void> {
  if (stop.jobType === "field_service") {
    await assertRouteEligibleForFieldService(
      organizationId,
      routeId,
      fieldServiceRequirementsFromStop(stop),
    );
    return;
  }
  await assertRouteBelongsToOrganization(organizationId, routeId);
}

export async function listStops(
  organizationId: string,
  routeId?: string,
  principal?: StopReadPrincipal,
) {
  const conditions = [
    eq(stopsTable.organizationId, organizationId),
    isNull(stopsTable.archivedAt),
  ];
  if (routeId) {
    conditions.push(eq(stopsTable.routeId, routeId));
  }

  if (principal?.role === "driver") {
    if (!principal.driverProfileId) return [];
    const rows = await db
      .select({ stop: stopsTable })
      .from(stopsTable)
      .innerJoin(
        routesTable,
        and(
          eq(stopsTable.routeId, routesTable.id),
          eq(routesTable.organizationId, organizationId),
        ),
      )
      .innerJoin(
        driversTable,
        and(
          eq(driversTable.id, principal.driverProfileId),
          eq(driversTable.organizationId, organizationId),
          eq(routesTable.handoffDriverId, principal.driverProfileId),
        ),
      )
      .where(and(...conditions));
    return rows.map(({ stop }) => stop);
  }

  const stops = await db.select().from(stopsTable).where(and(...conditions));
  return principal
    ? stops.map((stop) => projectStopForReadRole(stop, principal.role))
    : stops;
}

export type OrganizationStopListOptions = {
  search?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  workStatus?: OrganizationStopWorkStatus;
  deletionProtection?: OrganizationStopDeletionProtection;
  assignment?: "assigned" | "unassigned";
  routeId?: string;
  orderType?: "single_stop" | "pickup_delivery";
  jobType?: "transport" | "service";
  quality?: "ready" | "issues" | "geocode_error";
  planning?: "planned" | "unplanned";
  timeWindow?: "set" | "unset";
  requirements?: string;
  tracking?: string;
  dateField?: "planned_delivery" | "imported_created";
  dateFrom?: Date;
  dateToExclusive?: Date;
  includeWithoutPlannedDate?: boolean;
  archiveState?: "active" | "archived" | "all";
  page: number;
  pageSize: number;
};

/**
 * The archive applies every tenant filter before pagination. The returned
 * total is consequently exact rather than a capped-page approximation.
 */
export async function listOrganizationStops(
  organizationId: string,
  options: OrganizationStopListOptions,
) {
  const conditions = [eq(stopsTable.organizationId, organizationId)];
  if (options.archiveState === "archived") conditions.push(isNotNull(stopsTable.archivedAt));
  else if (options.archiveState !== "all") conditions.push(isNull(stopsTable.archivedAt));
  if (options.search?.trim()) {
    const pattern = `%${options.search.trim()}%`;
    conditions.push(or(
      ilike(stopsTable.address, pattern),
      ilike(stopsTable.contactName, pattern),
      ilike(stopsTable.externalRef, pattern),
      ilike(stopsTable.shopifyOrderName, pattern),
      ilike(stopsTable.notes, pattern),
    )!);
  }
  if (options.status) conditions.push(eq(stopsTable.status, options.status));
  if (options.workStatus === "current") {
    conditions.push(inArray(stopsTable.status, CURRENT_STOP_STATUSES));
  }
  if (options.workStatus === "terminal") {
    conditions.push(inArray(stopsTable.status, TERMINAL_STOP_STATUSES));
  }
  const proofExists = exists(
    db
      .select({ stopId: deliveryProofsTable.stopId })
      .from(deliveryProofsTable)
      .where(eq(deliveryProofsTable.stopId, stopsTable.id)),
  );
  const executionHistoryExists = exists(
    db
      .select({ stopId: executionEventsTable.stopId })
      .from(executionEventsTable)
      .where(and(
        eq(executionEventsTable.organizationId, organizationId),
        eq(executionEventsTable.stopId, stopsTable.id),
      )),
  );
  const serviceReportExists = exists(
    db
      .select({ stopId: serviceReportsTable.stopId })
      .from(serviceReportsTable)
      .where(and(
        eq(serviceReportsTable.organizationId, organizationId),
        eq(serviceReportsTable.stopId, stopsTable.id),
      )),
  );
  if (options.deletionProtection === "protected") {
    conditions.push(or(
      ne(stopsTable.status, "pending"),
      proofExists,
      executionHistoryExists,
      serviceReportExists,
    )!);
  }
  if (options.deletionProtection === "deletable") {
    conditions.push(and(
      eq(stopsTable.status, "pending"),
      not(proofExists),
      not(executionHistoryExists),
      not(serviceReportExists),
    )!);
  }
  if (options.assignment === "assigned") conditions.push(isNotNull(stopsTable.routeId));
  if (options.assignment === "unassigned") conditions.push(isNull(stopsTable.routeId));
  if (options.routeId) conditions.push(eq(stopsTable.routeId, options.routeId));
  if (options.orderType === "single_stop") conditions.push(isNull(stopsTable.pickupAddress));
  if (options.orderType === "pickup_delivery") conditions.push(isNotNull(stopsTable.pickupAddress));
  if (options.jobType === "transport") {
    conditions.push(or(eq(stopsTable.jobType, "delivery"), eq(stopsTable.jobType, "pickup_delivery"))!);
  }
  if (options.jobType === "service") conditions.push(eq(stopsTable.jobType, "field_service"));
  if (options.planning === "planned") conditions.push(isNotNull(stopsTable.routeId));
  if (options.planning === "unplanned") conditions.push(isNull(stopsTable.routeId));
  if (options.timeWindow === "set") {
    conditions.push(or(isNotNull(stopsTable.timeWindowStart), isNotNull(stopsTable.timeWindowEnd))!);
  }
  if (options.timeWindow === "unset") {
    conditions.push(and(isNull(stopsTable.timeWindowStart), isNull(stopsTable.timeWindowEnd))!);
  }
  if (options.requirements?.trim()) {
    const pattern = `%${options.requirements.trim()}%`;
    conditions.push(sql`concat_ws(' ',
      ${stopsTable.serviceCategory},
      array_to_string(${stopsTable.requiredSkills}, ' '),
      array_to_string(${stopsTable.requiredCertifications}, ' '),
      array_to_string(${stopsTable.requiredEquipment}, ' '),
      ${stopsTable.weightKg}::text,
      ${stopsTable.volumeM3}::text
    ) ILIKE ${pattern}`);
  }
  if (options.tracking?.trim()) conditions.push(ilike(stopsTable.trackingCode, `%${options.tracking.trim()}%`));

  const invalidCoordinates = or(
    sql`${stopsTable.latitude} < -90`,
    sql`${stopsTable.latitude} > 90`,
    sql`${stopsTable.longitude} < -180`,
    sql`${stopsTable.longitude} > 180`,
  )!;
  const pickupGeocodeError = and(
    isNotNull(stopsTable.pickupAddress),
    or(
      isNull(stopsTable.pickupLatitude),
      isNull(stopsTable.pickupLongitude),
      sql`${stopsTable.pickupLatitude} < -90`,
      sql`${stopsTable.pickupLatitude} > 90`,
      sql`${stopsTable.pickupLongitude} < -180`,
      sql`${stopsTable.pickupLongitude} > 180`,
    )!,
  );
  const geocodeError = or(
    sql`btrim(${stopsTable.address}) = ''`,
    invalidCoordinates,
    pickupGeocodeError,
  )!;
  if (options.quality === "geocode_error") conditions.push(geocodeError);
  if (options.quality === "ready") {
    conditions.push(sql`NOT (${geocodeError})`);
    conditions.push(or(isNotNull(stopsTable.timeWindowStart), isNotNull(stopsTable.timeWindowEnd))!);
  }
  if (options.quality === "issues") {
    conditions.push(or(
      geocodeError,
      and(isNull(stopsTable.timeWindowStart), isNull(stopsTable.timeWindowEnd)),
    )!);
  }

  const dateColumn = options.dateField === "planned_delivery"
    ? stopsTable.timeWindowStart
    : options.dateField === "imported_created"
      ? stopsTable.createdAt
      : null;
  if (dateColumn) {
    const dateBounds = [];
    if (options.dateFrom) dateBounds.push(gte(dateColumn, options.dateFrom));
    if (options.dateToExclusive) dateBounds.push(lt(dateColumn, options.dateToExclusive));
    const datedCondition = dateBounds.length > 0 ? and(...dateBounds) : undefined;
    if (options.dateField === "planned_delivery" && options.includeWithoutPlannedDate && datedCondition) {
      conditions.push(or(datedCondition, isNull(stopsTable.timeWindowStart))!);
    } else if (datedCondition) {
      conditions.push(datedCondition);
    }
  }

  const where = and(...conditions);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(stopsTable)
    .where(where);
  const rows = await db
    .select()
    .from(stopsTable)
    .where(where)
    .orderBy(desc(stopsTable.createdAt), desc(stopsTable.id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  const stopIds = rows.map((stop) => stop.id);
  const proofStopIds = stopIds.length === 0
    ? new Set<string>()
    : new Set((await db
      .selectDistinct({ stopId: deliveryProofsTable.stopId })
      .from(deliveryProofsTable)
      .where(inArray(deliveryProofsTable.stopId, stopIds)))
      .map((proof) => proof.stopId));
  const executionHistoryStopIds = stopIds.length === 0
    ? new Set<string>()
    : new Set((await db
      .selectDistinct({ stopId: executionEventsTable.stopId })
      .from(executionEventsTable)
      .where(and(
        eq(executionEventsTable.organizationId, organizationId),
        inArray(executionEventsTable.stopId, stopIds),
      )))
      .map((event) => event.stopId));
  const serviceReportStopIds = stopIds.length === 0
    ? new Set<string>()
    : new Set((await db
      .selectDistinct({ stopId: serviceReportsTable.stopId })
      .from(serviceReportsTable)
      .where(and(
        eq(serviceReportsTable.organizationId, organizationId),
        inArray(serviceReportsTable.stopId, stopIds),
      )))
      .map((report) => report.stopId));

  return {
    items: rows.map((stop) => ({
      ...stop,
      deletionProtection: proofStopIds.has(stop.id)
        ? "proof_on_file" as const
        : executionHistoryStopIds.has(stop.id)
          ? "execution_history" as const
          : serviceReportStopIds.has(stop.id)
            ? "service_report" as const
        : stop.status !== "pending"
          ? "active_or_terminal_status" as const
          : null,
    })),
    total: count,
    page: options.page,
    pageSize: options.pageSize,
  };
}

export async function getStop(
  id: string,
  organizationId: string,
  principal?: StopReadPrincipal,
) {
  const [stop] = await db
    .select()
    .from(stopsTable)
    .where(and(eq(stopsTable.id, id), eq(stopsTable.organizationId, organizationId)));
  return stop && principal ? projectStopForReadRole(stop, principal.role) : stop ?? null;
}

export async function getStopById(id: string) {
  const [stop] = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.id, id));
  return stop ?? null;
}

export async function createStop(
  data: Record<string, unknown>,
  plan?: PlanStopTarget,
) {
  // A plan membership must only be supplied through the guarded plan endpoint.
  if (!plan && data.planningPlanId != null) throw new StopCreationAssignmentError();
  if (
    (Object.prototype.hasOwnProperty.call(data, "routeId") && data.routeId != null) ||
    (Object.prototype.hasOwnProperty.call(data, "sequenceOrder") && data.sequenceOrder != null)
  ) {
    throw new StopCreationAssignmentError();
  }
  delete data.routeId;
  delete data.sequenceOrder;
  if (typeof data.status === "string" && isRetentionEligibleStopStatus(data.status)) {
    data.terminalAt = getTerminalTimestampForStopStatus(data.status);
  }

  const stop = await db.transaction(async (tx) => {
    const lockedPlanRoutes = plan
      ? await lockPlanStopTarget(tx, data.organizationId as string, plan)
      : [];
    if (plan) {
      data.planningPlanId = plan.planId;
      data.planningDate = lockedPlanRoutes[0].date;
      data.unplannedReason = "Nytt stopp väntar på manuell tilldelning.";
    }
    const customerId = typeof data.customerId === "string" ? data.customerId : null;
    if (customerId) {
      const customerById = await loadCustomerSnapshots(
        tx,
        data.organizationId as string,
        [customerId],
      );
      data.unavailablePeriods = materializeCustomerSnapshot(
        customerById.get(customerId)!,
        data.planningDate,
      );
    }
    const [created] = await tx.insert(stopsTable).values(data as any).returning();
    if (plan) {
      await registerPlanStopMembership(tx, lockedPlanRoutes, [{ id: created.id, priority: 2 }]);
    }
    if (created.routeId) {
      await tx
        .update(routesTable)
        .set({
          ...invalidatedRoutePlanningState(),
        })
        .where(
          and(
            eq(routesTable.id, created.routeId),
            eq(routesTable.organizationId, created.organizationId),
          ),
        );
    }
    return created;
  });
  getDistanceCache().invalidate(stop.latitude, stop.longitude);
  broadcastDataChange(stop.organizationId, "stop", "created", { id: stop.id, address: stop.address });
  return stop;
}

export function importStopValues(
  organizationId: string,
  stopRows: any[],
  defaultServiceDurationMin: number,
) {
  return stopRows.map((row: any) => ({
    organizationId,
    customerId: row.customerId ?? null,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    timeWindowStart: row.timeWindowStart ? new Date(row.timeWindowStart) : null,
    timeWindowEnd: row.timeWindowEnd ? new Date(row.timeWindowEnd) : null,
    planningDate: row.planningDate ? new Date(row.planningDate) : null,
    serviceDurationMin: resolveImportedServiceDuration(
      row.serviceDurationMin,
      defaultServiceDurationMin,
    ),
    notes: row.notes ?? null,
    weightKg: row.weightKg ?? null,
    volumeM3: row.volumeM3 ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    externalRef: row.externalRef ?? null,
    pickupAddress: row.pickupAddress ?? null,
    pickupLatitude: row.pickupLatitude ?? null,
    pickupLongitude: row.pickupLongitude ?? null,
    // Field service columns — default to delivery when absent so existing
    // transport imports are fully backward-compatible.
    jobType: row.jobType ?? "delivery",
    priority: row.priority ?? null,
    slaDeadline: row.slaDeadline ? new Date(row.slaDeadline) : null,
    serviceCategory: row.serviceCategory ?? null,
    serviceInstructions: row.serviceInstructions ?? null,
    requiredSkills: row.requiredSkills ?? null,
    requiredCertifications: row.requiredCertifications ?? null,
    requiredEquipment: row.requiredEquipment ?? null,
    customFields: row.customFields ?? null,
    sourceRowNumber: row.sourceRowNumber ?? null,
  }));
}

type CustomerSnapshot = {
  id: string;
  unavailablePeriods: NonNullable<typeof customersTable.$inferSelect.unavailablePeriods>;
  archivedAt: Date | null;
};
type MaterializedUnavailablePeriods = NonNullable<typeof stopsTable.$inferSelect.unavailablePeriods>;

async function loadCustomerSnapshots(
  tx: DbTransaction,
  organizationId: string,
  customerIds: string[],
): Promise<Map<string, CustomerSnapshot>> {
  if (customerIds.length === 0) return new Map();
  const customers = await tx
    .select({
      id: customersTable.id,
      unavailablePeriods: customersTable.unavailablePeriods,
      archivedAt: customersTable.archivedAt,
    })
    .from(customersTable)
    .where(and(
      eq(customersTable.organizationId, organizationId),
      inArray(customersTable.id, customerIds),
    ));
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  if (
    customerIds.some((customerId) => {
      const customer = customerById.get(customerId);
      return !customer || customer.archivedAt !== null;
    })
  ) {
    throw new CustomerLinkValidationError();
  }
  return customerById as Map<string, CustomerSnapshot>;
}

function planningDateFromValue(value: unknown): Date | null {
  const planningDate = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  return planningDate && Number.isFinite(planningDate.getTime())
    ? planningDate
    : null;
}

function materializeCustomerSnapshot(
  customer: CustomerSnapshot,
  planningDateValue: unknown,
): MaterializedUnavailablePeriods {
  if (customer.unavailablePeriods.length === 0) return [];
  const planningDate = planningDateFromValue(planningDateValue);
  if (!planningDate) throw new CustomerPlanningDateRequiredError();
  return materializeCustomerUnavailablePeriods(
    planningDate,
    customer.unavailablePeriods,
  );
}

export async function materializeImportedCustomerUnavailablePeriods(
  tx: DbTransaction,
  organizationId: string,
  values: Array<Record<string, any>>,
): Promise<void> {
  const customerIds = [...new Set(
    values
      .map((value) => value.customerId)
      .filter((id): id is string => typeof id === "string"),
  )];
  if (customerIds.length === 0) return;
  const customerById = await loadCustomerSnapshots(tx, organizationId, customerIds);
  for (const value of values) {
    if (typeof value.customerId !== "string") continue;
    const customer = customerById.get(value.customerId)!;
    value.unavailablePeriods = materializeCustomerSnapshot(
      customer,
      value.planningDate,
    );
  }
}

async function materializeDispatchCustomerUnavailablePeriods(
  tx: DbTransaction,
  organizationId: string,
  planningDate: Date,
  stops: Array<typeof stopsTable.$inferSelect>,
  options: {
    previewOnly?: boolean;
    refreshExisting?: boolean;
    storedPlanningDate?: Date;
  } = {},
): Promise<void> {
  const customerIds = [...new Set(
    stops
      .map((stop) => stop.customerId)
      .filter((id): id is string => typeof id === "string"),
  )];
  if (customerIds.length === 0) return;
  const customerById = await loadCustomerSnapshots(tx, organizationId, customerIds);
  const planningDay = planningDate.toISOString().slice(0, 10);
  for (const stop of stops) {
    if (!stop.customerId) continue;
    // Existing planning snapshots stay immutable during ordinary dispatch
    // assignment. A defer explicitly supplies a new calendar date and opts in
    // to refreshing the snapshot for that future workday.
    if (stop.planningDate && !options.refreshExisting) continue;
    const customer = customerById.get(stop.customerId)!;
    if (!customer) continue;
    const expected = materializeCustomerUnavailablePeriods(
      planningDate,
      customer.unavailablePeriods ?? [],
    );
    const stopPlanningDate = (stop as unknown as { planningDate?: Date | null }).planningDate;
    const stopDay = stopPlanningDate?.toISOString().slice(0, 10);
    if (
      !options.refreshExisting &&
      stopDay === planningDay
      && JSON.stringify(stop.unavailablePeriods ?? []) === JSON.stringify(expected)
    ) {
      continue;
    }
    if (options.previewOnly) {
      stop.unavailablePeriods = expected;
      stop.planningDate = options.storedPlanningDate ?? planningDate;
      continue;
    }
    const [updated] = await tx
      .update(stopsTable)
      .set({
        unavailablePeriods: expected,
        planningDate: options.storedPlanningDate ?? planningDate,
      })
      .where(and(
        eq(stopsTable.id, stop.id),
        eq(stopsTable.organizationId, organizationId),
      ))
      .returning();
    if (updated) {
      stop.unavailablePeriods = updated.unavailablePeriods;
      stop.planningDate = updated.planningDate;
    }
  }
}

export async function materializeUnplannedCustomerStopSnapshots(
  organizationId: string,
  planningDate: Date,
  stopIds: string[],
): Promise<Array<typeof stopsTable.$inferSelect>> {
  if (!Number.isFinite(planningDate.getTime())) {
    throw new CustomerPlanningDateRequiredError();
  }
  if (stopIds.length === 0) return [];
  return db.transaction(async (tx) => {
    const stops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.id, stopIds),
        isNull(stopsTable.routeId),
        isNull(stopsTable.archivedAt),
      ))
      .for("update");
    if (stops.some((stop) => stop.customerId != null && stop.planningDate == null)) {
      await materializeDispatchCustomerUnavailablePeriods(
        tx,
        organizationId,
        planningDate,
        stops,
      );
    }
    return stops;
  });
}

async function defaultServiceDuration(organizationId: string): Promise<number> {
  const [organization] = await db
    .select({ defaultServiceDurationMin: organizationsTable.defaultServiceDurationMin })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  return organization?.defaultServiceDurationMin ?? 5;
}

export async function importStops(organizationId: string, stopRows: any[], expectedRowCount = stopRows.length) {
  assertImportRowCount(expectedRowCount, stopRows.length);
  const values = importStopValues(
    organizationId,
    stopRows,
    await defaultServiceDuration(organizationId),
  );
  const created = await db.transaction(async (tx) => {
    await materializeImportedCustomerUnavailablePeriods(tx, organizationId, values);
    return tx.insert(stopsTable).values(values).returning();
  });
  const cache = getDistanceCache();
  for (const s of created) {
    cache.invalidate(s.latitude, s.longitude);
  }
  broadcastDataChange(organizationId, "stop", "created", { bulk: true, count: created.length });
  return created;
}

export async function getDraftImportReplay(
  organizationId: string,
  draftId: string,
  clientPayloadHash: string,
) {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(planningDraftsTable)
      .where(and(
        eq(planningDraftsTable.id, draftId),
        eq(planningDraftsTable.organizationId, organizationId),
      ))
      .limit(1)
      .for("update");
    if (!draft) {
      throw new PlanningDraftError("Planning draft not found.", 404, "DRAFT_NOT_FOUND");
    }
    if (!draft.importedPayloadHash) return null;
    if (draft.importedPayloadHash !== clientPayloadHash) {
      throw new PlanningDraftError(
        "This planning draft already has a different imported payload.",
        409,
        "DRAFT_IMPORT_CONFLICT",
      );
    }
    const stored = draft.importedResult;
    if (!stored) {
      throw new PlanningDraftError(
        "The planning draft has an incomplete import result. Try again.",
        409,
        "DRAFT_IMPORT_INCOMPLETE",
      );
    }
    const storedStops = stored.stopIds.length > 0
      ? await tx.select().from(stopsTable).where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.id, stored.stopIds),
      ))
      : [];
    if (storedStops.some((stop) => stop.archivedAt !== null)) {
      throw new PlanningDraftError(
        "This planning draft references archived stops and must be reconciled before replay.",
        409,
        "DRAFT_ARCHIVED_STOPS",
      );
    }
    if (storedStops.length !== stored.stopIds.length) {
      throw new PlanningDraftError(
        "The planning draft import result no longer has all of its source stops.",
        409,
        "DRAFT_IMPORT_INCOMPLETE",
      );
    }
    return {
      replayed: true as const,
      result: {
        ...stored,
        // Never replay serialized stop rows: durable rows are authoritative.
        stops: storedStops,
      },
    };
  });
}

/**
 * Import rows and the draft's durable import result in one transaction. The
 * draft row is the serialization point: a retry after a lost response returns
 * the original rows instead of inserting a second batch.
 */
export async function importStopsForDraft(
  organizationId: string,
  draftId: string,
  stopRows: any[],
  expectedRowCount = stopRows.length,
  clientPayloadHash = payloadIdentityHash({
    expectedRowCount,
    stops: stopRows,
  }),
) {
  assertImportRowCount(expectedRowCount, stopRows.length);
  const values = importStopValues(
    organizationId,
    stopRows,
    await defaultServiceDuration(organizationId),
  );
  const payloadHash = clientPayloadHash;
  const transactionResult = await db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(planningDraftsTable)
      .where(and(
        eq(planningDraftsTable.id, draftId),
        eq(planningDraftsTable.organizationId, organizationId),
      ))
      .limit(1)
      .for("update");
    if (!draft) {
      throw new PlanningDraftError("Planning draft not found.", 404, "DRAFT_NOT_FOUND");
    }
    if (draft.importedPayloadHash) {
      if (draft.importedPayloadHash !== payloadHash) {
        throw new PlanningDraftError(
          "This planning draft already has a different imported payload.",
          409,
          "DRAFT_IMPORT_CONFLICT",
        );
      }
      const stored = draft.importedResult;
      if (!stored) {
        throw new PlanningDraftError(
          "The planning draft has an incomplete import result. Try again.",
          409,
          "DRAFT_IMPORT_INCOMPLETE",
        );
      }
      const storedStops = stored.stopIds.length > 0
        ? await tx.select().from(stopsTable).where(and(
          eq(stopsTable.organizationId, organizationId),
          inArray(stopsTable.id, stored.stopIds),
        ))
        : [];
      if (storedStops.some((stop) => stop.archivedAt !== null)) {
        throw new PlanningDraftError(
          "This planning draft references archived stops and must be reconciled before replay.",
          409,
          "DRAFT_ARCHIVED_STOPS",
        );
      }
      if (storedStops.length !== stored.stopIds.length) {
        throw new PlanningDraftError(
          "The planning draft import result no longer has all of its source stops.",
          409,
          "DRAFT_IMPORT_INCOMPLETE",
        );
      }
      return {
        replayed: true,
        result: {
          ...stored,
          // Do not fall back to JSON-embedded rows after an archive/delete.
          stops: storedStops,
        },
      };
    }
    if (draft.planId) {
      throw new PlanningDraftError(
        "This planning draft already has a route plan.",
        409,
        "DRAFT_ALREADY_PLANNED",
      );
    }
    // Draft imports have an authoritative planning day even though the public
    // row payload does not. Persist it before materializing customer closures;
    // otherwise a linked stop could enter dispatch with an empty snapshot.
    for (const value of values) value.planningDate = draft.startAt;
    await materializeImportedCustomerUnavailablePeriods(tx, organizationId, values);
    const created = await tx.insert(stopsTable).values(values).returning();
    const result = {
      imported: created.length,
      receivedRowCount: stopRows.length,
      savedRowCount: created.length,
      stopIds: created.map((stop) => stop.id),
      stops: created,
      rowResults: created.map((stop, index) => ({
        sourceRowNumber: stopRows[index]?.sourceRowNumber ?? index + 1,
        status: "saved" as const,
        stopId: stop.id,
      })),
    };
    await tx.update(planningDraftsTable).set({
      importedPayloadHash: payloadHash,
      importedResult: result,
      updatedAt: new Date(),
    }).where(and(
      eq(planningDraftsTable.id, draftId),
      eq(planningDraftsTable.organizationId, organizationId),
    ));
    return { replayed: false, result };
  });
  if (!transactionResult.replayed) {
    const cache = getDistanceCache();
    const createdStops = transactionResult.result.stops as Array<{
      latitude: number;
      longitude: number;
    }>;
    for (const stop of createdStops) {
      cache.invalidate(stop.latitude, stop.longitude);
    }
    broadcastDataChange(organizationId, "stop", "created", {
      bulk: true,
      count: transactionResult.result.savedRowCount,
    });
  }
  return transactionResult;
}

export type DispatchAssignmentConflict =
  | "NO_VEHICLE"
  | "CAPACITY"
  | "TIME_WINDOW"
  | "WORKING_HOURS"
  | "RANGE";

export class DispatchRevisionConflictError extends Error {
  statusCode = 409;
  code = "DISPATCH_REVISION_CONFLICT" as const;

  constructor() {
    super("One or more routes changed while the move was being saved. Reload and try again.");
    this.name = "DispatchRevisionConflictError";
  }
}

let dispatchMutationBeforeLockHook:
  | (() => Promise<void>)
  | undefined;
let stopUpdateBeforeWriteHook:
  | (() => Promise<void>)
  | undefined;

function hasPersistedPlanningEvidence(
  snapshot: unknown,
): boolean {
  if (!snapshot || typeof snapshot !== "object") return false;
  const value = snapshot as Record<string, unknown>;
  return Number.isFinite(value.travelReservePercent)
    && Number.isInteger(value.stopReserveMin)
    && Number(value.travelReservePercent) >= 0
    && Number(value.stopReserveMin) >= 0;
}

/**
 * Resolve the driver that was actually assigned to a route. Protected import
 * routes must use the immutable optimization resource snapshot; handoff
 * recipients are also exact references and may never silently fall back to a
 * different active driver. A legacy route without either reference is safe
 * only when exactly one active driver is linked to its vehicle.
 */
async function dispatchDriverSnapshot(
  tx: DbTransaction,
  organizationId: string,
  route: typeof routesTable.$inferSelect | undefined,
) {
  if (!route?.vehicleId) return undefined;
  const activeDrivers = await tx.select().from(driversTable).where(and(
    eq(driversTable.vehicleId, route.vehicleId),
    eq(driversTable.organizationId, organizationId),
    eq(driversTable.isActive, true),
  )).orderBy(driversTable.id);
  const optimizationDriverId = optimizationDriverIdForRoute(route);
  const exactDriverId = isProtectedImportRoute(route)
    ? optimizationDriverId
    : route.handoffDriverId ?? optimizationDriverId;
  if (isProtectedImportRoute(route) && !exactDriverId) return undefined;
  if (exactDriverId) {
    return activeDrivers.find((driver) => driver.id === exactDriverId);
  }
  return activeDrivers.length === 1 ? activeDrivers[0] : undefined;
}

function dispatchDistanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const dLat = ((to.latitude - from.latitude) * Math.PI) / 180;
  const dLng = ((to.longitude - from.longitude) * Math.PI) / 180;
  const lat1 = (from.latitude * Math.PI) / 180;
  const lat2 = (to.latitude * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Legacy routes created directly by dispatch have no immutable planning
 * snapshot yet. Keep their established manual-dispatch feasibility checks
 * until a planning operation produces authoritative depot evidence. Protected
 * imported routes never use this fallback.
 */
type LegacyDispatchConflictResult = {
  conflicts: DispatchAssignmentConflict[];
  hardUnavailable: boolean;
};

function calculateLegacyDispatchConflicts(
  stop: typeof stopsTable.$inferSelect,
  route: typeof routesTable.$inferSelect,
  vehicle: typeof vehiclesTable.$inferSelect | undefined,
  driver: typeof driversTable.$inferSelect | undefined,
  routeStops: Array<typeof stopsTable.$inferSelect>,
): LegacyDispatchConflictResult {
  const conflicts = new Set<DispatchAssignmentConflict>();
  let hardUnavailable = false;
  if (!vehicle) {
    conflicts.add("NO_VEHICLE");
    return { conflicts: [...conflicts], hardUnavailable };
  }

  const activeRouteStops = routeStops.filter((candidate) => candidate.id !== stop.id);
  const totalWeight = activeRouteStops.reduce(
    (sum, candidate) => sum + (candidate.weightKg ?? 0),
    stop.weightKg ?? 0,
  );
  const totalVolume = activeRouteStops.reduce(
    (sum, candidate) => sum + (candidate.volumeM3 ?? 0),
    stop.volumeM3 ?? 0,
  );
  const effectiveCapacityKg = Math.min(
    vehicle.capacityKg,
    driver?.capacityKg ?? vehicle.capacityKg,
  );
  const effectiveCapacityVolume = Math.min(
    vehicle.capacityVolume,
    driver?.capacityVolume ?? vehicle.capacityVolume,
  );
  if (totalWeight > effectiveCapacityKg || totalVolume > effectiveCapacityVolume) {
    conflicts.add("CAPACITY");
  }

  const scheduled = [...activeRouteStops, stop].sort(
    (a, b) => (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER)
      - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const start = new Date(route.date);
  const [startHour, startMinute] = (driver?.workStartTime ?? "07:00").split(":").map(Number);
  start.setHours(startHour || 0, startMinute || 0, 0, 0);
  const workEnd = new Date(route.date);
  const [endHour, endMinute] = (driver?.workEndTime ?? "18:00").split(":").map(Number);
  workEnd.setHours(endHour || 0, endMinute || 0, 0, 0);
  if (workEnd <= start) workEnd.setDate(workEnd.getDate() + 1);
  let current = start;
  let previous: { latitude: number; longitude: number } | null = null;
  let routeDistance = 0;
  let breakTaken = false;
  const addElapsedMinutes = (minutes: number) => {
    if (!breakTaken && driver?.breakStartTime && driver.breakEndTime) {
      const breakStart = new Date(route.date);
      const breakEnd = new Date(route.date);
      const [breakStartHour, breakStartMinute] = driver.breakStartTime.split(":").map(Number);
      const [breakEndHour, breakEndMinute] = driver.breakEndTime.split(":").map(Number);
      breakStart.setHours(breakStartHour || 0, breakStartMinute || 0, 0, 0);
      breakEnd.setHours(breakEndHour || 0, breakEndMinute || 0, 0, 0);
      if (breakEnd <= breakStart) breakEnd.setDate(breakEnd.getDate() + 1);
      const intervalEnd = new Date(current.getTime() + minutes * 60_000);
      if (current < breakEnd && intervalEnd > breakStart) {
        current = new Date(Math.max(current.getTime(), breakStart.getTime()));
        current = new Date(current.getTime() + (breakEnd.getTime() - breakStart.getTime()));
        breakTaken = true;
      }
    }
    current = new Date(current.getTime() + minutes * 60_000);
  };

  for (const candidate of scheduled) {
    const visits = candidate.jobType === "pickup_delivery"
      ? [
          {
            latitude: candidate.pickupLatitude!,
            longitude: candidate.pickupLongitude!,
            serviceMinutes: 5,
            checkWindow: false,
          },
          {
            latitude: candidate.latitude,
            longitude: candidate.longitude,
            serviceMinutes: candidate.serviceDurationMin,
            checkWindow: true,
          },
        ]
      : [{
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          serviceMinutes: candidate.serviceDurationMin,
          checkWindow: true,
        }];

    for (const visit of visits) {
      if (previous) {
        const distance = dispatchDistanceKm(previous, visit);
        routeDistance += distance;
        addElapsedMinutes((distance / 30) * 60);
      }
      if (visit.checkWindow && candidate.timeWindowStart && current < candidate.timeWindowStart) {
        current = new Date(candidate.timeWindowStart);
      }
      if (visit.checkWindow && candidate.timeWindowEnd && current > candidate.timeWindowEnd) {
        conflicts.add("TIME_WINDOW");
      }
      if (visit.checkWindow) {
        const unavailablePeriods = (candidate as typeof candidate & {
          unavailablePeriods?: unknown;
        }).unavailablePeriods;
        const serviceSchedule = scheduleServiceAroundUnavailable(
          current,
          visit.serviceMinutes,
          unavailablePeriods,
        );
        if (!serviceSchedule.valid) {
          conflicts.add("TIME_WINDOW");
          hardUnavailable = true;
          addElapsedMinutes(visit.serviceMinutes);
        } else {
          // Advance through the returned waiting/service segments in order.
          // Pickup visits never enter this branch, so closures cannot block
          // pickup service for a composite pickup/delivery stop.
          const segments = [
            ...serviceSchedule.waiting.map((segment) => ({
              start: segment.start,
              end: segment.end,
            })),
            ...serviceSchedule.segments.map((segment) => ({
              start: segment.start,
              end: segment.end,
            })),
          ].sort((left, right) => left.start.getTime() - right.start.getTime());
          if (serviceSchedule.waiting.length > 0) hardUnavailable = true;
          for (const segment of segments) {
            addElapsedMinutes((segment.end.getTime() - segment.start.getTime()) / 60_000);
          }
        }
      } else {
        addElapsedMinutes(visit.serviceMinutes);
      }
      previous = visit;
    }
  }

  if (current > workEnd) conflicts.add("WORKING_HOURS");
  const effectiveRange = vehicle.vehicleType === "electric" && vehicle.rangeKm != null
    ? vehicle.rangeKm * Math.max(0, Math.min(100, vehicle.currentBatteryPercent ?? 100)) / 100
    : vehicle.rangeKm;
  if (effectiveRange != null && routeDistance * 2 > effectiveRange * 0.95) {
    conflicts.add("RANGE");
  }
  return { conflicts: [...conflicts], hardUnavailable };
}

export function calculateDispatchConflicts(
  route: typeof routesTable.$inferSelect,
  vehicle: typeof vehiclesTable.$inferSelect | undefined,
  driver: typeof driversTable.$inferSelect | undefined,
  routeStops: Array<typeof stopsTable.$inferSelect>,
  organization: { maxDriverOvertimeMin?: number | null; allowLateStopsMin?: number | null } | null | undefined,
): DispatchAssignmentConflict[] {
  const conflicts = new Set<DispatchAssignmentConflict>();
  if (!vehicle) {
    conflicts.add("NO_VEHICLE");
    return [...conflicts];
  }
  if (!hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot)) {
    conflicts.add("WORKING_HOURS");
    return [...conflicts];
  }
  const policy = effectivePlanningPolicy(organization, route.optimizationPlanningSnapshot);
  const planningInputs = normalizePlanningInputs(route.optimizationPlanningSnapshot);
  const nodes: ALNSNode[] = [];
  const sortedStops = [...routeStops].sort(
    (left, right) => (left.sequenceOrder ?? Number.MAX_SAFE_INTEGER)
      - (right.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const stopById = new Map(sortedStops.map((candidate) => [candidate.id, candidate]));
  const itinerary = route.plannerItinerary;
  const itineraryCustomerIds = itinerary?.filter((entry) => !entry.isChargingStop).map((entry) => entry.stopId) ?? [];
  const canRetainItinerary = itineraryCustomerIds.length === sortedStops.length
    && itineraryCustomerIds.every((id, index) => id === sortedStops[index]?.id);
  if (canRetainItinerary && itinerary) {
    for (const entry of itinerary) {
      if (entry.isChargingStop) {
        const station = CHARGING_STATIONS.find((candidate) => candidate.id === entry.stopId);
        if (station) nodes.push({ ...station });
      } else {
        const candidate = stopById.get(entry.stopId);
        if (candidate) nodes.push(nodeWithCanonicalPlanningLocks(toAlnsNode(candidate, planningInputs), candidate));
      }
    }
  } else {
    nodes.push(...sortedStops.map((candidate) => nodeWithCanonicalPlanningLocks(toAlnsNode(candidate, planningInputs), candidate)));
  }
  if (route.optimizationFrozen) nodes.splice(0, nodes.length, ...canonicalFrozenItinerary(route, sortedStops, nodes).nodes);
  const totalWeight = sortedStops.reduce((sum, candidate) => sum + (candidate.weightKg ?? 0), 0);
  const totalVolume = sortedStops.reduce((sum, candidate) => sum + (candidate.volumeM3 ?? 0), 0);
  const effectiveCapacityKg = Math.min(vehicle.capacityKg, driver?.capacityKg ?? vehicle.capacityKg);
  const effectiveCapacityVolume = Math.min(vehicle.capacityVolume, driver?.capacityVolume ?? vehicle.capacityVolume);
  if (totalWeight > effectiveCapacityKg || totalVolume > effectiveCapacityVolume) {
    conflicts.add("CAPACITY");
  }
  const baseRoutingVehicle: import("./alns/types").ALNSVehicle = {
    id: vehicle.id,
    vehicleType: vehicle.vehicleType,
    capacityKg: vehicle.capacityKg,
    capacityVolume: vehicle.capacityVolume,
    rangeKm: vehicle.vehicleType === "electric" && vehicle.rangeKm != null
      ? vehicle.rangeKm * Math.max(0, Math.min(100, vehicle.currentBatteryPercent ?? 100)) / 100
      : vehicle.rangeKm,
    startLatitude: route.depotSnapshot?.start.latitude,
    startLongitude: route.depotSnapshot?.start.longitude,
    endLatitude: route.depotSnapshot?.end.latitude,
    endLongitude: route.depotSnapshot?.end.longitude,
  };
  const routingVehicle = withOrganizationPlanningPolicy(
    driver ? applyDriverRoutingProfile(baseRoutingVehicle, driver) : baseRoutingVehicle,
    policy,
  );
  routingVehicle.driverId = driver?.id;
  routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
  const depotLatitude = route.depotSnapshot?.start.latitude ?? routingVehicle.startLatitude;
  const depotLongitude = route.depotSnapshot?.start.longitude ?? routingVehicle.startLongitude;
  if (depotLatitude == null || depotLongitude == null || !route.depotSnapshot) {
    conflicts.add("WORKING_HOURS");
    return [...conflicts];
  }
  const evaluation = evaluateRouteWorkday(
    nodes,
    routingVehicle,
    depotLatitude,
    depotLongitude,
    route.date,
    driver ? routingConstraintsForDriver(driver) : undefined,
  );
  if (
    evaluation.reasonCode === "TIME_WINDOW"
    || evaluation.reasonCode === "UNAVAILABLE_PERIOD"
  ) {
    // Preserve the existing dispatch API conflict vocabulary.  The detailed
    // hard-closure reason is retained by the canonical workday evaluator.
    conflicts.add("TIME_WINDOW");
  }
  if (evaluation.reasonCode === "SHIFT_END" || evaluation.reasonCode === "OVERTIME") conflicts.add("WORKING_HOURS");
  if (evaluation.reasonCode === "EV_RETURN_RANGE") conflicts.add("RANGE");
  return [...conflicts];
}

/**
 * The preview path runs the same authoritative hard-workday guard as the
 * mutation path, but evaluates proposed route contents in memory and never
 * persists derived route or stop state.
 */
export async function assertDispatchRouteWorkdaySafeForPreview(
  tx: DbTransaction,
  organizationId: string,
  route: typeof routesTable.$inferSelect,
  organization: { maxDriverOvertimeMin?: number | null; allowLateStopsMin?: number | null } | null | undefined,
  proposedStops: Array<typeof stopsTable.$inferSelect>,
): Promise<DispatchRouteMetrics | null> {
  const protectedRoute = isProtectedImportRoute(route);
  const hasPlanningEvidence = hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot);
  const requiresAuthoritativeWorkday = route.lockedFirstStopId != null;
  const fail = (message: string) => {
    const error = new Error(message) as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  };
  if (!route.depotSnapshot || (protectedRoute && !hasPlanningEvidence)) {
    if (protectedRoute || requiresAuthoritativeWorkday) {
      fail(!route.depotSnapshot
        ? "Rutten saknar sparat depåbevis och kan inte ändras säkert."
        : "Rutten saknar sparat reservunderlag och kan inte ändras säkert.");
    }
    return null;
  }
  if (!route.vehicleId) fail("Rutten saknar fordon och kan inte ändras säkert.");
  const [vehicle] = await tx.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.id, route.vehicleId!),
    eq(vehiclesTable.organizationId, organizationId),
  )).limit(1);
  const driver = await dispatchDriverSnapshot(tx, organizationId, route);
  if (!vehicle || !driver) {
    fail("Rutten saknar ett aktivt bil–chaufförspar och kan inte ändras säkert.");
  }
  const activeVehicle = vehicle!;
  const activeDriver = driver!;
  const stops = [...proposedStops].sort((left, right) =>
    (left.sequenceOrder ?? Number.MAX_SAFE_INTEGER)
    - (right.sequenceOrder ?? Number.MAX_SAFE_INTEGER));
  if (stops.some((stop) => stop.customerId != null)) {
    await materializeDispatchCustomerUnavailablePeriods(
      tx,
      organizationId,
      route.date,
      stops,
      { previewOnly: true },
    );
  }
  const planningInputs = normalizePlanningInputs(route.optimizationPlanningSnapshot);
  const policy = effectivePlanningPolicy(organization, route.optimizationPlanningSnapshot);
  planningInputs.maxDriverOvertimeMin = policy.maxDriverOvertimeMin;
  planningInputs.allowLateStopsMin = policy.allowLateStopsMin;
  const customerNodes = stops.map((stop) => nodeWithCanonicalPlanningLocks(toAlnsNode(stop, planningInputs), stop));
  const nodes = route.optimizationFrozen ? canonicalFrozenItinerary(route, stops, customerNodes).nodes : customerNodes;
  const routingVehicle = withOrganizationPlanningPolicy(applyDriverRoutingProfile({
    id: activeVehicle.id,
    vehicleType: activeVehicle.vehicleType,
    capacityKg: activeVehicle.capacityKg,
    capacityVolume: activeVehicle.capacityVolume,
    rangeKm: activeVehicle.vehicleType === "electric" && activeVehicle.rangeKm != null
      ? activeVehicle.rangeKm * Math.max(0, Math.min(100, activeVehicle.currentBatteryPercent ?? 100)) / 100
      : activeVehicle.rangeKm,
    startLatitude: route.depotSnapshot.start.latitude,
    startLongitude: route.depotSnapshot.start.longitude,
    endLatitude: route.depotSnapshot.end.latitude,
    endLongitude: route.depotSnapshot.end.longitude,
  }, activeDriver), policy);
  routingVehicle.driverId = activeDriver.id;
  routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
  const constraints = routingConstraintsForDriver(activeDriver);
  const candidate: ALNSRoute = {
    vehicleId: activeVehicle.id,
    nodes,
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
  const solution: ALNSSolution = {
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
  };
  if (!route.optimizationFrozen) chargingStationInsertion(
    solution,
    [routingVehicle],
    route.depotSnapshot.start.latitude,
    route.depotSnapshot.start.longitude,
    route.date,
    new Map([[activeVehicle.id, constraints]]),
  );
  const calculateWorkday = () => evaluateRouteWorkday(
    candidate.nodes,
    routingVehicle,
    route.depotSnapshot!.start.latitude,
    route.depotSnapshot!.start.longitude,
    route.date,
    constraints,
  );
  const workday = route.optimizationFrozen || stops.some(stop => stop.lockedVehicleId || stop.lockedServiceStartAt)
    ? withRequiredRoadData(calculateWorkday) : calculateWorkday();
  assertPlanningLockTimes(route, stops, workday.events);
  if (
    !workday.feasible
    && (
      route.lockedFirstStopId != null
      || workday.reasonCode === "UNAVAILABLE_PERIOD"
      || workday.unavailableWaitMin > 0
    )
  ) {
    fail(workdayInfeasibilityMessage(workday, {
    vehicleName: activeVehicle.name,
    breakStartTime: activeDriver.breakStartTime,
    breakEndTime: activeDriver.breakEndTime,
    }));
  }
  // Report only verified cached road calculations, never analytical geometry.
  // This performs no fetch and cannot spend matrix quota while holding locks.
  try {
    const verified = withRequiredRoadData(() => evaluateRouteWorkday(
      candidate.nodes, routingVehicle, route.depotSnapshot!.start.latitude,
      route.depotSnapshot!.start.longitude, route.date, constraints,
    ));
    assertPlanningLockTimes(route, stops, verified.events);
    if (!verified.feasible && (route.lockedFirstStopId != null
      || verified.reasonCode === "UNAVAILABLE_PERIOD" || verified.unavailableWaitMin > 0)) {
      fail(workdayInfeasibilityMessage(verified, {
        vehicleName: activeVehicle.name, breakStartTime: activeDriver.breakStartTime, breakEndTime: activeDriver.breakEndTime,
      }));
    }
    return {
      driveMin: verified.summary.nonReturnDrivingMin + verified.summary.returnMin,
      workMin: verified.summary.totalMin,
      endAt: verified.events.at(-1)?.endAt ?? null,
      windowViolations: verified.summary.lateStopIds?.length ?? 0,
      stopCount: stops.length,
    };
  } catch (error) {
    if (!(error instanceof RoadDataUnavailableError)) throw error;
    return null;
  }
}
/**
 * Rebuild the persisted route clock after a dispatch mutation. Dispatch
 * changes are not allowed to leave a route with a null or stale workday
 * summary: the same depot/reserve evidence used for validation is immediately
 * persisted as the new authoritative route state.
 */
export async function persistDispatchRouteWorkday(
  tx: DbTransaction,
  organizationId: string,
  route: typeof routesTable.$inferSelect,
  organization: { maxDriverOvertimeMin?: number | null; allowLateStopsMin?: number | null } | null | undefined,
) {
  // A dispatch move can leave an untouched third route holding stale A-C or
  // B-C evidence. Clear tenant-scoped derived evidence in this transaction;
  // do not change sibling revisions or approval/handoff state.
  if (!route.optimizationFrozen) await tx
    .update(routesTable)
    .set({ geographicOverlapExplanation: null })
    .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));
  const protectedRoute = isProtectedImportRoute(route);
  const hasPlanningEvidence = hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot);
  const requiresAuthoritativeWorkday = route.lockedFirstStopId != null;
  if (!route.depotSnapshot || (protectedRoute && !hasPlanningEvidence)) {
    if (protectedRoute || requiresAuthoritativeWorkday) {
      throw new Error(
        !route.depotSnapshot
          ? "Rutten saknar sparat depåbevis och kan inte ändras säkert."
          : "Rutten saknar sparat reservunderlag och kan inte ändras säkert.",
      );
    }
    // A manually created legacy route has no authoritative workday to
    // recalculate yet. Preserve the dispatch mutation and invalidate its
    // derived planning fields; the next optimization will establish evidence.
    const routeStops = await tx.select({ id: stopsTable.id }).from(stopsTable).where(and(
      eq(stopsTable.routeId, route.id),
      eq(stopsTable.organizationId, organizationId),
      isNull(stopsTable.archivedAt),
    ));
    const [updatedRoute] = await tx.update(routesTable).set({
      ...invalidatedRoutePlanningState(routeStops.length),
    }).where(and(
      eq(routesTable.id, route.id),
      eq(routesTable.organizationId, organizationId),
      eq(routesTable.planRevision, route.planRevision),
    )).returning({ id: routesTable.id });
    if (!updatedRoute) throw new DispatchRevisionConflictError();
    return;
  }
  if (!route.vehicleId) {
    throw new Error("Rutten saknar fordon och kan inte ändras säkert.");
  }
  const [vehicle] = await tx.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.id, route.vehicleId),
    eq(vehiclesTable.organizationId, organizationId),
  )).limit(1);
  const driver = await dispatchDriverSnapshot(tx, organizationId, route);
  if (!vehicle || !driver) {
    throw new Error("Rutten saknar ett aktivt bil–chaufförspar och kan inte ändras säkert.");
  }
  const stops = await tx.select().from(stopsTable).where(and(
    eq(stopsTable.routeId, route.id),
    eq(stopsTable.organizationId, organizationId),
    isNull(stopsTable.archivedAt),
  )).orderBy(stopsTable.sequenceOrder);
  // Manual assignment can introduce a customer-linked stop that was created
  // before a planning date existed. Materialize it against this route's day
  // before constructing ALNS nodes, so an empty snapshot cannot bypass a
  // customer's recurring hard closures.
  if (stops.some((stop) => stop.customerId != null)) {
    await materializeDispatchCustomerUnavailablePeriods(
      tx,
      organizationId,
      route.date,
      stops,
      { previewOnly: route.optimizationFrozen },
    );
  }
  const planningInputs = normalizePlanningInputs(route.optimizationPlanningSnapshot);
  const policy = effectivePlanningPolicy(organization, route.optimizationPlanningSnapshot);
  planningInputs.maxDriverOvertimeMin = policy.maxDriverOvertimeMin;
  planningInputs.allowLateStopsMin = policy.allowLateStopsMin;
  const customerNodes = stops.map((stop) => nodeWithCanonicalPlanningLocks(toAlnsNode(stop, planningInputs), stop));
  const nodes = route.optimizationFrozen ? canonicalFrozenItinerary(route, stops, customerNodes).nodes : customerNodes;
  const routingVehicle = withOrganizationPlanningPolicy(applyDriverRoutingProfile({
    id: vehicle.id,
    vehicleType: vehicle.vehicleType,
    capacityKg: vehicle.capacityKg,
    capacityVolume: vehicle.capacityVolume,
    rangeKm: vehicle.vehicleType === "electric" && vehicle.rangeKm != null
      ? vehicle.rangeKm * Math.max(0, Math.min(100, vehicle.currentBatteryPercent ?? 100)) / 100
      : vehicle.rangeKm,
    startLatitude: route.depotSnapshot.start.latitude,
    startLongitude: route.depotSnapshot.start.longitude,
    endLatitude: route.depotSnapshot.end.latitude,
    endLongitude: route.depotSnapshot.end.longitude,
  }, driver), policy);
  routingVehicle.driverId = driver.id;
  routingVehicle.travelReservePercent = planningInputs.travelReservePercent;
  const constraints = routingConstraintsForDriver(driver);
  const candidate: ALNSRoute = {
    vehicleId: vehicle.id,
    nodes,
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
  const solution: ALNSSolution = {
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
  };
  if (!route.optimizationFrozen) chargingStationInsertion(
    solution,
    [routingVehicle],
    route.depotSnapshot.start.latitude,
    route.depotSnapshot.start.longitude,
    route.date,
    new Map([[vehicle.id, constraints]]),
  );
  const calculateWorkday = () => evaluateRouteWorkday(
    candidate.nodes,
    routingVehicle,
    route.depotSnapshot!.start.latitude,
    route.depotSnapshot!.start.longitude,
    route.date,
    constraints,
  );
  const workday = route.optimizationFrozen || stops.some(stop => stop.lockedVehicleId || stop.lockedServiceStartAt)
    ? withRequiredRoadData(calculateWorkday) : calculateWorkday();
  assertPlanningLockTimes(route, stops, workday.events);
  const hardUnavailableInfeasibility =
    workday.reasonCode === "UNAVAILABLE_PERIOD"
    || workday.unavailableWaitMin > 0;
  if (
    !workday.feasible
    && (route.lockedFirstStopId != null || hardUnavailableInfeasibility)
  ) {
    const error = new Error(workdayInfeasibilityMessage(workday, {
      vehicleName: vehicle.name,
      breakStartTime: driver.breakStartTime,
      breakEndTime: driver.breakEndTime,
    })) as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  }
  if (route.optimizationFrozen) return;
  // A successfully recalculated manual move establishes a new planning
  // baseline. Keeping the old order here makes this very revision impossible
  // to approve. Infeasible overrides must not acquire fresh approval evidence.
  const certifications = workday.feasible
    ? await tx.select().from(driverCertificationsTable).where(and(
      eq(driverCertificationsTable.organizationId, organizationId),
      eq(driverCertificationsTable.driverId, driver.id),
    )).for("update")
    : [];
  const totalWeight = candidate.totalWeight;
  const plannerItinerary = itineraryForNodes(
    candidate.nodes,
    routingVehicle,
    driver,
    route.depotSnapshot.start.latitude,
    route.depotSnapshot.start.longitude,
    route.date,
  );
  const [updatedRoute] = await tx.update(routesTable).set({
    totalDistanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
    totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
    totalStops: stops.length,
    co2EmissionsKg: Math.round(estimateCo2(
      workday.totalDistanceKm,
      vehicle.vehicleType,
      totalWeight,
      routingVehicle.capacityKg,
    ) * 100) / 100,
    plannerItinerary,
    workdayTimeline: workday.events,
    workdaySummary: workday.summary,
    optimizationPlanningSnapshot: planningInputs,
    optimizationPlanningSnapshotHash: payloadIdentityHash(planningInputs),
    ...(workday.feasible ? {
      optimizationResourceSnapshot: materialResourceSnapshot(vehicle, driver, stops, certifications),
      optimizationResourceSnapshotHash: materialResourceSnapshotHash(vehicle, driver, stops, certifications),
    } : {}),
    planningSummary: null,
    manualReviewRequired: true,
    manualReviewedAt: null,
    geographicOverlapExplanation: null,
    executionProjection: null,
    redistributionSuggestion: null,
    planRevision: sql`${routesTable.planRevision} + 1`,
    ...workingRouteHandoff(),
  }).where(and(
    eq(routesTable.id, route.id),
    eq(routesTable.organizationId, organizationId),
    eq(routesTable.planRevision, route.planRevision),
  )).returning({ id: routesTable.id });
  if (!updatedRoute) throw new DispatchRevisionConflictError();
}

export async function moveStopsForDispatch(
  organizationId: string,
  input: {
    stopIds: string[];
    routeId: string | null;
    targetIndex: number;
    force?: boolean;
    routeRevisions: Array<{ routeId: string; planRevision: number }>;
    expectedPreviewDigest?: string;
    optimizeTargetRoute?: boolean;
    newProject?: { name: string; date: string; vehicleId: string };
  },
  options: { previewOnly?: boolean } = {},
): Promise<
  | { kind: "not_found" }
  | {
      kind: "ineligible";
      error: string;
      code?: DispatchMoveIneligibleCode;
      details?: DispatchLockedStopDetails;
    }
  | { kind: "conflict"; conflicts: DispatchAssignmentConflict[] }
  | {
      kind: "preview";
      canMove: boolean;
      conflicts: DispatchAssignmentConflict[];
      sourceRouteIds: string[];
      targetRouteId: string | null;
      targetStopCount: number;
      previewDigest: string;
      consequences: DispatchConsequences;
    }
  | {
      kind: "moved";
      draftId?: string;
      stops: Array<typeof stopsTable.$inferSelect>;
      conflicts: DispatchAssignmentConflict[];
    }
> {
  if (input.newProject && (input.routeId || input.optimizeTargetRoute || !input.newProject.name.trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.newProject.date)
    || !Number.isFinite(Date.parse(`${input.newProject.date}T00:00:00Z`))
    || new Date(`${input.newProject.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.newProject.date
    || (!options.previewOnly && !input.expectedPreviewDigest))) {
    return { kind: "ineligible", error: "Nytt projekt kräver namn, giltigt datum och granskad förhandsvisning." };
  }
  if (input.optimizeTargetRoute && (!input.routeId || (!options.previewOnly && !input.expectedPreviewDigest))) {
    return { kind: "ineligible", error: "Optimering kräver en befintlig mottagarrutt och en granskad förhandsvisning." };
  }
  // Reject impossible gestures before potentially expensive road-provider I/O.
  // This is only an early rejection: runMove still repeats lifecycle and
  // revision checks under its canonical transaction locks.
  const earlyStops = await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId),
    inArray(stopsTable.id, input.stopIds),
  ));
  if (earlyStops.length !== input.stopIds.length) return { kind: "not_found" };
  const earlyLockedStop = earlyStops.find(stop => stop.archivedAt !== null || stop.status !== "pending");
  if (earlyLockedStop) return {
    kind: "ineligible",
    error: earlyLockedStop.archivedAt !== null
      ? "Archived stops are historical records and cannot be moved in dispatch"
      : "Only pending stops can be moved in dispatch",
    code: STOP_LIFECYCLE_LOCKED_CODE,
    details: getDispatchLockedStopDetails(earlyLockedStop),
  };
  const strictRoads = await prepareDispatchLockRoadData(organizationId, {
    routeIds: input.routeId ? [input.routeId] : [], stopIds: input.stopIds,
  });
  // Preview search may perform matrix/provider I/O. Capture its exact locked
  // inputs, roll back, then compute without holding a transaction/connection.
  // A second locked pass must match these facts before retaining the proposal.
  class PrepareTargetOutsideTransaction extends Error {
    constructor(
      readonly factsDigest: string,
      readonly args: Parameters<typeof optimizeDispatchTarget>,
    ) { super("Prepare dispatch target outside transaction"); }
  }
  let preparedTarget: { factsDigest: string; stopIds: string[] } | undefined;
  const runMove = () => db.transaction(async (tx) => {
    const movingSnapshot = await tx
      .select()
      .from(stopsTable)
      .where(and(
        inArray(stopsTable.id, input.stopIds),
        eq(stopsTable.organizationId, organizationId),
      ));
    if (movingSnapshot.length !== input.stopIds.length) {
      return { kind: "not_found" as const };
    }
    const archivedMovingStop = movingSnapshot.find((stop) => stop.archivedAt !== null);
    if (archivedMovingStop) {
      return {
        kind: "ineligible" as const,
        error: "Archived stops are historical records and cannot be moved in dispatch",
        code: STOP_LIFECYCLE_LOCKED_CODE,
        details: getDispatchLockedStopDetails(archivedMovingStop),
      };
    }
    const movingLockedStop = movingSnapshot.find((stop) => stop.status !== "pending");
    if (movingLockedStop) {
      return {
        kind: "ineligible" as const,
        error: "Only pending stops can be moved in dispatch",
        code: STOP_LIFECYCLE_LOCKED_CODE,
        details: getDispatchLockedStopDetails(movingLockedStop),
      };
    }

    const [targetRouteSnapshot] = input.routeId
      ? await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, input.routeId),
          eq(routesTable.organizationId, organizationId),
        ))
        .limit(1)
      : [];
    if (input.routeId && !targetRouteSnapshot) return { kind: "not_found" as const };

    const affectedRouteIds = Array.from(new Set([
      ...(input.routeId ? [input.routeId] : []),
      ...movingSnapshot
        .map((stop) => stop.routeId)
        .filter((routeId): routeId is string => Boolean(routeId)),
    ])).sort();
    const suppliedRevisions = new Map(
      input.routeRevisions.map((item) => [item.routeId, item.planRevision]),
    );
    if (
      suppliedRevisions.size !== input.routeRevisions.length ||
      input.routeRevisions.length !== affectedRouteIds.length ||
      [...suppliedRevisions.keys()].some((routeId) => !affectedRouteIds.includes(routeId))
    ) {
      throw new DispatchRevisionConflictError();
    }
    const routeStopsSnapshot = affectedRouteIds.length > 0
      ? await tx
        .select()
        .from(stopsTable)
        .where(and(
          inArray(stopsTable.routeId, affectedRouteIds),
          eq(stopsTable.organizationId, organizationId),
          isNull(stopsTable.archivedAt),
        ))
      : [];
    const [vehicleSnapshot] = targetRouteSnapshot?.vehicleId
      ? await tx
        .select()
        .from(vehiclesTable)
        .where(and(
          eq(vehiclesTable.id, targetRouteSnapshot.vehicleId),
          eq(vehiclesTable.organizationId, organizationId),
        ))
        .limit(1)
      : [];
    const driverSnapshot = await dispatchDriverSnapshot(
      tx,
      organizationId,
      targetRouteSnapshot,
    );
    const certificationSnapshot = driverSnapshot
      ? await tx
        .select()
        .from(driverCertificationsTable)
        .where(and(
          eq(driverCertificationsTable.organizationId, organizationId),
          eq(driverCertificationsTable.driverId, driverSnapshot.id),
        ))
        .orderBy(driverCertificationsTable.id)
      : [];

    await dispatchMutationBeforeLockHook?.();
    for (const stopId of [...input.stopIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-stop:" + stopId}))`,
      );
    }
    for (const routeId of affectedRouteIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }
    const lockedRoutes = await lockRoutesForPlanningMutation(
      tx,
      organizationId,
      affectedRouteIds,
    );
    if (lockedRoutes.length !== affectedRouteIds.length) {
      return { kind: "not_found" as const };
    }

    const affectedRoutes = affectedRouteIds.length > 0
      ? await tx.select().from(routesTable).where(and(
          inArray(routesTable.id, affectedRouteIds),
          eq(routesTable.organizationId, organizationId),
        )).orderBy(routesTable.id).for("update")
      : [];
    const currentRouteStops = affectedRouteIds.length > 0
      ? await tx
        .select()
        .from(stopsTable)
        .where(and(
          inArray(stopsTable.routeId, affectedRouteIds),
          eq(stopsTable.organizationId, organizationId),
          isNull(stopsTable.archivedAt),
        ))
        .orderBy(stopsTable.id)
        .for("update")
      : [];
    const movingStops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        inArray(stopsTable.id, input.stopIds),
        eq(stopsTable.organizationId, organizationId),
      ))
      .orderBy(stopsTable.id)
      .for("update");
    if (affectedRoutes.length !== affectedRouteIds.length) {
      return { kind: "not_found" as const };
    }
    if (
      affectedRoutes.some((route) => suppliedRevisions.get(route.id) !== route.planRevision)
    ) {
      throw new DispatchRevisionConflictError();
    }
    const movingSnapshotById = new Map(movingSnapshot.map((stop) => [stop.id, stop]));
    let projectPair: { vehicleId: string; driverId: string } | undefined;
    if (input.newProject) {
      const [reservedDraft] = await tx.select({ id: planningDraftsTable.id }).from(planningDraftsTable).where(and(
        eq(planningDraftsTable.organizationId, organizationId),
        isNull(planningDraftsTable.planId),
        or(...input.stopIds.map(id => sql`${planningDraftsTable.state}->'dispatchSourceStopIds' @> ${JSON.stringify([id])}::jsonb`)),
      )).limit(1);
      if (reservedDraft) return { kind: "ineligible" as const, error: "Ett eller flera stopp tillhör redan ett nytt projektutkast. Öppna det projektet i stället." };
      if (affectedRoutes.some(route => !["draft", "optimized"].includes(route.status)
        || route.sentAt || route.handoffStatus !== "pending")) {
        return { kind: "ineligible" as const, error: "Nytt projekt kan bara skapas av stopp före utskick." };
      }
      const [resource] = await tx.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.id, input.newProject.vehicleId), eq(vehiclesTable.organizationId, organizationId),
      )).for("update");
      const profiles = await tx.select().from(driversTable).where(and(
        eq(driversTable.vehicleId, input.newProject.vehicleId), eq(driversTable.organizationId, organizationId),
        eq(driversTable.isActive, true),
      )).orderBy(driversTable.id).for("update");
      if (!resource?.isActive || profiles.length !== 1) {
        return { kind: "ineligible" as const, error: "Välj en aktiv resurs med entydigt planeringsunderlag." };
      }
      projectPair = { vehicleId: resource.id, driverId: profiles[0].id };
    }
    const routeStopsSnapshotById = new Map(routeStopsSnapshot.map((stop) => [stop.id, stop]));
    const targetRoute = input.routeId
      ? affectedRoutes.find((route) => route.id === input.routeId)
      : undefined;
    const lockedTargetDriver = await dispatchDriverSnapshot(
      tx,
      organizationId,
      targetRoute,
    );
    if ((lockedTargetDriver?.id ?? null) !== (driverSnapshot?.id ?? null)) {
      throw new DispatchRevisionConflictError();
    }
    const routesWithoutExactDriver = (await Promise.all(
      affectedRoutes.map(async (route) => {
        const driver = route.vehicleId
          ? await dispatchDriverSnapshot(tx, organizationId, route)
          : undefined;
        const activeDrivers = route.vehicleId && !driver
          ? await tx.select({ id: driversTable.id }).from(driversTable).where(and(
            eq(driversTable.vehicleId, route.vehicleId),
            eq(driversTable.organizationId, organizationId),
            eq(driversTable.isActive, true),
          ))
          : [];
        return { route, driver, activeDriverCount: activeDrivers.length };
      }),
    )).filter(({ route, driver, activeDriverCount }) =>
      route.vehicleId
      && !driver
      && (isProtectedImportRoute(route) || activeDriverCount > 0)
    );
    if (routesWithoutExactDriver.length > 0) {
      return {
        kind: "ineligible" as const,
        error: "Rutten saknar en entydigt tilldelad aktiv chaufför och kan inte ändras säkert.",
        code: DISPATCH_DRIVER_UNRESOLVED_CODE,
      };
    }
    const [organization] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1).for("update");
    const bindingFacts = await lockDispatchBindingFacts(
      tx, organizationId,
      [...new Set(affectedRoutes.flatMap((route) => route.vehicleId ? [route.vehicleId] : []))].sort(),
      [...new Set([...currentRouteStops, ...movingStops].flatMap((stop) => stop.customerId ? [stop.customerId] : []))].sort(),
    );
    if (input.optimizeTargetRoute && targetRoute && (!targetRoute.depotSnapshot
      || !hasPersistedPlanningEvidence(targetRoute.optimizationPlanningSnapshot) || targetRoute.optimizationFrozen)) {
      throw new DispatchTargetOptimizationError("DISPATCH_TARGET_UNAVAILABLE");
    }
    if (affectedRoutes.some((route) =>
      isProtectedImportRoute(route)
      && (!route.depotSnapshot || !hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot))
    )) {
      return {
        kind: "ineligible" as const,
        error: "Rutten saknar sparat depåbevis och kan inte ändras säkert.",
        code: DISPATCH_PLANNING_EVIDENCE_MISSING_CODE,
      };
    }
    if (
      movingStops.length !== movingSnapshot.length ||
      movingStops.some((stop) => {
        const original = movingSnapshotById.get(stop.id);
        return !original || !sameDispatchStopSnapshot(original, stop);
      }) ||
      currentRouteStops.length !== routeStopsSnapshot.length ||
      currentRouteStops.some((stop) => {
        const original = routeStopsSnapshotById.get(stop.id);
        return !original || !sameDispatchStopSnapshot(original, stop);
      }) ||
      (targetRouteSnapshot && (
        !targetRoute ||
        !sameDispatchRouteSnapshot(targetRouteSnapshot, targetRoute)
      ))
    ) {
      throw new DispatchRevisionConflictError();
    }
    if (movingStops.some((stop) => {
      const source = affectedRoutes.find(route => route.id === stop.routeId);
      return (input.optimizeTargetRoute && source && stop.planningPlanId != null && stop.planningPlanId !== source.planId)
        || (targetRoute && ((stop.planningPlanId != null && stop.planningPlanId !== targetRoute.planId)
          || (input.optimizeTargetRoute && source?.planId != null && source.planId !== targetRoute.planId)));
    })) {
      return {
        kind: "ineligible" as const,
        error: "Stoppet tillhör en annan plan. Välj en rutt i stoppets plan.",
      };
    }
    const movingById = new Map(movingStops.map((stop) => [stop.id, stop]));
    const orderedMoving = input.stopIds.map((id) => movingById.get(id)!);
    const movingIds = new Set(input.stopIds);
    const targetRemainder = input.routeId
      ? currentRouteStops
        .filter((stop) => stop.routeId === input.routeId && !movingIds.has(stop.id))
        .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0))
      : [];
    const insertAt = Math.max(0, Math.min(input.targetIndex, targetRemainder.length));
    let targetOrder = input.routeId
      ? [
          ...targetRemainder.slice(0, insertAt),
          ...orderedMoving,
          ...targetRemainder.slice(insertAt),
        ].map((stop, index) => ({
          ...stop,
          routeId: input.routeId,
          sequenceOrder: index + 1,
        }))
      : orderedMoving.map((stop) => ({
          ...stop,
          routeId: null,
          sequenceOrder: null,
        }));

    try {
      for (const route of affectedRoutes) {
        const customerStopIds = route.id === input.routeId
          ? targetOrder.map((candidate) => candidate.id)
          : currentRouteStops
            .filter((candidate) =>
              candidate.routeId === route.id &&
              !movingIds.has(candidate.id))
            .sort((left, right) =>
              (left.sequenceOrder ?? Number.MAX_SAFE_INTEGER)
              - (right.sequenceOrder ?? Number.MAX_SAFE_INTEGER))
            .map((candidate) => candidate.id);
        if (!(input.optimizeTargetRoute && route.id === input.routeId)) assertLockedFirstStopOrder(route, customerStopIds);
      }
    } catch (error) {
      if (error instanceof RouteFirstStopLockError) {
        return {
          kind: "ineligible" as const,
          error: error.message,
          code: DISPATCH_LOCKED_FIRST_STOP_CODE,
        };
      }
      throw error;
    }

    if (targetOrder.some((candidate) =>
      candidate.jobType === "pickup_delivery"
      && (candidate.pickupLatitude == null || candidate.pickupLongitude == null),
    )) {
      return {
        kind: "ineligible" as const,
        error: "Pickup and delivery stops require valid pickup coordinates",
        code: DISPATCH_PICKUP_COORDINATES_REQUIRED_CODE,
      };
    }
    const [vehicle] = targetRoute?.vehicleId
      ? await tx
        .select()
        .from(vehiclesTable)
        .where(and(
          eq(vehiclesTable.id, targetRoute.vehicleId),
          eq(vehiclesTable.organizationId, organizationId),
        ))
        .limit(1)
        .for("update")
      : [];
    const [driver] = driverSnapshot
      ? await tx
        .select()
        .from(driversTable)
        .where(and(
          eq(driversTable.id, driverSnapshot.id),
          eq(driversTable.organizationId, organizationId),
        ))
        .limit(1)
        .for("update")
      : [];
    const lockedCertifications = driverSnapshot
      ? await tx
        .select()
        .from(driverCertificationsTable)
        .where(and(
          eq(driverCertificationsTable.organizationId, organizationId),
          eq(driverCertificationsTable.driverId, driverSnapshot.id),
        ))
        .orderBy(driverCertificationsTable.id)
        .for("update")
      : [];
    const certificationSnapshotById = new Map(
      certificationSnapshot.map((certification) => [certification.id, certification]),
    );
    if (
      !sameDispatchVehicleSnapshot(vehicleSnapshot, vehicle) ||
      !sameDispatchDriverSnapshot(driverSnapshot, driver) ||
      lockedCertifications.length !== certificationSnapshot.length ||
      lockedCertifications.some((certification) => {
        const original = certificationSnapshotById.get(certification.id);
        return !original || !sameDispatchCertificationSnapshot(original, certification);
      })
    ) {
      throw new DispatchRevisionConflictError();
    }
    for (const stop of orderedMoving) {
      if (input.routeId) {
        await assertStopRouteAssignment(organizationId, input.routeId, stop);
      }
    }
    if (
      targetRoute
      && targetOrder.length > 0
      && targetOrder.some((stop) => stop.customerId != null)
    ) {
      await materializeDispatchCustomerUnavailablePeriods(
        tx,
        organizationId,
        targetRoute.date,
        targetOrder,
        { previewOnly: options.previewOnly || Boolean(input.expectedPreviewDigest) },
      );
    }
    let optimizationFactsDigest: string | undefined;
    if (input.optimizeTargetRoute) {
      if (!targetRoute || !vehicle || !driver || !targetRoute.depotSnapshot
        || !hasPersistedPlanningEvidence(targetRoute.optimizationPlanningSnapshot)
        || targetRoute.optimizationFrozen) {
        throw new DispatchTargetOptimizationError("DISPATCH_TARGET_UNAVAILABLE");
      }
      for (const candidate of targetOrder) {
        await assertStopRouteAssignment(organizationId, targetRoute.id, candidate);
      }
      optimizationFactsDigest = plannerFactsDigest({
        organizationId, routes: affectedRoutes, stops: currentRouteStops, movingStops,
        organization, bindingFacts, targetOrder, vehicle, driver, lockedCertifications,
        input: { stopIds: input.stopIds, routeId: input.routeId, targetIndex: input.targetIndex,
          force: input.force === true, optimizeTargetRoute: true,
          routeRevisions: [...input.routeRevisions].sort((a, b) => a.routeId.localeCompare(b.routeId)) },
      });
      let ids: string[];
      if (options.previewOnly) {
        if (!preparedTarget) {
          throw new PrepareTargetOutsideTransaction(optimizationFactsDigest,
            [targetRoute, targetOrder, vehicle, driver, organization, input.force === true]);
        }
        if (preparedTarget.factsDigest !== optimizationFactsDigest) throw new DispatchRevisionConflictError();
        ids = preparedTarget.stopIds;
      } else {
        const proposal = await loadRuntimeState<{ factsDigest: string; stopIds: string[] }>(
          organizationId, "dispatch-target-optimization", input.expectedPreviewDigest!,
        );
        if (!proposal || proposal.value.factsDigest !== optimizationFactsDigest) throw new DispatchRevisionConflictError();
        ids = proposal.value.stopIds;
      }
      const candidates = new Map(targetOrder.map(stop => [stop.id, stop]));
      if (ids.length !== candidates.size || new Set(ids).size !== ids.length || ids.some(id => !candidates.has(id))) {
        throw new DispatchRevisionConflictError();
      }
      targetOrder = ids.map((id, index) => ({ ...candidates.get(id)!, sequenceOrder: index + 1 }));
      assertLockedFirstStopOrder(targetRoute, ids);
    }
    const legacyConflictResult = targetRoute && targetOrder.length > 0
      && !isProtectedImportRoute(targetRoute)
      && !hasPersistedPlanningEvidence(targetRoute.optimizationPlanningSnapshot)
      ? calculateLegacyDispatchConflicts(
          targetOrder[0]!,
          targetRoute,
          vehicle,
          driver,
          targetOrder.slice(1),
        )
      : null;
    const evaluateConflicts = () => targetRoute && targetOrder.length > 0
      ? calculateDispatchConflicts(targetRoute, vehicle, driver, targetOrder, organization) : [];
    const conflicts = legacyConflictResult?.conflicts ?? (() => {
      try { return withRequiredRoadData(evaluateConflicts); }
      catch (error) {
        if (!(error instanceof RoadDataUnavailableError)) throw error;
        if (input.optimizeTargetRoute) throw error;
        // Preserve legacy eligibility behavior when road evidence is absent;
        // its consequence metrics are explicitly unknown, never verified.
        return evaluateConflicts();
      }
    })();
    const blockingConflicts = hasBlockingPlanningConflicts(
      conflicts, input.force === true, legacyConflictResult?.hardUnavailable === true,
    );
    if (
      blockingConflicts
      && !options.previewOnly
    ) {
      return { kind: "conflict" as const, conflicts };
    }

    const sourceOrders = affectedRouteIds
      .filter((routeId) => routeId !== input.routeId)
      .flatMap((routeId) =>
        currentRouteStops
          .filter((stop) => stop.routeId === routeId && !movingIds.has(stop.id))
          .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0))
          .map((stop, index) => ({ ...stop, sequenceOrder: index + 1 })),
      );
    const proposedStopById = new Map(
      [...sourceOrders, ...targetOrder].map((stop) => [stop.id, stop]),
    );
    const shiftedLockedStop = currentRouteStops.find((stop) => {
      if (stop.status === "pending") return false;
      const proposed = proposedStopById.get(stop.id);
      return (
        !proposed ||
        proposed.routeId !== stop.routeId ||
        proposed.sequenceOrder !== stop.sequenceOrder
      );
    });
    for (const affectedRoute of affectedRoutes) {
      assertPlanningLockOrder(
        affectedRoute,
        currentRouteStops.filter((stop) => stop.routeId === affectedRoute.id),
        [...sourceOrders, ...targetOrder].filter((stop) => stop.routeId === affectedRoute.id),
      );
    }
    if (shiftedLockedStop) {
      return {
        kind: "ineligible" as const,
        error: STOP_LIFECYCLE_LOCKED_ERROR,
        code: STOP_LIFECYCLE_LOCKED_CODE,
        details: getDispatchLockedStopDetails(shiftedLockedStop),
      };
    }
    let previewDigest: string | undefined;
    let consequences: DispatchConsequences | undefined;
    if (options.previewOnly || input.expectedPreviewDigest) {
      const proposedStopsByRouteId = new Map<string, Array<typeof stopsTable.$inferSelect>>();
      for (const proposed of [...sourceOrders, ...targetOrder]) {
        if (proposed.routeId == null) continue;
        const routeStops = proposedStopsByRouteId.get(proposed.routeId) ?? [];
        routeStops.push(proposed);
        proposedStopsByRouteId.set(proposed.routeId, routeStops);
      }
      const unknown = (stopCount: number): DispatchRouteMetrics => ({
        driveMin: null, workMin: null, endAt: null, windowViolations: null, stopCount,
      });
      const routeConsequences: DispatchConsequences["routes"] = [];
      for (const route of affectedRoutes) {
        const beforeStops = currentRouteStops.filter((stop) => stop.routeId === route.id);
        const afterStops = proposedStopsByRouteId.get(route.id) ?? [];
        const after = await assertDispatchRouteWorkdaySafeForPreview(
          tx,
          organizationId,
          route,
          organization,
          afterStops,
        );
        let before: DispatchRouteMetrics | null = null;
        try {
          before = await assertDispatchRouteWorkdaySafeForPreview(tx, organizationId, route, organization, beforeStops);
        } catch (error) {
          // New facts may make the old plan impossible. Do not prevent a
          // valid repair just because its "before" clock is no longer valid.
          if (!(error instanceof Error && "statusCode" in error && error.statusCode === 409)) throw error;
        }
        routeConsequences.push({ routeId: route.id, routeName: route.name,
          before: before ?? unknown(beforeStops.length), after: after ?? unknown(afterStops.length) });
      }
      if (legacyConflictResult?.hardUnavailable) {
        return { kind: "conflict" as const, conflicts };
      }
      const verified = routeConsequences.every((item) => item.before.workMin != null && item.after.workMin != null);
      consequences = {
        status: verified ? "verified" : "unknown",
        ...(!verified ? { reason: "Verifierade vägdata eller auktoritativt ruttunderlag saknas för vissa mått. Inga uppskattningar visas." } : {}),
        unplanned: {
          before: orderedMoving.filter((stop) => !stop.routeId).length,
          after: input.routeId ? 0 : orderedMoving.length,
        },
        routes: routeConsequences,
      };
      previewDigest = plannerFactsDigest({
        organizationId,
        newProject: input.newProject, projectPair,
        input: { stopIds: input.stopIds, routeId: input.routeId, targetIndex: input.targetIndex,
          optimizeTargetRoute: input.optimizeTargetRoute === true,
          force: input.force === true, routeRevisions: [...input.routeRevisions].sort((a, b) => a.routeId.localeCompare(b.routeId)) },
        routes: affectedRoutes, stops: currentRouteStops, movingStops, organization,
        bindingFacts, conflicts, consequences, targetOrder,
      });
      if (input.expectedPreviewDigest && input.expectedPreviewDigest !== previewDigest) {
        throw new DispatchRevisionConflictError();
      }
      if (options.previewOnly && input.optimizeTargetRoute && !blockingConflicts) {
        await saveRuntimeState(organizationId, "dispatch-target-optimization", previewDigest, {
          factsDigest: optimizationFactsDigest, stopIds: targetOrder.map(stop => stop.id),
        }, 15 * 60 * 1000, tx);
      }
      if (options.previewOnly) return {
        kind: "preview" as const,
        canMove: !blockingConflicts,
        conflicts,
        sourceRouteIds: Array.from(new Set(
          orderedMoving
            .map((stop) => stop.routeId)
            .filter((routeId): routeId is string =>
              routeId != null && routeId !== input.routeId
            ),
        )).sort(),
        targetRouteId: input.routeId,
        targetStopCount: input.routeId ? targetOrder.length : 0,
        previewDigest,
        consequences,
      };
    }
    const overrideAt = input.force && conflicts.length > 0 ? new Date() : null;
    const updatedMoving: Array<typeof stopsTable.$inferSelect> = [];
    const originalStopById = new Map([
      ...currentRouteStops.map((stop) => [stop.id, stop] as const),
      ...movingStops.map((stop) => [stop.id, stop] as const),
    ]);
    for (const candidate of [...sourceOrders, ...targetOrder]) {
      const isMoving = movingIds.has(candidate.id);
      const original = originalStopById.get(candidate.id);
      if (!original) throw new DispatchRevisionConflictError();
      if (affectedRoutes.some(route => route.id === original.routeId && route.optimizationFrozen)) {
        // The only admissible frozen move is an exact no-op, already checked
        // by assertPlanningLockOrder. Preserve stop metadata/accepted reasons.
        if (isMoving) updatedMoving.push(original);
        continue;
      }
      if (original.status !== "pending") continue;
      const [updated] = await tx
        .update(stopsTable)
        .set({
          routeId: candidate.routeId,
          sequenceOrder: candidate.sequenceOrder,
          ...(isMoving
            ? {
                unplannedReason: null,
                assignmentOverrideAt: overrideAt,
                assignmentOverrideReasonCodes: overrideAt ? conflicts : null,
              }
            : {}),
        })
        .where(and(
          eq(stopsTable.id, candidate.id),
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.status, original.status),
          isNull(stopsTable.archivedAt),
          ...(original.routeId
            ? [eq(stopsTable.routeId, original.routeId)]
            : [isNull(stopsTable.routeId)]),
        ))
        .returning();
      if (!updated) throw new DispatchRevisionConflictError();
      if (isMoving && updated) updatedMoving.push(updated);
    }

    for (const route of affectedRoutes) {
      const expected = consequences?.routes.find((item) => item.routeId === route.id)?.after;
      if (expected?.workMin != null) {
        // Use the same strict cached-road basis as the reviewed clock. A
        // cache refresh during intervening DB awaits must not silently change
        // the reviewed consequence.
        await withRequiredRoadData(() => persistDispatchRouteWorkday(tx, organizationId, route, organization));
        const [persisted] = await tx.select().from(routesTable).where(and(
          eq(routesTable.id, route.id), eq(routesTable.organizationId, organizationId),
        ));
        const summary = persisted?.workdaySummary;
        const actual: DispatchRouteMetrics = {
          driveMin: summary ? summary.nonReturnDrivingMin + summary.returnMin : null,
          workMin: summary?.totalMin ?? null,
          endAt: persisted?.workdayTimeline?.at(-1)?.endAt ?? null,
          windowViolations: summary ? summary.lateStopIds?.length ?? 0 : null,
          stopCount: persisted?.totalStops ?? 0,
        };
        if (plannerFactsDigest(actual) !== plannerFactsDigest(expected)) throw new DispatchRevisionConflictError();
      } else {
        await persistDispatchRouteWorkday(tx, organizationId, route, organization);
      }
    }
    let draftId: string | undefined;
    if (input.newProject && projectPair) {
      const ids = updatedMoving.map(stop => stop.id);
      const [draft] = await tx.insert(planningDraftsTable).values({
        organizationId, name: input.newProject.name.trim(),
        startAt: new Date(`${input.newProject.date}T00:00:00Z`),
        state: {
          source: "manual", step: 5, planningDate: input.newProject.date,
          selectedStopIds: ids, importedStopIds: ids,
          dispatchSourceStopIds: ids,
          resourceSelection: { pairValues: [`${projectPair.vehicleId}|${projectPair.driverId}`], optimizationProfile: "balanced" },
        },
      }).returning({ id: planningDraftsTable.id });
      draftId = draft.id;
      await tx.update(stopsTable).set({ planningPlanId: null }).where(and(
        eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, ids),
      ));
      for (const stop of updatedMoving) stop.planningPlanId = null;
    }
    return { kind: "moved" as const, stops: updatedMoving, conflicts, ...(draftId ? { draftId } : {}) };
  });

  const executeMove = () => strictRoads || input.optimizeTargetRoute ? withRequiredRoadData(runMove) : runMove();
  const result = await executeMove().catch(async error => {
    if (!(error instanceof PrepareTargetOutsideTransaction)) throw error;
    // db.transaction has completed its rollback and released the client here.
    preparedTarget = {
      factsDigest: error.factsDigest,
      stopIds: await withRequiredRoadData(() => optimizeDispatchTarget(...error.args)),
    };
    return executeMove();
  });
  if (result.kind === "moved") {
    broadcastDataChange(organizationId, "stop", "updated", {
      ids: input.stopIds,
      routeId: input.routeId,
    });
  }
  return result;
}

function stockholmCalendarDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}
export async function assignStopForDispatch(
  stopId: string,
  organizationId: string,
  input: { routeId: string; sequenceOrder?: number; force?: boolean },
): Promise<
  | { kind: "not_found" }
  | {
      kind: "ineligible";
      error: string;
      code?: DispatchMoveIneligibleCode;
      details?: DispatchLockedStopDetails;
    }
  | { kind: "conflict"; conflicts: DispatchAssignmentConflict[] }
  | { kind: "assigned"; stop: typeof stopsTable.$inferSelect; conflicts: DispatchAssignmentConflict[] }
> {
  const strictRoads = await prepareDispatchLockRoadData(organizationId, { routeIds: [input.routeId], stopIds: [stopId] });
  const runAssignment = () => db.transaction(async (tx) => {
    const [stopSnapshot] = await tx
      .select()
      .from(stopsTable)
      .where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId)))
      .limit(1);
    if (!stopSnapshot) return { kind: "not_found" as const };
    if (stopSnapshot.archivedAt) {
      return {
        kind: "ineligible" as const,
        error: "Archived stops cannot be assigned from this queue",
        code: STOP_LIFECYCLE_LOCKED_CODE,
        details: getDispatchLockedStopDetails(stopSnapshot),
      };
    }
    if (stopSnapshot.routeId || stopSnapshot.status !== "pending") {
      return {
        kind: "ineligible" as const,
        error: "Only pending, unplanned stops can be assigned from this queue",
        ...(stopSnapshot.status !== "pending"
          ? {
              code: STOP_LIFECYCLE_LOCKED_CODE,
              details: getDispatchLockedStopDetails(stopSnapshot),
            }
          : {}),
      };
    }

    const [routeSnapshot] = await tx
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.id, input.routeId), eq(routesTable.organizationId, organizationId)))
      .limit(1);
    if (!routeSnapshot) return { kind: "not_found" as const };
    const protectedRoute = isProtectedImportRoute(routeSnapshot);
    if (protectedRoute && !routeSnapshot.depotSnapshot) {
      return {
        kind: "ineligible" as const,
        error: "Rutten saknar sparat depåbevis och kan inte ändras säkert.",
      };
    }
    if (protectedRoute && !hasPersistedPlanningEvidence(routeSnapshot.optimizationPlanningSnapshot)) {
      return {
        kind: "ineligible" as const,
        error: "Rutten saknar sparat reservunderlag och kan inte ändras säkert.",
      };
    }
    const [organization] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    const routeStopsSnapshot = await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.routeId, routeSnapshot.id),
        eq(stopsTable.organizationId, organizationId),
        isNull(stopsTable.archivedAt),
      ));
    const [vehicleSnapshot] = routeSnapshot.vehicleId
      ? await tx
        .select()
        .from(vehiclesTable)
        .where(and(
          eq(vehiclesTable.id, routeSnapshot.vehicleId),
          eq(vehiclesTable.organizationId, organizationId),
        ))
        .limit(1)
      : [];
    const driverSnapshot = await dispatchDriverSnapshot(
      tx,
      organizationId,
      routeSnapshot,
    );
    if (routeSnapshot.vehicleId && !driverSnapshot) {
      if (
        protectedRoute
        || (await tx.select({ id: driversTable.id }).from(driversTable).where(and(
          eq(driversTable.vehicleId, routeSnapshot.vehicleId),
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true),
        ))).length > 0
      ) {
        return {
          kind: "ineligible" as const,
          error: "Rutten saknar en entydigt tilldelad aktiv chaufför och kan inte ändras säkert.",
        };
      }
    }
    const certificationSnapshot = driverSnapshot
      ? await tx
        .select()
        .from(driverCertificationsTable)
        .where(and(
          eq(driverCertificationsTable.organizationId, organizationId),
          eq(driverCertificationsTable.driverId, driverSnapshot.id),
        ))
        .orderBy(driverCertificationsTable.id)
      : [];

    await dispatchMutationBeforeLockHook?.();
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-stop:" + stopId}))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + input.routeId}))`,
    );

    const [route] = await tx
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.id, input.routeId), eq(routesTable.organizationId, organizationId)))
      .limit(1)
      .for("update");
    const lockedDriverSnapshot = await dispatchDriverSnapshot(
      tx,
      organizationId,
      route,
    );
    if ((lockedDriverSnapshot?.id ?? null) !== (driverSnapshot?.id ?? null)) {
      throw new DispatchRevisionConflictError();
    }
    const routeStops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.routeId, routeSnapshot.id),
        eq(stopsTable.organizationId, organizationId),
        isNull(stopsTable.archivedAt),
      ))
      .orderBy(stopsTable.id)
      .for("update");
    const [stop] = await tx
      .select()
      .from(stopsTable)
      .where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId)))
      .limit(1)
      .for("update");
    const [vehicle] = vehicleSnapshot
      ? await tx
        .select()
        .from(vehiclesTable)
        .where(and(
          eq(vehiclesTable.id, vehicleSnapshot.id),
          eq(vehiclesTable.organizationId, organizationId),
        ))
        .limit(1)
        .for("update")
      : [];
    const [driver] = driverSnapshot
      ? await tx
        .select()
        .from(driversTable)
        .where(and(
          eq(driversTable.id, driverSnapshot.id),
          eq(driversTable.organizationId, organizationId),
        ))
        .limit(1)
        .for("update")
      : [];
    const lockedCertifications = driverSnapshot
      ? await tx
        .select()
        .from(driverCertificationsTable)
        .where(and(
          eq(driverCertificationsTable.organizationId, organizationId),
          eq(driverCertificationsTable.driverId, driverSnapshot.id),
        ))
        .orderBy(driverCertificationsTable.id)
        .for("update")
      : [];
    const routeStopsSnapshotById = new Map(routeStopsSnapshot.map((candidate) => [candidate.id, candidate]));
    const certificationSnapshotById = new Map(
      certificationSnapshot.map((certification) => [certification.id, certification]),
    );
    if (
      !route ||
      !stop ||
      !sameDispatchRouteSnapshot(routeSnapshot, route) ||
      !sameDispatchStopSnapshot(stopSnapshot, stop) ||
      routeStops.length !== routeStopsSnapshot.length ||
      routeStops.some((candidate) => {
        const original = routeStopsSnapshotById.get(candidate.id);
        return !original || !sameDispatchStopSnapshot(original, candidate);
      }) ||
      !sameDispatchVehicleSnapshot(vehicleSnapshot, vehicle) ||
      !sameDispatchDriverSnapshot(driverSnapshot, driver) ||
      lockedCertifications.length !== certificationSnapshot.length ||
      lockedCertifications.some((certification) => {
        const original = certificationSnapshotById.get(certification.id);
        return !original || !sameDispatchCertificationSnapshot(original, certification);
      })
    ) {
      throw new DispatchRevisionConflictError();
    }
    await assertStopRouteAssignment(organizationId, route.id, stop);
    const allStops = [...routeStops, stop];
    if (allStops.some((candidate) =>
      candidate.jobType === "pickup_delivery" &&
      (candidate.pickupLatitude == null || candidate.pickupLongitude == null),
    )) {
      return { kind: "ineligible" as const, error: "Pickup and delivery stops require valid pickup coordinates" };
    }
    const orderedRouteStops = [...routeStops].sort(
      (a, b) => (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
    );
    const insertionIndex = Math.max(
      0,
      Math.min((input.sequenceOrder ?? orderedRouteStops.length + 1) - 1, orderedRouteStops.length),
    );
    const prospectiveOrder = [
      ...orderedRouteStops.slice(0, insertionIndex),
      stop,
      ...orderedRouteStops.slice(insertionIndex),
    ].map((candidate, index) => ({ ...candidate, sequenceOrder: index + 1 }));
    const prospectiveStop = prospectiveOrder.find((candidate) => candidate.id === stop.id)!;
    const prospectiveRouteStops = prospectiveOrder.filter((candidate) => candidate.id !== stop.id);
    const shiftedLockedStop = routeStops.find((candidate) => {
      if (candidate.status === "pending") return false;
      const proposed = prospectiveOrder.find((entry) => entry.id === candidate.id);
      return (
        !proposed ||
        proposed.routeId !== candidate.routeId ||
        proposed.sequenceOrder !== candidate.sequenceOrder
      );
    });
    if (shiftedLockedStop) {
      return {
        kind: "ineligible" as const,
        error: STOP_LIFECYCLE_LOCKED_ERROR,
        code: STOP_LIFECYCLE_LOCKED_CODE,
        details: getDispatchLockedStopDetails(shiftedLockedStop),
      };
    }
    try {
      assertLockedFirstStopOrder(
        route,
        prospectiveOrder.map((candidate) => candidate.id),
      );
    } catch (error) {
      if (error instanceof RouteFirstStopLockError) {
        return {
          kind: "ineligible" as const,
          error: error.message,
          code: DISPATCH_LOCKED_FIRST_STOP_CODE,
        };
      }
      throw error;
    }
    if (prospectiveOrder.some((candidate) => candidate.customerId != null)) {
      await materializeDispatchCustomerUnavailablePeriods(
        tx,
        organizationId,
        route.date,
        prospectiveOrder,
      );
    }
    const legacyConflictResult = !protectedRoute
      && !hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot)
      ? calculateLegacyDispatchConflicts(
          prospectiveStop,
          route,
          vehicle,
          driver,
          prospectiveRouteStops,
        )
      : null;
    const conflicts = legacyConflictResult?.conflicts
      ?? calculateDispatchConflicts(
        route,
        vehicle,
        driver,
        prospectiveOrder,
        organization,
      );

    if (
      hasBlockingPlanningConflicts(
        conflicts, input.force === true, legacyConflictResult?.hardUnavailable === true,
      )
    ) {
      return { kind: "conflict" as const, conflicts };
    }

    let updated: typeof stopsTable.$inferSelect | undefined;
    const originalStopById = new Map([
      ...routeStops.map((candidate) => [candidate.id, candidate] as const),
      [stop.id, stop] as const,
    ]);
    for (const candidate of prospectiveOrder) {
      const original = originalStopById.get(candidate.id);
      if (!original) throw new DispatchRevisionConflictError();
      if (original.status !== "pending") continue;
      const [row] = await tx
        .update(stopsTable)
        .set(candidate.id === stop.id
          ? {
              routeId: route.id,
              sequenceOrder: candidate.sequenceOrder,
              unplannedReason: null,
              assignmentOverrideAt: input.force && conflicts.length > 0 ? new Date() : null,
              assignmentOverrideReasonCodes: input.force && conflicts.length > 0 ? conflicts : null,
            }
          : { sequenceOrder: candidate.sequenceOrder })
        .where(and(
          eq(stopsTable.id, candidate.id),
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.status, original.status),
          isNull(stopsTable.archivedAt),
          ...(original.routeId
            ? [eq(stopsTable.routeId, original.routeId)]
            : [isNull(stopsTable.routeId)]),
        ))
        .returning();
      if (!row) throw new DispatchRevisionConflictError();
      if (candidate.id === stop.id) updated = row;
    }
    if (!updated) throw new DispatchRevisionConflictError();
    await persistDispatchRouteWorkday(tx, organizationId, route, organization);
    return { kind: "assigned" as const, stop: updated, conflicts };
  });
  let result: Awaited<ReturnType<typeof runAssignment>>;
  try {
    result = await (strictRoads ? withRequiredRoadData(runAssignment) : runAssignment());
  } catch (error) {
    // Legacy assignment has no client-supplied revision token. If a
    // concurrent bulk move won the advisory lock, refresh its snapshots once
    // and apply the independent queue assignment instead of turning a valid
    // concurrent write into a spurious 409. Test mutation hooks intentionally
    // remain fail-closed and are never retried.
    if (!(error instanceof DispatchRevisionConflictError) || dispatchMutationBeforeLockHook) {
      throw error;
    }
    result = await (strictRoads ? withRequiredRoadData(runAssignment) : runAssignment());
  }
  if (result.kind === "assigned") {
    broadcastDataChange(organizationId, "stop", "updated", {
      id: result.stop.id,
      routeId: result.stop.routeId,
    });
  }
  return result;
}

export async function updateStop(
  id: string,
  organizationId: string,
  data: Record<string, unknown>,
  contactFields: Record<string, string | null> = {},
  driverProfileId: string | null = null,
  assistedRouteId: string | null = null,
  options: {
    plannerCorrection?: {
      expectedStopDigest: string;
      expectedRouteDigest: string | null;
      actor: { userId: string; userEmail?: string | null };
      verification: "manual" | "exact_match";
      manualConfirmed: boolean;
    };
    expectedOutgoingVersion?: number;
  } = {},
) {
  const conditions = [eq(stopsTable.id, id), eq(stopsTable.organizationId, organizationId)];

  const [existing] = await db.select().from(stopsTable).where(and(...conditions));

  const updateData = { ...data, ...contactFields } as any;
  if (existing) {
    if (existing.archivedAt) throw new StopArchivedError();
    const changesCustomerLink =
      Object.prototype.hasOwnProperty.call(updateData, "customerId")
      && updateData.customerId !== existing.customerId;
    const changesPlanningDate =
      Object.prototype.hasOwnProperty.call(updateData, "planningDate")
      && planningDateFromValue(updateData.planningDate)?.getTime() !== existing.planningDate?.getTime();
    if (existing.routeId && (changesCustomerLink || changesPlanningDate)) {
      throw new CustomerAssignmentMutationError();
    }
    const changesRoutePosition =
      (Object.prototype.hasOwnProperty.call(data, "routeId") &&
        data.routeId !== existing.routeId) ||
      (Object.prototype.hasOwnProperty.call(data, "sequenceOrder") &&
        data.sequenceOrder !== existing.sequenceOrder);
    if (changesRoutePosition) {
      throw new StopRoutePositionMutationError();
    }
    delete updateData.routeId;
    delete updateData.sequenceOrder;
    if (
      typeof updateData.status === "string" &&
      updateData.status !== existing.status &&
      (
        isRetentionEligibleStopStatus(existing.status) ||
        (existing.status === "in_progress" && updateData.status === "pending")
      )
    ) {
      throw new StopLifecycleConflictError();
    }
  }
  const statusChanged = Boolean(
    existing
      && typeof updateData.status === "string"
      && existing.status !== updateData.status,
  );
  if (statusChanged) {
    updateData.terminalAt = getTerminalTimestampForStopStatus(updateData.status);
  }
  const assignmentFields = [
    "jobType",
    "requiredSkills",
    "requiredCertifications",
    "requiredEquipment",
  ];
  const assignmentChanged = assignmentFields.some((field) =>
    Object.prototype.hasOwnProperty.call(updateData, field),
  );
  if (existing && assignmentChanged) {
    const merged = { ...existing, ...updateData };
    if (merged.routeId) {
      await assertStopRouteAssignment(organizationId, merged.routeId, merged);
    }
  }
  const invalidatesReviewedPlan = [
    "address",
    "latitude",
    "longitude",
    "timeWindowStart",
    "timeWindowEnd",
    "serviceDurationMin",
    "weightKg",
    "volumeM3",
    "pickupAddress",
    "pickupLatitude",
    "pickupLongitude",
    // Assignment requirements are hard evaluator inputs even when travel
    // metrics are unchanged.
    ...assignmentFields,
  ].some((field) => Object.prototype.hasOwnProperty.call(updateData, field));

  const stop = await db.transaction(async (tx) => {
    let driverRouteId: string | null = null;
    let clearsFulfilledFirstStopLock = false;
    if (driverProfileId) {
      // Generic driver updates share route removal's authority lock. This
      // makes the authorization check and write atomic against cancellation,
      // preventing an offline retry from reviving a released stop.
      if (!existing) {
        throw new DriverStopUpdateAuthorizationError(
          "This stop is no longer assigned to an active route.",
          409,
        );
      }
      const initial = await outgoingStopContext(organizationId, id, driverProfileId, tx, assistedRouteId ?? undefined);
      driverRouteId = initial.route.id;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + driverRouteId}))`,
      );
      const [workingRoute] = await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, driverRouteId),
          eq(routesTable.organizationId, organizationId),
        ))
        .for("update");
      const context = await outgoingStopContext(organizationId, id, driverProfileId, tx, driverRouteId);
      const route = context.route;
      if (
        !workingRoute
        || route.status === "completed"
        || route.status === "cancelled"
        || route.handoffStatus !== "accepted"
        || route.handoffDriverId !== driverProfileId
        || route.planRevision !== initial.route.planRevision
        || (options.expectedOutgoingVersion != null && options.expectedOutgoingVersion !== route.planRevision)
      ) {
        throw new DriverStopUpdateAuthorizationError(
          "This stop is not assigned to the driver's current accepted route.",
          403,
        );
      }
      if (assistedRouteId && driverProfileId) {
        assertCurrentDriverAssistance(route, {
          routeId: assistedRouteId,
          driverId: driverProfileId,
        });
      }
      const [execution] = await tx
        .select({ id: routeExecutionsTable.id })
        .from(routeExecutionsTable)
        .where(and(
          eq(routeExecutionsTable.organizationId, organizationId),
          eq(routeExecutionsTable.routeId, route.id),
          eq(routeExecutionsTable.driverId, driverProfileId),
          eq(routeExecutionsTable.planVersion, route.planRevision),
          eq(routeExecutionsTable.status, "active"),
        ))
        .for("update");
      if (!execution) {
        throw new DriverStopUpdateAuthorizationError(
          "The current route execution is not active.",
          409,
        );
      }
      const [currentStop] = await tx
        .select({ routeId: stopsTable.routeId, archivedAt: stopsTable.archivedAt })
        .from(stopsTable)
        .where(and(
          eq(stopsTable.id, id),
          eq(stopsTable.organizationId, organizationId),
        ))
        .for("update");
      if (!currentStop || currentStop.archivedAt !== null) {
        throw new DriverStopUpdateAuthorizationError(
          "This stop is no longer assigned to the driver's current accepted route.",
          409,
        );
      }
    }
    if (options.plannerCorrection) {
      const correction = options.plannerCorrection;
      if (!existing) throw new DispatchRevisionConflictError();
      // Same route->stop lock order as the existing planning mutation paths.
      await lockRoutesForPlanningMutation(tx, organizationId, existing.routeId ? [existing.routeId] : []);
      const [current] = await tx.select().from(stopsTable).where(and(...conditions)).for("update");
      if (!current || plannerStopDigest(current) !== correction.expectedStopDigest) throw new DispatchRevisionConflictError();
      const [route] = current.routeId ? await tx.select().from(routesTable).where(and(
        eq(routesTable.id, current.routeId), eq(routesTable.organizationId, organizationId),
      )).for("update") : [];
      if ((route ? plannerFactsDigest(route) : null) !== correction.expectedRouteDigest) throw new DispatchRevisionConflictError();
      if (current.archivedAt || current.status !== "pending" || route?.optimizationFrozen
        || current.lockedServiceStartAt || current.lockedVehicleId || route?.lockedFirstStopId === id) {
        throw new RouteFirstStopLockError("Lås upp uppdraget eller rutten före adressrättning.");
      }
      if (correction.verification === "manual" && !correction.manualConfirmed) {
        throw new DispatchRevisionConflictError();
      }
      updateData.customFields = { ...(current.customFields ?? {}) };
      cleanNavigationVerification(updateData);
      if (correction.verification === "exact_match") {
        updateData.customFields[NAVIGATION_VERIFIED_KEY] = "true";
        updateData.customFields[NAVIGATION_ADDRESS_KEY] = updateData.address;
      }
      await tx.insert(auditLogTable).values({
        organizationId, userId: correction.actor.userId, userEmail: correction.actor.userEmail ?? null,
        action: "stop.address_corrected", resourceType: "stop", resourceId: id,
        method: "POST", path: "/api/planner-corrections/confirm", statusCode: "200",
        diff: {
          original: { address: current.address, latitude: current.latitude, longitude: current.longitude,
            sourceRowNumber: current.sourceRowNumber, customFields: current.customFields },
          proposed: { address: updateData.address, latitude: updateData.latitude, longitude: updateData.longitude },
          verification: correction.verification, manualConfirmed: correction.manualConfirmed,
        },
      });
    }
    if (existing) {
      await lockRoutesForPlanningMutation(
        tx,
        organizationId,
        [existing.routeId, updateData.routeId]
          .filter((routeId): routeId is string => typeof routeId === "string"),
      );
      if (existing.routeId) {
        const [lockedRoute] = await tx
          .select({ lockedFirstStopId: routesTable.lockedFirstStopId })
          .from(routesTable)
          .where(and(
            eq(routesTable.id, existing.routeId),
            eq(routesTable.organizationId, organizationId),
          ))
          .for("update");
        if (
          lockedRoute?.lockedFirstStopId === id
          && typeof updateData.status === "string"
          && updateData.status !== "pending"
        ) {
          clearsFulfilledFirstStopLock =
            isRetentionEligibleStopStatus(updateData.status);
        }
      }
    }
    if (
      existing
      && (
        Object.prototype.hasOwnProperty.call(updateData, "customerId")
        || Object.prototype.hasOwnProperty.call(updateData, "planningDate")
      )
    ) {
      const nextCustomerId =
        Object.prototype.hasOwnProperty.call(updateData, "customerId")
          ? (typeof updateData.customerId === "string" ? updateData.customerId : null)
          : existing.customerId;
      if (!nextCustomerId) {
        updateData.unavailablePeriods = [];
        updateData.planningDate = null;
      } else if (
        Object.prototype.hasOwnProperty.call(updateData, "customerId")
        || Object.prototype.hasOwnProperty.call(updateData, "planningDate")
      ) {
        const customerById = await loadCustomerSnapshots(
          tx,
          organizationId,
          [nextCustomerId],
        );
        const nextPlanningDate = Object.prototype.hasOwnProperty.call(updateData, "planningDate")
          ? updateData.planningDate
          : existing.planningDate;
        updateData.unavailablePeriods = materializeCustomerSnapshot(
          customerById.get(nextCustomerId)!,
          nextPlanningDate,
        );
        if (Object.prototype.hasOwnProperty.call(updateData, "planningDate")) {
          updateData.planningDate = planningDateFromValue(updateData.planningDate);
        }
      }
    }
    await stopUpdateBeforeWriteHook?.();
    const [updated] = await tx
      .update(stopsTable)
      .set(updateData)
        .where(and(
          ...conditions,
          isNull(stopsTable.archivedAt),
        ))
      .returning();
    if (!updated && existing) throw new StopArchivedError();
    if (clearsFulfilledFirstStopLock && updated.routeId) {
      // The pinned job has fulfilled the first-job invariant. Clear only the
      // route-owned constraint, without bumping planRevision or invalidating
      // driver acceptance while an execution is in progress.
      await tx.update(routesTable).set({
        lockedFirstStopId: null,
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.id, updated.routeId),
        eq(routesTable.organizationId, organizationId),
      ));
    }
    if (!updated || !existing || !invalidatesReviewedPlan) return updated;

    const affectedRouteIds = Array.from(
      new Set([existing.routeId, updated.routeId].filter((routeId): routeId is string => Boolean(routeId))),
    );
    if (affectedRouteIds.length > 0) {
      await tx
        .update(routesTable)
        .set({
          ...invalidatedRoutePlanningState(),
        })
        .where(
          and(
            inArray(routesTable.id, affectedRouteIds),
            eq(routesTable.organizationId, organizationId),
          ),
        );
    }
    // Evidence may live on a counterpart route in the same nearby pair.
    // Invalidate only this derived field; do not mutate sibling plan
    // revisions, approvals, or handoff state solely for explanation freshness.
    await tx
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));
    return updated;
  });
  if (!stop) return null;

  if (existing && (existing.latitude !== stop.latitude || existing.longitude !== stop.longitude)) {
    getDistanceCache().invalidate(existing.latitude, existing.longitude);
    getDistanceCache().invalidate(stop.latitude, stop.longitude);
  }

  if (existing && existing.status !== stop.status && (stop.status === "completed" || stop.status === "failed")) {
    let vehicleName = "Vehicle";
    let notifyDelivered = true;
    let notifyFailed = true;
    if (stop.routeId) {
      const [route] = await db.select().from(routesTable).where(eq(routesTable.id, stop.routeId));
      if (route?.vehicleId) {
        const [vehicle] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
        if (vehicle) vehicleName = vehicle.name;
      }
      if (route) {
        notifyDelivered = route.notifyDelivered;
        notifyFailed = route.notifyFailed;
      }
    }

    if (stop.status === "failed") {
      await db.insert(notificationsTable).values({
        organizationId: stop.organizationId,
        type: "stop_failed",
        title: `Delivery failed`,
        message: `${vehicleName} failed delivery at ${stop.address}`,
        relatedEntityId: stop.id,
      });
      if (notifyFailed) {
        sendFailedNotification(stop.id, stop.routeId, vehicleName).catch((err) =>
          console.error("[EMAIL] Failed to send failed notification:", err)
        );
      }
    } else if (stop.status === "completed" && notifyDelivered) {
      sendDeliveredNotification(stop.id, stop.routeId, vehicleName).catch((err) =>
        console.error("[EMAIL] Failed to send delivered notification:", err)
      );
    }
  }

  if (existing && existing.status !== stop.status) {
    const eventMap: Record<string, string> = { completed: "stop.completed", failed: "stop.failed", skipped: "stop.skipped" };
    const event = eventMap[stop.status];
    if (event) {
      dispatchWebhookEvent(stop.organizationId, event, {
        stopId: stop.id, address: stop.address, status: stop.status, routeId: stop.routeId,
      }).catch(() => {});
    }
  }

  broadcastDataChange(stop.organizationId, "stop", "updated", { id: stop.id, address: stop.address, status: stop.status });
  return stop;
}

export async function deleteStop(id: string, organizationId: string) {
  const [deleted] = await deleteStops([id], organizationId);
  return deleted ?? null;
}

export async function deleteStops(stopIds: string[], organizationId: string) {
  return deleteStopsWithPolicy(stopIds, organizationId, null);
}

/**
 * Archives an all-or-nothing selection while retaining every stop row and its
 * immutable route/evidence association. Route cancellation follows the same
 * lock namespace as dispatch and route removal, so an offline driver retry
 * cannot execute a stop after it has left operational planning.
 */
export async function archiveStops(
  requestedStopIds: string[],
  organizationId: string,
  actor: StopArchiveActor,
  confirmActiveRoutes = false,
): Promise<{ archivedCount: number; archivedStopIds: string[]; affectedRouteIds: string[] }> {
  const ids = [...new Set(requestedStopIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return { archivedCount: 0, archivedStopIds: [], affectedRouteIds: [] };

  const result = await db.transaction(async (tx) => {
    const requested = await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.id, ids),
      ))
      .orderBy(stopsTable.id)
      .for("update");
    if (requested.length !== ids.length) throw new StopBulkDeleteNotFoundError();

    const candidates = requested.filter((stop) => stop.archivedAt === null);
    if (candidates.length === 0) {
      return { archivedStopIds: [] as string[], affectedRouteIds: [] as string[] };
    }
    const routeIds = [...new Set(
      candidates.flatMap((stop) => stop.routeId ? [stop.routeId] : []),
    )].sort();
    for (const routeId of routeIds) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`);
    }
    const routes = routeIds.length === 0 ? [] : await tx
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.organizationId, organizationId), inArray(routesTable.id, routeIds)))
      .orderBy(routesTable.id)
      .for("update");
    if (routes.length !== routeIds.length) throw new StopBulkDeleteNotFoundError();
    const activeExecutions = routeIds.length === 0 ? [] : await tx
      .select({ routeId: routeExecutionsTable.routeId, id: routeExecutionsTable.id })
      .from(routeExecutionsTable)
      .where(and(
        eq(routeExecutionsTable.organizationId, organizationId),
        inArray(routeExecutionsTable.routeId, routeIds),
        eq(routeExecutionsTable.status, "active"),
      ))
      .orderBy(routeExecutionsTable.id)
      .for("update");
    const activeExecutionRouteIds = new Set(activeExecutions.map((execution) => execution.routeId));

    // Re-read selected rows after taking the route authority locks. This is
    // the CAS boundary against simultaneous dispatch/route mutations.
    const lockedSelected = await tx
      .select()
      .from(stopsTable)
      .where(and(eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, ids)))
      .orderBy(stopsTable.id)
      .for("update");
    if (
      lockedSelected.length !== ids.length
      || lockedSelected.some((stop) => {
        const before = requested.find((candidate) => candidate.id === stop.id);
        return !before || before.routeId !== stop.routeId || before.archivedAt !== stop.archivedAt;
      })
    ) {
      throw new StopBulkDeleteConflictError();
    }
    const lockedCandidates = lockedSelected.filter((stop) => stop.archivedAt === null);
    const approvals = routeIds.length === 0 ? [] : await tx
      .select({ routeId: routePlanApprovalsTable.routeId })
      .from(routePlanApprovalsTable)
      .where(and(
        eq(routePlanApprovalsTable.organizationId, organizationId),
        inArray(routePlanApprovalsTable.routeId, routeIds),
      ))
      .for("update");
    const approvedRouteIds = new Set(approvals.map((approval) => approval.routeId));
    const cancellationRouteIds = routes
      .filter((route) =>
        route.status !== "completed"
        && route.status !== "cancelled"
        && (
          route.status === "in_progress"
          || route.handoffStatus !== "pending"
          || approvedRouteIds.has(route.id)
          || activeExecutionRouteIds.has(route.id)
        ),
      )
      .map((route) => route.id);
    // Ending an active execution is separately confirmation-gated. A terminal
    // route must retain its historical route/handoff state, but an orphaned
    // live execution cannot remain executable after archival.
    const executionShutdownRouteIds = routes
      .filter((route) => activeExecutionRouteIds.has(route.id))
      .map((route) => route.id);
    const confirmationRouteIds = [...new Set([
      ...cancellationRouteIds,
      ...executionShutdownRouteIds,
    ])].sort();
    if (confirmationRouteIds.length > 0 && !confirmActiveRoutes) {
      throw new StopBulkArchiveConfirmationRequiredError(confirmationRouteIds);
    }

    const now = new Date();
    const selectedIds = lockedCandidates.map((stop) => stop.id);
    const draftIds = routes
      .map((route) => route.draftId)
      .filter((draftId): draftId is string => Boolean(draftId));
    const draftAssociations = [
      ...(draftIds.length > 0 ? [inArray(planningDraftsTable.id, draftIds)] : []),
      ...(routes.length > 0 ? [inArray(planningDraftsTable.planId, routes.map((route) => route.planId))] : []),
      // Imported, preview, and draft-state payloads retain source stop UUIDs.
      // Lock all references, including an unassigned imported stop, so a stale
      // durable replay can never restore it from embedded JSON.
      ...selectedIds.flatMap((stopId) => [
        sql`${planningDraftsTable.importedResult} @> ${JSON.stringify({ stopIds: [stopId] })}::jsonb`,
        sql`${planningDraftsTable.state}::text LIKE ${"%" + stopId + "%"}`,
        sql`${planningDraftsTable.planResult}::text LIKE ${"%" + stopId + "%"}`,
      ]),
    ];
    const draftRows = await tx
      .select({ id: planningDraftsTable.id, state: planningDraftsTable.state })
      .from(planningDraftsTable)
      .where(and(
        eq(planningDraftsTable.organizationId, organizationId),
        or(...draftAssociations),
      ))
      .for("update");

    const archived = await tx
      .update(stopsTable)
      .set({ archivedAt: now })
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.id, selectedIds),
        isNull(stopsTable.archivedAt),
      ))
      .returning({ id: stopsTable.id });
    if (archived.length !== selectedIds.length) throw new StopBulkDeleteConflictError();

    if (cancellationRouteIds.length > 0) {
      // Do not detach selected archived rows: their route position and POD
      // evidence remain a stable historical association. Only other unfinished
      // jobs are released for future planning.
      await tx.update(stopsTable).set({
        routeId: null,
        sequenceOrder: null,
        planningPlanId: null,
        planningDate: null,
        unplannedReason: null,
        status: "pending",
      }).where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.routeId, cancellationRouteIds),
        not(inArray(stopsTable.id, selectedIds)),
        inArray(stopsTable.status, CURRENT_STOP_STATUSES),
        isNull(stopsTable.archivedAt),
      ));
      await tx.update(routesTable).set({
        status: "cancelled",
        lockedFirstStopId: null,
        planRevision: sql`${routesTable.planRevision} + 1`,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null, receivedAt: null, openedAt: null, acceptedAt: null, rejectedAt: null, rejectionReason: null,
        executionProjection: null,
        redistributionSuggestion: null,
        updatedAt: now,
      }).where(and(eq(routesTable.organizationId, organizationId), inArray(routesTable.id, cancellationRouteIds)));
    }
    if (executionShutdownRouteIds.length > 0) {
      await tx.update(routeExecutionsTable).set({
        status: "ended",
        endedAt: now,
        updatedAt: now,
      }).where(and(
        eq(routeExecutionsTable.organizationId, organizationId),
        inArray(routeExecutionsTable.routeId, executionShutdownRouteIds),
        eq(routeExecutionsTable.status, "active"),
      ));
    }

    for (const route of routes) {
      if (cancellationRouteIds.includes(route.id)) continue;
      if (route.status === "completed" || route.status === "cancelled") {
        if (route.lockedFirstStopId != null && selectedIds.includes(route.lockedFirstStopId)) {
          await tx.update(routesTable).set({
            lockedFirstStopId: null,
          }).where(and(
            eq(routesTable.id, route.id),
            eq(routesTable.organizationId, organizationId),
          ));
        }
        continue;
      }
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(stopsTable).where(and(
        eq(stopsTable.organizationId, organizationId),
        eq(stopsTable.routeId, route.id),
        isNull(stopsTable.archivedAt),
      ));
      await tx.update(routesTable).set({
        ...invalidatedRoutePlanningState(count),
        ...(route.lockedFirstStopId != null &&
          selectedIds.includes(route.lockedFirstStopId)
          ? { lockedFirstStopId: null }
          : {}),
        ...(count === 0 ? { status: "cancelled", plannerItinerary: [] } : {}),
      }).where(and(eq(routesTable.id, route.id), eq(routesTable.organizationId, organizationId)));
    }

    // A stale generated-plan cache must never be able to write an archived
    // source stop back into its route. Invalidate any affected draft atomically;
    // a planner must deliberately create/reconcile a new revision.
    if (draftRows.length > 0) {
      const archivedIdSet = new Set(selectedIds);
      for (const draft of draftRows) {
        const reconciled = reconcileDraftStateForArchivedStops(
          draft.state,
          archivedIdSet,
        );
        await tx.update(planningDraftsTable).set({
          importedPayloadHash: null,
          importedResult: null,
          planId: null,
          planPayloadHash: null,
          planResult: null,
          state: ((reconciled === ARCHIVED_DRAFT_VALUE ? {} : reconciled) as PlanningDraftState),
          revision: sql`${planningDraftsTable.revision} + 1`,
          updatedAt: now,
        }).where(and(
          eq(planningDraftsTable.organizationId, organizationId),
          eq(planningDraftsTable.id, draft.id),
        ));
      }
    }
    await tx.insert(auditLogTable).values({
      organizationId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: "stops.bulk_archive",
      resourceType: "stop",
      resourceId: null,
      method: "POST",
      path: "/stops/bulk-archive",
      statusCode: "200",
      requestId: null,
      ipAddress: null,
      userAgent: null,
      diff: {
        archivedStopIds: archived.map((stop) => stop.id),
        affectedRouteIds: routeIds,
      },
      metadata: {
        confirmedActiveRoutes: confirmActiveRoutes,
        routeStatesBefore: routes.map((route) => ({
          id: route.id,
          status: route.status,
          handoffStatus: route.handoffStatus,
          planRevision: route.planRevision,
          activeExecution: activeExecutionRouteIds.has(route.id),
        })),
      },
    });
    return { archivedStopIds: archived.map((stop) => stop.id), affectedRouteIds: routeIds };
  });

  const archivedStopIds = requestedStopIds.filter((id) => result.archivedStopIds.includes(id.toLowerCase()));
  if (archivedStopIds.length > 0) {
    broadcastDataChange(organizationId, "stop", "updated", {
      bulk: true,
      archived: true,
      ids: archivedStopIds,
    });
  }
  for (const routeId of result.affectedRouteIds) {
    broadcastDataChange(organizationId, "route", "updated", { id: routeId, stopArchive: true });
  }
  return {
    archivedCount: archivedStopIds.length,
    archivedStopIds,
    affectedRouteIds: result.affectedRouteIds,
  };
}

export async function deleteRetentionEligibleStops(
  stopIds: string[],
  organizationId: string,
  cutoff: Date,
) {
  return deleteStopsWithPolicy(stopIds, organizationId, cutoff);
}
/**
 * Removes terminal stops only after the organization has explicitly enabled a
 * retention window. Pending and in-progress work is intentionally never queried.
 */
export async function deleteExpiredStops(): Promise<{ organizations: number; stops: number }> {
  const organizations = await db
    .select({
      id: organizationsTable.id,
      retentionDays: organizationsTable.stopRetentionDays,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.stopRetentionEnabled, true));

  let organizationsWithDeletes = 0;
  let totalDeleted = 0;

  for (const organization of organizations) {
    const cutoff = getStopRetentionCutoff(organization.retentionDays);
    let deletedForOrganization = 0;

    while (true) {
      const candidates = await db
        .select({ id: stopsTable.id })
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.organizationId, organization.id),
            isNull(stopsTable.archivedAt),
            inArray(stopsTable.status, RETENTION_ELIGIBLE_STOP_STATUSES),
            isNotNull(stopsTable.terminalAt),
            lt(stopsTable.terminalAt, cutoff),
          ),
        )
        .limit(500);

      if (candidates.length === 0) break;
      const deleted = await deleteRetentionEligibleStops(
        candidates.map((candidate) => candidate.id),
        organization.id,
        cutoff,
      );
      if (deleted.length === 0) break;
      deletedForOrganization += deleted.length;
    }

    if (deletedForOrganization > 0) {
      organizationsWithDeletes += 1;
      totalDeleted += deletedForOrganization;
      await db.insert(auditLogTable).values({
        organizationId: organization.id,
        userId: null,
        userEmail: null,
        action: "stops.retention_cleanup",
        resourceType: "stop",
        resourceId: null,
        method: "SYSTEM",
        path: "/system/stop-retention-cleanup",
        statusCode: "200",
        requestId: null,
        ipAddress: null,
        userAgent: null,
        diff: null,
        metadata: {
          deletedCount: deletedForOrganization,
          retentionDays: organization.retentionDays,
          terminalStatuses: RETENTION_ELIGIBLE_STOP_STATUSES,
          retentionTimestamp: "terminal_at",
        },
      });
    }
  }

  return { organizations: organizationsWithDeletes, stops: totalDeleted };
}

function sameDispatchVehicleSnapshot(
  left: typeof vehiclesTable.$inferSelect | undefined,
  right: typeof vehiclesTable.$inferSelect | undefined,
): boolean {
  if (!left || !right) return left === right;
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

export function setDispatchMutationBeforeLockHookForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Dispatch mutation hooks are only available in tests.");
  }
  dispatchMutationBeforeLockHook = hook;
}

export function setStopUpdateBeforeWriteHookForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Stop update hooks are only available in tests.");
  }
  stopUpdateBeforeWriteHook = hook;
}

function sameDispatchDriverSnapshot(
  left: typeof driversTable.$inferSelect | undefined,
  right: typeof driversTable.$inferSelect | undefined,
): boolean {
  if (!left || !right) return left === right;
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

export class StopLifecycleConflictError extends Error {
  statusCode = 409;

  constructor() {
    super("Active or terminal stops cannot be reopened through generic stop editing.");
    this.name = "StopLifecycleConflictError";
  }
}

export class DriverStopUpdateAuthorizationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 409,
  ) {
    super(message);
    this.name = "DriverStopUpdateAuthorizationError";
  }
}

export class StopCreationAssignmentError extends Error {
  statusCode = 409;

  constructor() {
    super("Create stops unassigned, then use an atomic planning or dispatch operation.");
    this.name = "StopCreationAssignmentError";
  }
}

export class CustomerLinkValidationError extends Error {
  statusCode = 422;
  code = "CUSTOMER_NOT_FOUND_OR_ARCHIVED";

  constructor() {
    super("The customer link is invalid, belongs to another organization, or refers to an archived customer.");
    this.name = "CustomerLinkValidationError";
  }
}

export class CustomerPlanningDateRequiredError extends Error {
  statusCode = 422;
  code = "CUSTOMER_UNAVAILABLE_PERIOD_DATE_REQUIRED";

  constructor() {
    super("A customer-linked stop with delivery-unavailable periods requires a planning date.");
    this.name = "CustomerPlanningDateRequiredError";
  }
}

export class CustomerAssignmentMutationError extends Error {
  statusCode = 409;
  code = "STOP_ROUTE_ASSIGNMENT_REQUIRED";

  constructor() {
    super("Customer and planning-date changes for a routed stop must go through dispatch assignment.");
    this.name = "CustomerAssignmentMutationError";
  }
}

function sameDispatchCertificationSnapshot(
  left: typeof driverCertificationsTable.$inferSelect,
  right: typeof driverCertificationsTable.$inferSelect,
): boolean {
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.driverId === right.driverId &&
    left.certificationCode === right.certificationCode &&
    left.issuedAt.getTime() === right.issuedAt.getTime() &&
    left.expiresAt?.getTime() === right.expiresAt?.getTime()
  );
}

function sameDispatchRouteSnapshot(
  left: typeof routesTable.$inferSelect,
  right: typeof routesTable.$inferSelect,
): boolean {
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.planId === right.planId &&
    left.draftId === right.draftId &&
    left.vehicleId === right.vehicleId &&
    left.status === right.status &&
    left.planRevision === right.planRevision &&
    left.date.getTime() === right.date.getTime()
  );
}

function sameDispatchStopSnapshot(
  left: typeof stopsTable.$inferSelect,
  right: typeof stopsTable.$inferSelect,
): boolean {
  const sameDate = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();
  const unavailablePeriods = (stop: typeof stopsTable.$inferSelect) =>
    (stop as typeof stop & { unavailablePeriods?: unknown }).unavailablePeriods ?? null;
  return (
    left.id === right.id &&
    left.organizationId === right.organizationId &&
    left.routeId === right.routeId &&
    sameDate(left.archivedAt, right.archivedAt) &&
    left.status === right.status &&
    left.sequenceOrder === right.sequenceOrder &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    sameDate(left.timeWindowStart, right.timeWindowStart) &&
    sameDate(left.timeWindowEnd, right.timeWindowEnd) &&
    left.serviceDurationMin === right.serviceDurationMin &&
    left.weightKg === right.weightKg &&
    left.volumeM3 === right.volumeM3 &&
    left.pickupLatitude === right.pickupLatitude &&
    left.pickupLongitude === right.pickupLongitude &&
    left.jobType === right.jobType &&
    JSON.stringify(left.requiredSkills ?? []) === JSON.stringify(right.requiredSkills ?? []) &&
    JSON.stringify(left.requiredCertifications ?? []) ===
      JSON.stringify(right.requiredCertifications ?? []) &&
    JSON.stringify(left.requiredEquipment ?? []) ===
      JSON.stringify(right.requiredEquipment ?? []) &&
    JSON.stringify(unavailablePeriods(left)) === JSON.stringify(unavailablePeriods(right))
  );
}

export class StopRoutePositionMutationError extends Error {
  statusCode = 409;

  constructor() {
    super("Route and sequence changes must use an atomic planning or dispatch operation.");
    this.name = "StopRoutePositionMutationError";
  }
}

/**
 * Deletes the supplied stops as one all-or-nothing organization-scoped operation.
 * Delivery proofs use a database cascade from stops, matching the existing single
 * stop deletion behavior.
 */
async function deleteStopsWithPolicy(
  stopIds: string[],
  organizationId: string,
  retentionCutoff: Date | null,
) {
  const ids = Array.from(new Set(stopIds));
  if (ids.length === 0) return [];
  const snapshot = await db
    .select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
      status: stopsTable.status,
      sequenceOrder: stopsTable.sequenceOrder,
      terminalAt: stopsTable.terminalAt,
      archivedAt: stopsTable.archivedAt,
    })
    .from(stopsTable)
    .where(and(
      eq(stopsTable.organizationId, organizationId),
      inArray(stopsTable.id, ids),
      ...(retentionCutoff ? [isNull(stopsTable.archivedAt)] : []),
    ));
  if (!retentionCutoff) {
    if (snapshot.length !== ids.length) throw new StopBulkDeleteNotFoundError();
    if (snapshot.some((stop) => stop.archivedAt)) {
      throw new StopBulkDeleteConflictError("archived");
    }
    if (snapshot.some((stop) => stop.status !== "pending")) {
      throw new StopBulkDeleteConflictError("status");
    }
    const proof = await db
      .select({ stopId: deliveryProofsTable.stopId })
      .from(deliveryProofsTable)
      .where(inArray(deliveryProofsTable.stopId, ids))
      .limit(1);
    if (proof.length > 0) throw new StopBulkDeleteConflictError("proof");
    const [executionEvent, serviceReport] = await Promise.all([
      db.select({ stopId: executionEventsTable.stopId }).from(executionEventsTable).where(and(
        eq(executionEventsTable.organizationId, organizationId),
        inArray(executionEventsTable.stopId, ids),
      )).limit(1),
      db.select({ stopId: serviceReportsTable.stopId }).from(serviceReportsTable).where(and(
        eq(serviceReportsTable.organizationId, organizationId),
        inArray(serviceReportsTable.stopId, ids),
      )).limit(1),
    ]);
    if (executionEvent.length > 0) throw new StopBulkDeleteConflictError("execution");
    if (serviceReport.length > 0) throw new StopBulkDeleteConflictError("serviceReport");
  }
  const deletionSnapshot = retentionCutoff
    ? snapshot.filter((stop) =>
        isRetentionEligibleStopStatus(stop.status) &&
        stop.terminalAt !== null &&
        stop.terminalAt < retentionCutoff
      )
    : snapshot;
  if (deletionSnapshot.length === 0) return [];
  const deletionSnapshotIds = deletionSnapshot.map((stop) => stop.id);
  const affectedRouteIds = Array.from(
    new Set(
      deletionSnapshot
        .map((stop) => stop.routeId)
        .filter((routeId): routeId is string => Boolean(routeId)),
    ),
  ).sort();

  const deleted = await db.transaction(async (tx) => {
    for (const routeId of affectedRouteIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }
    const lockedRouteRows = affectedRouteIds.length > 0
      ? await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.organizationId, organizationId),
          inArray(routesTable.id, affectedRouteIds),
        ))
        .orderBy(routesTable.id)
        .for("update")
      : [];
    for (const route of lockedRouteRows) {
      assertLockedFirstStopNotRemoved(route, deletionSnapshotIds);
    }
    const lockedRouteStops = affectedRouteIds.length > 0
      ? await tx
          .select()
          .from(stopsTable)
          .where(and(
            eq(stopsTable.organizationId, organizationId),
            inArray(stopsTable.routeId, affectedRouteIds),
          ))
          .orderBy(stopsTable.id)
          .for("update")
      : [];
    const unplannedIds = deletionSnapshot
      .filter((stop) => !stop.routeId)
      .map((stop) => stop.id);
    const lockedUnplannedStops = unplannedIds.length > 0
      ? await tx
          .select()
          .from(stopsTable)
          .where(and(
            eq(stopsTable.organizationId, organizationId),
            inArray(stopsTable.id, unplannedIds),
          ))
          .orderBy(stopsTable.id)
          .for("update")
      : [];
    const lockedById = new Map(
      [...lockedRouteStops, ...lockedUnplannedStops].map((stop) => [stop.id, stop]),
    );
    const lockedStops = deletionSnapshotIds
      .map((id) => lockedById.get(id))
      .filter((stop): stop is typeof stopsTable.$inferSelect => Boolean(stop));
    const snapshotById = new Map(deletionSnapshot.map((stop) => [stop.id, stop]));
    if (!retentionCutoff && (
      lockedStops.length !== deletionSnapshot.length ||
      lockedStops.some((stop) => {
        const original = snapshotById.get(stop.id);
        return (
          !original ||
          original.routeId !== stop.routeId ||
          original.status !== stop.status ||
          original.sequenceOrder !== stop.sequenceOrder
        );
      })
    )) {
      throw new StopBulkDeleteConflictError();
    }
    const stopsToDelete = retentionCutoff
      ? lockedStops.filter((stop) => {
          const original = snapshotById.get(stop.id);
          return (
            original?.routeId === stop.routeId &&
            isRetentionEligibleStopStatus(stop.status) &&
            stop.terminalAt !== null &&
            stop.terminalAt < retentionCutoff
          );
        })
      : lockedStops;
    if (stopsToDelete.length === 0) return [];
    const deletionIds = stopsToDelete.map((stop) => stop.id);
    if (!retentionCutoff) {
      const proof = await tx
        .select({ stopId: deliveryProofsTable.stopId })
        .from(deliveryProofsTable)
        .where(inArray(deliveryProofsTable.stopId, deletionIds))
        .limit(1);
      const executionEvent = await tx
        .select({ stopId: executionEventsTable.stopId })
        .from(executionEventsTable)
        .where(and(
          eq(executionEventsTable.organizationId, organizationId),
          inArray(executionEventsTable.stopId, deletionIds),
        ))
        .limit(1);
      const serviceReport = await tx
        .select({ stopId: serviceReportsTable.stopId })
        .from(serviceReportsTable)
        .where(and(
          eq(serviceReportsTable.organizationId, organizationId),
          inArray(serviceReportsTable.stopId, deletionIds),
        ))
        .limit(1);
      if (proof.length > 0) throw new StopBulkDeleteConflictError("proof");
      if (executionEvent.length > 0) throw new StopBulkDeleteConflictError("execution");
      if (serviceReport.length > 0) throw new StopBulkDeleteConflictError("serviceReport");
    }
    const deletedIds = new Set(deletionIds);
    const transactionRouteIds = Array.from(
      new Set(
        stopsToDelete
          .map((stop) => stop.routeId)
          .filter((routeId): routeId is string => Boolean(routeId)),
      ),
    ).sort();
    const transactionRouteIdSet = new Set(transactionRouteIds);
    const remainingRouteStops = lockedRouteStops.filter((stop) =>
      stop.routeId !== null &&
      transactionRouteIdSet.has(stop.routeId) &&
      !deletedIds.has(stop.id)
    );
    const nextSequenceByStopId = new Map<string, number>();
    for (const routeId of transactionRouteIds) {
      const remaining = remainingRouteStops
        .filter((stop) => stop.routeId === routeId)
        .sort((left, right) =>
          (left.sequenceOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
        );
      remaining.forEach((stop, index) => nextSequenceByStopId.set(stop.id, index + 1));
      if (!retentionCutoff && remaining.some((stop) =>
        stop.status !== "pending" &&
        nextSequenceByStopId.get(stop.id) !== stop.sequenceOrder
      )) {
        throw new StopBulkDeleteConflictError("sequence");
      }
    }
    // These tables predate cascading foreign keys. Delete their historical
    // telemetry/notification rows in the same transaction before removing
    // stops; delivery proofs and service reports already cascade.
    await tx.delete(deliveryNotificationsTable).where(inArray(deliveryNotificationsTable.stopId, deletionIds));
    await tx.delete(geofenceEventsTable).where(inArray(geofenceEventsTable.stopId, deletionIds));

    const removed = await tx
      .delete(stopsTable)
      .where(and(eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, deletionIds)))
      .returning();

    if (removed.length !== deletionIds.length) {
      throw new StopBulkDeleteNotFoundError();
    }
    for (const stop of retentionCutoff ? [] : remainingRouteStops) {
      if (stop.status !== "pending") continue;
      const [saved] = await tx
        .update(stopsTable)
        .set({ sequenceOrder: nextSequenceByStopId.get(stop.id)! })
        .where(and(
          eq(stopsTable.id, stop.id),
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.routeId, stop.routeId!),
          eq(stopsTable.status, "pending"),
        ))
        .returning({ id: stopsTable.id });
      if (!saved) throw new StopBulkDeleteConflictError();
    }

    if (transactionRouteIds.length > 0) {
      const remainingCounts = await tx
        .select({
          routeId: stopsTable.routeId,
          count: sql<number>`count(*)::int`,
        })
        .from(stopsTable)
        .where(and(
          eq(stopsTable.organizationId, organizationId),
          inArray(stopsTable.routeId, transactionRouteIds),
        ))
        .groupBy(stopsTable.routeId);
      const remainingByRoute = new Map(
        remainingCounts.flatMap(({ routeId, count }) => routeId ? [[routeId, count] as const] : []),
      );
      for (const routeId of transactionRouteIds) {
        const totalStops = remainingByRoute.get(routeId) ?? 0;
        await tx.update(routesTable).set({
          totalStops,
          ...(totalStops === 0 ? {
            status: sql`CASE WHEN ${routesTable.status} = 'completed' THEN 'completed'::route_status ELSE 'cancelled'::route_status END`,
            plannerItinerary: [],
          } : {}),
          ...invalidatedRoutePlanningState(),
        }).where(and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, organizationId),
        ));
      }
    }
    // Removed stops can be the counterpart in persisted nearby-pair evidence.
    // Preserve all sibling plan state and clear only derived explanations.
    await tx
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));

    return removed;
  });

  for (const stop of deleted) {
    getDistanceCache().invalidate(stop.latitude, stop.longitude);
  }
  if (deleted.length === 0) return deleted;
  broadcastDataChange(organizationId, "stop", "deleted", {
    bulk: true,
    count: deleted.length,
    ids: deleted.map((stop) => stop.id),
  });
  return deleted;
}

function stockholmWorkdayDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month! - 1
    || calendarDate.getUTCDate() !== day!
  ) {
    return null;
  }
  // A date-only input represents Stockholm-local midnight, not a UTC day.
  return stockholmClock(calendarDate, "00:00");
}

export async function deferStopsForDispatch(
  organizationId: string,
  input: {
    stopIds: string[];
    targetDate: string;
    routeRevisions: Array<{ routeId: string; planRevision: number }>;
  },
): Promise<
  | { kind: "not_found" }
  | { kind: "ineligible"; error: string; code?: DispatchMoveIneligibleCode }
  | {
      kind: "deferred";
      stopIds: string[];
      targetDate: string;
      sourceRouteImpacts: Array<{
        routeId: string;
        previousPlanRevision: number;
        planRevision: number;
        deferredStopIds: string[];
        remainingStopCount: number;
      }>;
    }
> {
  const targetWorkday = stockholmWorkdayDate(input.targetDate);
  if (!targetWorkday) {
    return {
      kind: "ineligible",
      error: "targetDate must be a valid YYYY-MM-DD Stockholm calendar date",
    };
  }
  if (input.targetDate <= stockholmCalendarDate()) {
    return {
      kind: "ineligible",
      error: "targetDate must be a future workday in Europe/Stockholm",
    };
  }
  const strictRoads = await prepareDispatchLockRoadData(organizationId, { stopIds: input.stopIds });
  const runDefer = () => db.transaction(async (tx) => {
    const movingSnapshot = await tx
      .select()
      .from(stopsTable)
      .where(and(
        inArray(stopsTable.id, input.stopIds),
        eq(stopsTable.organizationId, organizationId),
      ));
    if (movingSnapshot.length !== input.stopIds.length) {
      return { kind: "not_found" as const };
    }
    const archived = movingSnapshot.find((stop) => stop.archivedAt !== null);
    if (archived) {
      return {
        kind: "ineligible" as const,
        error: "Archived stops are historical records and cannot be deferred",
        code: STOP_LIFECYCLE_LOCKED_CODE,
      };
    }
    if (movingSnapshot.some((stop) => stop.status !== "pending")) {
      return {
        kind: "ineligible" as const,
        error: "Only pending stops can be deferred from dispatch",
        code: STOP_LIFECYCLE_LOCKED_CODE,
      };
    }
    if (movingSnapshot.some((stop) => stop.routeId === null)) {
      return {
        kind: "ineligible" as const,
        error: "Only stops currently assigned to a dispatch route can be deferred",
      };
    }

    const affectedRouteIds = [...new Set(movingSnapshot.map((stop) => stop.routeId!))].sort();
    const suppliedRevisions = new Map(
      input.routeRevisions.map((item) => [item.routeId, item.planRevision]),
    );
    if (
      suppliedRevisions.size !== input.routeRevisions.length
      || input.routeRevisions.length !== affectedRouteIds.length
      || [...suppliedRevisions.keys()].some((routeId) => !affectedRouteIds.includes(routeId))
    ) {
      throw new DispatchRevisionConflictError();
    }
    const routeSnapshots = await tx
      .select()
      .from(routesTable)
      .where(and(
        inArray(routesTable.id, affectedRouteIds),
        eq(routesTable.organizationId, organizationId),
      ));
    if (routeSnapshots.length !== affectedRouteIds.length) {
      return { kind: "not_found" as const };
    }
    if (routeSnapshots.some((route) =>
      (
        isProtectedImportRoute(route)
        && (!route.depotSnapshot || !hasPersistedPlanningEvidence(route.optimizationPlanningSnapshot))
      )
      || (route.lockedFirstStopId != null && !route.depotSnapshot)
    )) {
      return {
        kind: "ineligible" as const,
        error: "A source route lacks its saved depot or planning evidence and cannot be changed safely",
        code: DISPATCH_PLANNING_EVIDENCE_MISSING_CODE,
      };
    }
    const routeStopsSnapshot = await tx
      .select()
      .from(stopsTable)
      .where(and(
        inArray(stopsTable.routeId, affectedRouteIds),
        eq(stopsTable.organizationId, organizationId),
        isNull(stopsTable.archivedAt),
      ));
    const sourceVehicleIds = [...new Set(
      routeSnapshots.map((route) => route.vehicleId).filter((id): id is string => id !== null),
    )].sort();
    const vehicleSnapshots = sourceVehicleIds.length > 0
      ? await tx.select().from(vehiclesTable).where(and(
          inArray(vehiclesTable.id, sourceVehicleIds),
          eq(vehiclesTable.organizationId, organizationId),
        ))
      : [];
    const driverSnapshots = sourceVehicleIds.length > 0
      ? await tx.select().from(driversTable).where(and(
          inArray(driversTable.vehicleId, sourceVehicleIds),
          eq(driversTable.organizationId, organizationId),
        )).orderBy(driversTable.id)
      : [];
    const driverIds = driverSnapshots.map((driver) => driver.id);
    const certificationSnapshots = driverIds.length > 0
      ? await tx.select().from(driverCertificationsTable).where(and(
          inArray(driverCertificationsTable.driverId, driverIds),
          eq(driverCertificationsTable.organizationId, organizationId),
        )).orderBy(driverCertificationsTable.id)
      : [];
    const resolvedDrivers = new Map(
      await Promise.all(routeSnapshots.map(async (route) => [
        route.id,
        await dispatchDriverSnapshot(tx, organizationId, route),
      ] as const)),
    );
    if (routeSnapshots.some((route) =>
      route.depotSnapshot
      && (!route.vehicleId
        || !vehicleSnapshots.some((vehicle) => vehicle.id === route.vehicleId)
        || !resolvedDrivers.get(route.id))
    )) {
      return {
        kind: "ineligible" as const,
        error: "A source route lacks its assigned vehicle and active driver and cannot be recalculated safely",
        code: DISPATCH_DRIVER_UNRESOLVED_CODE,
      };
    }

    await dispatchMutationBeforeLockHook?.();
    for (const stopId of [...input.stopIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-stop:" + stopId}))`,
      );
    }
    for (const routeId of affectedRouteIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }
    const lockedRoutes = await lockRoutesForPlanningMutation(
      tx,
      organizationId,
      affectedRouteIds,
    );
    if (lockedRoutes.length !== affectedRouteIds.length) {
      return { kind: "not_found" as const };
    }
    const currentRoutes = await tx
      .select()
      .from(routesTable)
      .where(and(
        inArray(routesTable.id, affectedRouteIds),
        eq(routesTable.organizationId, organizationId),
      ))
      .orderBy(routesTable.id)
      .for("update");
    const lockedVehicles = sourceVehicleIds.length > 0
      ? await tx.select().from(vehiclesTable).where(and(
          inArray(vehiclesTable.id, sourceVehicleIds),
          eq(vehiclesTable.organizationId, organizationId),
        )).orderBy(vehiclesTable.id).for("update")
      : [];
    const lockedDrivers = driverIds.length > 0
      ? await tx.select().from(driversTable).where(and(
          inArray(driversTable.id, driverIds),
          eq(driversTable.organizationId, organizationId),
        )).orderBy(driversTable.id).for("update")
      : [];
    const lockedCertifications = driverIds.length > 0
      ? await tx.select().from(driverCertificationsTable).where(and(
          inArray(driverCertificationsTable.driverId, driverIds),
          eq(driverCertificationsTable.organizationId, organizationId),
        )).orderBy(driverCertificationsTable.id).for("update")
      : [];
    const currentRouteStops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        inArray(stopsTable.routeId, affectedRouteIds),
        eq(stopsTable.organizationId, organizationId),
        isNull(stopsTable.archivedAt),
      ))
      .orderBy(stopsTable.id)
      .for("update");
    const movingStops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        inArray(stopsTable.id, input.stopIds),
        eq(stopsTable.organizationId, organizationId),
      ))
      .orderBy(stopsTable.id)
      .for("update");
    if (currentRoutes.length !== affectedRouteIds.length) {
      return { kind: "not_found" as const };
    }
    if (
      currentRoutes.some((route) => suppliedRevisions.get(route.id) !== route.planRevision)
    ) {
      throw new DispatchRevisionConflictError();
    }
    const movingSnapshotById = new Map(movingSnapshot.map((stop) => [stop.id, stop]));
    const routeSnapshotsById = new Map(routeSnapshots.map((route) => [route.id, route]));
    const routeStopsSnapshotById = new Map(routeStopsSnapshot.map((stop) => [stop.id, stop]));
    const vehicleSnapshotsById = new Map(vehicleSnapshots.map((vehicle) => [vehicle.id, vehicle]));
    const lockedVehiclesById = new Map(lockedVehicles.map((vehicle) => [vehicle.id, vehicle]));
    const driverSnapshotsById = new Map(driverSnapshots.map((driver) => [driver.id, driver]));
    const lockedDriversById = new Map(lockedDrivers.map((driver) => [driver.id, driver]));
    const certificationSnapshotsById = new Map(
      certificationSnapshots.map((certification) => [certification.id, certification]),
    );
    const lockedCertificationsById = new Map(
      lockedCertifications.map((certification) => [certification.id, certification]),
    );
    if (
      movingStops.length !== movingSnapshot.length
      || movingStops.some((stop) => {
        const original = movingSnapshotById.get(stop.id);
        return !original
          || !sameDispatchStopSnapshot(original, stop)
          || original.planningPlanId !== stop.planningPlanId
          || original.planningDate?.getTime() !== stop.planningDate?.getTime();
      })
      || currentRoutes.some((route) => {
        const original = routeSnapshotsById.get(route.id);
        return !original || !sameDispatchRouteSnapshot(original, route);
      })
      || lockedVehicles.length !== vehicleSnapshots.length
      || lockedVehicles.some((vehicle) => {
        const original = vehicleSnapshotsById.get(vehicle.id);
        return !original || !sameDispatchVehicleSnapshot(original, vehicle);
      })
      || lockedDrivers.length !== driverSnapshots.length
      || lockedDrivers.some((driver) => {
        const original = driverSnapshotsById.get(driver.id);
        return !original || !sameDispatchDriverSnapshot(original, driver);
      })
      || lockedCertifications.length !== certificationSnapshots.length
      || lockedCertifications.some((certification) => {
        const original = certificationSnapshotsById.get(certification.id);
        return !original || !sameDispatchCertificationSnapshot(original, certification);
      })
      || [...resolvedDrivers.values()].some((driver) =>
        driver != null
        && !sameDispatchDriverSnapshot(driver, lockedDriversById.get(driver.id))
      )
      || currentRouteStops.length !== routeStopsSnapshot.length
      || currentRouteStops.some((stop) => {
        const original = routeStopsSnapshotById.get(stop.id);
        return !original || !sameDispatchStopSnapshot(original, stop);
      })
    ) {
      throw new DispatchRevisionConflictError();
    }

    const movingIds = new Set(input.stopIds);
    const movingById = new Map(movingStops.map((stop) => [stop.id, stop]));
    const movedStops = input.stopIds.map((id) => movingById.get(id)!);
    const routeChanges: Array<{
      route: typeof routesTable.$inferSelect;
      routeMoving: typeof stopsTable.$inferSelect[];
      remaining: Array<typeof stopsTable.$inferSelect & { sequenceOrder: number }>;
    }> = [];
    for (const route of currentRoutes) {
      const routeMoving = movedStops.filter((stop) => stop.routeId === route.id);
      const remaining = currentRouteStops
        .filter((stop) => stop.routeId === route.id && !movingIds.has(stop.id))
        .sort((a, b) =>
          (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER)
          - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER))
        .map((stop, index) => ({ ...stop, sequenceOrder: index + 1 }));
      try {
        assertLockedFirstStopOrder(route, remaining.map((stop) => stop.id));
      } catch (error) {
        if (error instanceof RouteFirstStopLockError) {
          return {
            kind: "ineligible" as const,
            error: error.message,
            code: DISPATCH_LOCKED_FIRST_STOP_CODE,
          };
        }
        throw error;
      }
      const proposedById = new Map(remaining.map((stop) => [stop.id, stop]));
      const shiftedLockedStop = currentRouteStops.find((stop) => {
        if (stop.routeId !== route.id || stop.status === "pending") return false;
        const proposed = proposedById.get(stop.id);
        return !proposed || proposed.sequenceOrder !== stop.sequenceOrder;
      });
      if (shiftedLockedStop) {
        return {
          kind: "ineligible" as const,
          error: STOP_LIFECYCLE_LOCKED_ERROR,
          code: STOP_LIFECYCLE_LOCKED_CODE,
        };
      }
      if (routeMoving.some((stop) => stop.status !== "pending" || stop.archivedAt !== null)) {
        return {
          kind: "ineligible" as const,
          error: "Only active pending stops can be deferred from a route",
          code: STOP_LIFECYCLE_LOCKED_CODE,
        };
      }
      routeChanges.push({ route, routeMoving, remaining });
    }
    const planningCalendarDate = new Date(`${input.targetDate}T00:00:00.000Z`);
    await materializeDispatchCustomerUnavailablePeriods(
      tx,
      organizationId,
      planningCalendarDate,
      movedStops,
      { refreshExisting: true, storedPlanningDate: targetWorkday },
    );
    const [organization] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    const impacts = [];
    for (const { route, routeMoving, remaining } of routeChanges) {
      for (const stop of routeMoving) {
        const [updated] = await tx
          .update(stopsTable)
          .set({
            routeId: null,
            sequenceOrder: null,
            planningPlanId: null,
            planningDate: targetWorkday,
            unplannedReason: null,
            assignmentOverrideAt: null,
            assignmentOverrideReasonCodes: null,
          })
          .where(and(
            eq(stopsTable.id, stop.id),
            eq(stopsTable.organizationId, organizationId),
            eq(stopsTable.routeId, route.id),
            eq(stopsTable.status, "pending"),
            isNull(stopsTable.archivedAt),
          ))
          .returning({ id: stopsTable.id });
        if (!updated) throw new DispatchRevisionConflictError();
      }
      for (const candidate of remaining) {
        const original = currentRouteStops.find((stop) => stop.id === candidate.id);
        if (!original || original.status !== "pending") continue;
        const [updated] = await tx
          .update(stopsTable)
          .set({ sequenceOrder: candidate.sequenceOrder })
          .where(and(
            eq(stopsTable.id, original.id),
            eq(stopsTable.organizationId, organizationId),
            eq(stopsTable.routeId, route.id),
            eq(stopsTable.status, "pending"),
            isNull(stopsTable.archivedAt),
          ))
          .returning({ id: stopsTable.id });
        if (!updated) throw new DispatchRevisionConflictError();
      }
      await persistDispatchRouteWorkday(tx, organizationId, route, organization);
      impacts.push({
        routeId: route.id,
        previousPlanRevision: route.planRevision,
        planRevision: route.planRevision + 1,
        deferredStopIds: routeMoving.map((stop) => stop.id),
        remainingStopCount: remaining.length,
      });
    }
    return {
      kind: "deferred" as const,
      stopIds: input.stopIds,
      targetDate: input.targetDate,
      sourceRouteImpacts: impacts,
    };
  });

  const result = await (strictRoads ? withRequiredRoadData(runDefer) : runDefer());
  if (result.kind === "deferred") {
    broadcastDataChange(organizationId, "stop", "updated", {
      ids: result.stopIds,
      routeId: null,
      deferred: true,
      targetDate: result.targetDate,
    });
    for (const impact of result.sourceRouteImpacts) {
      broadcastDataChange(organizationId, "route", "updated", {
        id: impact.routeId,
        deferredStopIds: impact.deferredStopIds,
      });
    }
  }
  return result;
}
