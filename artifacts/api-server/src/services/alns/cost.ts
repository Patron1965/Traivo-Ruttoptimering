import type {
  ALNSRoute, ALNSVehicle, ALNSDriverConstraints, ALNSSolution,
  OptimizationWeights, RouteEvaluation, CostBreakdown,
} from "./types";
import { getEnvCtx, FULL_CHARGE_DURATION_MIN } from "./types";
import { cachedDistance, estimateDuration, estimateCo2 } from "./distance-cache";

function parseTimeToMinutesALNS(time: string): number {
  const parts = time.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
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
    if (overtime > 2) {
      return { feasible: false, penalty: Infinity };
    }
    penalty += overtime * 50;
  }

  if (constraints.avoidNightDriving) {
    const endHour = endTime.getHours() + endTime.getMinutes() / 60;
    const startHour = startTime.getHours() + startTime.getMinutes() / 60;
    if (endHour >= 21 || startHour < 5) {
      penalty += 100;
    } else if (endHour >= 19) {
      penalty += (endHour - 19) * 25;
    }
  }

  const prefStartMin = parseTimeToMinutesALNS(constraints.preferredStartTime);
  const prefEndMin = parseTimeToMinutesALNS(constraints.preferredEndTime);
  const actualStartMin = startTime.getHours() * 60 + startTime.getMinutes();
  const actualEndMin = endTime.getHours() * 60 + endTime.getMinutes();

  const startDiff = Math.abs(actualStartMin - prefStartMin);
  if (startDiff > 30) {
    penalty += (startDiff - 30) * 0.5;
  }

  const endOvershoot = Math.max(0, actualEndMin - prefEndMin);
  if (endOvershoot > 0) {
    penalty += endOvershoot * 0.8;
  }

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
  const envCtx = getEnvCtx();
  let currentTime = new Date(startTime);
  let prevLat = depotLat;
  let prevLon = depotLon;
  let totalDist = 0;
  let totalSlack = 0;
  let rangeUsed = 0;
  let chargingInsertions = 0;

  for (const node of route.nodes) {
    const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);

    const effectiveRange = vehicle.rangeKm ? vehicle.rangeKm * envCtx.evRangeMultiplier : null;
    if (effectiveRange && rangeUsed + dist > effectiveRange * 0.95) {
      return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
    }

    totalDist += dist;
    rangeUsed += dist;

    const travelMin = estimateDuration(dist, currentTime, prevLat, prevLon, node.latitude, node.longitude);
    const arrival = new Date(currentTime.getTime() + travelMin * 60000);

    if (node.isChargingStation) {
      chargingInsertions++;
      const chargeDur = node.chargingDurationMin ?? FULL_CHARGE_DURATION_MIN;
      currentTime = new Date(arrival.getTime() + chargeDur * 60000);
      if (vehicle.rangeKm) {
        rangeUsed = 0;
      }
      prevLat = node.latitude;
      prevLon = node.longitude;
      continue;
    }

    if (node.timeWindowEnd && arrival.getTime() > node.timeWindowEnd.getTime()) {
      return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: arrival, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
    }

    if (node.timeWindowEnd) {
      const slackMs = node.timeWindowEnd.getTime() - arrival.getTime();
      totalSlack += slackMs / 60000;
    }

    const effectiveStart = node.timeWindowStart && node.timeWindowStart.getTime() > arrival.getTime()
      ? node.timeWindowStart
      : arrival;
    currentTime = new Date(effectiveStart.getTime() + node.serviceDurationMin * 60000);
    prevLat = node.latitude;
    prevLon = node.longitude;
  }

  const returnDist = cachedDistance(prevLat, prevLon, depotLat, depotLon);
  const returnRange = vehicle.rangeKm ? vehicle.rangeKm * envCtx.evRangeMultiplier : null;
  if (returnRange && rangeUsed + returnDist > returnRange * 0.9) {
    return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
  }

  if (route.totalWeight > vehicle.capacityKg || route.totalVolume > vehicle.capacityVolume) {
    return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
  }

  const co2 = estimateCo2(totalDist, vehicle.vehicleType, route.totalWeight, vehicle.capacityKg);

  const driverEval = evaluateDriverConstraints(startTime, currentTime, driverConstraints);
  if (!driverEval.feasible) {
    return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: co2, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: driverEval.penalty };
  }

  return {
    feasible: true,
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
  driverConstraintsMap?: Map<string, ALNSDriverConstraints>
): { cost: number; breakdown: CostBreakdown } {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  let totalDist = 0;
  let totalCo2 = 0;
  let totalSlack = 0;
  let totalDriverPenalty = 0;
  let allFeasible = true;

  for (const route of solution.routes) {
    if (route.nodes.length === 0) continue;
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle) continue;

    const constraints = driverConstraintsMap?.get(route.vehicleId);
    const evalResult = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
    if (!evalResult.feasible) {
      allFeasible = false;
    }
    totalDist += evalResult.totalDistanceKm;
    totalCo2 += evalResult.totalCo2Kg;
    totalSlack += evalResult.totalTimeWindowSlackMin;
    totalDriverPenalty += evalResult.driverPenalty;
  }

  const unassignedPenalty = solution.unassigned.length * 10000;
  const infeasibilityPenalty = allFeasible ? 0 : 50000;

  const normalizedSlackPenalty = totalSlack > 0 ? totalSlack / 60 : 0;

  const cost =
    weights.distanceWeight * totalDist +
    weights.co2Weight * totalCo2 * 100 +
    weights.etaPrecisionWeight * normalizedSlackPenalty * 10 +
    weights.driverHappinessWeight * totalDriverPenalty +
    unassignedPenalty +
    infeasibilityPenalty;

  return {
    cost,
    breakdown: {
      distanceCost: totalDist,
      co2Cost: totalCo2,
      etaPrecisionCost: normalizedSlackPenalty,
      driverPenaltyCost: weights.driverHappinessWeight * totalDriverPenalty,
      totalDistanceKm: totalDist,
      totalCo2Kg: totalCo2,
      totalTimeWindowSlackMin: totalSlack,
      totalDriverPenalty,
    },
  };
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
