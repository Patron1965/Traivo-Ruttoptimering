import type {
  ALNSRoute, ALNSVehicle, ALNSDriverConstraints, ALNSSolution,
  OptimizationWeights, RouteEvaluation, CostBreakdown,
} from "./types";
import { getEnvCtx, FULL_CHARGE_DURATION_MIN } from "./types";
import { cachedDistance, estimateDuration, estimateCo2 } from "./distance-cache";
import { localAssignmentCost } from "./geographic-neighborhood";
import {
  evaluateRouteWorkday,
  scheduleServiceAroundUnavailable,
  stockholmClock,
} from "../route-workday";

// Kept comfortably below assignment and infeasibility penalties (10,000 / 50,000)
// while making a strongly selected preference materially affect feasible candidates.
const GEOGRAPHIC_COHESION_COST_SCALE = 3_000;

/**
 * Scores local customer ownership, never shared transit-road geometry.
 * Bounded nearest-neighbor votes keep the result in [0, 1].
 */
export function computeGeographicCohesionCost(routes: ALNSRoute[]): number {
  return localAssignmentCost(routes);
}

function parseTimeToMinutesALNS(time: string): number {
  const parts = time.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

const stockholmClockFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
});

function stockholmWallClockMinutes(date: Date): number {
  const parts = stockholmClockFormatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function evaluateDriverConstraints(
  startTime: Date,
  endTime: Date,
  constraints: ALNSDriverConstraints | undefined
): { feasible: boolean; penalty: number } {
  if (!constraints) return { feasible: true, penalty: 0 };

  let penalty = 0;
  const drivingMinutes = (endTime.getTime() - startTime.getTime()) / 60000;
  const drivingHours = drivingMinutes / 60;
  const maxHours = constraints.maxDrivingHoursPerDay;

  if (drivingHours > maxHours) {
    const overtime = drivingHours - maxHours;
    penalty += overtime * 50;
  }

  if (constraints.avoidNightDriving) {
    const endHour = stockholmWallClockMinutes(endTime) / 60;
    const startHour = stockholmWallClockMinutes(startTime) / 60;
    if (endHour >= 21 || startHour < 5) {
      penalty += 100;
    } else if (endHour >= 19) {
      penalty += (endHour - 19) * 25;
    }
  }

  const prefStartMin = parseTimeToMinutesALNS(constraints.preferredStartTime);
  const actualStartMin = stockholmWallClockMinutes(startTime);

  const startDiff = Math.abs(actualStartMin - prefStartMin);
  if (startDiff > 30) {
    penalty += (startDiff - 30) * 0.5;
  }

  // Shift end and organization overtime tolerance are evaluated by the
  // canonical workday clock below. Keeping this as a hard check here would
  // reject a route that is exactly within the configured allowance.

  return { feasible: true, penalty };
}

export function evaluateRoute(
  route: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints?: ALNSDriverConstraints
): RouteEvaluation {
  driverConstraints = vehicle.canonicalDriverConstraints ?? driverConstraints;
  const envCtx = getEnvCtx();
  const effectiveRouteStart = driverConstraints?.preferredStartTime
    ? stockholmClock(startTime, driverConstraints.preferredStartTime)
    : new Date(startTime);
  let currentTime = new Date(effectiveRouteStart);
  let prevLat = vehicle.startLatitude ?? depotLat;
  let prevLon = vehicle.startLongitude ?? depotLon;
  let totalDist = 0;
  let totalSlack = 0;
  let rangeUsed = 0;
  let chargingInsertions = 0;

  for (const node of route.nodes) {
    const effectiveRange = vehicle.rangeKm ? vehicle.rangeKm * envCtx.evRangeMultiplier : null;

    // ── Pickup & Delivery: visit pickup location first ──────────────────────
    if (node.pickupLat != null && node.pickupLon != null) {
      const distToPickup = cachedDistance(prevLat, prevLon, node.pickupLat, node.pickupLon);
      if (effectiveRange && rangeUsed + distToPickup > effectiveRange * 0.95) {
        return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
      }
      totalDist += distToPickup;
      rangeUsed += distToPickup;
      const pickupTravelMin = estimateDuration(distToPickup, currentTime, prevLat, prevLon, node.pickupLat, node.pickupLon) * (vehicle.tempoMultiplier ?? 1)
        * (1 + Math.max(0, node.travelReservePercent ?? vehicle.travelReservePercent ?? 0) / 100);
      const pickupArrival = new Date(currentTime.getTime() + pickupTravelMin * 60000);
      currentTime = pickupArrival;
      if (node.lockedServiceStartAt && currentTime < node.lockedServiceStartAt) {
        currentTime = new Date(node.lockedServiceStartAt);
      }
      const pickupServiceMin = (node.pickupServiceMin ?? node.serviceDurationMin) + (node.stopReserveMin ?? 0);
      currentTime = new Date(currentTime.getTime() + pickupServiceMin * 60000);
      prevLat = node.pickupLat;
      prevLon = node.pickupLon;
    }
    // ────────────────────────────────────────────────────────────────────────

    const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);

    if (effectiveRange && rangeUsed + dist > effectiveRange * 0.95) {
      return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
    }

    totalDist += dist;
    rangeUsed += dist;

    const travelMin = estimateDuration(dist, currentTime, prevLat, prevLon, node.latitude, node.longitude) * (vehicle.tempoMultiplier ?? 1)
      * (1 + Math.max(0, node.travelReservePercent ?? vehicle.travelReservePercent ?? 0) / 100);
    const arrival = new Date(currentTime.getTime() + travelMin * 60000);

    if (node.isChargingStation) {
      chargingInsertions++;
      const chargeDur = node.chargingDurationMin ?? FULL_CHARGE_DURATION_MIN;
      currentTime = arrival;
      currentTime = new Date(currentTime.getTime() + chargeDur * 60000);
      if (vehicle.rangeKm) {
        rangeUsed = 0;
      }
      prevLat = node.latitude;
      prevLon = node.longitude;
      continue;
    }

    if (node.timeWindowEnd) {
      const slackMs = node.timeWindowEnd.getTime() - arrival.getTime();
      totalSlack += Math.max(0, slackMs / 60000);
    }

    currentTime = new Date(arrival);
    if (node.timeWindowStart && node.timeWindowStart.getTime() > currentTime.getTime()) {
      if (currentTime < node.timeWindowStart) currentTime = new Date(node.timeWindowStart);
    }
    if (node.pickupLat == null && node.lockedServiceStartAt && currentTime < node.lockedServiceStartAt) {
      currentTime = new Date(node.lockedServiceStartAt);
    }
    const deliverySchedule = scheduleServiceAroundUnavailable(
      currentTime,
      node.serviceDurationMin,
      node.unavailablePeriods,
    );
    if (!deliverySchedule.valid) {
      return {
        feasible: false,
        totalDistanceKm: totalDist,
        totalCo2Kg: 0,
        totalTimeWindowSlackMin: Infinity,
        endTime: currentTime,
        rangeUsedKm: rangeUsed,
        chargingInsertions,
        driverPenalty: 0,
      };
    }
    // Closures apply to delivery service only. Stop reserve is an operational
    // post-service buffer and may be consumed after the closure ends.
    currentTime = new Date(
      deliverySchedule.end.getTime() + (node.stopReserveMin ?? 0) * 60000,
    );
    prevLat = node.latitude;
    prevLon = node.longitude;
  }

  const endLat = vehicle.endLatitude ?? vehicle.startLatitude ?? depotLat;
  const endLon = vehicle.endLongitude ?? vehicle.startLongitude ?? depotLon;
  const returnDist = cachedDistance(prevLat, prevLon, endLat, endLon);
  totalDist += returnDist;
  const returnTravelMin = estimateDuration(
    returnDist,
    currentTime,
    prevLat,
    prevLon,
    endLat,
    endLon,
  ) * (vehicle.tempoMultiplier ?? 1)
    * (1 + Math.max(0, vehicle.travelReservePercent ?? 0) / 100);
  currentTime = new Date(currentTime.getTime() + returnTravelMin * 60000);
  const returnRange = vehicle.rangeKm ? vehicle.rangeKm * envCtx.evRangeMultiplier : null;
  if (returnRange && rangeUsed + returnDist > returnRange * 0.9) {
    return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
  }

  if (route.totalWeight > vehicle.capacityKg || route.totalVolume > vehicle.capacityVolume) {
    return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
  }

  // Field service hard requirement: block if any node is ineligible for this vehicle
  if (vehicle.ineligibleStopIds && vehicle.ineligibleStopIds.size > 0) {
    for (const node of route.nodes) {
      if (!node.isChargingStation && vehicle.ineligibleStopIds.has(node.id)) {
        return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
      }
    }
  }

  // The persisted route clock is authoritative for breaks, return, and shift
  // end. Keep the preceding loop for fast capacity/range/time-window pruning,
  // then make the canonical final decision from the shared evaluator.
  const workday = evaluateRouteWorkday(route.nodes, vehicle, depotLat, depotLon, startTime, driverConstraints);
  totalDist = workday.totalDistanceKm;
  currentTime = workday.endTime;
  rangeUsed = workday.rangeUsedKm;
  const co2 = estimateCo2(totalDist, vehicle.vehicleType, route.totalWeight, vehicle.capacityKg);

  const canonicalStart = workday.events[0]?.startAt
    ? new Date(workday.events[0].startAt)
    : effectiveRouteStart;
  const driverEval = evaluateDriverConstraints(canonicalStart, currentTime, driverConstraints);
  if (!workday.feasible || !driverEval.feasible) {
    return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: co2, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: driverEval.penalty };
  }

  return {
    feasible: true,
    drivingMinutes: workday.summary.nonReturnDrivingMin + workday.summary.returnMin,
    actualWorkMinutes: workday.events.reduce((sum, event) =>
      sum + (["driving", "return", "service"].includes(event.type) ? event.durationMin : 0), 0),
    totalDistanceKm: totalDist,
    totalCo2Kg: co2,
    totalTimeWindowSlackMin: totalSlack,
    endTime: currentTime,
    rangeUsedKm: rangeUsed,
    chargingInsertions,
    driverPenalty: driverEval.penalty,
  };
}

export function computeSolutionCost(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap?: Map<string, ALNSDriverConstraints>,
  vehicleDistributionMode: "minimize" | "balance" = "minimize",
  scoringCache?: { evaluations: WeakMap<ALNSRoute, RouteEvaluation>; geographicCohesionCost?: number },
): { cost: number; breakdown: CostBreakdown } {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  let totalDist = 0;
  let totalDriving = 0;
  let totalCo2 = 0;
  let totalSlack = 0;
  let totalDriverPenalty = 0;
  let allFeasible = true;
  let infeasibleRoutes = 0;
  const actualWork: Record<string, number> = Object.fromEntries(vehicles.map(v => [v.id, 0]));
  const routeWorkMinutes: number[] = [];

  for (const route of solution.routes) {
    if (route.nodes.length === 0) {
      routeWorkMinutes.push(0);
      continue;
    }
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle) { allFeasible = false; infeasibleRoutes++; continue; }

    // Use the same authoritative profile as evaluateRouteWorkday. Otherwise
    // canonical-only vehicles are scored from UTC midnight rather than their
    // actual shift start, skewing balanced workload comparisons.
    const constraints = vehicle.canonicalDriverConstraints ?? driverConstraintsMap?.get(route.vehicleId);
    const evalResult = scoringCache?.evaluations.get(route)
      ?? evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
    scoringCache?.evaluations.set(route, evalResult);
    if (!evalResult.feasible) {
      allFeasible = false;
      infeasibleRoutes++;
    }
    actualWork[route.vehicleId] = (actualWork[route.vehicleId] ?? 0) + (evalResult.actualWorkMinutes ?? 0);
    totalDist += evalResult.totalDistanceKm;
    totalDriving += evalResult.drivingMinutes ?? 0;
    totalCo2 += evalResult.totalCo2Kg;
    totalSlack += evalResult.totalTimeWindowSlackMin;
    totalDriverPenalty += evalResult.driverPenalty;
    const effectiveStart = constraints?.preferredStartTime
      ? stockholmClock(startTime, constraints.preferredStartTime)
      : startTime;
    routeWorkMinutes.push(Math.max(0, (evalResult.endTime.getTime() - effectiveStart.getTime()) / 60000));
  }

  // Mandatory (2) stops must dominate all soft choices. High-priority stops
  // are still materially preferred before normal stops when capacity is short.
  const unassignedPenalty = solution.unassigned.reduce(
    (sum, node) => sum + (node.planningPriority === 2 ? 1_000_000 : node.planningPriority === 1 ? 100_000 : 10_000),
    0,
  );
  const infeasibilityPenalty = allFeasible ? 0 : 50000;
  // Do not introduce new road-leg requirements or search work for customers
  // who did not select the geographic objective.
  const geographicCohesionCost = scoringCache?.geographicCohesionCost ?? (
    weights.geographicCohesionWeight > 0 || weights.objectivePriority === "areas_worktime"
      ? computeGeographicCohesionCost(solution.routes) : 0);

  const normalizedSlackPenalty = totalSlack > 0 ? totalSlack / 60 : 0;
  const activeRouteCount = solution.routes.filter((route) => route.nodes.some((node) => !node.isChargingStation)).length;
  // Minimax reduces the longest workday without rewarding detours on shorter
  // routes. Fleet occupancy is enforced separately by the import repair gate.
  // Absolute deviation/spread is unsafe: adding driving can reduce that score.
  const distributionPenalty = vehicleDistributionMode === "balance"
    ? Math.max(0, ...routeWorkMinutes) * 20 * (weights.workloadBalanceWeight ?? 1)
    : weights.searchProfile ? Math.max(0, ...routeWorkMinutes) * 20 * (weights.workloadBalanceWeight ?? 0)
      : activeRouteCount * 1000;

  const cost =
    weights.distanceWeight * totalDist +
    weights.co2Weight * totalCo2 * 100 +
    weights.etaPrecisionWeight * normalizedSlackPenalty * 10 +
    weights.driverHappinessWeight * totalDriverPenalty +
    weights.geographicCohesionWeight * geographicCohesionCost * GEOGRAPHIC_COHESION_COST_SCALE +
    distributionPenalty +
    unassignedPenalty +
    infeasibilityPenalty;

  return {
    cost,
    breakdown: {
      ...(weights.searchProfile ? {
        profileScore: [
          infeasibleRoutes,
          solution.unassigned.filter(n => !n.isChargingStation && n.planningPriority === 2).length,
          solution.unassigned.filter(n => !n.isChargingStation && n.planningPriority === 1).length,
          solution.unassigned.filter(n => !n.isChargingStation).length,
          ...(weights.searchProfile === "shortest" ? [totalDist, totalDriving]
            : weights.searchProfile === "geographic" ? [geographicCohesionCost, totalDist, totalDriving]
            : weights.searchProfile === "areas_worktime" ? [geographicCohesionCost, Math.max(0, ...routeWorkMinutes), totalDist]
            : weights.searchProfile === "minimize_vehicles" ? [activeRouteCount, cost]
            : [cost]),
        ],
      } : {}),
      ...(weights.objectivePriority === "areas_worktime" ? {
        areasWorktime: {
          infeasibleRoutes,
          unassignedMandatory: solution.unassigned.filter(n => !n.isChargingStation && n.planningPriority === 2).length,
          unassignedCustomers: solution.unassigned.filter(n => !n.isChargingStation).length,
          worktimeSpreadMin: Object.keys(actualWork).length
            ? Math.max(...Object.values(actualWork)) - Math.min(...Object.values(actualWork)) : 0,
          routeWorkMinutes: actualWork,
        },
      } : {}),
      distanceCost: totalDist,
      co2Cost: totalCo2,
      etaPrecisionCost: normalizedSlackPenalty,
      driverPenaltyCost: weights.driverHappinessWeight * totalDriverPenalty,
      geographicCohesionCost,
      totalDistanceKm: totalDist,
      totalCo2Kg: totalCo2,
      totalTimeWindowSlackMin: totalSlack,
      totalDriverPenalty,
    },
  };
}

/** Explicit lexicographic order; scalar legacy cost is telemetry, not a proxy. */
export function compareSolutionScores(
  left: { cost: number; breakdown: CostBreakdown },
  right: { cost: number; breakdown: CostBreakdown },
): number {
  const leftProfile = left.breakdown.profileScore;
  const rightProfile = right.breakdown.profileScore;
  if (leftProfile && rightProfile) {
    for (let i = 0; i < leftProfile.length; i++) {
      if (Math.abs(leftProfile[i] - rightProfile[i]) > 1e-9)
        return leftProfile[i] < rightProfile[i] ? -1 : 1;
    }
    return 0;
  }
  const a = left.breakdown.areasWorktime;
  const b = right.breakdown.areasWorktime;
  if (!a || !b) return left.cost - right.cost;
  const pairs = [
    [a.infeasibleRoutes, b.infeasibleRoutes],
    [a.unassignedMandatory, b.unassignedMandatory],
    [a.unassignedCustomers, b.unassignedCustomers],
    [left.breakdown.geographicCohesionCost, right.breakdown.geographicCohesionCost],
    [Math.max(0, ...Object.values(a.routeWorkMinutes)), Math.max(0, ...Object.values(b.routeWorkMinutes))],
    [left.breakdown.totalDistanceKm, right.breakdown.totalDistanceKm],
  ];
  for (const [x, y] of pairs) if (Math.abs(x - y) > 1e-9) return x < y ? -1 : 1;
  return 0;
}

export function compareSolutions(left: ALNSSolution, right: ALNSSolution): number {
  return compareSolutionScores(
    { cost: left.cost, breakdown: left.costBreakdown },
    { cost: right.cost, breakdown: right.costBreakdown },
  );
}

export function evaluateRouteCost(
  evalResult: { totalDistanceKm: number; totalCo2Kg: number; totalTimeWindowSlackMin: number; driverPenalty: number },
  weights: OptimizationWeights
): number {
  return weights.distanceWeight * evalResult.totalDistanceKm
    + weights.co2Weight * evalResult.totalCo2Kg * 100
    + weights.etaPrecisionWeight * (evalResult.totalTimeWindowSlackMin / 60) * 10
    + weights.driverHappinessWeight * evalResult.driverPenalty;
}
