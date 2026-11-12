import crypto from "node:crypto";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  driverCertificationsTable,
  planningDraftsTable,
  routePlanApprovalsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
  type Route,
  type RoutePlanApproval,
  type Driver,
  type DriverCertification,
  type Stop,
  type Vehicle,
} from "@workspace/db";
import { effectivePlanningPolicy } from "./planning-policy";
import { assertOutgoingDispatchCompatible } from "./route-dispatch-snapshot-service";
import { PlanningLockError } from "./planning-lock-service";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function canReviewWorkingRoute(route: Route): boolean {
  return route.status === "optimized" || (
    route.status === "in_progress" && route.handoffVersion != null
    && route.handoffDriverId != null && route.planRevision >= route.handoffVersion
    && route.dispatchSnapshotVersion === route.handoffVersion
  );
}

export function routePlanningSettingsMatchCurrent(
  route: Pick<Route, "optimizationPlanningSnapshot">,
  organization: { maxDriverOvertimeMin?: number | null; allowLateStopsMin?: number | null },
): boolean {
  const snapshot = route.optimizationPlanningSnapshot;
  const expectedOvertime = typeof snapshot?.maxDriverOvertimeMin === "number"
    ? snapshot.maxDriverOvertimeMin : 0;
  const expectedLate = typeof snapshot?.allowLateStopsMin === "number"
    ? snapshot.allowLateStopsMin : 0;
  const current = effectivePlanningPolicy(organization, snapshot);
  return expectedOvertime === current.maxDriverOvertimeMin
    && expectedLate === current.allowLateStopsMin;
}

export type RoutePlanApprovalInput = {
  routeId: string;
  planRevision: number;
  driverId: string;
};

export type RoutePlanApprovalSummary = {
  routeId: string;
  planId: string;
  draftId: string | null;
  planRevision: number;
  status: Route["status"];
  vehicleId: string | null;
  driverId: string | null;
  approval: {
    approved: boolean;
    approvedAt: Date | null;
    approvedByUserId: string | null;
  };
};

export class RoutePlanApprovalError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 409,
    readonly code:
      | "PLAN_NOT_FOUND"
      | "PLAN_NOT_PROTECTED"
      | "ROUTE_NOT_IN_PLAN"
      | "STALE_PLAN_REVISION"
      | "INVALID_RECIPIENT"
      | "STALE_RESOURCE_SNAPSHOT"
      | "APPROVAL_REQUIRED" = "APPROVAL_REQUIRED",
  ) {
    super(message);
    this.name = "RoutePlanApprovalError";
  }
}

/** A draft association, not the legacy manual review fields, protects a plan. */
export function isProtectedImportRoute(route: Pick<Route, "draftId">): boolean {
  return route.draftId != null;
}

export function optimizationDriverIdForRoute(
  route: Pick<Route, "optimizationResourceSnapshot">,
): string | null {
  const snapshot = route.optimizationResourceSnapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const driver = (snapshot as Record<string, unknown>).driver;
  if (!driver || typeof driver !== "object") return null;
  const id = (driver as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/**
 * Resolve the resource recipient for a route mutation. Protected imported
 * routes may not fall back to another linked driver: absent an explicit
 * resource-change request, they must retain the optimization snapshot driver.
 * Legacy routes retain their historical first-active-driver fallback.
 */
export function resolveDriverForRoute<T extends { id: string }>(
  route: Pick<Route, "draftId" | "optimizationResourceSnapshot">,
  drivers: readonly T[],
  explicitDriverId?: string,
): T | undefined {
  const selectedDriverId = explicitDriverId
    ?? (isProtectedImportRoute(route) ? optimizationDriverIdForRoute(route) : null);
  if (isProtectedImportRoute(route) && !selectedDriverId) return undefined;
  return selectedDriverId
    ? drivers.find((driver) => driver.id === selectedDriverId)
    : drivers[0];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function currentPlanRoutes(routes: Route[]): Route[] {
  return routes.filter((route) => route.status !== "cancelled");
}

export type ApprovalSnapshotResources = {
  routes: Route[];
  stops: Stop[];
  vehicles: Vehicle[];
  drivers: Driver[];
  certifications: DriverCertification[];
};

function stableSnapshotString(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSnapshotString(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSnapshotString(entry)}`)
    .join(",")}}`;
}

function pickSnapshotFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function approvalSnapshot(
  route: Route,
  stops: Stop[],
  vehicle: Vehicle,
  driver: Driver,
  certifications: DriverCertification[],
): Record<string, unknown> {
  return {
    route: pickSnapshotFields(route as unknown as Record<string, unknown>, [
      "id", "planId", "draftId", "organizationId", "vehicleId", "name",
      "manualReviewRequired", "manualReviewedAt", "planRevision", "date",
      "totalDistanceKm", "totalDurationMin", "totalStops", "co2EmissionsKg",
      "plannerItinerary", "geographicOverlapExplanation", "depotSnapshot",
       "workdayTimeline", "workdaySummary", "optimizationPlanningSnapshot",
       "optimizationPlanningSnapshotHash", "sharedInstructions", "planningSummary",
    ]),
    stops: stops
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((stop) => pickSnapshotFields(stop as unknown as Record<string, unknown>, [
        "id", "organizationId", "routeId", "address", "latitude", "longitude",
        "timeWindowStart", "timeWindowEnd", "serviceDurationMin", "weightKg",
        "volumeM3", "sequenceOrder", "pickupAddress", "pickupLatitude",
        "pickupLongitude", "jobType", "requiredSkills", "requiredCertifications",
        "requiredEquipment", "priority", "slaDeadline", "serviceCategory",
        "serviceInstructions", "customFields",
      ])),
    ...materialResourceSnapshot(vehicle, driver, stops, certifications),
  };
}

export function approvalSnapshotHash(snapshot: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableSnapshotString(snapshot)).digest("hex");
}

function snapshotWithoutStopLifecycleStatus(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  if (Array.isArray(normalized.stops)) {
    normalized.stops = normalized.stops.map((stop) => {
      if (!stop || typeof stop !== "object") return stop;
      const { status: _status, ...materialStop } = stop as Record<string, unknown>;
      return materialStop;
    });
  }
  return normalized;
}

/**
 * Old protected snapshots included stop lifecycle status.  Verify the stored
 * legacy hash before comparing a normalized copy, so removing that field does
 * not turn a tampered snapshot into a newly approved resource state.
 */
function snapshotMatchesCurrent(
  storedSnapshot: Record<string, unknown> | null | undefined,
  storedHash: string | null | undefined,
  currentSnapshot: Record<string, unknown>,
): boolean {
  if (!storedHash) return false;
  const currentHash = approvalSnapshotHash(currentSnapshot);
  if (storedHash === currentHash) return true;
  if (!storedSnapshot || approvalSnapshotHash(storedSnapshot) !== storedHash) return false;
  return stableSnapshotString(snapshotWithoutStopLifecycleStatus(storedSnapshot))
    === stableSnapshotString(snapshotWithoutStopLifecycleStatus(currentSnapshot));
}

function materialResourceSnapshotMatchesCurrent(
  route: Pick<Route, "optimizationResourceSnapshot" | "optimizationResourceSnapshotHash">,
  vehicle: Vehicle,
  driver: Driver,
  stops: Stop[],
  certifications: DriverCertification[],
): boolean {
  return snapshotMatchesCurrent(
    route.optimizationResourceSnapshot,
    route.optimizationResourceSnapshotHash,
    materialResourceSnapshot(vehicle, driver, stops, certifications),
  );
}

/**
 * The optimization-time baseline deliberately excludes route totals and
 * itinerary output. It is the exact resource/stop input that must still be
 * true when a planner approves the resulting route.
 */
export function materialResourceSnapshot(
  vehicle: Vehicle,
  driver: Driver,
  stops: Stop[],
  certifications: DriverCertification[],
): Record<string, unknown> {
  return {
    vehicle: pickSnapshotFields(vehicle as unknown as Record<string, unknown>, [
      "id", "organizationId", "vehicleType", "capacityKg", "capacityVolume",
      "isActive", "currentBatteryPercent", "rangeKm", "equipmentInventory",
    ]),
    driver: pickSnapshotFields(driver as unknown as Record<string, unknown>, [
      "id", "organizationId", "vehicleId", "isActive", "workStartTime",
      "workEndTime", "breakStartTime", "breakEndTime", "tempo", "capacityKg",
      "capacityVolume", "startAddress", "startLatitude", "startLongitude",
      "endAddress", "endLatitude", "endLongitude", "driverRole", "skills",
    ]),
    stops: stops
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((stop) => pickSnapshotFields(stop as unknown as Record<string, unknown>, [
        "id", "organizationId", "routeId", "address", "latitude", "longitude",
        "timeWindowStart", "timeWindowEnd", "serviceDurationMin", "weightKg",
        "volumeM3", "sequenceOrder", "pickupAddress", "pickupLatitude",
        "pickupLongitude", "jobType", "requiredSkills", "requiredCertifications",
        "requiredEquipment", "priority", "slaDeadline", "serviceCategory",
        "serviceInstructions", "customFields",
      ])),
    certifications: certifications
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((certification) => pickSnapshotFields(
        certification as unknown as Record<string, unknown>,
        ["id", "organizationId", "driverId", "certificationCode", "issuedAt", "expiresAt"],
      )),
  };
}

export function materialResourceSnapshotHash(
  vehicle: Vehicle,
  driver: Driver,
  stops: Stop[],
  certifications: DriverCertification[],
): string {
  return approvalSnapshotHash(materialResourceSnapshot(
    vehicle,
    driver,
    stops,
    certifications,
  ));
}

function resourceForRoute(
  resources: ApprovalSnapshotResources,
  route: Route,
  driverId: string,
): {
  vehicle: Vehicle | undefined;
  driver: Driver | undefined;
  certifications: DriverCertification[];
  stops: Stop[];
} {
  return {
    vehicle: resources.vehicles.find((vehicle) => vehicle.id === route.vehicleId),
    driver: resources.drivers.find((driver) =>
      driver.id === driverId
      && driver.vehicleId === route.vehicleId
      && driver.isActive,
    ),
    certifications: resources.certifications.filter((certification) =>
      certification.driverId === driverId,
    ),
    stops: resources.stops.filter((stop) => stop.routeId === route.id),
  };
}

function approvalForRoute(
  route: Route,
  approvals: RoutePlanApproval[],
  resources: ApprovalSnapshotResources,
  activeDriversByVehicle: Map<string, Driver[]>,
): RoutePlanApproval | null {
  if (route.status === "cancelled") return null;
  const candidates = approvals.filter((candidate) =>
    candidate.routeId === route.id
    && candidate.planRevision === route.planRevision
    && candidate.vehicleId === route.vehicleId,
  );
  return candidates.find((candidate) => {
    const selectedDriverId = isProtectedImportRoute(route)
      ? optimizationDriverIdForRoute(route)
      : null;
    if (isProtectedImportRoute(route)
      && (!selectedDriverId || candidate.driverId !== selectedDriverId)) {
      return false;
    }
    const currentDriver = activeDriversByVehicle.get(route.vehicleId ?? "")
      ?.find((driver) => driver.id === candidate.driverId);
    if (!currentDriver || !candidate.snapshotHash || !route.vehicleId) return false;
    const current = resourceForRoute(resources, route, currentDriver.id);
    if (!current.vehicle || !current.vehicle.isActive) return false;
    if (!materialResourceSnapshotMatchesCurrent(
      route,
      current.vehicle,
      currentDriver,
      current.stops,
      current.certifications,
    )) return false;
    const snapshot = approvalSnapshot(
      route,
      current.stops,
      current.vehicle,
      currentDriver,
      current.certifications,
    );
    return snapshotMatchesCurrent(candidate.snapshot, candidate.snapshotHash, snapshot);
  }) ?? null;
}

function currentDriverByRoute(
  routes: Route[],
  drivers: Driver[],
): Map<string, Driver> {
  const activeDriversByVehicle = new Map<string, Driver[]>();
  for (const driver of drivers) {
    if (!driver.isActive || !driver.vehicleId) continue;
    const existing = activeDriversByVehicle.get(driver.vehicleId) ?? [];
    existing.push(driver);
    activeDriversByVehicle.set(driver.vehicleId, existing);
  }
  for (const current of activeDriversByVehicle.values()) {
    current.sort((left, right) => left.id.localeCompare(right.id));
  }
  return new Map(routes.flatMap((route) => {
    const candidates = route.vehicleId
      ? activeDriversByVehicle.get(route.vehicleId) ?? []
      : [];
    const selectedDriverId = isProtectedImportRoute(route)
      ? optimizationDriverIdForRoute(route)
      : null;
    if (isProtectedImportRoute(route) && !selectedDriverId) return [];
    const driver = selectedDriverId
      ? candidates.find((candidate) => candidate.id === selectedDriverId)
      : candidates[0];
    return driver ? [[route.id, driver] as const] : [];
  }));
}

async function summarizeRoutes(
  executor: typeof db | DbTransaction,
  organizationId: string,
  routes: Route[],
  resources: ApprovalSnapshotResources,
): Promise<RoutePlanApprovalSummary[]> {
  const currentRoutes = currentPlanRoutes(routes);
  if (currentRoutes.length === 0) return [];
  const routeIds = currentRoutes.map((route) => route.id);
  const approvals = await executor
    .select()
    .from(routePlanApprovalsTable)
    .where(and(
      eq(routePlanApprovalsTable.organizationId, organizationId),
      inArray(routePlanApprovalsTable.routeId, routeIds),
    ));
  const activeDriversByVehicle = new Map<string, Driver[]>();
  for (const driver of resources.drivers) {
    if (!driver.isActive || !driver.vehicleId) continue;
    const current = activeDriversByVehicle.get(driver.vehicleId) ?? [];
    current.push(driver);
    activeDriversByVehicle.set(driver.vehicleId, current);
  }
  for (const current of activeDriversByVehicle.values()) {
    current.sort((left, right) => left.id.localeCompare(right.id));
  }
  const driverByRoute = currentDriverByRoute(currentRoutes, resources.drivers);
  return currentRoutes.map((route) => {
    const approval = approvalForRoute(route, approvals, resources, activeDriversByVehicle);
    const currentDriverId = driverByRoute.get(route.id)?.id ?? null;
    return {
      routeId: route.id,
      planId: route.planId,
      draftId: route.draftId,
      planRevision: route.planRevision,
      status: route.status,
      vehicleId: route.vehicleId,
      driverId: approval?.driverId ?? currentDriverId,
      approval: {
        approved: approval != null,
        approvedAt: approval?.approvedAt ?? null,
        approvedByUserId: approval?.approvedByUserId ?? null,
      },
    };
  });
}

/**
 * Canonical planner lock order shared with import/reoptimization:
 * advisory route locks, vehicles, drivers, certifications, routes, stops.
 *
 * The initial route/resource reads intentionally do not lock.  They only
 * identify the resource rows to lock before taking route row locks, so a
 * reoptimization transaction (which takes resources before routes) cannot
 * deadlock with approval.
 */
export async function lockApprovalResources(
  tx: DbTransaction,
  organizationId: string,
  routeIds: string[],
  requestedDriverIds: string[],
): Promise<ApprovalSnapshotResources> {
  const sortedRouteIds = uniqueSorted(routeIds);
  for (const routeId of sortedRouteIds) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
    );
  }

  const initialRoutes = sortedRouteIds.length === 0
    ? []
    : await tx
      .select({ id: routesTable.id, vehicleId: routesTable.vehicleId })
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.id, sortedRouteIds),
      ))
      .orderBy(asc(routesTable.id));
  const vehicleIds = uniqueSorted(
    initialRoutes.flatMap((route) => route.vehicleId ? [route.vehicleId] : []),
  );
  const vehicles = vehicleIds.length === 0
    ? []
    : await tx
      .select()
      .from(vehiclesTable)
      .where(and(
        eq(vehiclesTable.organizationId, organizationId),
        inArray(vehiclesTable.id, vehicleIds),
      ))
      .orderBy(asc(vehiclesTable.id))
      .for("update");

  const initialLinkedDrivers = vehicleIds.length === 0
    ? []
    : await tx
      .select({ id: driversTable.id })
      .from(driversTable)
      .where(and(
        eq(driversTable.organizationId, organizationId),
        inArray(driversTable.vehicleId, vehicleIds),
      ))
      .orderBy(asc(driversTable.id));
  const driverIds = uniqueSorted([
    ...requestedDriverIds,
    ...initialLinkedDrivers.map((driver) => driver.id),
  ]);
  const drivers = driverIds.length === 0
    ? []
    : await tx
      .select()
      .from(driversTable)
      .where(and(
        eq(driversTable.organizationId, organizationId),
        inArray(driversTable.id, driverIds),
      ))
      .orderBy(asc(driversTable.id))
      .for("update");
  const certifications = driverIds.length === 0
    ? []
    : await tx
      .select()
      .from(driverCertificationsTable)
      .where(and(
        eq(driverCertificationsTable.organizationId, organizationId),
        inArray(driverCertificationsTable.driverId, driverIds),
      ))
      .orderBy(asc(driverCertificationsTable.id))
      .for("update");

  const routes = sortedRouteIds.length === 0
    ? []
    : await tx
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.id, sortedRouteIds),
      ))
      .orderBy(asc(routesTable.id))
      .for("update");
  const stops = sortedRouteIds.length === 0
    ? []
    : await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.routeId, sortedRouteIds),
      ))
      .orderBy(asc(stopsTable.routeId), asc(stopsTable.id))
      .for("update");
  return { routes, stops, vehicles, drivers, certifications };
}

/**
 * Returns the authoritative current state for a plan.  The route revision and
 * current resource are read together with the approval row; clients must not
 * infer approval from manualReviewRequired/manualReviewedAt.
 */
export async function getRoutePlanApprovalState(
  organizationId: string,
  planId: string,
) {
  return db.transaction(async (tx) => {
    const routeIds = (
      await tx
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.planId, planId),
          ne(routesTable.status, "cancelled"),
        ))
        .orderBy(asc(routesTable.id))
    ).map((route) => route.id);
    if (routeIds.length === 0) {
      const [persistedDraft] = await tx
        .select({ id: planningDraftsTable.id })
        .from(planningDraftsTable)
        .where(and(
          eq(planningDraftsTable.organizationId, organizationId),
          eq(planningDraftsTable.planId, planId),
        ))
        .limit(1);
      if (persistedDraft) {
        return {
          planId,
          protected: true,
          routes: [],
        };
      }
      throw new RoutePlanApprovalError(
        "Route plan not found.",
        404,
        "PLAN_NOT_FOUND",
      );
    }
    const resources = await lockApprovalResources(tx, organizationId, routeIds, []);
    const routes = currentPlanRoutes(
      resources.routes.filter((route) => route.planId === planId),
    );
    if (routes.length !== routeIds.length) {
      throw new RoutePlanApprovalError(
        "Route plan changed while reading approval state.",
        409,
        "STALE_PLAN_REVISION",
      );
    }
    return {
      planId,
      protected: routes.some(isProtectedImportRoute),
      routes: await summarizeRoutes(tx, organizationId, routes, resources),
    };
  });
}

/**
 * Approves one or more exact route versions.  Route, vehicle, and recipient
 * rows are locked before validation and the approval upsert is in that same
 * transaction.  Consequently a dispatch racing a resource change cannot
 * observe an approval for an older recipient.
 */
export async function approveRoutePlan(
  organizationId: string,
  planId: string,
  actorUserId: string,
  requestedRoutes: RoutePlanApprovalInput[],
) {
  const routeIds = uniqueSorted(requestedRoutes.map((route) => route.routeId));
  if (routeIds.length !== requestedRoutes.length) {
    throw new RoutePlanApprovalError(
      "Each route may be approved only once per request.",
      400,
      "ROUTE_NOT_IN_PLAN",
    );
  }
  if (routeIds.length === 0) {
    throw new RoutePlanApprovalError(
      "At least one route must be approved.",
      400,
      "ROUTE_NOT_IN_PLAN",
    );
  }

  return db.transaction(async (tx) => {
    const planRoutes = await tx
      .select({ id: routesTable.id })
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planId, planId),
          ne(routesTable.status, "cancelled"),
      ))
      .orderBy(asc(routesTable.id));
    if (planRoutes.length === 0) {
      throw new RoutePlanApprovalError(
        "Route plan not found.",
        404,
        "PLAN_NOT_FOUND",
      );
    }
    const resources = await lockApprovalResources(
      tx,
      organizationId,
      planRoutes.map((route) => route.id),
      requestedRoutes.map((route) => route.driverId),
    );
    const routes = currentPlanRoutes(
      resources.routes.filter((route) => route.planId === planId),
    );
    const [organization] = await tx
      .select({
        maxDriverOvertimeMin: organizationsTable.maxDriverOvertimeMin,
        allowLateStopsMin: organizationsTable.allowLateStopsMin,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    if (!organization || routes.some((route) => !routePlanningSettingsMatchCurrent(route, organization))) {
      throw new RoutePlanApprovalError(
        "Organisationens arbetstidsinställningar ändrades efter optimeringen; optimera om innan godkännande.",
        409,
        "STALE_RESOURCE_SNAPSHOT",
      );
    }
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const approvableRouteIds = uniqueSorted(
      routes
        .filter(canReviewWorkingRoute)
        .map((route) => route.id),
    );
    if (
      routeIds.length !== approvableRouteIds.length
      || routeIds.some((routeId) => !approvableRouteIds.includes(routeId))
    ) {
      throw new RoutePlanApprovalError(
        "Approval must include exactly the current reviewable working routes in the plan.",
        409,
        "ROUTE_NOT_IN_PLAN",
      );
    }
    const selected = routeIds.map((routeId) => routeById.get(routeId));
    if (selected.some((route): route is undefined => !route)) {
      throw new RoutePlanApprovalError(
        "One or more routes do not belong to this plan.",
        409,
        "ROUTE_NOT_IN_PLAN",
      );
    }
    const selectedRoutes = selected.filter(
      (route): route is NonNullable<typeof route> => route !== undefined,
    );
    if (!selectedRoutes.every((route) => isProtectedImportRoute(route))) {
      throw new RoutePlanApprovalError(
        "Only routes associated with a named planning draft require explicit approval.",
        409,
        "PLAN_NOT_PROTECTED",
      );
    }

    const vehicleIds = uniqueSorted(
      selectedRoutes.flatMap((route) => route.vehicleId ? [route.vehicleId] : []),
    );
    const driverIds = uniqueSorted(requestedRoutes.map((route) => route.driverId));
    const [vehicles, drivers] = await Promise.all([
      vehicleIds.length === 0
        ? Promise.resolve([])
        : tx
          .select()
          .from(vehiclesTable)
          .where(and(
            eq(vehiclesTable.organizationId, organizationId),
            inArray(vehiclesTable.id, vehicleIds),
          ))
          .orderBy(asc(vehiclesTable.id))
          .for("update"),
      tx
        .select()
        .from(driversTable)
        .where(and(
          eq(driversTable.organizationId, organizationId),
          inArray(driversTable.id, driverIds),
        ))
        .orderBy(asc(driversTable.id))
        .for("update"),
    ]);
    const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
    // Do not trust a historical summary after manual route mutations. The
    // approval transaction re-reads the complete plan's stops and verifies
    // every Must stop is currently assigned to a live route.
    const allPlanStops = await tx.select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
      priority: stopsTable.priority,
    }).from(stopsTable).where(and(
      eq(stopsTable.organizationId, organizationId),
      eq(stopsTable.planningPlanId, planId),
    )).for("update");
    const priorityMap = (selectedRoutes[0]?.optimizationPlanningSnapshot as
      { stopPriorities?: Record<string, number> } | null)?.stopPriorities ?? {};
    const currentRouteIds = new Set(routes.map((route) => route.id));
    const mandatoryUnplanned = allPlanStops.filter((stop) =>
      (priorityMap[stop.id] ?? stop.priority ?? 0) === 2 &&
      (!stop.routeId || !currentRouteIds.has(stop.routeId)));
    if (mandatoryUnplanned.length > 0) {
      throw new RoutePlanApprovalError(
        "Planen innehåller ett obligatoriskt stopp som inte kan planeras. Ändra kravet eller resurserna och optimera igen.",
        409,
        "APPROVAL_REQUIRED",
      );
    }

    for (const requested of requestedRoutes) {
      const route = routeById.get(requested.routeId)!;
      if (route.planRevision !== requested.planRevision) {
        throw new RoutePlanApprovalError(
          `Route ${route.id} is stale; current plan revision is ${route.planRevision}.`,
          409,
          "STALE_PLAN_REVISION",
        );
      }
      if (!route.vehicleId) {
        throw new RoutePlanApprovalError(
          `Route ${route.id} has no assigned vehicle.`,
          409,
          "INVALID_RECIPIENT",
        );
      }
      const vehicle = vehicleById.get(route.vehicleId);
      const driver = driverById.get(requested.driverId);
      if (
        !vehicle
        || !vehicle.isActive
        || !driver
        || !driver.isActive
        || driver.vehicleId !== route.vehicleId
      ) {
        throw new RoutePlanApprovalError(
          `The selected driver is no longer an active recipient for route ${route.id}.`,
          409,
          "INVALID_RECIPIENT",
        );
      }
      if (!canReviewWorkingRoute(route)) {
        throw new RoutePlanApprovalError(
          `Route ${route.id} is no longer awaiting planner approval.`,
          409,
          "STALE_PLAN_REVISION",
        );
      }
      const optimizationDriverId = optimizationDriverIdForRoute(route);
      if (!optimizationDriverId || optimizationDriverId !== requested.driverId) {
        throw new RoutePlanApprovalError(
          `Route ${route.id} must retain the driver selected during optimization.`,
          409,
          "INVALID_RECIPIENT",
        );
      }
      const resource = resourceForRoute(resources, route, driver.id);
      if (!resource.vehicle || !resource.driver) {
        throw new RoutePlanApprovalError(
          `The selected driver is no longer an active recipient for route ${route.id}.`,
          409,
          "INVALID_RECIPIENT",
        );
      }
      const snapshot = approvalSnapshot(
        route,
        resource.stops,
        resource.vehicle,
        resource.driver,
        resource.certifications,
      );
      if (!materialResourceSnapshotMatchesCurrent(
        route,
        resource.vehicle,
        resource.driver,
        resource.stops,
        resource.certifications,
      )) {
        throw new RoutePlanApprovalError(
          `Route ${route.id} no longer matches its optimization inputs; reoptimize before approval.`,
          409,
          "STALE_RESOURCE_SNAPSHOT",
        );
      }

      // Approval never alters the outgoing snapshot or completed execution.
      // Validate that the working proposal can preserve outgoing history before
      // accepting it; dispatch repeats this check under its own locks.
      if (route.status === "in_progress") {
        try {
          await assertOutgoingDispatchCompatible(tx, route, resource.stops);
        } catch (error) {
          if (error instanceof PlanningLockError) {
            throw new RoutePlanApprovalError(error.message, 409, "STALE_PLAN_REVISION");
          }
          throw error;
        }
      }
      await tx
        .insert(routePlanApprovalsTable)
        .values({
          organizationId,
          planId,
          routeId: route.id,
          planRevision: requested.planRevision,
          driverId: driver.id,
          vehicleId: vehicle.id,
          approvedByUserId: actorUserId,
          snapshotHash: approvalSnapshotHash(snapshot),
          snapshot,
        })
        .onConflictDoUpdate({
          target: [
            routePlanApprovalsTable.routeId,
            routePlanApprovalsTable.planRevision,
            routePlanApprovalsTable.driverId,
          ],
          set: {
            driverId: driver.id,
            vehicleId: vehicle.id,
            approvedByUserId: actorUserId,
            approvedAt: new Date(),
            snapshotHash: approvalSnapshotHash(snapshot),
            snapshot,
          },
        });
    }

    return {
      planId,
      protected: true,
      routes: await summarizeRoutes(tx, organizationId, routes, resources),
    };
  });
}

/**
 * Dispatch uses this guard only after locking the route in its own
 * transaction.  It intentionally does not consult manualReview fields.
 */
export async function assertProtectedRouteDispatchApproval(
  tx: DbTransaction,
  organizationId: string,
  route: Route,
  resources: ApprovalSnapshotResources,
  driverId: string,
): Promise<void> {
  if (!isProtectedImportRoute(route)) return;
  const [organization] = await tx
    .select({
      maxDriverOvertimeMin: organizationsTable.maxDriverOvertimeMin,
      allowLateStopsMin: organizationsTable.allowLateStopsMin,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId))
    .limit(1);
  if (!organization || !routePlanningSettingsMatchCurrent(route, organization)) {
    throw new RoutePlanApprovalError(
      "Organisationens arbetstidsinställningar ändrades efter optimeringen; optimera om innan dispatch.",
      409,
      "STALE_RESOURCE_SNAPSHOT",
    );
  }
  const optimizationDriverId = optimizationDriverIdForRoute(route);
  if (!optimizationDriverId || optimizationDriverId !== driverId) {
    throw new RoutePlanApprovalError(
      "The protected route must retain the driver selected during optimization.",
      409,
      "INVALID_RECIPIENT",
    );
  }
  const resource = resourceForRoute(resources, route, driverId);
  if (
    !route.vehicleId
    || !resource.vehicle
    || !resource.vehicle.isActive
    || !resource.driver
  ) {
    throw new RoutePlanApprovalError(
      "The protected route recipient or vehicle is no longer active and linked.",
      409,
      "INVALID_RECIPIENT",
    );
  }
  const snapshot = approvalSnapshot(
    route,
    resource.stops,
    resource.vehicle,
    resource.driver,
    resource.certifications,
  );
  if (!materialResourceSnapshotMatchesCurrent(
    route,
    resource.vehicle,
    resource.driver,
    resource.stops,
    resource.certifications,
  )) {
    throw new RoutePlanApprovalError(
      "The route resources changed after optimization; reoptimize before dispatch approval.",
      409,
      "STALE_RESOURCE_SNAPSHOT",
    );
  }
  const [approval] = await tx
    .select()
    .from(routePlanApprovalsTable)
    .where(and(
      eq(routePlanApprovalsTable.organizationId, organizationId),
      eq(routePlanApprovalsTable.planId, route.planId),
      eq(routePlanApprovalsTable.routeId, route.id),
      eq(routePlanApprovalsTable.planRevision, route.planRevision),
      eq(routePlanApprovalsTable.driverId, driverId),
      eq(routePlanApprovalsTable.vehicleId, route.vehicleId),
    ))
    .limit(1);
  if (!approval) {
    throw new RoutePlanApprovalError(
      "The current route version and exact recipient require explicit planner approval before dispatch.",
      409,
      "APPROVAL_REQUIRED",
    );
  }
  if (!snapshotMatchesCurrent(approval.snapshot, approval.snapshotHash, snapshot)) {
    throw new RoutePlanApprovalError(
      "The route, stop requirements, vehicle, driver, or certifications changed after approval.",
      409,
      "STALE_RESOURCE_SNAPSHOT",
    );
  }
}