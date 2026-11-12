import { Router, type IRouter } from "express";
import { readOptimizationJob, startOptimizationJob } from "../services/durable-optimization-job";
import { withOptimizationEnvironment, DEFAULT_ENV_CTX } from "../services/alns/types";
import { eq, and, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  db,
  vehiclesTable,
  stopsTable,
  routesTable,
  notificationsTable,
  driversTable,
  driverPreferencesTable,
  driverCertificationsTable,
  routePlanApprovalsTable,
  organizationsTable,
} from "@workspace/db";
import { OptimizeRoutesBody } from "@workspace/api-zod";
import {
  assertVehicleEligibleForFieldService,
  checkFieldServiceEligibility,
  fieldServiceRequirementsFromStop,
} from "../services/field-service";
import {
  applyFieldServiceEligibilityToVehicles,
  INCOMPATIBLE_TECHNICIAN_REASON,
} from "../services/field-service-policy";
import { handleError } from "../lib/errors";
import { assertOrgScope } from "../middleware/auth";
import { lockAndValidateReoptimizationSnapshot } from "../services/reoptimization-lock-service";
import crypto from "crypto";
import { z } from "zod";
import { checkOptimizationUsage, recordUsage } from "../services/usage";
import { getUsageContext } from "../services/usage-context";
import {
  estimateDurationMinPredictive,
  getTrafficDescription,
} from "../services/eta";
import {
  haversineDistance,
  estimateCo2,
  cachedDistance,
  getDistanceCache,
  type ALNSNode,
  type ALNSVehicle,
  type ALNSRoute,
  type ALNSConfig,
  type ALNSDriverConstraints,
  type OptimizationWeights,
  DEFAULT_WEIGHTS,
  type ClusteredOptimizationProgress,
  type EnvironmentContext,
  type OptimizationPerformance,
  explainGeographicRouteOverlap,
  policyToALNSConfig,
  resolveOptimizationPolicy,
} from "../services/alns";
import {
  optimizeWithCanonicalPlanningLocks as optimizeWithALNS,
  reoptimizeWithCanonicalPlanningLocks as reoptimizeAffectedRoutes,
  canonicalLockContext, lockCanonicalOptimizationContext, assertCanonicalRouteResult,
  loadCanonicalLockInputs,
} from "../services/planner-lock-canonical-optimizer";
import { applyDriverRoutingProfile } from "../services/driver-routing-profile";
import { materializeUnplannedCustomerStopSnapshots } from "../services/stop-service";
import {
  organizationPlanningPolicy,
  effectivePlanningPolicy,
  withOrganizationPlanningPolicy,
} from "../services/planning-policy";
import { payloadIdentityHash } from "../services/planning-draft-service";
import { getCachedOsrmDistance } from "../services/osrm";
import {
  getWeatherForLocation,
  getWeatherSeverity,
} from "../services/weather-service";
import {
  evaluateRouteWorkday,
  workdayInfeasibilityMessage,
} from "../services/route-workday";
import {
  classifyUnplannedNodes,
  itineraryForNodes,
  normalizePlanningInputs,
  optimizationEvidenceForConfig,
  planningWeights,
  refreshedPlanningSummary,
  toAlnsNode,
  verifiedDepotSnapshot,
  type PlanningInputsV1,
  type StopRow,
} from "../services/import-route-workflow";
import {
  isProtectedImportRoute,
  materialResourceSnapshot,
  materialResourceSnapshotHash,
} from "../services/route-plan-approval-service";
import { broadcast } from "../ws";
import {
  ContinuousOptimizer,
  getActiveOptimizer,
  setActiveOptimizer,
  removeActiveOptimizer,
} from "../services/continuous-optimizer";

function assertPersistableWorkday(
  evaluation: ReturnType<typeof evaluateRouteWorkday>,
  vehicleName: string,
  constraints?: ALNSDriverConstraints,
): void {
  if (evaluation.feasible) return;
  const error = new Error(workdayInfeasibilityMessage(evaluation, {
    vehicleName,
    breakStartTime: constraints?.breakStartTime,
    breakEndTime: constraints?.breakEndTime,
  })) as Error & { statusCode: number };
  error.statusCode = 409;
  throw error;
}

interface OptimizationJob {
  [key: string]: unknown;
  id: string;
  organizationId: string;
  status: "running" | "complete" | "error";
  progress: ClusteredOptimizationProgress | null;
  result: unknown;
  error: string | null;
  createdAt: number;
  stopCount: number;
  vehicleCount: number;
}

function generateTrackingCodeRaw(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.randomBytes(4);
  let code = "RT-";
  for (let i = 0; i < 4; i++) {
    code += chars[random[i] % chars.length];
  }
  return code;
}

function generateTrackingCodeBatch(count: number): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(generateTrackingCodeRaw());
  }
  return [...codes];
}

async function generateUniqueTrackingCode(): Promise<string> {
  const MAX_RETRIES = 10;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateTrackingCodeRaw();
    const existing = await db
      .select({ id: stopsTable.id })
      .from(stopsTable)
      .where(eq(stopsTable.trackingCode, code))
      .limit(1);
    if (existing.length === 0) return code;
  }
  const fallback = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `RT-${fallback}`;
}

const EMISSION_PROFILES: Record<
  string,
  { gCo2PerKm: number; loadFactor: number }
> = {
  fossil: { gCo2PerKm: 210, loadFactor: 1.15 },
  electric: { gCo2PerKm: 50, loadFactor: 1.05 },
};

function estimateDurationMin(
  distanceKm: number,
  departureTime?: Date,
  lat1?: number,
  lon1?: number,
  lat2?: number,
  lon2?: number,
): number {
  if (lat1 != null && lon1 != null && lat2 != null && lon2 != null) {
    const osrm = getCachedOsrmDistance(lat1, lon1, lat2, lon2);
    if (osrm) return osrm.durationMin;
  }
  if (departureTime) {
    return estimateDurationMinPredictive(distanceKm, departureTime);
  }
  const avgSpeedKmH = 35;
  return (distanceKm / avgSpeedKmH) * 60;
}

const OptimizationWeightsSchema = z.object({
  distanceWeight: z.number().min(0).max(1).optional().default(0.45),
  co2Weight: z.number().min(0).max(1).optional().default(0.25),
  etaPrecisionWeight: z.number().min(0).max(1).optional().default(0.15),
  driverHappinessWeight: z.number().min(0).max(1).optional().default(0.15),
  geographicCohesionWeight: z.number().min(0).max(1).optional().default(0),
});

function normalizeWeights(w: OptimizationWeights): OptimizationWeights {
  const sum =
    w.distanceWeight +
    w.co2Weight +
    w.etaPrecisionWeight +
    w.driverHappinessWeight +
    w.geographicCohesionWeight;
  if (sum === 0)
    return {
      distanceWeight: 0.45,
      co2Weight: 0.25,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    };
  return {
    distanceWeight: w.distanceWeight / sum,
    co2Weight: w.co2Weight / sum,
    etaPrecisionWeight: w.etaPrecisionWeight / sum,
    driverHappinessWeight: w.driverHappinessWeight / sum,
    geographicCohesionWeight: w.geographicCohesionWeight / sum,
  };
}

export function optimizationStartTimeForRequest(
  requestedDate: unknown,
  fallback = new Date(),
): Date {
  return typeof requestedDate === "string" ? new Date(requestedDate) : fallback;
}

const ExtendedOptimizeBody = OptimizeRoutesBody.extend({
  optimizationWeights: OptimizationWeightsSchema.optional(),
  timeBudgetMs: z.number().min(1000).max(120000).optional(),
  async: z.boolean().optional().default(false),
  vehicleDistributionMode: z
    .enum(["minimize", "balance"])
    .optional()
    .default("minimize"),
  date: z.string().optional(),
  planningInputs: z.unknown().optional(),
});

function createOptimizationTiming(
  inputLoadMs: number,
  weatherMs: number,
  performance: OptimizationPerformance,
  persistenceMs: number,
  totalMs: number,
  policy: ReturnType<typeof resolveOptimizationPolicy>,
) {
  return {
    inputLoadMs,
    weatherMs,
    distanceMatrixMs: performance.distanceMatrixMs,
    clusteringMs: performance.clusteringMs,
    alnsSearchMs: performance.alnsSearchMs,
    mergingMs: performance.mergingMs,
    searchMs: performance.searchMs,
    persistenceMs,
    totalMs,
    timeBudgetMs: policy.timeLimitMs,
    profile: policy.profile,
    distanceSource: performance.distanceSource,
    iterations: performance.runStats?.iterations ?? 0,
    improvements: performance.runStats?.improvements ?? 0,
    localSearchMs:
      performance.runStats && "localSearchMs" in performance.runStats
        ? performance.runStats.localSearchMs
        : 0,
    stopReason: performance.runStats?.stopReason ?? "max_iterations",
    totalClusters:
      performance.runStats && "totalClusters" in performance.runStats
        ? performance.runStats.totalClusters
        : 1,
    optimizedClusters:
      performance.runStats && "optimizedClusters" in performance.runStats
        ? performance.runStats.optimizedClusters
        : 1,
    clusterStopReasons:
      performance.runStats && "clusterStopReasons" in performance.runStats
        ? performance.runStats.clusterStopReasons
        : undefined,
  };
}

const ReoptimizeBody = z.object({
  organizationId: z.guid(),
  routeIds: z.array(z.guid()).optional(),
  reason: z.string().optional(),
  depotLatitude: z.number().optional(),
  depotLongitude: z.number().optional(),
  disruptionType: z
    .enum([
      "traffic_delay",
      "stop_added",
      "stop_cancelled",
      "vehicle_breakdown",
    ])
    .optional(),
  affectedStopId: z.guid().optional(),
  planRevision: z.number().int().nonnegative().optional(),
  routeRevisions: z
    .array(
      z.object({
        routeId: z.guid(),
        planRevision: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const router: IRouter = Router();
/**
 * Convert DB stop rows into ALNS nodes.
 *
 * Pickup & Delivery stops are represented as a SINGLE composite node whose
 * pickup coordinates are embedded via `pickupLat/pickupLon/pickupServiceMin`.
 * `evaluateRoute` in cost.ts automatically routes to the pickup first, then
 * the delivery — so precedence and same-vehicle constraints are both satisfied
 * without any post-processing, and cargo weight is counted exactly once.
 */
function expandStopsToNodes(
  stops: StopRow[],
  planningInputs: PlanningInputsV1 = normalizePlanningInputs(null),
): ALNSNode[] {
  return stops.map((stop) => toAlnsNode(stop, planningInputs));
}

export function persistOptimizationResult(...args: Parameters<typeof persistOptimizationResultCore>) {
  return withOptimizationEnvironment(args[0].environment ?? DEFAULT_ENV_CTX, () => persistOptimizationResultCore(...args));
}

async function persistOptimizationResultCore(
  result: { routes: ALNSRoute[]; unassigned: ALNSNode[]; costBreakdown: any; environment?: EnvironmentContext },
  vehicles: any[],
  drivers: any[],
  stops: StopRow[],
  routingVehicles: ALNSVehicle[],
  organizationId: string,
  depotLatitude: number,
  depotLongitude: number,
  weights: OptimizationWeights,
  driverConstraints: ALNSDriverConstraints[],
  planningInputs: PlanningInputsV1,
  optimizationEvidence: import("@workspace/db").OptimizationEvidence,
  optimizationStartTime: Date,
  reqDate?: string,
  globallyIneligibleNodeIds?: Set<string>,
  unassignedFieldServiceReasons?: Map<
    string,
    { reasonCodes: string[]; details: string[] }
  >,
) {
  const optimizedRoutes: Array<{
    vehicleId: string;
    routeId: string;
    planId: string;
    planRevision: number;
    stops: Array<{
      stopId: string;
      sequenceOrder: number;
      estimatedArrival: string;
      distanceFromPreviousKm: number;
      isChargingStop?: boolean;
      chargingStationName?: string;
    }>;
    distanceKm: number;
    durationMin: number;
    co2EmissionsKg: number;
    chargingStopsInserted: number;
    geographicOverlapExplanation?: NonNullable<
      typeof routesTable.$inferSelect.geographicOverlapExplanation
    >;
    depotSnapshot: typeof routesTable.$inferSelect.depotSnapshot;
    workdayTimeline: NonNullable<
      typeof routesTable.$inferSelect.workdayTimeline
    >;
    workdaySummary: NonNullable<typeof routesTable.$inferSelect.workdaySummary>;
  }> = [];
  const planId = crypto.randomUUID();
  const routeDate = reqDate
    ? new Date(reqDate)
    : new Date(optimizationStartTime);
  let totalDistanceKm = 0;
  let totalDurationMin = 0;
  const routingVehicleMap = new Map(
    routingVehicles.map((vehicle) => [vehicle.id, vehicle]),
  );
  const driverConstraintsMap = new Map(
    driverConstraints.map((constraints) => [
      constraints.vehicleId,
      constraints,
    ]),
  );
  const driverByVehicleId = new Map(
    drivers
      .filter((driver) => driver.vehicleId)
      .map((driver) => [driver.vehicleId, driver]),
  );
  const overlapExplanations = explainGeographicRouteOverlap(
    result.routes,
    routingVehicles,
    depotLatitude,
    depotLongitude,
    optimizationStartTime,
    driverConstraints,
  );
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const unplannedNodes = [
    ...result.unassigned.filter((node) => !node.isChargingStation),
    ...(globallyIneligibleNodeIds
      ? stops
          .filter((stop) => globallyIneligibleNodeIds.has(stop.id))
          .map((stop) => toAlnsNode(stop, planningInputs))
      : []),
  ].filter(
    (node, index, nodes) =>
      nodes.findIndex((candidate) => candidate.id === node.id) === index,
  );
  const diagnosticResources = vehicles.flatMap((vehicle) => {
    const driver = drivers.find(
      (candidate) => candidate.vehicleId === vehicle.id,
    );
    const routingVehicle = routingVehicleMap.get(vehicle.id);
    return driver && routingVehicle
      ? [{ vehicle, driver, routingVehicle }]
      : [];
  });
  const diagnostics = classifyUnplannedNodes(
    unplannedNodes,
    stopById,
    diagnosticResources,
    depotLatitude,
    depotLongitude,
    optimizationStartTime,
  ).map((diagnostic) =>
    diagnostic.code === "OVERTIME_ALLOWANCE_EXCEEDED"
      ? {
          ...diagnostic,
          code: "WORKING_TIME_OR_TIME_WINDOW_EXCEEDED" as const,
        }
      : diagnostic,
  );
  const diagnosticByStopId = new Map(
    diagnostics.map((diagnostic) => [diagnostic.stopId, diagnostic]),
  );
  const selectedPairValues = drivers
    .filter(
      (driver) =>
        driver.vehicleId &&
        vehicles.some((vehicle) => vehicle.id === driver.vehicleId),
    )
    .map((driver) => `${driver.vehicleId}:${driver.id}`);
  const usedPairValues = result.routes
    .filter((route) => route.nodes.some((node) => !node.isChargingStation))
    .map((route) => {
      const driver = driverByVehicleId.get(route.vehicleId);
      return driver ? `${route.vehicleId}:${driver.id}` : null;
    })
    .filter((pairValue): pairValue is string => pairValue != null);
  const unusedPairValues = selectedPairValues
    .filter((pairValue) => !usedPairValues.includes(pairValue))
    .map((pairValue) => ({
      pairValue,
      reason:
        "Kunde inte få ett kundstopp utan att bryta hårda planeringsvillkor.",
    }));
  const planningSummary = refreshedPlanningSummary(
    { selectedPairValues, usedPairValues, unusedPairValues },
    planningInputs,
    unplannedNodes,
    new Map(
      [...diagnosticByStopId].map(([stopId, diagnostic]) => [
        stopId,
        diagnostic.detail,
      ]),
    ),
    optimizationEvidence,
  );

  return db.transaction(async (tx) => {
    const lockContext = await lockCanonicalOptimizationContext(tx, result);
    if (lockContext && (
      vehicles.some(vehicle => JSON.stringify(vehicle) !== JSON.stringify(lockContext.vehicles.find(row => row.id === vehicle.id)))
      || drivers.some(driver => JSON.stringify(driver) !== JSON.stringify(lockContext.drivers?.find(row => row.id === driver.id)))
      || stops.some(stop => JSON.stringify(stop) !== JSON.stringify(lockContext.stops.find(row => row.id === stop.id)))
    )) {
      const conflict = new Error("Optimeringsunderlaget ändrades innan sökningen kunde starta. Ladda om planen.") as Error & { statusCode: number };
      conflict.statusCode = 409;
      throw conflict;
    }
    const [organization] = await tx
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    const persistedStopRows = stops.length > 0
      ? await tx
        .select({
          id: stopsTable.id,
          customerId: stopsTable.customerId,
          planningDate: stopsTable.planningDate,
          unavailablePeriods: stopsTable.unavailablePeriods,
          routeId: stopsTable.routeId,
          archivedAt: stopsTable.archivedAt,
        })
        .from(stopsTable)
        .where(and(
          eq(stopsTable.organizationId, organizationId),
          inArray(stopsTable.id, stops.map((stop) => stop.id)),
        ))
        .for("update")
      : [];
    const persistedStopById = new Map(persistedStopRows.map((stop) => [stop.id, stop]));
    for (const sourceStop of stops) {
      const currentStop = persistedStopById.get(sourceStop.id);
      if (
        !currentStop
        || currentStop.archivedAt !== null
        || currentStop.customerId !== sourceStop.customerId
        || currentStop.routeId !== sourceStop.routeId
        || currentStop.planningDate?.getTime() !== sourceStop.planningDate?.getTime()
        || JSON.stringify(currentStop.unavailablePeriods ?? [])
          !== JSON.stringify(sourceStop.unavailablePeriods ?? [])
      ) {
        const conflict = new Error(
          "A stop changed while customer delivery-unavailable snapshots were being materialized. Optimize again.",
        ) as Error & { statusCode: number };
        conflict.statusCode = 409;
        throw conflict;
      }
    }
    for (const alnsRoute of result.routes) {
      if (alnsRoute.nodes.length === 0) continue;
      const sourceRoute = lockContext?.routes.find(route => route.id === alnsRoute.sourceRouteId);
      if (alnsRoute.optimizationFrozen) {
        if (!sourceRoute?.optimizationFrozen || !sourceRoute.workdayTimeline || !sourceRoute.workdaySummary) {
          throw new Error("En fryst rutt saknar sitt kanoniska låsunderlag.");
        }
        // No stop, itinerary, clock, depot, pair, revision or approval writes.
        totalDistanceKm += sourceRoute.totalDistanceKm ?? 0;
        totalDurationMin += sourceRoute.totalDurationMin ?? 0;
        optimizedRoutes.push({
          vehicleId: alnsRoute.vehicleId, routeId: sourceRoute.id, planId: sourceRoute.planId,
          planRevision: sourceRoute.planRevision, stops: sourceRoute.plannerItinerary ?? [],
          distanceKm: sourceRoute.totalDistanceKm ?? 0, durationMin: sourceRoute.totalDurationMin ?? 0,
          co2EmissionsKg: sourceRoute.co2EmissionsKg ?? 0,
          chargingStopsInserted: sourceRoute.plannerItinerary?.filter(entry => entry.isChargingStop).length ?? 0,
          depotSnapshot: sourceRoute.depotSnapshot, workdayTimeline: sourceRoute.workdayTimeline,
          workdaySummary: sourceRoute.workdaySummary,
        });
        continue;
      }

      const vehicle = vehicles.find((v: any) => v.id === alnsRoute.vehicleId);
      if (!vehicle) continue;
      const routingVehicle = routingVehicleMap.get(alnsRoute.vehicleId);
      if (!routingVehicle) continue;
      const constraints = driverConstraintsMap.get(alnsRoute.vehicleId);

      const route = sourceRoute ?? (await tx
        .insert(routesTable)
        .values({
          planId,
          organizationId,
          vehicleId: vehicle.id,
          name: `${vehicle.name} - Optimized`,
          date: routeDate,
          status: "optimized",
          totalStops: alnsRoute.nodes.filter((n) => !n.isChargingStation)
            .length,
          optimizationPlanningSnapshot: planningInputs,
          optimizationPlanningSnapshotHash: payloadIdentityHash(planningInputs),
          planningSummary,
        })
        .returning())[0];

      let routeDistance = 0;
      let routeDuration = 0;
      const optimizedStops: Array<{
        stopId: string;
        sequenceOrder: number;
        estimatedArrival: string;
        distanceFromPreviousKm: number;
        isChargingStop?: boolean;
        chargingStationName?: string;
      }> = [];
      const effectiveRouteStart = new Date(optimizationStartTime);
      if (constraints?.preferredStartTime) {
        const [hours, minutes] = constraints.preferredStartTime
          .split(":")
          .map(Number);
        effectiveRouteStart.setHours(hours, minutes, 0, 0);
      }
      let currentTime = new Date(effectiveRouteStart);
      let seqOrder = 0;
      let prevLat = routingVehicle.startLatitude ?? depotLatitude;
      let prevLon = routingVehicle.startLongitude ?? depotLongitude;
      let breakTaken = false;
      const applyScheduledBreak = (intervalMinutes: number) => {
        if (
          breakTaken ||
          !constraints?.breakStartTime ||
          !constraints.breakEndTime
        )
          return;
        const [startHours, startMinutes] = constraints.breakStartTime
          .split(":")
          .map(Number);
        const [endHours, endMinutes] = constraints.breakEndTime
          .split(":")
          .map(Number);
        const breakStart = new Date(effectiveRouteStart);
        breakStart.setHours(startHours, startMinutes, 0, 0);
        const breakEnd = new Date(effectiveRouteStart);
        breakEnd.setHours(endHours, endMinutes, 0, 0);
        const intervalEnd = new Date(
          currentTime.getTime() + intervalMinutes * 60000,
        );
        if (currentTime < breakEnd && intervalEnd > breakStart) {
          currentTime = new Date(
            currentTime.getTime() + (breakEnd.getTime() - breakStart.getTime()),
          );
          breakTaken = true;
        }
      };
      const tempoMultiplier = routingVehicle.tempoMultiplier ?? 1;

      // Count only real DB stops (exclude charging stations)
      const realDeliveryNodes = alnsRoute.nodes.filter(
        (n) => !n.isChargingStation,
      );
      const trackingCodes = generateTrackingCodeBatch(realDeliveryNodes.length);
      let codeIdx = 0;
      const stopUpdates: Array<{
        stopId: string;
        routeId: string;
        seqOrder: number;
        trackingCode: string;
      }> = [];

      for (const node of alnsRoute.nodes) {
        // For P&D composite nodes: route to pickup first, then delivery.
        // This mirrors what evaluateRoute does in cost.ts so timing/distance are consistent.
        if (node.pickupLat != null && node.pickupLon != null) {
          const pickupDist = cachedDistance(
            prevLat,
            prevLon,
            node.pickupLat,
            node.pickupLon,
          );
          const pickupDur =
            estimateDurationMin(
              pickupDist,
              currentTime,
              prevLat,
              prevLon,
              node.pickupLat,
              node.pickupLon,
            ) * tempoMultiplier;
          applyScheduledBreak(pickupDur);
          routeDistance += pickupDist;
          const pickupArrival = new Date(
            currentTime.getTime() + pickupDur * 60000,
          );
          currentTime = pickupArrival;
          const pickupServiceMin =
            node.pickupServiceMin ?? node.serviceDurationMin;
          applyScheduledBreak(pickupServiceMin);
          currentTime = new Date(
            currentTime.getTime() + pickupServiceMin * 60000,
          );
          prevLat = node.pickupLat;
          prevLon = node.pickupLon;
        }

        const dist = cachedDistance(
          prevLat,
          prevLon,
          node.latitude,
          node.longitude,
        );
        const dur =
          estimateDurationMin(
            dist,
            currentTime,
            prevLat,
            prevLon,
            node.latitude,
            node.longitude,
          ) * tempoMultiplier;
        applyScheduledBreak(dur);

        routeDistance += dist;
        const arrivalTime = new Date(currentTime.getTime() + dur * 60000);

        seqOrder++;

        if (node.isChargingStation) {
          const chargeDur = node.chargingDurationMin ?? 30;
          optimizedStops.push({
            stopId: node.id,
            sequenceOrder: seqOrder,
            estimatedArrival: arrivalTime.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
            isChargingStop: true,
            chargingStationName: node.chargingStationName,
          });

          currentTime = arrivalTime;
          applyScheduledBreak(chargeDur);
          currentTime = new Date(currentTime.getTime() + chargeDur * 60000);
        } else {
          const effectiveStart =
            node.timeWindowStart &&
            node.timeWindowStart.getTime() > arrivalTime.getTime()
              ? node.timeWindowStart
              : arrivalTime;

          stopUpdates.push({
            stopId: node.id,
            routeId: route.id,
            seqOrder,
            trackingCode: trackingCodes[codeIdx++],
          });

          optimizedStops.push({
            stopId: node.id,
            sequenceOrder: seqOrder,
            estimatedArrival: effectiveStart.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
          });

          currentTime = new Date(effectiveStart);
          applyScheduledBreak(node.serviceDurationMin);
          currentTime = new Date(
            currentTime.getTime() + node.serviceDurationMin * 60000,
          );
        }

        prevLat = node.latitude;
        prevLon = node.longitude;
      }

      const endLat =
        routingVehicle.endLatitude ??
        routingVehicle.startLatitude ??
        depotLatitude;
      const endLon =
        routingVehicle.endLongitude ??
        routingVehicle.startLongitude ??
        depotLongitude;
      const returnDistance = cachedDistance(prevLat, prevLon, endLat, endLon);
      const returnDuration =
        estimateDurationMin(
          returnDistance,
          currentTime,
          prevLat,
          prevLon,
          endLat,
          endLon,
        ) * tempoMultiplier;
      applyScheduledBreak(returnDuration);
      routeDistance += returnDistance;
      currentTime = new Date(currentTime.getTime() + returnDuration * 60000);
      routeDuration =
        (currentTime.getTime() - effectiveRouteStart.getTime()) / 60000;
      // Persist the same explicit workday clock used for review/audit. The
      // itinerary remains stop-only so existing driver clients stay compatible.
      const workday = evaluateRouteWorkday(
        alnsRoute.nodes,
        routingVehicle,
        depotLatitude,
        depotLongitude,
        optimizationStartTime,
        constraints,
      );
      assertPersistableWorkday(workday, vehicle.name, constraints);
      const scheduledAtByStopId = new Map<string, string>();
      for (const event of workday.events) {
        if (
          event.stopId &&
          (event.type === "service" || event.type === "charging")
        ) {
          scheduledAtByStopId.set(event.stopId, event.startAt);
        }
      }
      for (const stop of optimizedStops) {
        stop.estimatedArrival =
          scheduledAtByStopId.get(stop.stopId) ?? stop.estimatedArrival;
      }
      const depotSnapshot = sourceRoute?.depotSnapshot ?? verifiedDepotSnapshot(organization);

      for (const u of stopUpdates) {
        const sourceStop = stopById.get(u.stopId);
        const [claimed] = await tx
          .update(stopsTable)
          .set({
            routeId: u.routeId,
            sequenceOrder: u.seqOrder,
            trackingCode: u.trackingCode,
            planningPlanId: route.planId,
            ...(sourceStop?.planningDate == null ? { planningDate: routeDate } : {}),
            unplannedReason: null,
          })
          .where(
            and(
              eq(stopsTable.id, u.stopId),
              eq(stopsTable.organizationId, organizationId),
              sourceStop?.routeId === route.id
                ? eq(stopsTable.routeId, route.id)
                : isNull(stopsTable.routeId),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!claimed) {
          throw new Error(
            "Ett stopp tilldelades av någon annan medan planen sparades. Försök optimera igen.",
          );
        }
      }

      const driver = driverByVehicleId.get(vehicle.id);
      if (driver) {
        const snapshotStops = stopUpdates
          .map((update) => {
            const stop = stops.find(
              (candidate) => candidate.id === update.stopId,
            );
            return stop
              ? { ...stop, routeId: route.id, sequenceOrder: update.seqOrder }
              : null;
          })
          .filter((stop): stop is NonNullable<typeof stop> => stop != null);
        const certifications = await tx
          .select()
          .from(driverCertificationsTable)
          .where(
            and(
              eq(driverCertificationsTable.organizationId, organizationId),
              eq(driverCertificationsTable.driverId, driver.id),
            ),
          )
          .orderBy(driverCertificationsTable.id);
        const optimizationSnapshot = materialResourceSnapshot(
          vehicle,
          driver,
          snapshotStops,
          certifications,
        );
        const optimizationSnapshotHash = materialResourceSnapshotHash(
          vehicle,
          driver,
          snapshotStops,
          certifications,
        );
        // The route update below is the same transaction as stop assignment, so
        // this baseline represents the exact inputs that produced the plan.
        const [savedRouteWithSnapshot] = await tx
          .update(routesTable)
          .set({
            optimizationResourceSnapshot: optimizationSnapshot,
            optimizationResourceSnapshotHash: optimizationSnapshotHash,
          })
          .where(eq(routesTable.id, route.id))
          .returning({ id: routesTable.id });
        if (!savedRouteWithSnapshot) {
          throw new Error("Ruttens optimeringsunderlag kunde inte sparas.");
        }
      }

      const co2 = estimateCo2(
        workday.totalDistanceKm,
        vehicle.vehicleType,
        alnsRoute.totalWeight,
        routingVehicle.capacityKg,
      );
      if (sourceRoute && lockContext) {
        assertCanonicalRouteResult(lockContext, sourceRoute, stopUpdates.map(update => ({
          ...stopById.get(update.stopId)!, routeId: route.id, sequenceOrder: update.seqOrder,
        })), workday.events);
        await tx.delete(routePlanApprovalsTable).where(and(
          eq(routePlanApprovalsTable.organizationId, organizationId), eq(routePlanApprovalsTable.routeId, route.id),
        ));
      }

      const [savedRoute] = await tx
        .update(routesTable)
        .set({
          totalDistanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
          totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
          co2EmissionsKg: Math.round(co2 * 100) / 100,
          plannerItinerary: optimizedStops,
          depotSnapshot,
          optimizationPlanningSnapshot: planningInputs,
          optimizationPlanningSnapshotHash: payloadIdentityHash(planningInputs),
          planningSummary,
          workdayTimeline: workday.events,
          workdaySummary: workday.summary,
          geographicOverlapExplanation:
            overlapExplanations.get(vehicle.id) ?? null,
          planRevision: sql`${routesTable.planRevision} + 1`,
          manualReviewedAt: null,
          handoffStatus: "pending",
          handoffVersion: null,
          handoffDriverId: null,
          sentAt: null,
          receivedAt: null,
          openedAt: null,
          acceptedAt: null,
          rejectedAt: null,
          rejectionReason: null,
        })
        .where(and(eq(routesTable.id, route.id), eq(routesTable.planRevision, route.planRevision)))
        .returning({ planRevision: routesTable.planRevision });
      if (!savedRoute) throw new Error("Planversionen ändrades innan optimeringen kunde sparas.");

      totalDistanceKm += workday.totalDistanceKm;
      totalDurationMin += workday.summary.totalMin;

      const chargingCount = alnsRoute.nodes.filter(
        (n) => n.isChargingStation,
      ).length;

      optimizedRoutes.push({
        vehicleId: vehicle.id,
        routeId: route.id,
        planId: route.planId,
        planRevision: savedRoute.planRevision,
        stops: optimizedStops,
        distanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
        durationMin: Math.round(workday.summary.totalMin * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        chargingStopsInserted: chargingCount,
        geographicOverlapExplanation: overlapExplanations.get(vehicle.id),
        depotSnapshot,
        workdayTimeline: workday.events,
        workdaySummary: workday.summary,
      });
    }

    // Combine ALNS unassigned + globally ineligible stops
    const alnsUnassignedIds = result.unassigned.map((n) => n.id);
    const ineligibleIds = globallyIneligibleNodeIds
      ? [...globallyIneligibleNodeIds]
      : [];
    const allUnassignedIds = [
      ...new Set([...alnsUnassignedIds, ...ineligibleIds]),
    ];

    // Build per-stop reason detail for the response.
    const unassignedReasonDetails = allUnassignedIds.map((stopId) => {
      const diagnostic = diagnosticByStopId.get(stopId);
      if (diagnostic) {
        return {
          stopId,
          reasonCodes: [diagnostic.code],
          details: [diagnostic.detail],
        };
      }
      const fsReason = unassignedFieldServiceReasons?.get(stopId);
      if (fsReason) {
        return {
          stopId,
          reasonCodes: fsReason.reasonCodes,
          details: fsReason.details,
        };
      }
      return {
        stopId,
        reasonCodes: ["WORKING_TIME_OR_TIME_WINDOW_EXCEEDED"],
        details: [
          "Stoppet kan inte planeras inom valda resurser och hårda arbetstidsvillkor.",
        ],
      };
    });
    for (const reason of unassignedReasonDetails) {
      const sourceStop = stopById.get(reason.stopId);
      await tx
        .update(stopsTable)
        .set({
          planningPlanId: planId,
          ...(sourceStop?.planningDate == null ? { planningDate: routeDate } : {}),
          unplannedReason: reason.details.join(" "),
        })
        .where(
          and(
            eq(stopsTable.id, reason.stopId),
            eq(stopsTable.organizationId, organizationId),
            isNull(stopsTable.routeId),
          ),
        );
    }

    return {
      planId,
      routes: optimizedRoutes,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalDurationMin: Math.round(totalDurationMin * 100) / 100,
      unassignedStopIds: allUnassignedIds,
      unassignedReasons: unassignedReasonDetails,
      trafficCondition: getTrafficDescription(routeDate),
      etaModel: "predictive",
      optimizer: "alns",
      optimizationWeights: weights,
      optimizationEvidence,
      driverConstraintsApplied: driverConstraints.map((dc) => ({
        vehicleId: dc.vehicleId,
        driverName: dc.driverName,
        maxHours: dc.maxDrivingHoursPerDay,
        avoidNight: dc.avoidNightDriving,
        preferredWindow: `${dc.preferredStartTime.slice(0, 5)} - ${dc.preferredEndTime.slice(0, 5)}`,
      })),
      costBreakdown: {
        totalDistanceKm:
          Math.round(result.costBreakdown.totalDistanceKm * 100) / 100,
        totalCo2Kg: Math.round(result.costBreakdown.totalCo2Kg * 100) / 100,
        totalTimeWindowSlackMin:
          Math.round(result.costBreakdown.totalTimeWindowSlackMin * 100) / 100,
        totalDriverPenalty:
          Math.round(result.costBreakdown.totalDriverPenalty * 100) / 100,
        driverPenaltyCost:
          Math.round(result.costBreakdown.driverPenaltyCost * 100) / 100,
        geographicCohesionCost:
          Math.round(result.costBreakdown.geographicCohesionCost * 10_000) /
          10_000,
      },
    };
  });
}
/*
async function persistOptimizationResult(
  result: { routes: ALNSRoute[]; unassigned: ALNSNode[]; costBreakdown: any },
  vehicles: any[],
  drivers: any[],
  stops: StopRow[],
  routingVehicles: ALNSVehicle[],
  organizationId: string,
  depotLatitude: number,
  depotLongitude: number,
  weights: OptimizationWeights,
  planningInputs: PlanningInputsV1,
  driverConstraints: ALNSDriverConstraints[],
  optimizationStartTime: Date,
  reqDate?: string,
  globallyIneligibleNodeIds?: Set<string>,
  unassignedFieldServiceReasons?: Map<string, { reasonCodes: string[]; details: string[] }>,
) {
  const optimizedRoutes: Array<{
    vehicleId: string;
    routeId: string;
    planId: string;
    planRevision: number;
    stops: Array<{
      stopId: string;
      sequenceOrder: number;
      estimatedArrival: string;
      distanceFromPreviousKm: number;
      isChargingStop?: boolean;
      chargingStationName?: string;
    }>;
    distanceKm: number;
    durationMin: number;
    co2EmissionsKg: number;
    chargingStopsInserted: number;
    geographicOverlapExplanation?: {
      reasonCode: "TIME_WINDOW" | "CAPACITY" | "SKILL" | "WORKING_HOURS" | "EV_RANGE";
      message: string;
    };
    depotSnapshot: typeof routesTable.$inferSelect.depotSnapshot;
    workdayTimeline: NonNullable<typeof routesTable.$inferSelect.workdayTimeline>;
    workdaySummary: NonNullable<typeof routesTable.$inferSelect.workdaySummary>;
  }> = [];
  const planId = crypto.randomUUID();
  const routeDate = reqDate ? new Date(reqDate) : new Date();
  let totalDistanceKm = 0;
  let totalDurationMin = 0;
  const routingVehicleMap = new Map(routingVehicles.map((vehicle) => [vehicle.id, vehicle]));
  const driverConstraintsMap = new Map(driverConstraints.map((constraints) => [constraints.vehicleId, constraints]));
  const driverByVehicleId = new Map(
    drivers
      .filter((driver) => driver.vehicleId)
      .map((driver) => [driver.vehicleId, driver]),
  );
  const overlapExplanations = explainGeographicRouteOverlap(
    result.routes,
    routingVehicles,
    depotLatitude,
    depotLongitude,
    optimizationStartTime,
    driverConstraints,
  );
  const stopById = new Map(stops.map((stop) => [stop.id, stop]));
  const planningNodes = stops.map((stop) => toAlnsNode(stop, planningInputs));
  const planningNodeById = new Map(planningNodes.map((node) => [node.id, node]));
  const allUnassignedIds = [...new Set([
    ...result.unassigned.filter((node) => !node.isChargingStation).map((node) => node.id),
    ...(globallyIneligibleNodeIds ? [...globallyIneligibleNodeIds] : []),
  ])];
  const unplannedNodes = allUnassignedIds
    .map((stopId) => result.unassigned.find((node) => node.id === stopId) ?? planningNodeById.get(stopId))
    .filter((node): node is ALNSNode => node != null);
  const diagnosticResources = vehicles.flatMap((vehicle) => {
    const driver = driverByVehicleId.get(vehicle.id);
    const routingVehicle = routingVehicleMap.get(vehicle.id);
    return driver && routingVehicle
      ? [{ vehicle, driver, routingVehicle }]
      : [];
  });
  const diagnostics = classifyUnplannedNodes(
    unplannedNodes,
    stopById,
    diagnosticResources,
    depotLatitude,
    depotLongitude,
    optimizationStartTime,
  );
  const diagnosticByStopId = new Map(diagnostics.map((diagnostic) => [
    diagnostic.stopId,
    diagnostic,
  ]));
  const selectedPairValues = drivers
    .filter((driver) => driver.vehicleId && vehicles.some((vehicle) => vehicle.id === driver.vehicleId))
    .map((driver) => `${driver.vehicleId}:${driver.id}`);
  const usedPairValues = result.routes
    .filter((route) => route.nodes.some((node) => !node.isChargingStation))
    .map((route) => {
      const driver = driverByVehicleId.get(route.vehicleId);
      return driver ? `${route.vehicleId}:${driver.id}` : null;
    })
    .filter((pairValue): pairValue is string => pairValue != null);
  const unusedPairValues = selectedPairValues
    .filter((pairValue) => !usedPairValues.includes(pairValue))
    .map((pairValue) => ({
      pairValue,
      reason: "Kunde inte få ett kundstopp utan att bryta hårda planeringsvillkor.",
    }));
  const planningSummary = refreshedPlanningSummary(
    { selectedPairValues, usedPairValues, unusedPairValues },
    planningInputs,
    unplannedNodes,
    new Map([...diagnosticByStopId].map(([stopId, diagnostic]) => [
      stopId,
      diagnostic.detail,
    ])),
  );

  return db.transaction(async (tx) => {
  const [organization] = await tx.select().from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  for (const alnsRoute of result.routes) {
    if (alnsRoute.nodes.length === 0) continue;

    const vehicle = vehicles.find((v: any) => v.id === alnsRoute.vehicleId);
    if (!vehicle) continue;
    const routingVehicle = routingVehicleMap.get(alnsRoute.vehicleId);
    if (!routingVehicle) continue;
    const constraints = driverConstraintsMap.get(alnsRoute.vehicleId);

    const [route] = await tx
      .insert(routesTable)
      .values({
        planId,
        organizationId,
        vehicleId: vehicle.id,
        name: `${vehicle.name} - Optimized`,
        date: routeDate,
        status: "optimized",
        totalStops: alnsRoute.nodes.filter(n => !n.isChargingStation).length,
         optimizationPlanningSnapshot: planningInputs,
         optimizationPlanningSnapshotHash: payloadIdentityHash(planningInputs),
         planningSummary,
      })
      .returning();

    let routeDistance = 0;
    let routeDuration = 0;
    const optimizedStops: Array<{
      stopId: string;
      sequenceOrder: number;
      estimatedArrival: string;
      distanceFromPreviousKm: number;
      isChargingStop?: boolean;
      chargingStationName?: string;
    }> = [];
    const effectiveRouteStart = new Date(optimizationStartTime);
    if (constraints?.preferredStartTime) {
      const [hours, minutes] = constraints.preferredStartTime.split(":").map(Number);
      effectiveRouteStart.setHours(hours, minutes, 0, 0);
    }
    let currentTime = new Date(effectiveRouteStart);
    let seqOrder = 0;
    let prevLat = routingVehicle.startLatitude ?? depotLatitude;
    let prevLon = routingVehicle.startLongitude ?? depotLongitude;
    let breakTaken = false;
    const applyScheduledBreak = (intervalMinutes: number) => {
      if (breakTaken || !constraints?.breakStartTime || !constraints.breakEndTime) return;
      const [startHours, startMinutes] = constraints.breakStartTime.split(":").map(Number);
      const [endHours, endMinutes] = constraints.breakEndTime.split(":").map(Number);
      const breakStart = new Date(effectiveRouteStart);
      breakStart.setHours(startHours, startMinutes, 0, 0);
      const breakEnd = new Date(effectiveRouteStart);
      breakEnd.setHours(endHours, endMinutes, 0, 0);
      const intervalEnd = new Date(currentTime.getTime() + intervalMinutes * 60000);
      if (currentTime < breakEnd && intervalEnd > breakStart) {
        currentTime = new Date(currentTime.getTime() + (breakEnd.getTime() - breakStart.getTime()));
        breakTaken = true;
      }
    };
    const tempoMultiplier = routingVehicle.tempoMultiplier ?? 1;

    // Count only real DB stops (exclude charging stations)
    const realDeliveryNodes = alnsRoute.nodes.filter(n => !n.isChargingStation);
    const trackingCodes = generateTrackingCodeBatch(realDeliveryNodes.length);
    let codeIdx = 0;
    const stopUpdates: Array<{ stopId: string; routeId: string; seqOrder: number; trackingCode: string }> = [];

    for (const node of alnsRoute.nodes) {
      // For P&D composite nodes: route to pickup first, then delivery.
      // This mirrors what evaluateRoute does in cost.ts so timing/distance are consistent.
      if (node.pickupLat != null && node.pickupLon != null) {
        const pickupDist = cachedDistance(prevLat, prevLon, node.pickupLat, node.pickupLon);
        const pickupDur = estimateDurationMin(pickupDist, currentTime, prevLat, prevLon, node.pickupLat, node.pickupLon) * tempoMultiplier;
        applyScheduledBreak(pickupDur);
        routeDistance += pickupDist;
        const pickupArrival = new Date(currentTime.getTime() + pickupDur * 60000);
        currentTime = pickupArrival;
        const pickupServiceMin = node.pickupServiceMin ?? node.serviceDurationMin;
        applyScheduledBreak(pickupServiceMin);
        currentTime = new Date(currentTime.getTime() + pickupServiceMin * 60000);
        prevLat = node.pickupLat;
        prevLon = node.pickupLon;
      }

      const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);
      const dur = estimateDurationMin(dist, currentTime, prevLat, prevLon, node.latitude, node.longitude) * tempoMultiplier;
      applyScheduledBreak(dur);

      routeDistance += dist;
      const arrivalTime = new Date(currentTime.getTime() + dur * 60000);

      seqOrder++;

      if (node.isChargingStation) {
        const chargeDur = node.chargingDurationMin ?? 30;
        optimizedStops.push({
          stopId: node.id,
          sequenceOrder: seqOrder,
          estimatedArrival: arrivalTime.toISOString(),
          distanceFromPreviousKm: Math.round(dist * 100) / 100,
          isChargingStop: true,
          chargingStationName: node.chargingStationName,
        });

        currentTime = arrivalTime;
        applyScheduledBreak(chargeDur);
        currentTime = new Date(currentTime.getTime() + chargeDur * 60000);
      } else {
        const effectiveStart = node.timeWindowStart && node.timeWindowStart.getTime() > arrivalTime.getTime()
          ? node.timeWindowStart
          : arrivalTime;

        stopUpdates.push({
          stopId: node.id,
          routeId: route.id,
          seqOrder,
          trackingCode: trackingCodes[codeIdx++],
        });

        optimizedStops.push({
          stopId: node.id,
          sequenceOrder: seqOrder,
          estimatedArrival: effectiveStart.toISOString(),
          distanceFromPreviousKm: Math.round(dist * 100) / 100,
        });

        currentTime = new Date(effectiveStart);
        applyScheduledBreak(node.serviceDurationMin);
        currentTime = new Date(currentTime.getTime() + node.serviceDurationMin * 60000);
      }

      prevLat = node.latitude;
      prevLon = node.longitude;
    }

    const endLat = routingVehicle.endLatitude ?? routingVehicle.startLatitude ?? depotLatitude;
    const endLon = routingVehicle.endLongitude ?? routingVehicle.startLongitude ?? depotLongitude;
    const returnDistance = cachedDistance(prevLat, prevLon, endLat, endLon);
    const returnDuration = estimateDurationMin(returnDistance, currentTime, prevLat, prevLon, endLat, endLon) * tempoMultiplier;
    applyScheduledBreak(returnDuration);
    routeDistance += returnDistance;
    currentTime = new Date(currentTime.getTime() + returnDuration * 60000);
    routeDuration = (currentTime.getTime() - effectiveRouteStart.getTime()) / 60000;
    // Persist the same explicit workday clock used for review/audit. The
    // itinerary remains stop-only so existing driver clients stay compatible.
    const workday = evaluateRouteWorkday(
      alnsRoute.nodes, routingVehicle, depotLatitude, depotLongitude, optimizationStartTime, constraints,
    );
    assertPersistableWorkday(workday, vehicle.name, constraints);
    const scheduledAtByStopId = new Map<string, string>();
    for (const event of workday.events) {
      if (event.stopId && (event.type === "service" || event.type === "charging")) {
        scheduledAtByStopId.set(event.stopId, event.startAt);
      }
    }
    for (const stop of optimizedStops) {
      stop.estimatedArrival = scheduledAtByStopId.get(stop.stopId) ?? stop.estimatedArrival;
    }
    const depotSnapshot = organization?.depotStartVerifiedAt && organization.depotEndVerifiedAt
      && organization.depotStartLatitude != null && organization.depotStartLongitude != null
      && organization.depotEndLatitude != null && organization.depotEndLongitude != null
      ? {
          start: { address: organization.depotStartAddress ?? "", latitude: organization.depotStartLatitude, longitude: organization.depotStartLongitude, verifiedAt: organization.depotStartVerifiedAt.toISOString(), verification: organization.depotStartVerification },
          end: { address: organization.depotEndAddress ?? "", latitude: organization.depotEndLatitude, longitude: organization.depotEndLongitude, verifiedAt: organization.depotEndVerifiedAt.toISOString(), verification: organization.depotEndVerification },
        }
      : null;

    for (const u of stopUpdates) {
      const [claimed] = await tx.update(stopsTable)
        .set({
          routeId: u.routeId,
          sequenceOrder: u.seqOrder,
          trackingCode: u.trackingCode,
          planningPlanId: planId,
          planningDate: routeDate,
          unplannedReason: null,
        })
        .where(and(
          eq(stopsTable.id, u.stopId),
          eq(stopsTable.organizationId, organizationId),
          isNull(stopsTable.routeId),
        ))
        .returning({ id: stopsTable.id });
      if (!claimed) {
        throw new Error("Ett stopp tilldelades av någon annan medan planen sparades. Försök optimera igen.");
      }
    }

    const driver = driverByVehicleId.get(vehicle.id);
    if (driver) {
      const snapshotStops = stopUpdates
        .map((update) => {
          const stop = stops.find((candidate) => candidate.id === update.stopId);
          return stop
            ? { ...stop, routeId: route.id, sequenceOrder: update.seqOrder }
            : null;
        })
        .filter((stop): stop is NonNullable<typeof stop> => stop != null);
      const certifications = await tx
        .select()
        .from(driverCertificationsTable)
        .where(and(
          eq(driverCertificationsTable.organizationId, organizationId),
          eq(driverCertificationsTable.driverId, driver.id),
        ))
        .orderBy(driverCertificationsTable.id);
      const optimizationSnapshot = materialResourceSnapshot(
        vehicle,
        driver,
        snapshotStops,
        certifications,
      );
      const optimizationSnapshotHash = materialResourceSnapshotHash(
        vehicle,
        driver,
        snapshotStops,
        certifications,
      );
      // The route update below is the same transaction as stop assignment, so
      // this baseline represents the exact inputs that produced the plan.
      const [savedRouteWithSnapshot] = await tx
        .update(routesTable)
        .set({
          optimizationResourceSnapshot: optimizationSnapshot,
          optimizationResourceSnapshotHash: optimizationSnapshotHash,
        })
        .where(eq(routesTable.id, route.id))
        .returning({ id: routesTable.id });
      if (!savedRouteWithSnapshot) {
        throw new Error("Ruttens optimeringsunderlag kunde inte sparas.");
      }
    }

    const co2 = estimateCo2(workday.totalDistanceKm, vehicle.vehicleType, alnsRoute.totalWeight, routingVehicle.capacityKg);

    const [savedRoute] = await tx
      .update(routesTable)
      .set({
        totalDistanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
        totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        plannerItinerary: optimizedStops,
        depotSnapshot,
        workdayTimeline: workday.events,
        workdaySummary: workday.summary,
        geographicOverlapExplanation: overlapExplanations.get(vehicle.id) ?? null,
        planRevision: sql`${routesTable.planRevision} + 1`,
        handoffStatus: "pending", handoffVersion: null, handoffDriverId: null,
        sentAt: null, receivedAt: null, openedAt: null, acceptedAt: null, rejectedAt: null, rejectionReason: null,
      })
      .where(eq(routesTable.id, route.id))
      .returning({ planRevision: routesTable.planRevision });

    totalDistanceKm += workday.totalDistanceKm;
    totalDurationMin += workday.summary.totalMin;

    const chargingCount = alnsRoute.nodes.filter(n => n.isChargingStation).length;

    optimizedRoutes.push({
      vehicleId: vehicle.id,
      routeId: route.id,
      planId: route.planId,
      planRevision: savedRoute.planRevision,
      stops: optimizedStops,
      distanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
      durationMin: Math.round(workday.summary.totalMin * 100) / 100,
      co2EmissionsKg: Math.round(co2 * 100) / 100,
      chargingStopsInserted: chargingCount,
      geographicOverlapExplanation: overlapExplanations.get(vehicle.id),
      depotSnapshot,
      workdayTimeline: workday.events,
      workdaySummary: workday.summary,
    });
  }

  // Build per-stop reason detail for the response
  const unassignedReasonDetails = allUnassignedIds.map(stopId => {
    const diagnostic = diagnosticByStopId.get(stopId);
    if (diagnostic) {
      return {
        stopId,
        reasonCodes: [diagnostic.code],
        details: [diagnostic.detail],
      };
    }
    const fsReason = unassignedFieldServiceReasons?.get(stopId);
    if (fsReason) {
      return { stopId, reasonCodes: fsReason.reasonCodes, details: fsReason.details };
    }
    return {
      stopId,
      reasonCodes: ["WORKING_TIME_OR_TIME_WINDOW_EXCEEDED"],
      details: ["Stoppet kan inte planeras inom valda resurser och hårda arbetstidsvillkor."],
    };
  });
  for (const reason of unassignedReasonDetails) {
    await tx.update(stopsTable).set({
      planningPlanId: planId,
      planningDate: routeDate,
      unplannedReason: reason.details.length > 0
        ? reason.details.join(" ")
        : "Stoppet kunde inte tilldelas inom valda resurser och planeringsvillkor.",
    }).where(and(
      eq(stopsTable.id, reason.stopId),
      eq(stopsTable.organizationId, organizationId),
      isNull(stopsTable.routeId),
    ));
  }

  return {
    planId,
    routes: optimizedRoutes,
    totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
    totalDurationMin: Math.round(totalDurationMin * 100) / 100,
    unassignedStopIds: allUnassignedIds,
    unassignedReasons: unassignedReasonDetails,
    trafficCondition: getTrafficDescription(routeDate),
    etaModel: "predictive",
    optimizer: "alns",
    optimizationWeights: weights,
    driverConstraintsApplied: driverConstraints.map(dc => ({
      vehicleId: dc.vehicleId,
      driverName: dc.driverName,
      maxHours: dc.maxDrivingHoursPerDay,
      avoidNight: dc.avoidNightDriving,
      preferredWindow: `${dc.preferredStartTime.slice(0, 5)} - ${dc.preferredEndTime.slice(0, 5)}`,
    })),
    costBreakdown: {
      totalDistanceKm: Math.round(result.costBreakdown.totalDistanceKm * 100) / 100,
      totalCo2Kg: Math.round(result.costBreakdown.totalCo2Kg * 100) / 100,
      totalTimeWindowSlackMin: Math.round(result.costBreakdown.totalTimeWindowSlackMin * 100) / 100,
      totalDriverPenalty: Math.round(result.costBreakdown.totalDriverPenalty * 100) / 100,
      driverPenaltyCost: Math.round(result.costBreakdown.driverPenaltyCost * 100) / 100,
      geographicCohesionCost: Math.round(result.costBreakdown.geographicCohesionCost * 10_000) / 10_000,
    },
  };
  });
}
*/

/** Resolve raw request/snapshot allowances before normalization fills omissions
 * with zero. Persist explicit effective zeros, not deleted/ambiguous fields. */
export function optimizationPlanningInputsWithPolicy(
  value: unknown,
  organization: Parameters<typeof effectivePlanningPolicy>[0],
): PlanningInputsV1 {
  const normalized = normalizePlanningInputs(value);
  return {
    ...normalized,
    ...effectivePlanningPolicy(organization, value as PlanningInputsV1 | null | undefined),
  };
}

async function loadOptimizationInputs(parsed: any) {
  const { organizationId, vehicleIds, stopIds, timeBudgetMs } = parsed;
  const [organization] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  if (!organization) throw new Error("Organization not found");
  const hasExplicitPlanningInputs =
    parsed.planningInputs !== undefined && parsed.planningInputs !== null;
  const planningInputs = optimizationPlanningInputsWithPolicy(parsed.planningInputs, organization);
  const organizationPolicy = effectivePlanningPolicy(organization, planningInputs);
  if (!hasExplicitPlanningInputs) {
    planningInputs.vehicleSelectionMode =
      parsed.vehicleDistributionMode === "minimize"
        ? "minimize_vehicles"
        : "use_all_selected_pairs";
  }
  const hasVerifiedStart =
    organization.depotStartVerifiedAt &&
    organization.depotStartLatitude != null &&
    organization.depotStartLongitude != null;
  const hasVerifiedEnd =
    organization.depotEndVerifiedAt &&
    organization.depotEndLatitude != null &&
    organization.depotEndLongitude != null;
  // A configured depot is authoritative; unverified request coordinates remain
  // supported only for organizations that have not configured depot settings.
  const depotLatitude = hasVerifiedStart
    ? organization.depotStartLatitude!
    : parsed.depotLatitude;
  const depotLongitude = hasVerifiedStart
    ? organization.depotStartLongitude!
    : parsed.depotLongitude;

  const weights = hasExplicitPlanningInputs
    ? {
        ...DEFAULT_WEIGHTS,
        ...planningWeights(planningInputs),
      }
    : normalizeWeights({
        distanceWeight:
          parsed.optimizationWeights?.distanceWeight ??
          DEFAULT_WEIGHTS.distanceWeight,
        co2Weight:
          parsed.optimizationWeights?.co2Weight ?? DEFAULT_WEIGHTS.co2Weight,
        etaPrecisionWeight:
          parsed.optimizationWeights?.etaPrecisionWeight ??
          DEFAULT_WEIGHTS.etaPrecisionWeight,
        driverHappinessWeight:
          parsed.optimizationWeights?.driverHappinessWeight ??
          DEFAULT_WEIGHTS.driverHappinessWeight,
        geographicCohesionWeight:
          parsed.optimizationWeights?.geographicCohesionWeight ??
          DEFAULT_WEIGHTS.geographicCohesionWeight,
      });
  const vehicleDistributionMode = hasExplicitPlanningInputs
    ? planningInputs.vehicleSelectionMode === "minimize_vehicles"
      ? ("minimize" as const)
      : ("balance" as const)
    : parsed.vehicleDistributionMode;
  const optimizationEvidence = optimizationEvidenceForConfig({
    source: hasExplicitPlanningInputs ? "planningInputs" : "legacy",
    planningInputs,
    requestedWeights: hasExplicitPlanningInputs
      ? planningWeights(planningInputs)
      : parsed.optimizationWeights,
    effectiveWeights: weights,
    vehicleDistributionMode,
  });

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
    throw new Error(
      "One or more vehicles do not belong to the specified organization",
    );
  }

  const loadedStops = await db
    .select()
    .from(stopsTable)
    .where(
      and(
        inArray(stopsTable.id, stopIds),
        eq(stopsTable.organizationId, organizationId),
      ),
    );

  if (loadedStops.length !== stopIds.length) {
    throw new Error(
      "One or more stops do not belong to the specified organization",
    );
  }
  const planningDate = parsed.date ? new Date(parsed.date) : new Date();
  if (!Number.isFinite(planningDate.getTime())) {
    const error = new Error("The optimization date is invalid.") as Error & { statusCode: number };
    error.statusCode = 422;
    throw error;
  }
  const materializedStops = await materializeUnplannedCustomerStopSnapshots(
    organizationId,
    planningDate,
    stopIds,
  );
  const materializedById = new Map(materializedStops.map((stop) => [stop.id, stop]));
  const stops = loadedStops.map((stop) => materializedById.get(stop.id) ?? stop);

  // Build one composite ALNS node per stop (P&D stops carry embedded pickup coords).
  const alnsNodes: ALNSNode[] = expandStopsToNodes(stops, planningInputs);

  const alnsVehicles: ALNSVehicle[] = vehicles.map((v) => ({
    id: v.id,
    vehicleType: v.vehicleType,
    capacityKg: v.capacityKg,
    capacityVolume: v.capacityVolume,
    rangeKm: v.rangeKm,
    travelReservePercent: planningInputs.travelReservePercent,
    ...(hasVerifiedEnd
      ? {
          endLatitude: organization.depotEndLatitude!,
          endLongitude: organization.depotEndLongitude!,
        }
      : {}),
    ...organizationPolicy,
  }));

  const orgDrivers = await db
    .select()
    .from(driversTable)
    .where(
      and(
        eq(driversTable.organizationId, organizationId),
        eq(driversTable.isActive, true),
      ),
    );
  const drivers = orgDrivers.filter(
    (d) => d.vehicleId && vehicleIds.includes(d.vehicleId),
  );
  const seenResourceIds = new Set<string>();
  for (const profile of drivers) {
    if (seenResourceIds.has(profile.vehicleId!)) {
      throw Object.assign(new Error("En vald resurs har flera äldre driftprofiler och måste granskas innan planering."), { statusCode: 409 });
    }
    seenResourceIds.add(profile.vehicleId!);
  }
  const driverByVehicleId = new Map(
    drivers.map((driver) => [driver.vehicleId!, driver]),
  );
  for (const vehicle of alnsVehicles) {
    const driver = driverByVehicleId.get(vehicle.id);
    if (!driver) continue;
    Object.assign(
      vehicle,
      withOrganizationPlanningPolicy(
        applyDriverRoutingProfile(vehicle, driver),
        organizationPolicy,
      ),
    );
    if (hasVerifiedStart) {
      vehicle.startLatitude = depotLatitude;
      vehicle.startLongitude = depotLongitude;
    }
    if (hasVerifiedEnd) {
      vehicle.endLatitude = organization.depotEndLatitude!;
      vehicle.endLongitude = organization.depotEndLongitude!;
    }
  }

  const driverConstraints: ALNSDriverConstraints[] = [];
  if (drivers.length > 0) {
    const driverIds = drivers.map((d) => d.id);
    const allPrefs = await db
      .select()
      .from(driverPreferencesTable)
      .where(inArray(driverPreferencesTable.driverId, driverIds));

    const prefsMap = new Map(allPrefs.map((p) => [p.driverId, p]));
    for (const driver of drivers) {
      if (!driver.vehicleId) continue;
      const prefs = prefsMap.get(driver.id);
      driverConstraints.push({
        vehicleId: driver.vehicleId,
        driverName: driver.name,
        preferredStartTime:
          driver.workStartTime ?? prefs?.preferredStartTime ?? "07:00:00",
        preferredEndTime:
          driver.workEndTime ?? prefs?.preferredEndTime ?? "16:00:00",
        maxDrivingHoursPerDay: prefs?.maxDrivingHoursPerDay ?? 8,
        avoidNightDriving: prefs?.avoidNightDriving ?? false,
        breakFrequencyMinutes: prefs?.breakFrequencyMinutes ?? 120,
        preferredBreakDurationMin: prefs?.preferredBreakDurationMin ?? 15,
        breakStartTime: driver.breakStartTime,
        breakEndTime: driver.breakEndTime,
      });
    }
  }

  // Pre-compute field service eligibility for each vehicle+driver pair.
  // Every service job requires an active technician. Skills, certifications,
  // and equipment add further hard requirements.
  const fieldServiceNodes = alnsNodes.filter(
    (n) => n.jobType === "field_service",
  );

  // unassignedFieldServiceReasons: nodeId → worst-case reasons (across all vehicles)
  const unassignedFieldServiceReasons = new Map<
    string,
    { reasonCodes: string[]; details: string[] }
  >();

  const now = new Date();
  const globallyIneligibleNodeIds =
    await applyFieldServiceEligibilityToVehicles(
      alnsVehicles,
      fieldServiceNodes,
      drivers,
      async (driverId, vehicleId, node) => {
        const result = await checkFieldServiceEligibility(
          driverId,
          vehicleId,
          {
            requiredSkills: node.requiredSkills ?? [],
            requiredCertifications: node.requiredCertifications ?? [],
            requiredEquipment: node.requiredEquipment ?? [],
          },
          now,
        );
        if (!result.eligible) {
          if (!unassignedFieldServiceReasons.has(node.id)) {
            unassignedFieldServiceReasons.set(node.id, {
              reasonCodes: result.reasonCodes,
              details: result.details,
            });
          }
        }
        return result.eligible;
      },
    );

  for (const nodeId of globallyIneligibleNodeIds) {
    if (!unassignedFieldServiceReasons.has(nodeId)) {
      unassignedFieldServiceReasons.set(nodeId, {
        reasonCodes: [...INCOMPATIBLE_TECHNICIAN_REASON.reasonCodes],
        details: [...INCOMPATIBLE_TECHNICIAN_REASON.details],
      });
    }
  }

  const sourceRouteIds = [...new Set(stops.flatMap(stop => stop.routeId ? [stop.routeId] : []))];
  const sourceLocks = sourceRouteIds.length ? await db.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), inArray(routesTable.id, sourceRouteIds),
  )) : [];
  const protectedStopIds = new Set(stops.filter(stop => stop.lockedVehicleId || stop.lockedServiceStartAt
    || sourceLocks.some(route => route.id === stop.routeId && (route.optimizationFrozen || route.lockedFirstStopId === stop.id)))
    .map(stop => stop.id));
  const filteredAlnsNodes = alnsNodes.filter(
    node => !globallyIneligibleNodeIds.has(node.id) || protectedStopIds.has(node.id),
  );

  return {
    organizationId,
    planningInputs,
    depotLatitude,
    depotLongitude,
    timeBudgetMs,
    weights,
    vehicles,
    stops,
    drivers,
    alnsNodes: filteredAlnsNodes,
    alnsVehicles,
    driverConstraints,
    globallyIneligibleNodeIds,
    unassignedFieldServiceReasons,
    optimizationEvidence,
    vehicleDistributionMode,
  };
}

/*
router.post("/optimize", async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const parsed = ContinuousStartBody.parse(req.body);
    parsed.organizationId = assertOrgScope(req, parsed.organizationId);
    const inputs = await loadOptimizationInputs(parsed);

    const {
      planningInputs,
      depotLatitude,
      depotLongitude,
      timeBudgetMs,
      vehicles,
      drivers,
      stops,
      alnsNodes,
      alnsVehicles,
      driverConstraints,
      globallyIneligibleNodeIds,
      unassignedFieldServiceReasons,
    } = inputs;
    const inputLoadMs = Date.now() - requestStartedAt;
    const {
      organizationId,
      depotLatitude,
      depotLongitude,
      timeBudgetMs,
      weights,
      vehicles,
      stops,
      drivers,
      alnsNodes,
      alnsVehicles,
      driverConstraints,
      globallyIneligibleNodeIds,
      unassignedFieldServiceReasons,
      planningInputs,
      optimizationEvidence,
      vehicleDistributionMode,
    } = inputs;
    const { organizationId, planningInputs, depotLatitude, depotLongitude, timeBudgetMs, weights, vehicles, stops, drivers, alnsNodes, alnsVehicles, driverConstraints, globallyIneligibleNodeIds, unassignedFieldServiceReasons } = inputs;
    // The optimizer's clock must use the requested route date. Using wall-clock
    // time here makes date-only planning evaluate windows and shifts against a
    // different calendar day than the persisted route.
    const requestedDate = (req.body as Record<string, unknown>).date;
    const optimizationStartTime = optimizationStartTimeForRequest(requestedDate);
    const policy = resolveOptimizationPolicy(alnsNodes.length, timeBudgetMs);
    const alnsPolicyConfig = policyToALNSConfig(policy);

    const ASYNC_THRESHOLD = 100;
    const useAsync = parsed.async || alnsNodes.length > ASYNC_THRESHOLD;

    if (useAsync) {
      const jobId = crypto.randomUUID();
  const job = optimizationJobs.get(req.params.jobId);
      optimizationJobs.set(jobId, job);

      res.json({ jobId, status: "running", stopCount: alnsNodes.length, vehicleCount: alnsVehicles.length });

      setImmediate(async () => {
        try {
          job.progress = {
            totalClusters: 0,
            completedClusters: 0,
            phase: "preparing",
            elapsedMs: Date.now() - job.createdAt,
            iterations: 0,
            improvements: 0,
            stopReason: null,
            clusterStopReasons: {},
          };
    const weatherStartedAt = Date.now();
    const weather = await getWeatherForLocation(depotLatitude, depotLongitude);
    const weatherMs = Date.now() - weatherStartedAt;
    const environment: EnvironmentContext = {
      weatherImpact: weather.drivingImpact,
      evRangeMultiplier: weather.evRangeMultiplier,
    };

    const startTime = affectedRoutes[0]?.date ?? new Date();
    const result = await reoptimizeAffectedRoutes(
      currentALNSRoutes,
      affectedVehicleIds,
      alnsVehicles,
      depLat,
      depLon,
      startTime,
      { timeLimitMs: 15000, driverConstraints: reoptDriverConstraints }
    );

    const persistenceStartedAt = Date.now();
    const persisted = await persistOptimizationResult(
      result, vehicles, drivers, stops, alnsVehicles, organizationId, depotLatitude, depotLongitude,
      weights, driverConstraints, planningInputs, startTime,
      (req.body as Record<string, unknown>).date as string | undefined,
      globallyIneligibleNodeIds, unassignedFieldServiceReasons,
    );
    const persisted = await persistOptimizationResult(
      result, vehicles, drivers, stops, alnsVehicles, organizationId, depotLatitude, depotLongitude,
      weights, planningInputs, driverConstraints, startTime, (req.body as Record<string, unknown>).date as string | undefined,
      globallyIneligibleNodeIds, unassignedFieldServiceReasons,
    );
    const persistenceMs = Date.now() - persistenceStartedAt;
    const optimizationTiming = createOptimizationTiming(
      inputLoadMs,
      weatherMs,
      result.performance,
      persistenceMs,
      Date.now() - requestStartedAt,
      policy,
    );
          const persistedWithTiming = { ...persisted, optimizationTiming };

          job.status = "complete";
          job.result = persistedWithTiming;
          const runStats = result.performance.runStats;
          const totalClusters = runStats && "totalClusters" in runStats ? runStats.totalClusters : 1;
          job.progress = {
            totalClusters,
            completedClusters: totalClusters,
            phase: "complete",
            elapsedMs: Date.now() - job.createdAt,
            iterations: runStats?.iterations ?? 0,
            improvements: runStats?.improvements ?? 0,
            stopReason: runStats?.stopReason ?? null,
            clusterStopReasons: runStats && "clusterStopReasons" in runStats
              ? runStats.clusterStopReasons
              : runStats
                ? { [runStats.stopReason]: 1 }
                : {},
          };

          broadcast(organizationId, "optimization:complete", { jobId, result: persistedWithTiming });
        } catch (err: any) {
          job.status = "error";
          job.error = err.message || "Optimization failed";
        }
      });

      return;
    }

    const weatherStartedAt = Date.now();
    const weather = await getWeatherForLocation(depotLatitude, depotLongitude);
    const weatherMs = Date.now() - weatherStartedAt;
    const environment: EnvironmentContext = {
      weatherImpact: weather.drivingImpact,
      evRangeMultiplier: weather.evRangeMultiplier,
    };

    const startTime = affectedRoutes[0]?.date ?? new Date();
    const result = await reoptimizeAffectedRoutes(
      currentALNSRoutes,
      affectedVehicleIds,
      alnsVehicles,
      depLat,
      depLon,
      startTime,
      { timeLimitMs: 15000, driverConstraints: reoptDriverConstraints }
    );

    const persistenceStartedAt = Date.now();
    const persisted = await persistOptimizationResult(
      result, vehicles, drivers, stops, alnsVehicles, organizationId, depotLatitude, depotLongitude,
      weights, driverConstraints, planningInputs, startTime,
      (req.body as Record<string, unknown>).date as string | undefined,
      globallyIneligibleNodeIds, unassignedFieldServiceReasons,
    );
    const persisted = await persistOptimizationResult(
      result, vehicles, drivers, stops, alnsVehicles, organizationId, depotLatitude, depotLongitude,
      weights, planningInputs, driverConstraints, startTime, (req.body as Record<string, unknown>).date as string | undefined,
      globallyIneligibleNodeIds, unassignedFieldServiceReasons,
    );
    const persistenceMs = Date.now() - persistenceStartedAt;
    const optimizationTiming = createOptimizationTiming(
      inputLoadMs,
      weatherMs,
      result.performance,
      persistenceMs,
      Date.now() - requestStartedAt,
      policy,
    );

    res.json({
      ...persisted,
      optimizationTiming,
      weatherConditions: {
        description: weather.description,
        severity: getWeatherSeverity(weather),
        drivingImpact: weather.drivingImpact,
        temperature: weather.temperature,
      },
    });
  } catch (err) {
    handleError(res, err);
  }
});

*/

router.post("/optimize/usage-preview", async (req, res) => {
  const parsed = z.object({
    organizationId: z.guid().optional(),
    stopCount: z.number().int().min(1).max(100_000),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Ogiltig jobbstorlek" }); return; }
  try {
    const organizationId = assertOrgScope(req, parsed.data.organizationId);
    res.json(await checkOptimizationUsage(organizationId, parsed.data.stopCount));
  } catch (err) { handleError(res, err); }
});

async function recordOptimizationJobState(
  organizationId: string, jobId: string, stopCount: number,
  outcome: "started" | "complete" | "error" | "blocked",
): Promise<void> {
  await recordUsage({
    organizationId, jobId, eventKey: `${jobId}:job:${outcome}`,
    category: "optimization", provider: "internal", operation: "job_state",
    outcome, units: 0, stopCount,
    sizeClass: stopCount > 100 ? "large" : "small", engine: "alns",
  });
}

router.post("/optimize", async (req, res) => {
  const requestStartedAt = Date.now();
  let attemptedJob: { organizationId: string; jobId: string; stopCount: number } | null = null;
  try {
    const parsed = ExtendedOptimizeBody.parse(req.body);
    parsed.organizationId = assertOrgScope(req, parsed.organizationId);
    attemptedJob = {
      organizationId: parsed.organizationId,
      jobId: getUsageContext()?.jobId ?? crypto.randomUUID(),
      stopCount: parsed.stopIds.length,
    };
    await recordOptimizationJobState(attemptedJob.organizationId, attemptedJob.jobId, attemptedJob.stopCount, "started");
    const inputs = await loadOptimizationInputs(parsed);
    const inputLoadMs = Date.now() - requestStartedAt;
    const {
      organizationId,
      depotLatitude,
      depotLongitude,
      timeBudgetMs,
      weights,
      vehicles,
      stops,
      drivers,
      alnsNodes,
      alnsVehicles,
      driverConstraints,
      globallyIneligibleNodeIds,
      unassignedFieldServiceReasons,
      planningInputs,
      optimizationEvidence,
      vehicleDistributionMode,
    } = inputs;
    const requestedDate = (req.body as Record<string, unknown>).date;
    const optimizationStartTime =
      optimizationStartTimeForRequest(requestedDate);
    const policy = resolveOptimizationPolicy(alnsNodes.length, timeBudgetMs);
    const alnsPolicyConfig = policyToALNSConfig(policy);
    const useAsync = parsed.async || alnsNodes.length > 100;
    const usageRisk = await checkOptimizationUsage(organizationId, alnsNodes.length);
    if (usageRisk.blocked) {
      await recordOptimizationJobState(organizationId, attemptedJob.jobId, alnsNodes.length, "blocked");
      res.status(429).json({ error: usageRisk.blocked, code: "OPTIMIZATION_USAGE_LIMIT", usageRisk });
      return;
    }

    if (useAsync) {
      const jobId = attemptedJob.jobId;
      const job: OptimizationJob = {
        id: jobId,
        organizationId,
        status: "running",
        progress: null,
        result: null,
        error: null,
        createdAt: Date.now(),
        stopCount: alnsNodes.length,
        vehicleCount: alnsVehicles.length,
      };
      const reporter = await startOptimizationJob(job);
      res.json({
        jobId,
        status: "running",
        stopCount: alnsNodes.length,
        vehicleCount: alnsVehicles.length,
        usageRisk,
      });
      setImmediate(async () => {
        try {
          job.progress = {
            totalClusters: 0,
            completedClusters: 0,
            phase: "preparing",
            elapsedMs: Date.now() - job.createdAt,
            iterations: 0,
            improvements: 0,
            stopReason: null,
            clusterStopReasons: {},
          };
          const weatherStartedAt = Date.now();
          const weather = await getWeatherForLocation(
            depotLatitude,
            depotLongitude,
            undefined,
            {
              timeoutMs: policy.weatherTimeoutMs,
              fallbackEvRangeMultiplier: 0.55,
            },
          );
          const weatherMs = Date.now() - weatherStartedAt;
          const result = await optimizeWithALNS(
            alnsNodes,
            alnsVehicles,
            depotLatitude,
            depotLongitude,
            optimizationStartTime,
            {
              weights,
              ...alnsPolicyConfig,
              driverConstraints,
              environment: {
                weatherImpact: weather.drivingImpact,
                evRangeMultiplier: weather.evRangeMultiplier,
              },
              vehicleDistributionMode: inputs.vehicleDistributionMode,
            },
            (progress) => {
              job.progress = progress;
            },
          );
          const persistenceStartedAt = Date.now();
          const persisted = await persistOptimizationResult(
            result,
            vehicles,
            drivers,
            stops,
            alnsVehicles,
            organizationId,
            depotLatitude,
            depotLongitude,
            weights,
            driverConstraints,
            planningInputs,
            optimizationEvidence,
            optimizationStartTime,
            requestedDate as string | undefined,
            globallyIneligibleNodeIds,
            unassignedFieldServiceReasons,
          );
          const persistenceMs = Date.now() - persistenceStartedAt;
          const optimizationTiming = createOptimizationTiming(
            inputLoadMs,
            weatherMs,
            result.performance,
            persistenceMs,
            Date.now() - requestStartedAt,
            policy,
          );
          const persistedWithTiming = { ...persisted, optimizationTiming };
          job.status = "complete";
          job.result = persistedWithTiming;
          try { await recordOptimizationJobState(organizationId, jobId, alnsNodes.length, "complete"); }
          catch (ledgerError) { console.error("Could not record completed optimization job", ledgerError); }
          const runStats = result.performance.runStats;
          const totalClusters =
            runStats && "totalClusters" in runStats
              ? runStats.totalClusters
              : 1;
          job.progress = {
            totalClusters,
            completedClusters: totalClusters,
            phase: "complete",
            elapsedMs: Date.now() - job.createdAt,
            iterations: runStats?.iterations ?? 0,
            improvements: runStats?.improvements ?? 0,
            stopReason: runStats?.stopReason ?? null,
            clusterStopReasons:
              runStats && "clusterStopReasons" in runStats
                ? runStats.clusterStopReasons
                : runStats
                  ? { [runStats.stopReason]: 1 }
                  : {},
          };
          broadcast(organizationId, "optimization:complete", {
            jobId,
            result: persistedWithTiming,
          });
        } catch (err: any) {
          job.status = "error";
          job.error = err.message || "Optimization failed";
          try { await recordOptimizationJobState(organizationId, jobId, alnsNodes.length, "error"); }
          catch (ledgerError) { console.error("Could not record failed optimization job", ledgerError); }
        } finally {
          await reporter.finish().catch(() => {
            console.error("Could not persist final optimization state");
          });
        }
      });
      return;
    }

    const weatherStartedAt = Date.now();
    const weather = await getWeatherForLocation(
      depotLatitude,
      depotLongitude,
      undefined,
      {
        timeoutMs: policy.weatherTimeoutMs,
        fallbackEvRangeMultiplier: 0.55,
      },
    );
    const weatherMs = Date.now() - weatherStartedAt;
    const result = await optimizeWithALNS(
      alnsNodes,
      alnsVehicles,
      depotLatitude,
      depotLongitude,
      optimizationStartTime,
      {
        weights,
        ...alnsPolicyConfig,
        driverConstraints,
        environment: {
          weatherImpact: weather.drivingImpact,
          evRangeMultiplier: weather.evRangeMultiplier,
        },
        vehicleDistributionMode: inputs.vehicleDistributionMode,
      },
    );
    const persistenceStartedAt = Date.now();
    const persisted = await persistOptimizationResult(
      result,
      vehicles,
      drivers,
      stops,
      alnsVehicles,
      organizationId,
      depotLatitude,
      depotLongitude,
      weights,
      driverConstraints,
      planningInputs,
      optimizationEvidence,
      optimizationStartTime,
      requestedDate as string | undefined,
      globallyIneligibleNodeIds,
      unassignedFieldServiceReasons,
    );
    const persistenceMs = Date.now() - persistenceStartedAt;
    const optimizationTiming = createOptimizationTiming(
      inputLoadMs,
      weatherMs,
      result.performance,
      persistenceMs,
      Date.now() - requestStartedAt,
      policy,
    );
    try { await recordOptimizationJobState(organizationId, attemptedJob.jobId, alnsNodes.length, "complete"); }
    catch (ledgerError) { console.error("Could not record completed optimization job", ledgerError); }
    res.json({
      ...persisted,
      optimizationTiming,
      usageRisk,
      weatherConditions: {
        description: weather.description,
        severity: getWeatherSeverity(weather),
        drivingImpact: weather.drivingImpact,
        temperature: weather.temperature,
      },
    });
  } catch (err) {
    if (attemptedJob) {
      try { await recordOptimizationJobState(attemptedJob.organizationId, attemptedJob.jobId, attemptedJob.stopCount, "error"); }
      catch (ledgerError) { console.error("Could not record failed optimization job", ledgerError); }
    }
    handleError(res, err);
  }
});

const ALTERNATIVE_PROFILES = [
  {
    name: "fastest",
    weights: {
      distanceWeight: 0.7,
      co2Weight: 0.1,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.05,
      geographicCohesionWeight: 0,
    },
  },
  {
    name: "greenest",
    weights: {
      distanceWeight: 0.2,
      co2Weight: 0.5,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    },
  },
  {
    name: "balanced",
    weights: {
      distanceWeight: 0.45,
      co2Weight: 0.25,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    },
  },
];

router.post("/optimize/alternatives", async (req, res) => {
  try {
    const parsed = ExtendedOptimizeBody.parse(req.body);
    parsed.organizationId = assertOrgScope(req, parsed.organizationId);
    const inputs = await loadOptimizationInputs(parsed);
    const usageRisk = await checkOptimizationUsage(inputs.organizationId, inputs.alnsNodes.length);
    if (usageRisk.blocked) {
      res.status(429).json({ error: usageRisk.blocked, code: "OPTIMIZATION_USAGE_LIMIT", usageRisk });
      return;
    }

    const {
      planningInputs,
      depotLatitude,
      depotLongitude,
      timeBudgetMs,
      vehicles,
      drivers,
      stops,
      alnsNodes,
      alnsVehicles,
      driverConstraints,
      globallyIneligibleNodeIds,
      unassignedFieldServiceReasons,
    } = inputs;
    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    const planningNodes = stops.map((stop) => toAlnsNode(stop, planningInputs));
    const planningNodeById = new Map(
      planningNodes.map((node) => [node.id, node]),
    );
    const diagnosticResources = vehicles.flatMap((vehicle) => {
      const driver = drivers.find(
        (candidate) => candidate.vehicleId === vehicle.id,
      );
      const routingVehicle = alnsVehicles.find(
        (candidate) => candidate.id === vehicle.id,
      );
      return driver && routingVehicle
        ? [{ vehicle, driver, routingVehicle }]
        : [];
    });
    const weather = await getWeatherForLocation(depotLatitude, depotLongitude);
    const environment: EnvironmentContext = {
      weatherImpact: weather.drivingImpact,
      evRangeMultiplier: weather.evRangeMultiplier,
    };

    const startTime = optimizationStartTimeForRequest(
      (req.body as Record<string, unknown>).date,
    );
    const perPlanBudget = Math.max(
      5000,
      Math.floor((timeBudgetMs ?? 30000) / 3),
    );

    const alternatives = await Promise.all(
      ALTERNATIVE_PROFILES.map(async (profile) => {
        const w = normalizeWeights(profile.weights);
        const result = await optimizeWithALNS(
          alnsNodes,
          alnsVehicles,
          depotLatitude,
          depotLongitude,
          startTime,
          {
            weights: w,
            timeLimitMs: perPlanBudget,
            driverConstraints,
            environment,
            vehicleDistributionMode: inputs.vehicleDistributionMode,
          },
        );

        const totalDistanceKm = result.costBreakdown.totalDistanceKm;
        const totalCo2Kg = result.costBreakdown.totalCo2Kg;
        const totalTimeMin = result.costBreakdown.totalTimeWindowSlackMin;
        const vehicleCount = result.routes.filter(
          (r) => r.nodes.filter((n) => !n.isChargingStation).length > 0,
        ).length;
        const totalCost =
          result.costBreakdown.distanceCost +
          result.costBreakdown.co2Cost +
          result.costBreakdown.etaPrecisionCost +
          result.costBreakdown.driverPenaltyCost +
          w.geographicCohesionWeight *
            result.costBreakdown.geographicCohesionCost *
            3_000;
        const unassignedStopIds = [
          ...new Set([
            ...result.unassigned
              .filter((node) => !node.isChargingStation)
              .map((node) => node.id),
            ...globallyIneligibleNodeIds,
          ]),
        ];
        const unplannedNodes = unassignedStopIds
          .map(
            (stopId) =>
              result.unassigned.find((node) => node.id === stopId) ??
              planningNodeById.get(stopId),
          )
          .filter((node): node is ALNSNode => node != null);
        const diagnostics = classifyUnplannedNodes(
          unplannedNodes,
          stopById,
          diagnosticResources,
          depotLatitude,
          depotLongitude,
          startTime,
        );
        const diagnosticByStopId = new Map(
          diagnostics.map((diagnostic) => [diagnostic.stopId, diagnostic]),
        );
        const unassignedReasons = unassignedStopIds.map((stopId) => {
          const diagnostic = diagnosticByStopId.get(stopId);
          if (diagnostic) {
            return {
              stopId,
              reasonCodes: [diagnostic.code],
              details: [diagnostic.detail],
            };
          }
          const fieldServiceReason = unassignedFieldServiceReasons.get(stopId);
          return fieldServiceReason
            ? {
                stopId,
                reasonCodes: fieldServiceReason.reasonCodes,
                details: fieldServiceReason.details,
              }
            : {
                stopId,
                reasonCodes: ["WORKING_TIME_OR_TIME_WINDOW_EXCEEDED"],
                details: [
                  "Stoppet kan inte planeras inom valda resurser och hårda arbetstidsvillkor.",
                ],
              };
        });

        let totalDurationMin = 0;
        for (const route of result.routes) {
          if (route.nodes.filter((n) => !n.isChargingStation).length === 0)
            continue;
          let prevLat2 = depotLatitude;
          let prevLon2 = depotLongitude;
          let routeTime = 0;
          for (const node of route.nodes) {
            const d = cachedDistance(
              prevLat2,
              prevLon2,
              node.latitude,
              node.longitude,
            );
            routeTime += estimateDurationMinPredictive(d, startTime);
            routeTime += node.serviceDurationMin;
            prevLat2 = node.latitude;
            prevLon2 = node.longitude;
          }
          const dBack = cachedDistance(
            prevLat2,
            prevLon2,
            depotLatitude,
            depotLongitude,
          );
          routeTime += estimateDurationMinPredictive(dBack, startTime);
          totalDurationMin = Math.max(totalDurationMin, routeTime);
        }

        return {
          name: profile.name,
          weights: w,
          cost: Math.round(totalCost * 100) / 100,
          vehicleCount,
          stopCount: alnsNodes.length,
          unassignedCount: unassignedStopIds.length,
          unassignedStopIds,
          unassignedReasons,
          totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
          totalCo2Kg: Math.round(totalCo2Kg * 100) / 100,
          totalDurationMin: Math.round(totalDurationMin),
          totalTimeWindowSlackMin: Math.round(totalTimeMin * 100) / 100,
          routes: result.routes.map((r) => ({
            vehicleId: r.vehicleId,
            stopCount: r.nodes.filter((n) => !n.isChargingStation).length,
            stops: r.nodes
              .filter((n) => !n.isChargingStation)
              .map((n) => ({
                id: n.id,
                latitude: n.latitude,
                longitude: n.longitude,
              })),
          })),
        };
      }),
    );

    res.json({
      alternatives,
      usageRisk,
      weather: {
        description: weather.description,
        severity: getWeatherSeverity(weather),
      },
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/optimize/status/:jobId", async (req, res) => {
  try {
  const orgId = req.user!.organizationId;
  const job = orgId ? await readOptimizationJob<OptimizationJob>(orgId, req.params.jobId) : null;
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (orgId && job.organizationId !== orgId) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    stopCount: job.stopCount,
    vehicleCount: job.vehicleCount,
    result: job.status === "complete" ? job.result : undefined,
    error: job.error,
    elapsedMs: Date.now() - job.createdAt,
  });
  } catch (error) {
    handleError(res, error);
  }
});

router.post("/optimize/reoptimize", async (req, res) => {
  try {
    const parsed = ReoptimizeBody.parse(req.body);
    const {
      routeIds: suppliedRouteIds,
      reason,
      disruptionType,
      affectedStopId,
    } = parsed;
    const organizationId = assertOrgScope(req, parsed.organizationId);

    let affectedRouteIds: string[] = suppliedRouteIds ?? [];
    let additionalStopIds: string[] = [];

    if (affectedRouteIds.length === 0 && disruptionType) {
      if (disruptionType === "stop_added") {
        if (!affectedStopId) {
          res
            .status(400)
            .json({
              error: "affectedStopId is required for stop_added disruptions",
            });
          return;
        }
        const [newStop] = await db
          .select()
          .from(stopsTable)
          .where(
            and(
              eq(stopsTable.id, affectedStopId),
              eq(stopsTable.organizationId, organizationId),
            ),
          );
        if (!newStop) {
          res.status(404).json({ error: "Affected stop not found" });
          return;
        }
        if (newStop.routeId) {
          affectedRouteIds = [newStop.routeId];
        } else {
          additionalStopIds = [newStop.id];
          const activeRoutes = await db
            .select()
            .from(routesTable)
            .where(
              and(
                eq(routesTable.organizationId, organizationId),
                eq(routesTable.status, "optimized"),
              ),
            );
          if (activeRoutes.length === 0) {
            res
              .status(400)
              .json({
                error: "No optimized routes available to absorb the new stop",
              });
            return;
          }
          const nearestRoutes = [];
          for (const route of activeRoutes) {
            const routeStops = await db
              .select()
              .from(stopsTable)
              .where(
                and(
                  eq(stopsTable.routeId, route.id),
                  eq(stopsTable.organizationId, organizationId),
                  isNull(stopsTable.archivedAt),
                ),
              );
            const minDist = Math.min(
              ...routeStops.map((s) =>
                haversineDistance(
                  newStop.latitude,
                  newStop.longitude,
                  s.latitude,
                  s.longitude,
                ),
              ),
              Infinity,
            );
            nearestRoutes.push({ route, minDist });
          }
          nearestRoutes.sort((a, b) => a.minDist - b.minDist);
          affectedRouteIds = nearestRoutes.slice(0, 2).map((r) => r.route.id);
        }
      } else if (disruptionType === "stop_cancelled") {
        if (!affectedStopId) {
          res
            .status(400)
            .json({
              error:
                "affectedStopId is required for stop_cancelled disruptions",
            });
          return;
        }
        const [cancelledStop] = await db
          .select()
          .from(stopsTable)
          .where(
            and(
              eq(stopsTable.id, affectedStopId),
              eq(stopsTable.organizationId, organizationId),
            ),
          );
        if (cancelledStop?.routeId) {
          affectedRouteIds = [cancelledStop.routeId];
        } else {
          res
            .status(400)
            .json({
              error: "Cancelled stop has no assigned route to re-optimize",
            });
          return;
        }
      } else if (disruptionType === "traffic_delay") {
        if (!suppliedRouteIds || suppliedRouteIds.length === 0) {
          res
            .status(400)
            .json({
              error:
                "routeIds are required for traffic_delay disruptions to scope affected routes",
            });
          return;
        }
      } else if (disruptionType === "vehicle_breakdown") {
        if (!suppliedRouteIds || suppliedRouteIds.length === 0) {
          res
            .status(400)
            .json({
              error: "routeIds are required for vehicle_breakdown disruptions",
            });
          return;
        }
      }
    }

    if (affectedRouteIds.length === 0) {
      res
        .status(400)
        .json({
          error:
            "Could not determine affected routes. Provide routeIds or a disruptionType with affectedStopId.",
        });
      return;
    }

    const affectedRoutes = await db
      .select()
      .from(routesTable)
      .where(
        and(
          inArray(routesTable.id, affectedRouteIds),
          eq(routesTable.organizationId, organizationId),
        ),
      );

    if (
      affectedRoutes.length === 0 ||
      affectedRoutes.length !== new Set(affectedRouteIds).size
    ) {
      res.status(404).json({ error: "No matching routes found" });
      return;
    }
    const protectedRoute = affectedRoutes.find(isProtectedImportRoute);
    if (protectedRoute) {
      res.status(409).json({
        error:
          "Protected import routes cannot use generic /optimize/reoptimize. Use the protected import route reoptimization preview/apply flow.",
      });
      return;
    }
    const expectedRevisionByRoute = new Map(
      (parsed.routeRevisions ?? []).map((item) => [
        item.routeId,
        item.planRevision,
      ]),
    );
    if (
      expectedRevisionByRoute.size !== (parsed.routeRevisions?.length ?? 0) ||
      (parsed.routeRevisions &&
        (parsed.routeRevisions.length !== affectedRoutes.length ||
          affectedRoutes.some(
            (route) =>
              expectedRevisionByRoute.get(route.id) !== route.planRevision,
          ))) ||
      (parsed.planRevision != null &&
        (affectedRoutes.length !== 1 ||
          affectedRoutes[0].planRevision !== parsed.planRevision))
    ) {
      res.status(409).json({
        error:
          "One or more routes changed after reoptimization was requested. Reload and try again.",
      });
      return;
    }
    const [organization] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    const organizationPolicy = organizationPlanningPolicy(organization);
    const currentDepotSnapshot = verifiedDepotSnapshot(organization);

    const affectedVehicleIds = affectedRoutes
      .map((r) => r.vehicleId)
      .filter((id): id is string => id !== null);
    const allOrgVehicles = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));

    const allAffectedStops: (typeof stopsTable.$inferSelect)[] = [];
    for (const route of affectedRoutes) {
      const routeStops = await db
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.routeId, route.id),
            eq(stopsTable.organizationId, organizationId),
              isNull(stopsTable.archivedAt),
          ),
        );
      allAffectedStops.push(...routeStops);
    }

    const affectedPlanIds = [
      ...new Set(affectedRoutes.map((route) => route.planId)),
    ];
    if (affectedPlanIds.length > 0) {
      const previouslyUnassigned = await db
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.organizationId, organizationId),
            eq(stopsTable.status, "pending"),
            isNull(stopsTable.routeId),
            inArray(stopsTable.planningPlanId, affectedPlanIds),
          ),
        );
      allAffectedStops.push(...previouslyUnassigned);
    }
    const planningInputsByRouteId = new Map(
      affectedRoutes.map((route) => [
        route.id,
        optimizationPlanningInputsWithPolicy(route.optimizationPlanningSnapshot, organization),
      ]),
    );
    const optimizationConfigByRouteId = new Map(
      affectedRoutes.map((route) => {
        const evidence = route.planningSummary?.optimizationEvidence;
        const hasPersistedEffectiveConfig =
          evidence?.source !== "unknown" &&
          evidence?.effectiveWeights != null;
        const weights = {
          ...DEFAULT_WEIGHTS,
          ...(hasPersistedEffectiveConfig
            ? evidence.effectiveWeights
            : {}),
        };
        const vehicleDistributionMode =
          hasPersistedEffectiveConfig &&
          evidence.vehicleDistributionMode != null
            ? evidence.vehicleDistributionMode
            : ("minimize" as const);
        return [
          route.id,
          {
            weights,
            vehicleDistributionMode,
          },
        ] as const;
      }),
    );
    const optimizationConfigFingerprints = new Set(
      [...optimizationConfigByRouteId.values()].map(({ weights, vehicleDistributionMode }) =>
        JSON.stringify({
          distanceWeight: weights.distanceWeight,
          co2Weight: weights.co2Weight,
          etaPrecisionWeight: weights.etaPrecisionWeight,
          driverHappinessWeight: weights.driverHappinessWeight,
          geographicCohesionWeight: weights.geographicCohesionWeight,
          vehicleDistributionMode,
        }),
      ),
    );
    if (optimizationConfigFingerprints.size !== 1) {
      res.status(409).json({
        error:
          "Affected routes use different effective optimization configurations. Reoptimize routes with matching profiles together.",
      });
      return;
    }
    const reoptimizationConfig =
      optimizationConfigByRouteId.get(affectedRoutes[0].id)!;
    const reoptimizationEvidenceByRouteId = new Map(
      affectedRoutes.map((route) => {
        const previousEvidence = route.planningSummary?.optimizationEvidence;
        const mode = reoptimizationConfig.vehicleDistributionMode;
        const invocationEvidence =
          previousEvidence?.source !== "unknown" &&
          previousEvidence?.effectiveWeights != null
            ? {
                ...previousEvidence,
                effectiveWeights: reoptimizationConfig.weights,
                vehicleDistributionMode: mode,
                vehicleSelectionMode:
                  mode === "minimize"
                    ? ("minimize_vehicles" as const)
                    : ("use_all_selected_pairs" as const),
              }
            : optimizationEvidenceForConfig({
                source: "legacy",
                effectiveWeights: reoptimizationConfig.weights,
                vehicleDistributionMode: mode,
              });
        return [route.id, invocationEvidence] as const;
      }),
    );

    const lifecycleLockedStop = allAffectedStops.find(
      (stop) => stop.status !== "pending",
    );
    if (lifecycleLockedStop) {
      res.status(409).json({
        error:
          "Routes with active or terminal stops must use remaining-route preview so locked stops keep their route position.",
      });
      return;
    }

    const pendingStops = allAffectedStops.filter((s) => s.status === "pending");

    let extraUnassignedStops: typeof pendingStops = [];
    if (additionalStopIds.length > 0) {
      const extras = await db
        .select()
        .from(stopsTable)
        .where(
          and(
            inArray(stopsTable.id, additionalStopIds),
            eq(stopsTable.organizationId, organizationId),
          ),
        );
      extraUnassignedStops = extras.filter((s) => s.status === "pending");
      pendingStops.push(...extraUnassignedStops);
    }

    const sourceRouteByStopId = new Map(
      allAffectedStops.map((stop) => [stop.id, stop.routeId]),
    );
    for (const stop of allAffectedStops.filter(
      (candidate) => candidate.routeId == null,
    )) {
      const sourceRoute =
        affectedRoutes.find(
          (route) =>
            route.planId === stop.planningPlanId &&
            route.date.toISOString().slice(0, 10) ===
              stop.planningDate?.toISOString().slice(0, 10),
        ) ??
        affectedRoutes.find((route) => route.planId === stop.planningPlanId);
      if (sourceRoute) sourceRouteByStopId.set(stop.id, sourceRoute.id);
    }
    for (const stop of extraUnassignedStops) {
      sourceRouteByStopId.set(stop.id, affectedRoutes[0]?.id ?? null);
    }
    let currentALNSRoutes: ALNSRoute[] = affectedRoutes.map((r, idx) => {
      const routeStops = allAffectedStops.filter(
        (s) =>
          (s.routeId === r.id || sourceRouteByStopId.get(s.id) === r.id) &&
          s.status === "pending",
      );
      const planningInputs =
        planningInputsByRouteId.get(r.id) ?? normalizePlanningInputs(null);
      const nodes: ALNSNode[] = expandStopsToNodes(routeStops, planningInputs);
      if (idx === 0) {
        nodes.push(...expandStopsToNodes(extraUnassignedStops, planningInputs));
      }
      return {
        vehicleId: r.vehicleId ?? "",
        sourceRouteId: r.id,
        nodes,
        totalWeight: nodes.reduce((sum, n) => sum + (n.weightKg ?? 0), 0),
        totalVolume: nodes.reduce((sum, n) => sum + (n.volumeM3 ?? 0), 0),
        lockedFirstStopId: r.lockedFirstStopId,
      };
    });

    let alnsVehicles: ALNSVehicle[] = allOrgVehicles.map((v) => ({
      id: v.id,
      vehicleType: v.vehicleType,
      capacityKg: v.capacityKg,
      capacityVolume: v.capacityVolume,
      rangeKm: v.rangeKm,
      ...organizationPolicy,
    }));

    const startTime = affectedRoutes[0]?.date ?? new Date();

    const reoptDrivers = await db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true),
        ),
      );
    const reoptDriversFiltered = reoptDrivers.filter(
      (d) => d.vehicleId && affectedVehicleIds.includes(d.vehicleId),
    );
    const reoptDriverByVehicleId = new Map(
      reoptDriversFiltered.map((driver) => [driver.vehicleId!, driver]),
    );
    const affectedRouteByVehicleId = new Map(
      affectedRoutes
        .filter(
          (route): route is typeof route & { vehicleId: string } =>
            route.vehicleId != null,
        )
        .map((route) => [route.vehicleId, route]),
    );
    alnsVehicles = alnsVehicles.map((vehicle) => {
      const driver = reoptDriverByVehicleId.get(vehicle.id);
      const routePolicy = effectivePlanningPolicy(
        organization, affectedRouteByVehicleId.get(vehicle.id)?.optimizationPlanningSnapshot,
      );
      const routingVehicle = withOrganizationPlanningPolicy(
        driver ? applyDriverRoutingProfile(vehicle, driver) : vehicle,
        routePolicy,
      );
      const routePlanningInputs = affectedRouteByVehicleId.get(vehicle.id)
        ? planningInputsByRouteId.get(
            affectedRouteByVehicleId.get(vehicle.id)!.id,
          )
        : undefined;
      if (routePlanningInputs) {
        routingVehicle.travelReservePercent =
          routePlanningInputs.travelReservePercent;
      }
      const depotSnapshot =
        affectedRouteByVehicleId.get(vehicle.id)?.depotSnapshot ??
        currentDepotSnapshot;
      if (depotSnapshot) {
        routingVehicle.startLatitude = depotSnapshot.start.latitude;
        routingVehicle.startLongitude = depotSnapshot.start.longitude;
        routingVehicle.endLatitude = depotSnapshot.end.latitude;
        routingVehicle.endLongitude = depotSnapshot.end.longitude;
      }
      return routingVehicle;
    });
    const firstAffectedVehicle = alnsVehicles.find((vehicle) =>
      affectedVehicleIds.includes(vehicle.id),
    );
    const firstRouteDepot =
      affectedRoutes.find((route) => route.depotSnapshot)?.depotSnapshot ??
      currentDepotSnapshot;
    const depLat =
      firstRouteDepot?.start.latitude ??
      firstAffectedVehicle?.startLatitude ??
      59.3293;
    const depLon =
      firstRouteDepot?.start.longitude ??
      firstAffectedVehicle?.startLongitude ??
      18.0686;
    const reoptDriverConstraints: ALNSDriverConstraints[] = [];
    if (reoptDriversFiltered.length > 0) {
      const dIds = reoptDriversFiltered.map((d) => d.id);
      const dPrefs = await db
        .select()
        .from(driverPreferencesTable)
        .where(inArray(driverPreferencesTable.driverId, dIds));
      const pMap = new Map(dPrefs.map((p) => [p.driverId, p]));
      for (const drv of reoptDriversFiltered) {
        if (!drv.vehicleId) continue;
        const p = pMap.get(drv.id);
        reoptDriverConstraints.push({
          vehicleId: drv.vehicleId,
          driverName: drv.name,
          preferredStartTime:
            drv.workStartTime ?? p?.preferredStartTime ?? "07:00:00",
          preferredEndTime:
            drv.workEndTime ?? p?.preferredEndTime ?? "16:00:00",
          maxDrivingHoursPerDay: p?.maxDrivingHoursPerDay ?? 8,
          avoidNightDriving: p?.avoidNightDriving ?? false,
          breakFrequencyMinutes: p?.breakFrequencyMinutes ?? 120,
          preferredBreakDurationMin: p?.preferredBreakDurationMin ?? 15,
          breakStartTime: drv.breakStartTime,
          breakEndTime: drv.breakEndTime,
        });
      }
    }

    const reoptFieldServiceNodes = pendingStops
      .map((stop) =>
        toAlnsNode(
          stop,
          planningInputsByRouteId.get(sourceRouteByStopId.get(stop.id) ?? "") ??
            normalizePlanningInputs(null),
        ),
      )
      .filter((node) => node.jobType === "field_service");
    const affectedAlnsVehicles = alnsVehicles.filter((vehicle) =>
      affectedVehicleIds.includes(vehicle.id),
    );
    const globallyIneligibleReoptNodeIds =
      await applyFieldServiceEligibilityToVehicles(
        affectedAlnsVehicles,
        reoptFieldServiceNodes,
        reoptDriversFiltered,
        async (driverId, vehicleId, node) => {
          const eligibility = await checkFieldServiceEligibility(
            driverId,
            vehicleId,
            {
              requiredSkills: node.requiredSkills ?? [],
              requiredCertifications: node.requiredCertifications ?? [],
              requiredEquipment: node.requiredEquipment ?? [],
            },
            startTime,
          );
          return eligibility.eligible;
        },
      );
    if (globallyIneligibleReoptNodeIds.size > 0) {
      if (pendingStops.some(stop => globallyIneligibleReoptNodeIds.has(stop.id)
        && (stop.lockedVehicleId || stop.lockedServiceStartAt
          || affectedRoutes.some(route => route.id === stop.routeId && (route.optimizationFrozen || route.lockedFirstStopId === stop.id))))) {
        const conflict = new Error("Ett låst uppdrag kan inte utföras med sina aktuella hårda behörighetsvillkor.") as Error & { statusCode: number };
        conflict.statusCode = 409;
        throw conflict;
      }
      currentALNSRoutes = currentALNSRoutes.map((route) => {
        const nodes = route.nodes.filter(
          (node) => !globallyIneligibleReoptNodeIds.has(node.id),
        );
        return {
          ...route,
          nodes,
          totalWeight: nodes.reduce(
            (sum, node) => sum + (node.weightKg ?? 0),
            0,
          ),
          totalVolume: nodes.reduce(
            (sum, node) => sum + (node.volumeM3 ?? 0),
            0,
          ),
        };
      });
    }

    const usageRisk = await checkOptimizationUsage(organizationId, pendingStops.length);
    if (usageRisk.blocked) {
      res.status(429).json({ error: usageRisk.blocked, code: "OPTIMIZATION_USAGE_LIMIT", usageRisk });
      return;
    }
    const result = await reoptimizeAffectedRoutes(
      currentALNSRoutes,
      affectedVehicleIds,
      alnsVehicles,
      depLat,
      depLon,
      startTime,
      {
        timeLimitMs: 15000,
        driverConstraints: reoptDriverConstraints,
        weights: reoptimizationConfig.weights,
        vehicleDistributionMode: reoptimizationConfig.vehicleDistributionMode,
      },
    );

    const stopById = new Map(pendingStops.map((stop) => [stop.id, stop]));

    const planningNodeById = new Map(
      pendingStops.map((stop) => {
        const node = toAlnsNode(
          stop,
          planningInputsByRouteId.get(sourceRouteByStopId.get(stop.id) ?? "") ??
            normalizePlanningInputs(null),
        );
        return [node.id, node];
      }),
    );
    const diagnosticResources = affectedRoutes.flatMap((route) => {
      if (!route.vehicleId) return [];
      const vehicle = allOrgVehicles.find(
        (candidate) => candidate.id === route.vehicleId,
      );
      const driver = reoptDriverByVehicleId.get(route.vehicleId);
      const routingVehicle = alnsVehicles.find(
        (candidate) => candidate.id === route.vehicleId,
      );
      return vehicle && driver && routingVehicle
        ? [{ vehicle, driver, routingVehicle }]
        : [];
    });
    const allUnassignedIds = [
      ...new Set([
        ...result.unassigned
          .filter((node) => !node.isChargingStation)
          .map((node) => node.id),
        ...globallyIneligibleReoptNodeIds,
      ]),
    ];
    const unplannedNodes = allUnassignedIds
      .map(
        (stopId) =>
          result.unassigned.find((node) => node.id === stopId) ??
          planningNodeById.get(stopId),
      )
      .filter((node): node is ALNSNode => node != null);
    const diagnostics = classifyUnplannedNodes(
      unplannedNodes,
      stopById,
      diagnosticResources,
      depLat,
      depLon,
      startTime,
    );
    const diagnosticByStopId = new Map(
      diagnostics.map((diagnostic) => [diagnostic.stopId, diagnostic.detail]),
    );
    const planningSummaryByRouteId = new Map(
      affectedRoutes.map((route) => {
        const routeUnplanned = unplannedNodes.filter(
          (node) => sourceRouteByStopId.get(node.id) === route.id,
        );
        return [
          route.id,
          refreshedPlanningSummary(
            route.planningSummary,
            planningInputsByRouteId.get(route.id) ??
              normalizePlanningInputs(null),
            routeUnplanned,
            diagnosticByStopId,
            reoptimizationEvidenceByRouteId.get(route.id),
          ),
        ];
      }),
    );
    const reoptimizedRoutes = [];
    const allReoptStopUpdates: Array<{
      stopId: string;
      routeId: string;
      seqOrder: number;
      trackingCode: string;
    }> = [];
    const allReoptRouteUpdates: Array<{
      routeId: string;
      totalDistanceKm: number;
      totalDurationMin: number;
      co2EmissionsKg: number;
      totalStops: number;
      plannerItinerary: Array<{
        stopId: string;
        sequenceOrder: number;
        estimatedArrival: string;
        distanceFromPreviousKm: number;
        isChargingStop?: boolean;
        chargingStationName?: string;
      }>;
      depotSnapshot: typeof routesTable.$inferSelect.depotSnapshot;
      workdayTimeline: NonNullable<
        typeof routesTable.$inferSelect.workdayTimeline
      >;
      workdaySummary: NonNullable<
        typeof routesTable.$inferSelect.workdaySummary
      >;
      optimizationPlanningSnapshot: NonNullable<
        typeof routesTable.$inferSelect.optimizationPlanningSnapshot
      >;
      optimizationPlanningSnapshotHash: string;
      planningSummary: NonNullable<
        typeof routesTable.$inferSelect.planningSummary
      >;
      planRevision: number;
    }> = [];

    const affectedResultRoutes = affectedRoutes.map(
      (route) =>
        result.routes.find(
          (candidate) => candidate.vehicleId === route.vehicleId,
        ) ?? {
          vehicleId: route.vehicleId ?? "",
          nodes: [],
          totalWeight: 0,
          totalVolume: 0,
        },
    );

    for (const alnsRoute of affectedResultRoutes) {
      const vehicle = allOrgVehicles.find((v) => v.id === alnsRoute.vehicleId);
      if (!vehicle) continue;
      const routingVehicle = alnsVehicles.find(
        (v) => v.id === alnsRoute.vehicleId,
      );

      const routePlanningInputs = affectedRouteByVehicleId.get(vehicle.id)
        ? planningInputsByRouteId.get(
            affectedRouteByVehicleId.get(vehicle.id)!.id,
          )
        : undefined;
      if (!routingVehicle) continue;
      const constraints = reoptDriverConstraints.find(
        (item) => item.vehicleId === alnsRoute.vehicleId,
      );

      const existingRoute = affectedRoutes.find(
        (r) => r.vehicleId === vehicle.id,
      );
      const routeId = existingRoute?.id;
      if (!routeId) continue;
      if (existingRoute.optimizationFrozen) {
        reoptimizedRoutes.push({
          vehicleId: vehicle.id, routeId, stops: existingRoute.plannerItinerary ?? [],
          distanceKm: existingRoute.totalDistanceKm ?? 0, durationMin: existingRoute.totalDurationMin ?? 0,
          co2EmissionsKg: existingRoute.co2EmissionsKg ?? 0, depotSnapshot: existingRoute.depotSnapshot,
          workdayTimeline: existingRoute.workdayTimeline ?? [],
          workdaySummary: existingRoute.workdaySummary!,
        });
        continue;
      }
      const driver = reoptDriverByVehicleId.get(vehicle.id);
      if (!driver) {
        res
          .status(409)
          .json({
            error: `Rutten för ${vehicle.name} saknar en aktiv chaufför.`,
          });
        return;
      }
      const routeDepotSnapshot =
        existingRoute.depotSnapshot ?? currentDepotSnapshot;
      const routeDepotLatitude =
        routeDepotSnapshot?.start.latitude ??
        routingVehicle.startLatitude ??
        depLat;
      const routeDepotLongitude =
        routeDepotSnapshot?.start.longitude ??
        routingVehicle.startLongitude ??
        depLon;
      const workday = evaluateRouteWorkday(
        alnsRoute.nodes,
        routingVehicle,
        routeDepotLatitude,
        routeDepotLongitude,
        existingRoute.date,
        constraints,
      );
      if (!workday.feasible) {
        res.status(409).json({
          error: workdayInfeasibilityMessage(workday, {
            vehicleName: vehicle.name,
            breakStartTime: driver.breakStartTime,
            breakEndTime: driver.breakEndTime,
          }),
        });
        return;
      }
      const optimizedStops = itineraryForNodes(
        alnsRoute.nodes,
        routingVehicle,
        driver,
        routeDepotLatitude,
        routeDepotLongitude,
        existingRoute.date,
      );
      const deliveryEntries = optimizedStops.filter(
        (entry) => !entry.isChargingStop,
      );
      const trackingCodes = generateTrackingCodeBatch(deliveryEntries.length);
      const reoptStopUpdates = deliveryEntries.map((entry, index) => ({
        stopId: entry.stopId,
        routeId,
        seqOrder: entry.sequenceOrder,
        trackingCode: trackingCodes[index],
      }));
      const resultLocks = canonicalLockContext(result);
      if (resultLocks) assertCanonicalRouteResult(resultLocks, existingRoute, reoptStopUpdates.map(update => ({
        ...stopById.get(update.stopId)!, routeId, sequenceOrder: update.seqOrder,
      })), workday.events);
      const routeDistance = workday.totalDistanceKm;
      const routeDuration = workday.summary.totalMin;
      const co2 = estimateCo2(
        routeDistance,
        vehicle.vehicleType,
        alnsRoute.totalWeight,
        routingVehicle.capacityKg,
      );
      const optimizationPlanningSnapshot = {
        ...(existingRoute.optimizationPlanningSnapshot ?? {
          version: 1 as const,
          objective: "balanced" as const,
          travelReservePercent: 0,
          stopReserveMin: 0,
          stopPriorities: {},
          excludedPairValues: [],
          depotOverride: null,
          vehicleSelectionMode: "use_all_selected_pairs" as const,
        }),
        maxDriverOvertimeMin: routingVehicle.maxDriverOvertimeMin ?? 0,
        allowLateStopsMin: routingVehicle.allowLateStopsMin ?? 0,
      };
      allReoptStopUpdates.push(...reoptStopUpdates);
      allReoptRouteUpdates.push({
        routeId,
        totalDistanceKm: Math.round(routeDistance * 100) / 100,
        totalDurationMin: Math.round(routeDuration * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        totalStops: alnsRoute.nodes.filter((n) => !n.isChargingStation).length,
        plannerItinerary: optimizedStops,
        depotSnapshot: existingRoute.depotSnapshot ?? currentDepotSnapshot,
        workdayTimeline: workday.events,
        workdaySummary: workday.summary,
        optimizationPlanningSnapshot,
        optimizationPlanningSnapshotHash: payloadIdentityHash(
          optimizationPlanningSnapshot,
        ),
        planningSummary:
          planningSummaryByRouteId.get(routeId) ??
          refreshedPlanningSummary(
            existingRoute.planningSummary,
            planningInputsByRouteId.get(routeId) ??
              normalizePlanningInputs(null),
            [],
            diagnosticByStopId,
            reoptimizationEvidenceByRouteId.get(routeId),
          ),
        planRevision: existingRoute.planRevision,
      });

      reoptimizedRoutes.push({
        vehicleId: vehicle.id,
        routeId,
        stops: optimizedStops,
        distanceKm: Math.round(routeDistance * 100) / 100,
        durationMin: Math.round(routeDuration * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        depotSnapshot: existingRoute.depotSnapshot ?? currentDepotSnapshot,
        workdayTimeline: workday.events,
        workdaySummary: workday.summary,
      });
    }

    const pendingStopById = new Map(
      pendingStops.map((stop) => [stop.id, stop]),
    );
    for (const update of allReoptStopUpdates) {
      const stop = pendingStopById.get(update.stopId);
      if (stop?.jobType === "field_service") {
        await assertVehicleEligibleForFieldService(
          organizationId,
          update.routeId
            ? (affectedRoutes.find((route) => route.id === update.routeId)
                ?.vehicleId ?? null)
            : null,
          fieldServiceRequirementsFromStop(stop),
          startTime,
        );
      }
    }

    await db.transaction(async (tx) => {
      await lockCanonicalOptimizationContext(tx, result);
      for (const routeId of [...affectedRouteIds].sort()) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
        );
      }
      await lockAndValidateReoptimizationSnapshot(
        tx,
        organizationId,
        affectedRoutes,
        pendingStops,
      );
      const protectedLockedRoutes = await tx
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            inArray(routesTable.id, affectedRouteIds),
            isNotNull(routesTable.draftId),
          ),
        )
        .for("update");
      if (protectedLockedRoutes.length > 0) {
        const conflict = new Error(
          "Rutten ändrades under omplaneringen. Ladda om och försök igen.",
        ) as Error & { statusCode: number };
        conflict.statusCode = 409;
        throw conflict;
      }
      for (const stop of pendingStops) {
        if (stop.lockedVehicleId || stop.lockedServiceStartAt
          || affectedRoutes.some(route => route.id === stop.routeId
            && (route.optimizationFrozen || route.lockedFirstStopId === stop.id))) continue;
        const [cleared] = await tx
          .update(stopsTable)
          .set({
            routeId: null,
            sequenceOrder: null,
            unplannedReason: null,
          })
          .where(
            and(
              eq(stopsTable.id, stop.id),
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.status, "pending"),
              ...(stop.routeId
                ? [eq(stopsTable.routeId, stop.routeId)]
                : [isNull(stopsTable.routeId)]),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!cleared) {
          const conflict = new Error(
            "Rutten ändrades under omplaneringen. Ladda om och försök igen.",
          ) as Error & { statusCode: number };
          conflict.statusCode = 409;
          throw conflict;
        }
      }
      for (const update of allReoptStopUpdates) {
        const [savedStop] = await tx
          .update(stopsTable)
          .set({
            routeId: update.routeId,
            sequenceOrder: update.seqOrder,
            trackingCode: update.trackingCode,
            planningPlanId:
              affectedRoutes.find((route) => route.id === update.routeId)
                ?.planId ?? null,
            planningDate:
              affectedRoutes.find((route) => route.id === update.routeId)
                ?.date ?? startTime,
            unplannedReason: null,
          })
          .where(
            and(
              eq(stopsTable.id, update.stopId),
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.status, "pending"),
              pendingStopById.get(update.stopId)?.lockedVehicleId
                || pendingStopById.get(update.stopId)?.lockedServiceStartAt
                || affectedRoutes.some(route => route.lockedFirstStopId === update.stopId)
                ? eq(stopsTable.routeId, update.routeId)
                : isNull(stopsTable.routeId),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!savedStop) {
          const conflict = new Error(
            "Rutten ändrades under omplaneringen. Ladda om och försök igen.",
          ) as Error & { statusCode: number };
          conflict.statusCode = 409;
          throw conflict;
        }
      }
      for (const node of unplannedNodes) {
        const sourceRoute = affectedRoutes.find(
          (route) => route.id === sourceRouteByStopId.get(node.id),
        );
        const [savedUnplanned] = await tx
          .update(stopsTable)
          .set({
            routeId: null,
            sequenceOrder: null,
            planningPlanId:
              sourceRoute?.planId ?? affectedRoutes[0]?.planId ?? null,
            planningDate:
              sourceRoute?.date ?? affectedRoutes[0]?.date ?? startTime,
            unplannedReason:
              diagnosticByStopId.get(node.id) ??
              "Stoppet kunde inte tilldelas inom valda resurser och hårda planeringsvillkor.",
          })
          .where(
            and(
              eq(stopsTable.id, node.id),
              eq(stopsTable.organizationId, organizationId),
              eq(stopsTable.status, "pending"),
              isNull(stopsTable.routeId),
            ),
          )
          .returning({ id: stopsTable.id });
        if (!savedUnplanned) {
          const conflict = new Error(
            "Rutten ändrades under omplaneringen. Ladda om och försök igen.",
          ) as Error & { statusCode: number };
          conflict.statusCode = 409;
          throw conflict;
        }
      }
      for (const update of allReoptRouteUpdates) {
        const [savedRoute] = await tx
          .update(routesTable)
          .set({
            totalDistanceKm: update.totalDistanceKm,
            totalDurationMin: update.totalDurationMin,
            co2EmissionsKg: update.co2EmissionsKg,
            totalStops: update.totalStops,
            plannerItinerary: update.plannerItinerary,
            depotSnapshot: update.depotSnapshot,
            optimizationPlanningSnapshot: update.optimizationPlanningSnapshot,
            optimizationPlanningSnapshotHash:
              update.optimizationPlanningSnapshotHash,
            workdayTimeline: update.workdayTimeline,
            workdaySummary: update.workdaySummary,
            planningSummary: update.planningSummary,
            geographicOverlapExplanation: null,
            executionProjection: null,
            redistributionSuggestion: null,
            planRevision: sql`${routesTable.planRevision} + 1`,
            handoffStatus: "pending",
            handoffVersion: null,
            handoffDriverId: null,
            sentAt: null,
            receivedAt: null,
            openedAt: null,
            acceptedAt: null,
            rejectedAt: null,
            rejectionReason: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routesTable.id, update.routeId),
              eq(routesTable.organizationId, organizationId),
              eq(routesTable.planRevision, update.planRevision),
            ),
          )
          .returning({ id: routesTable.id });
        if (!savedRoute) {
          const conflict = new Error(
            "Rutten ändrades under omplaneringen. Ladda om och försök igen.",
          ) as Error & { statusCode: number };
          conflict.statusCode = 409;
          throw conflict;
        }
      }
      // Incremental/route-subset reoptimization does not re-evaluate every
      // nearby counterpart in the organization. Clear only derived overlap
      // evidence so an untouched third route cannot retain stale pair claims.
      await tx
        .update(routesTable)
        .set({ geographicOverlapExplanation: null })
        .where(eq(routesTable.organizationId, organizationId));
    });

    broadcast(organizationId, "routes:reoptimized", {
      routeIds: reoptimizedRoutes.map((r) => r.routeId),
      reason: reason ?? disruptionType ?? "disruption",
    });

    await db.insert(notificationsTable).values({
      organizationId,
      type: "route_started",
      title: "Routes re-optimized",
      message: `${reoptimizedRoutes.length} route(s) re-optimized due to ${reason ?? disruptionType ?? "disruption"}`,
      relatedEntityId: reoptimizedRoutes[0]?.routeId ?? null,
    });

    res.json({
      reoptimizedRoutes,
      affectedRouteIds: affectedRouteIds,
      unassignedStopIds: Array.from(
        new Set([
          ...result.unassigned.map((n) => n.id),
          ...globallyIneligibleReoptNodeIds,
        ]),
      ),
      reason: reason ?? disruptionType ?? "disruption",
      optimizer: "alns-incremental",
    });
  } catch (err) {
    handleError(res, err);
  }
});

const ContinuousStartBody = z.object({
  organizationId: z.guid(),
  routeIds: z.array(z.guid()).optional(),
  depotLatitude: z.number().optional().default(59.3293),
  depotLongitude: z.number().optional().default(18.0686),
  microIterationMs: z.number().min(50).max(500).optional().default(100),
  maxIdleMinutes: z.number().min(1).max(60).optional().default(5),
});

router.post("/optimize/continuous/start", async (req, res) => {
  try {
    const parsed = ContinuousStartBody.parse(req.body);
    const {
      organizationId: requestedOrganizationId,
      routeIds,
      depotLatitude,
      depotLongitude,
      microIterationMs,
      maxIdleMinutes,
    } = parsed;
    const organizationId = assertOrgScope(req, requestedOrganizationId);

    const existing = getActiveOptimizer(organizationId);
    if (existing?.isRunning()) {
      res
        .status(409)
        .json({
          error:
            "Continuous optimization already running for this organization",
        });
      return;
    }

    let targetRouteIds = routeIds;
    if (!targetRouteIds || targetRouteIds.length === 0) {
      const optimizedRoutes = await db
        .select()
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            inArray(routesTable.status, ["optimized", "draft", "in_progress"]),
          ),
        );
      targetRouteIds = optimizedRoutes.map((r) => r.id);
    }

    if (targetRouteIds.length === 0) {
      res
        .status(400)
        .json({ error: "No routes with pending stops found to optimize" });
      return;
    }

    const routes = await db
      .select()
      .from(routesTable)
      .where(
        and(
          inArray(routesTable.id, targetRouteIds),
          eq(routesTable.organizationId, organizationId),
        ),
      );
    const [organization] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    const organizationPolicy = organizationPlanningPolicy(organization);

    const allStops: ALNSNode[] = [];
    for (const route of routes) {
      const routeStops = await db
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.routeId, route.id),
            eq(stopsTable.organizationId, organizationId),
            isNull(stopsTable.archivedAt),
          ),
        );

      allStops.push(
        ...expandStopsToNodes(
          routeStops.filter(
            (stop) =>
              stop.status === "pending" || stop.status === "in_progress",
          ),
          optimizationPlanningInputsWithPolicy(route.optimizationPlanningSnapshot, organization),
        ),
      );
    }

    if (allStops.length === 0) {
      res
        .status(400)
        .json({ error: "No pending stops found in the selected routes" });
      return;
    }
    const usageRisk = await checkOptimizationUsage(organizationId, allStops.length);
    if (usageRisk.blocked) {
      res.status(429).json({ error: usageRisk.blocked, code: "OPTIMIZATION_USAGE_LIMIT", usageRisk });
      return;
    }

    const allVehicles = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));

    let alnsVehicles: ALNSVehicle[] = allVehicles.map((v) => ({
      id: v.id,
      vehicleType: v.vehicleType,
      capacityKg: v.capacityKg,
      capacityVolume: v.capacityVolume,
      rangeKm: v.rangeKm,
      ...organizationPolicy,
    }));
    const continuousDrivers = await db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true),
        ),
      );
    const continuousDriverByVehicleId = new Map(
      continuousDrivers
        .filter((driver) => driver.vehicleId)
        .map((driver) => [driver.vehicleId!, driver]),
    );
    alnsVehicles = alnsVehicles.map((vehicle) => {
      const driver = continuousDriverByVehicleId.get(vehicle.id);
      const sourceRoute = routes.find(route => route.vehicleId === vehicle.id);
      const routePolicy = effectivePlanningPolicy(organization, sourceRoute?.optimizationPlanningSnapshot);
      return withOrganizationPlanningPolicy(
        driver ? applyDriverRoutingProfile(vehicle, driver) : vehicle,
        routePolicy,
      );
    });
    const continuousDriverConstraints: ALNSDriverConstraints[] =
      continuousDrivers
        .filter((driver) => driver.vehicleId)
        .map((driver) => ({
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
        }));
    await applyFieldServiceEligibilityToVehicles(
      alnsVehicles,
      allStops.filter((node) => node.jobType === "field_service"),
      continuousDrivers,
      async (driverId, vehicleId, node) => {
        const eligibility = await checkFieldServiceEligibility(
          driverId,
          vehicleId,
          {
            requiredSkills: node.requiredSkills ?? [],
            requiredCertifications: node.requiredCertifications ?? [],
            requiredEquipment: node.requiredEquipment ?? [],
          },
          new Date(),
        );
        return eligibility.eligible;
      },
    );

    const stopCount = allStops.length;
    const scaledMaxTotalMinutes =
      stopCount <= 5
        ? 0.5
        : stopCount <= 15
          ? 1
          : stopCount <= 30
            ? 3
            : stopCount <= 100
              ? 10
              : 30;
    const scaledMaxIdleMinutes =
      stopCount <= 5
        ? 0.1
        : stopCount <= 15
          ? 0.25
          : stopCount <= 30
            ? 0.5
            : Math.min(maxIdleMinutes, 2);

    const continuousDate = routes[0]?.date ?? new Date();
    if (routes.some(route => route.date.getTime() !== continuousDate.getTime())) {
      res.status(409).json({ error: "Välj rutter från samma planeringsdatum för kontinuerlig optimering." });
      return;
    }
    const continuousLocks = await loadCanonicalLockInputs(allStops, alnsVehicles,
      depotLatitude, depotLongitude, continuousDate,
      { driverConstraints: continuousDriverConstraints }, routes.map(route => route.id));
    const optimizer = new ContinuousOptimizer(
      organizationId,
      allStops,
      alnsVehicles,
      depotLatitude,
      depotLongitude,
      {
        microIterationMs,
        maxIdleMinutes: scaledMaxIdleMinutes,
        maxTotalMinutes: scaledMaxTotalMinutes,
        driverConstraints: continuousLocks.config.driverConstraints,
        planningLockInputs: continuousLocks.input,
        planningDate: continuousDate,
      },
    );

    optimizer.on("improvement", (event, status) => {
      broadcast(organizationId, "optimization:improvement", {
        iteration: event.iteration,
        cost: Math.round(event.cost * 100) / 100,
        previousCost: Math.round(event.previousCost * 100) / 100,
        deltaPercent: Math.round(event.deltaPercent * 100) / 100,
        totalImprovementPercent:
          Math.round(status.totalImprovementPercent * 100) / 100,
        costBreakdown: event.costBreakdown,
        startedAt: status.startedAt,
      });
    });

    optimizer.on("stopped", (status) => {
      broadcast(organizationId, "optimization:stopped", {
        totalImprovementPercent:
          Math.round(status.totalImprovementPercent * 100) / 100,
        iterations: status.iteration,
        bestCost: Math.round(status.bestCost * 100) / 100,
        startedAt: status.startedAt,
      });
    });
    optimizer.on("planning-conflict", (error: Error) => {
      broadcast(organizationId, "optimization:stopped", { reason: "planning-lock-conflict", error: error.message });
      removeActiveOptimizer(organizationId);
    });

    optimizer.on("idle-timeout", (status) => {
      broadcast(organizationId, "optimization:stopped", {
        reason: "idle-timeout",
        totalImprovementPercent:
          Math.round(status.totalImprovementPercent * 100) / 100,
        iterations: status.iteration,
        bestCost: Math.round(status.bestCost * 100) / 100,
        startedAt: status.startedAt,
      });
      removeActiveOptimizer(organizationId);
    });

    optimizer.on("timeout", (status) => {
      broadcast(organizationId, "optimization:stopped", {
        reason: "max-time",
        totalImprovementPercent:
          Math.round(status.totalImprovementPercent * 100) / 100,
        iterations: status.iteration,
        bestCost: Math.round(status.bestCost * 100) / 100,
        startedAt: status.startedAt,
      });
      removeActiveOptimizer(organizationId);
    });

    setActiveOptimizer(organizationId, optimizer);
    await optimizer.start();

    res.json({
      message: "Continuous optimization started",
      status: optimizer.getStatus(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/optimize/continuous/stop", async (req, res) => {
  try {
    const { organizationId: requestedOrganizationId } = z
      .object({ organizationId: z.guid() })
      .parse(req.body);
    const organizationId = assertOrgScope(req, requestedOrganizationId);

    const optimizer = getActiveOptimizer(organizationId);
    if (!optimizer || !optimizer.isRunning()) {
      if (optimizer) removeActiveOptimizer(organizationId);
      res.json({
        message: "Continuous optimization already stopped",
        status: optimizer?.getStatus() ?? { running: false, organizationId },
      });
      return;
    }

    await optimizer.validatePlanningSnapshot();
    const bestSolution = optimizer.getSolution();
    optimizer.stop();
    const finalStatus = optimizer.getStatus();
    removeActiveOptimizer(organizationId);

    res.json({
      message: "Continuous optimization stopped",
      status: finalStatus,
      bestSolution: bestSolution
        ? {
            routes: bestSolution.routes.map((r) => ({
              vehicleId: r.vehicleId,
              nodeCount: r.nodes.filter((n) => !n.isChargingStation).length,
              totalWeight: r.totalWeight,
              totalVolume: r.totalVolume,
            })),
            unassignedCount: bestSolution.unassigned.length,
            cost: bestSolution.cost,
            costBreakdown: bestSolution.costBreakdown,
          }
        : null,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/optimize/continuous/status", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;

    const optimizer = getActiveOptimizer(organizationId);
    if (!optimizer) {
      res.json({ running: false, organizationId });
      return;
    }

    res.json(optimizer.getStatus());
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
