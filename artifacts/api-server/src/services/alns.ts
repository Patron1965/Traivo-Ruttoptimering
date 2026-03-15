import { estimateDurationMinPredictive } from "./eta";

export interface ALNSNode {
  id: string;
  latitude: number;
  longitude: number;
  timeWindowStart: Date | null;
  timeWindowEnd: Date | null;
  serviceDurationMin: number;
  weightKg: number;
  volumeM3: number;
  isChargingStation?: boolean;
  chargingStationName?: string;
  chargingDurationMin?: number;
}

export interface ALNSVehicle {
  id: string;
  vehicleType: string;
  capacityKg: number;
  capacityVolume: number;
  rangeKm: number | null;
}

export interface ALNSDriverConstraints {
  vehicleId: string;
  driverName: string;
  preferredStartTime: string;
  preferredEndTime: string;
  maxDrivingHoursPerDay: number;
  avoidNightDriving: boolean;
  breakFrequencyMinutes: number;
  preferredBreakDurationMin: number;
}

export interface ALNSRoute {
  vehicleId: string;
  nodes: ALNSNode[];
  totalWeight: number;
  totalVolume: number;
}

export interface ALNSSolution {
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  cost: number;
  costBreakdown: CostBreakdown;
}

export interface CostBreakdown {
  distanceCost: number;
  co2Cost: number;
  etaPrecisionCost: number;
  driverPenaltyCost: number;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalTimeWindowSlackMin: number;
  totalDriverPenalty: number;
}

export interface OptimizationWeights {
  distanceWeight: number;
  co2Weight: number;
  etaPrecisionWeight: number;
  driverHappinessWeight: number;
}

const DEFAULT_WEIGHTS: OptimizationWeights = {
  distanceWeight: 0.45,
  co2Weight: 0.25,
  etaPrecisionWeight: 0.15,
  driverHappinessWeight: 0.15,
};

const CHARGING_STATIONS: ALNSNode[] = [
  { id: "cs-1", name: "Ionity Stockholm North", latitude: 59.3850, longitude: 18.0200 },
  { id: "cs-2", name: "Recharge Solna", latitude: 59.3600, longitude: 18.0000 },
  { id: "cs-3", name: "Tesla SC Kista", latitude: 59.4050, longitude: 17.9450 },
  { id: "cs-4", name: "Vattenfall Södermalm", latitude: 59.3150, longitude: 18.0700 },
  { id: "cs-5", name: "Mer Hammarby", latitude: 59.3050, longitude: 18.1000 },
  { id: "cs-6", name: "Ionity Nacka", latitude: 59.3100, longitude: 18.1600 },
  { id: "cs-7", name: "Recharge Bromma", latitude: 59.3400, longitude: 17.9400 },
  { id: "cs-8", name: "E.ON Järfälla", latitude: 59.4300, longitude: 17.8700 },
  { id: "cs-9", name: "Fortum Lidingö", latitude: 59.3700, longitude: 18.1500 },
  { id: "cs-10", name: "ChargeNode Danderyd", latitude: 59.3950, longitude: 18.0600 },
].map(s => ({
  id: s.id,
  latitude: s.latitude,
  longitude: s.longitude,
  timeWindowStart: null,
  timeWindowEnd: null,
  serviceDurationMin: 0,
  weightKg: 0,
  volumeM3: 0,
  isChargingStation: true,
  chargingStationName: s.name,
  chargingDurationMin: 30,
}));

const FULL_CHARGE_DURATION_MIN = 30;
const MIN_CHARGE_DURATION_MIN = 10;
const EV_CONSUMPTION_KM_PER_KWH = 5;

const EMISSION_PROFILES: Record<string, { gCo2PerKm: number; loadFactor: number }> = {
  fossil: { gCo2PerKm: 210, loadFactor: 1.15 },
  electric: { gCo2PerKm: 50, loadFactor: 1.05 },
  hybrid: { gCo2PerKm: 130, loadFactor: 1.10 },
};

class DistanceMatrixCache {
  private cache = new Map<string, number>();

  private key(lat1: number, lon1: number, lat2: number, lon2: number): string {
    return `${lat1.toFixed(6)},${lon1.toFixed(6)}-${lat2.toFixed(6)},${lon2.toFixed(6)}`;
  }

  get(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const k = this.key(lat1, lon1, lat2, lon2);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;

    const dist = haversineDistance(lat1, lon1, lat2, lon2);
    this.cache.set(k, dist);
    this.cache.set(this.key(lat2, lon2, lat1, lon1), dist);
    return dist;
  }

  invalidate(lat: number, lon: number): void {
    const prefix = `${lat.toFixed(6)},${lon.toFixed(6)}-`;
    const suffix = `-${lat.toFixed(6)},${lon.toFixed(6)}`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix) || k.endsWith(suffix)) {
        this.cache.delete(k);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

const globalDistanceCache = new DistanceMatrixCache();

export function getDistanceCache(): DistanceMatrixCache {
  return globalDistanceCache;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function cachedDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return globalDistanceCache.get(lat1, lon1, lat2, lon2);
}

function estimateDuration(distanceKm: number, departureTime?: Date): number {
  if (departureTime) {
    return estimateDurationMinPredictive(distanceKm, departureTime);
  }
  return (distanceKm / 35) * 60;
}

function estimateCo2(distanceKm: number, vehicleType: string, loadKg = 0, capacityKg = 1000): number {
  const profile = EMISSION_PROFILES[vehicleType] ?? EMISSION_PROFILES.fossil;
  const loadRatio = capacityKg > 0 ? Math.min(loadKg / capacityKg, 1) : 0;
  const loadAdjustment = 1 + loadRatio * (profile.loadFactor - 1);
  return (distanceKm * profile.gCo2PerKm * loadAdjustment) / 1000;
}

interface RouteEvaluation {
  feasible: boolean;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalTimeWindowSlackMin: number;
  endTime: Date;
  rangeUsedKm: number;
  chargingInsertions: number;
  driverPenalty: number;
}

function parseTimeToMinutesALNS(time: string): number {
  const parts = time.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function evaluateDriverConstraints(
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

function evaluateRoute(
  route: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints?: ALNSDriverConstraints
): RouteEvaluation {
  let currentTime = new Date(startTime);
  let prevLat = depotLat;
  let prevLon = depotLon;
  let totalDist = 0;
  let totalSlack = 0;
  let rangeUsed = 0;
  let chargingInsertions = 0;

  for (const node of route.nodes) {
    const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);

    if (vehicle.rangeKm && rangeUsed + dist > vehicle.rangeKm * 0.95) {
      return { feasible: false, totalDistanceKm: totalDist, totalCo2Kg: 0, totalTimeWindowSlackMin: Infinity, endTime: currentTime, rangeUsedKm: rangeUsed, chargingInsertions, driverPenalty: 0 };
    }

    totalDist += dist;
    rangeUsed += dist;

    const travelMin = estimateDuration(dist, currentTime);
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
  if (vehicle.rangeKm && rangeUsed + returnDist > vehicle.rangeKm * 0.9) {
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

function computeSolutionCost(
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

function deepCloneSolution(sol: ALNSSolution): ALNSSolution {
  return {
    routes: sol.routes.map(r => ({
      vehicleId: r.vehicleId,
      nodes: r.nodes.map(n => ({ ...n })),
      totalWeight: r.totalWeight,
      totalVolume: r.totalVolume,
    })),
    unassigned: sol.unassigned.map(n => ({ ...n })),
    cost: sol.cost,
    costBreakdown: { ...sol.costBreakdown },
  };
}

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

function randomRemoval(solution: ALNSSolution, count: number): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const activeRoutes = solution.routes.filter(r => r.nodes.filter(n => !n.isChargingStation).length > 0);
  if (activeRoutes.length === 0) return removed;

  for (let i = 0; i < count; i++) {
    const routeIdx = randomInt(activeRoutes.length);
    const route = activeRoutes[routeIdx];
    const deliveryNodes = route.nodes.filter(n => !n.isChargingStation);
    if (deliveryNodes.length === 0) continue;

    const nodeIdx = randomInt(deliveryNodes.length);
    const node = deliveryNodes[nodeIdx];
    route.nodes = route.nodes.filter(n => n.id !== node.id);
    route.totalWeight -= node.weightKg;
    route.totalVolume -= node.volumeM3;
    removed.push(node);
  }

  return removed;
}

function worstRemoval(
  solution: ALNSSolution,
  count: number,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights
): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));

  for (let i = 0; i < count; i++) {
    let worstNode: ALNSNode | null = null;
    let worstRouteRef: ALNSRoute | null = null;
    let worstCostDiff = -Infinity;

    for (const route of solution.routes) {
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle) continue;

      const baseCost = evaluateRoute(route, vehicle, depotLat, depotLon, startTime);
      const deliveryNodes = route.nodes.filter(n => !n.isChargingStation);

      for (const node of deliveryNodes) {
        const testRoute: ALNSRoute = {
          ...route,
          nodes: route.nodes.filter(n => n.id !== node.id),
          totalWeight: route.totalWeight - node.weightKg,
          totalVolume: route.totalVolume - node.volumeM3,
        };
        const removedCost = evaluateRoute(testRoute, vehicle, depotLat, depotLon, startTime);
        const costDiff = baseCost.totalDistanceKm * weights.distanceWeight - removedCost.totalDistanceKm * weights.distanceWeight;

        if (costDiff > worstCostDiff) {
          worstCostDiff = costDiff;
          worstNode = node;
          worstRouteRef = route;
        }
      }
    }

    if (worstNode && worstRouteRef) {
      worstRouteRef.nodes = worstRouteRef.nodes.filter(n => n.id !== worstNode!.id);
      worstRouteRef.totalWeight -= worstNode.weightKg;
      worstRouteRef.totalVolume -= worstNode.volumeM3;
      removed.push(worstNode);
    }
  }

  return removed;
}

function shawRemoval(solution: ALNSSolution, count: number): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const activeRoutes = solution.routes.filter(r => r.nodes.filter(n => !n.isChargingStation).length > 0);
  if (activeRoutes.length === 0) return removed;

  const routeIdx = randomInt(activeRoutes.length);
  const route = activeRoutes[routeIdx];
  const deliveryNodes = route.nodes.filter(n => !n.isChargingStation);
  if (deliveryNodes.length === 0) return removed;

  const seedNode = deliveryNodes[randomInt(deliveryNodes.length)];
  route.nodes = route.nodes.filter(n => n.id !== seedNode.id);
  route.totalWeight -= seedNode.weightKg;
  route.totalVolume -= seedNode.volumeM3;
  removed.push(seedNode);

  const allDeliveryNodes: { node: ALNSNode; route: ALNSRoute }[] = [];
  for (const r of solution.routes) {
    for (const n of r.nodes) {
      if (!n.isChargingStation) {
        allDeliveryNodes.push({ node: n, route: r });
      }
    }
  }

  allDeliveryNodes.sort((a, b) => {
    const distA = cachedDistance(seedNode.latitude, seedNode.longitude, a.node.latitude, a.node.longitude);
    const distB = cachedDistance(seedNode.latitude, seedNode.longitude, b.node.latitude, b.node.longitude);
    return distA - distB;
  });

  for (const { node, route: nodeRoute } of allDeliveryNodes) {
    if (removed.length >= count) break;
    if (removed.some(r => r.id === node.id)) continue;
    nodeRoute.nodes = nodeRoute.nodes.filter(n => n.id !== node.id);
    nodeRoute.totalWeight -= node.weightKg;
    nodeRoute.totalVolume -= node.volumeM3;
    removed.push(node);
  }

  return removed;
}

function chargingStationRemoval(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[]
): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));

  for (const route of solution.routes) {
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle || vehicle.vehicleType !== "electric") continue;

    const chargingIndices = route.nodes
      .map((n, i) => n.isChargingStation ? i : -1)
      .filter(i => i >= 0);
    if (chargingIndices.length === 0) continue;

    const targetIdx = chargingIndices[randomInt(chargingIndices.length)];
    const nodeToRemove = route.nodes[targetIdx];
    route.nodes.splice(targetIdx, 1);
    removed.push(nodeToRemove);
  }

  return removed;
}

// Future: Integrate electricity spot prices (SE1-SE4) from the electricity service
// to prefer charging stations during low-price windows. Use getOptimalChargingWindow()
// to score insertion candidates by energy cost, not just distance/SoC.
function chargingStationInsertion(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date
): void {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const MAX_CHARGING_INSERTS_PER_ROUTE = 5;

  for (const route of solution.routes) {
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle || !vehicle.rangeKm || vehicle.vehicleType !== "electric") continue;

    let rangeUsed = 0;
    let prevLat = depotLat;
    let prevLon = depotLon;
    let chargingInserts = route.nodes.filter(n => n.isChargingStation).length;

    for (let i = 0; i < route.nodes.length; i++) {
      if (chargingInserts >= MAX_CHARGING_INSERTS_PER_ROUTE) break;

      const node = route.nodes[i];
      if (node.isChargingStation) {
        rangeUsed = 0;
        prevLat = node.latitude;
        prevLon = node.longitude;
        continue;
      }

      const distToNode = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);
      const returnDist = cachedDistance(node.latitude, node.longitude, depotLat, depotLon);

      if (rangeUsed + distToNode + returnDist > vehicle.rangeKm * 0.85) {
        let bestStation: ALNSNode | null = null;
        let bestDetour = Infinity;

        for (const station of CHARGING_STATIONS) {
          const distToStation = cachedDistance(prevLat, prevLon, station.latitude, station.longitude);
          if (distToStation > (vehicle.rangeKm - rangeUsed) * 0.95) continue;

          const distFromStation = cachedDistance(station.latitude, station.longitude, node.latitude, node.longitude);
          const detour = distToStation + distFromStation - distToNode;

          if (detour < bestDetour) {
            bestDetour = detour;
            bestStation = station;
          }
        }

        if (bestStation) {
          const remainingRouteKm = estimateRemainingRouteDistance(route.nodes, i, depotLat, depotLon);
          const neededRangeKm = remainingRouteKm * 1.15;
          const chargeRatio = Math.min(1, neededRangeKm / vehicle.rangeKm);
          const chargeDuration = Math.max(MIN_CHARGE_DURATION_MIN, Math.round(chargeRatio * FULL_CHARGE_DURATION_MIN));

          route.nodes.splice(i, 0, {
            ...bestStation,
            chargingDurationMin: chargeDuration,
          });
          chargingInserts++;
          rangeUsed = 0;
          prevLat = bestStation.latitude;
          prevLon = bestStation.longitude;
          continue;
        }
      }

      rangeUsed += distToNode;
      prevLat = node.latitude;
      prevLon = node.longitude;
    }
  }
}

function greedyInsertion(
  solution: ALNSSolution,
  nodesToInsert: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date
): void {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));

  for (const node of nodesToInsert) {
    let bestRoute: ALNSRoute | null = null;
    let bestPosition = -1;
    let bestCostIncrease = Infinity;

    for (const route of solution.routes) {
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle) continue;

      if (route.totalWeight + node.weightKg > vehicle.capacityKg) continue;
      if (route.totalVolume + node.volumeM3 > vehicle.capacityVolume) continue;

      for (let pos = 0; pos <= route.nodes.length; pos++) {
        const testNodes = [...route.nodes];
        testNodes.splice(pos, 0, node);

        const testRoute: ALNSRoute = {
          ...route,
          nodes: testNodes,
          totalWeight: route.totalWeight + node.weightKg,
          totalVolume: route.totalVolume + node.volumeM3,
        };

        const evalResult = evaluateRoute(testRoute, vehicle, depotLat, depotLon, startTime);
        if (!evalResult.feasible) continue;

        const origEval = evaluateRoute(route, vehicle, depotLat, depotLon, startTime);
        const costIncrease = evalResult.totalDistanceKm - (origEval.feasible ? origEval.totalDistanceKm : 0);

        if (costIncrease < bestCostIncrease) {
          bestCostIncrease = costIncrease;
          bestRoute = route;
          bestPosition = pos;
        }
      }
    }

    if (bestRoute && bestPosition >= 0) {
      bestRoute.nodes.splice(bestPosition, 0, node);
      bestRoute.totalWeight += node.weightKg;
      bestRoute.totalVolume += node.volumeM3;
    } else {
      solution.unassigned.push(node);
    }
  }
}

function regret2Insertion(
  solution: ALNSSolution,
  nodesToInsert: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date
): void {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const remaining = [...nodesToInsert];

  while (remaining.length > 0) {
    let bestNodeIdx = -1;
    let bestRegretValue = -Infinity;
    let bestRoute: ALNSRoute | null = null;
    let bestPosition = -1;

    for (let nIdx = 0; nIdx < remaining.length; nIdx++) {
      const node = remaining[nIdx];
      const insertionCosts: { route: ALNSRoute; position: number; cost: number }[] = [];

      for (const route of solution.routes) {
        const vehicle = vehicleMap.get(route.vehicleId);
        if (!vehicle) continue;
        if (route.totalWeight + node.weightKg > vehicle.capacityKg) continue;
        if (route.totalVolume + node.volumeM3 > vehicle.capacityVolume) continue;

        let bestPosCost = Infinity;
        let bestPos = -1;

        for (let pos = 0; pos <= route.nodes.length; pos++) {
          const testNodes = [...route.nodes];
          testNodes.splice(pos, 0, node);
          const testRoute: ALNSRoute = {
            ...route,
            nodes: testNodes,
            totalWeight: route.totalWeight + node.weightKg,
            totalVolume: route.totalVolume + node.volumeM3,
          };
          const evalResult = evaluateRoute(testRoute, vehicle, depotLat, depotLon, startTime);
          if (!evalResult.feasible) continue;

          const origEval = evaluateRoute(route, vehicle, depotLat, depotLon, startTime);
          const costInc = evalResult.totalDistanceKm - (origEval.feasible ? origEval.totalDistanceKm : 0);
          if (costInc < bestPosCost) {
            bestPosCost = costInc;
            bestPos = pos;
          }
        }

        if (bestPos >= 0) {
          insertionCosts.push({ route, position: bestPos, cost: bestPosCost });
        }
      }

      insertionCosts.sort((a, b) => a.cost - b.cost);

      if (insertionCosts.length === 0) continue;

      const regretValue = insertionCosts.length >= 2
        ? insertionCosts[1].cost - insertionCosts[0].cost
        : 10000;

      if (regretValue > bestRegretValue) {
        bestRegretValue = regretValue;
        bestNodeIdx = nIdx;
        bestRoute = insertionCosts[0].route;
        bestPosition = insertionCosts[0].position;
      }
    }

    if (bestNodeIdx >= 0 && bestRoute && bestPosition >= 0) {
      const node = remaining.splice(bestNodeIdx, 1)[0];
      bestRoute.nodes.splice(bestPosition, 0, node);
      bestRoute.totalWeight += node.weightKg;
      bestRoute.totalVolume += node.volumeM3;
    } else {
      solution.unassigned.push(...remaining);
      break;
    }
  }
}

function estimateRemainingRouteDistance(nodes: ALNSNode[], fromIndex: number, depotLat: number, depotLon: number): number {
  let dist = 0;
  let prevLat = fromIndex > 0 ? nodes[fromIndex - 1].latitude : depotLat;
  let prevLon = fromIndex > 0 ? nodes[fromIndex - 1].longitude : depotLon;

  for (let i = fromIndex; i < nodes.length; i++) {
    dist += cachedDistance(prevLat, prevLon, nodes[i].latitude, nodes[i].longitude);
    prevLat = nodes[i].latitude;
    prevLon = nodes[i].longitude;
  }

  dist += cachedDistance(prevLat, prevLon, depotLat, depotLon);
  return dist;
}

function removeUnusedChargingStations(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date
): void {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));

  for (const route of solution.routes) {
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle) continue;

    const chargingIndices = route.nodes
      .map((n, i) => n.isChargingStation ? i : -1)
      .filter(i => i >= 0)
      .reverse();

    for (const idx of chargingIndices) {
      const testNodes = route.nodes.filter((_, i) => i !== idx);
      const testRoute: ALNSRoute = { ...route, nodes: testNodes };
      const evalResult = evaluateRoute(testRoute, vehicle, depotLat, depotLon, startTime);
      if (evalResult.feasible) {
        route.nodes = testNodes;
      }
    }
  }
}

interface OperatorStats {
  score: number;
  uses: number;
  weight: number;
}

export interface ALNSConfig {
  timeLimitMs: number;
  weights: OptimizationWeights;
  maxIterations: number;
  removalFraction: number;
  coolingRate: number;
  initialTemperature: number;
  driverConstraints?: ALNSDriverConstraints[];
}

const DEFAULT_CONFIG: ALNSConfig = {
  timeLimitMs: 30000,
  weights: DEFAULT_WEIGHTS,
  maxIterations: 10000,
  removalFraction: 0.3,
  coolingRate: 0.9995,
  initialTemperature: 100,
};

export function runALNS(
  initialSolution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {}
): ALNSSolution {
  const cfg: ALNSConfig = { ...DEFAULT_CONFIG, ...config };
  const weights = cfg.weights;
  const startMs = Date.now();

  const driverConstraintsMap = new Map<string, ALNSDriverConstraints>();
  if (cfg.driverConstraints) {
    for (const dc of cfg.driverConstraints) {
      driverConstraintsMap.set(dc.vehicleId, dc);
    }
  }

  const hasEvVehicles = vehicles.some(v => v.vehicleType === "electric" && v.rangeKm);
  const destroyOps = hasEvVehicles
    ? ["random", "worst", "shaw", "charging_remove"] as const
    : ["random", "worst", "shaw"] as const;
  const repairOps = hasEvVehicles
    ? ["greedy", "regret2", "charging_insert"] as const
    : ["greedy", "regret2"] as const;

  const destroyStats: Record<string, OperatorStats> = {};
  const repairStats: Record<string, OperatorStats> = {};

  for (const op of destroyOps) destroyStats[op] = { score: 0, uses: 0, weight: 1 };
  for (const op of repairOps) repairStats[op] = { score: 0, uses: 0, weight: 1 };

  let currentSolution = deepCloneSolution(initialSolution);
  let { cost: currentCost, breakdown } = computeSolutionCost(currentSolution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap);
  currentSolution.cost = currentCost;
  currentSolution.costBreakdown = breakdown;

  let bestSolution = deepCloneSolution(currentSolution);
  let bestCost = currentCost;

  let temperature = cfg.initialTemperature;
  let iteration = 0;
  const SEGMENT_LENGTH = 100;

  while (iteration < cfg.maxIterations) {
    if (Date.now() - startMs >= cfg.timeLimitMs) break;

    iteration++;
    const candidate = deepCloneSolution(currentSolution);

    const totalDeliveryNodes = candidate.routes.reduce(
      (sum, r) => sum + r.nodes.filter(n => !n.isChargingStation).length, 0
    );
    const removalCount = Math.max(1, Math.min(
      Math.floor(totalDeliveryNodes * cfg.removalFraction),
      totalDeliveryNodes - 1
    ));

    if (removalCount <= 0 || totalDeliveryNodes <= 0) break;

    const destroyOp = selectOperator(destroyStats);
    let removedNodes: ALNSNode[];

    switch (destroyOp) {
      case "random":
        removedNodes = randomRemoval(candidate, removalCount);
        break;
      case "worst":
        removedNodes = worstRemoval(candidate, removalCount, vehicles, depotLat, depotLon, startTime, weights);
        break;
      case "shaw":
        removedNodes = shawRemoval(candidate, removalCount);
        break;
      case "charging_remove":
        removedNodes = chargingStationRemoval(candidate, vehicles);
        break;
      default:
        removedNodes = randomRemoval(candidate, removalCount);
    }

    const deliveryNodesToInsert = removedNodes.filter(n => !n.isChargingStation);
    const allToInsert = [...deliveryNodesToInsert, ...candidate.unassigned];
    candidate.unassigned = [];

    const repairOp = selectOperator(repairStats);

    switch (repairOp) {
      case "greedy":
        greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime);
        break;
      case "regret2":
        regret2Insertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime);
        break;
      case "charging_insert":
        greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime);
        chargingStationInsertion(candidate, vehicles, depotLat, depotLon, startTime);
        break;
      default:
        greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime);
    }

    if (repairOp !== "charging_insert") {
      chargingStationInsertion(candidate, vehicles, depotLat, depotLon, startTime);
    }
    removeUnusedChargingStations(candidate, vehicles, depotLat, depotLon, startTime);

    const { cost: candidateCost, breakdown: candidateBreakdown } = computeSolutionCost(
      candidate, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap
    );
    candidate.cost = candidateCost;
    candidate.costBreakdown = candidateBreakdown;

    const costDiff = candidateCost - currentCost;

    let accepted = false;
    if (costDiff < 0) {
      accepted = true;
      if (candidateCost < bestCost) {
        bestSolution = deepCloneSolution(candidate);
        bestCost = candidateCost;
        updateOperatorScore(destroyStats, destroyOp, 3);
        updateOperatorScore(repairStats, repairOp, 3);
      } else {
        updateOperatorScore(destroyStats, destroyOp, 2);
        updateOperatorScore(repairStats, repairOp, 2);
      }
    } else {
      const acceptProb = Math.exp(-costDiff / temperature);
      if (Math.random() < acceptProb) {
        accepted = true;
        updateOperatorScore(destroyStats, destroyOp, 1);
        updateOperatorScore(repairStats, repairOp, 1);
      }
    }

    if (accepted) {
      currentSolution = candidate;
      currentCost = candidateCost;
    }

    temperature *= cfg.coolingRate;

    if (iteration % SEGMENT_LENGTH === 0) {
      updateOperatorWeights(destroyStats);
      updateOperatorWeights(repairStats);
    }
  }

  return bestSolution;
}

function selectOperator(stats: Record<string, OperatorStats>): string {
  const ops = Object.keys(stats);
  const totalWeight = ops.reduce((sum, op) => sum + stats[op].weight, 0);
  let rand = Math.random() * totalWeight;
  for (const op of ops) {
    rand -= stats[op].weight;
    if (rand <= 0) return op;
  }
  return ops[ops.length - 1];
}

function updateOperatorScore(stats: Record<string, OperatorStats>, op: string, score: number): void {
  stats[op].score += score;
  stats[op].uses++;
}

function updateOperatorWeights(stats: Record<string, OperatorStats>): void {
  const decay = 0.8;
  for (const op of Object.keys(stats)) {
    const s = stats[op];
    const avgScore = s.uses > 0 ? s.score / s.uses : 0;
    s.weight = decay * s.weight + (1 - decay) * Math.max(avgScore, 0.1);
    s.score = 0;
    s.uses = 0;
  }
}

export function buildInitialSolutionFromCW(
  stops: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date
): ALNSSolution {
  const routes: ALNSRoute[] = vehicles.map(v => ({
    vehicleId: v.id,
    nodes: [],
    totalWeight: 0,
    totalVolume: 0,
  }));

  if (stops.length === 0) {
    return {
      routes,
      unassigned: [],
      cost: 0,
      costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0 },
    };
  }

  interface CWRoute { stops: ALNSNode[]; weight: number; volume: number }
  const cwRoutes: CWRoute[] = stops.map(s => ({ stops: [s], weight: s.weightKg, volume: s.volumeM3 }));
  const stopToRoute = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) stopToRoute.set(stops[i].id, i);

  const distFromDepot = new Map<string, number>();
  for (const s of stops) {
    distFromDepot.set(s.id, cachedDistance(depotLat, depotLon, s.latitude, s.longitude));
  }

  interface Saving { i: number; j: number; value: number }
  const savings: Saving[] = [];
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const dI = distFromDepot.get(stops[i].id)!;
      const dJ = distFromDepot.get(stops[j].id)!;
      const dIJ = cachedDistance(stops[i].latitude, stops[i].longitude, stops[j].latitude, stops[j].longitude);
      const saving = dI + dJ - dIJ;
      if (saving > 0) savings.push({ i, j, value: saving });
    }
  }
  savings.sort((a, b) => b.value - a.value);

  for (const saving of savings) {
    const rIdxI = stopToRoute.get(stops[saving.i].id)!;
    const rIdxJ = stopToRoute.get(stops[saving.j].id)!;
    if (rIdxI === rIdxJ) continue;

    const rI = cwRoutes[rIdxI];
    const rJ = cwRoutes[rIdxJ];
    if (rI.stops.length === 0 || rJ.stops.length === 0) continue;

    const mergedWeight = rI.weight + rJ.weight;
    const mergedVolume = rI.volume + rJ.volume;

    const canFitAny = vehicles.some(v => mergedWeight <= v.capacityKg && mergedVolume <= v.capacityVolume);
    if (!canFitAny) continue;

    const lastI = rI.stops[rI.stops.length - 1];
    const firstJ = rJ.stops[0];

    if (lastI.id === stops[saving.i].id && firstJ.id === stops[saving.j].id) {
      rI.stops = [...rI.stops, ...rJ.stops];
    } else if (rJ.stops[rJ.stops.length - 1].id === stops[saving.j].id && rI.stops[0].id === stops[saving.i].id) {
      rI.stops = [...rJ.stops, ...rI.stops];
    } else {
      continue;
    }

    rI.weight = mergedWeight;
    rI.volume = mergedVolume;
    rJ.stops = [];
    rJ.weight = 0;
    rJ.volume = 0;
    for (const s of rI.stops) stopToRoute.set(s.id, rIdxI);
  }

  const activeRoutes = cwRoutes.filter(r => r.stops.length > 0);
  activeRoutes.sort((a, b) => b.stops.length - a.stops.length);

  const unassigned: ALNSNode[] = [];
  const usedVehicles = new Set<string>();
  const sortedVehicles = [...vehicles].sort((a, b) => b.capacityKg - a.capacityKg);

  for (const cwRoute of activeRoutes) {
    let bestVehicleIdx = -1;

    for (let vi = 0; vi < sortedVehicles.length; vi++) {
      const v = sortedVehicles[vi];
      if (usedVehicles.has(v.id)) continue;
      if (cwRoute.weight > v.capacityKg || cwRoute.volume > v.capacityVolume) continue;
      bestVehicleIdx = vi;
      break;
    }

    if (bestVehicleIdx < 0) {
      unassigned.push(...cwRoute.stops);
      continue;
    }

    const vehicle = sortedVehicles[bestVehicleIdx];
    usedVehicles.add(vehicle.id);
    const routeIdx = routes.findIndex(r => r.vehicleId === vehicle.id);
    if (routeIdx >= 0) {
      routes[routeIdx].nodes = cwRoute.stops;
      routes[routeIdx].totalWeight = cwRoute.weight;
      routes[routeIdx].totalVolume = cwRoute.volume;
    }
  }

  const initialSolution: ALNSSolution = {
    routes,
    unassigned,
    cost: 0,
    costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0 },
  };

  chargingStationInsertion(initialSolution, vehicles, depotLat, depotLon, startTime);

  return initialSolution;
}

export interface ALNSResult {
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  costBreakdown: CostBreakdown;
  routeEvaluations: Map<string, RouteEvaluation>;
}

export function optimizeWithALNS(
  stops: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {}
): ALNSResult {
  const initialSolution = buildInitialSolutionFromCW(stops, vehicles, depotLat, depotLon, startTime);
  const bestSolution = runALNS(initialSolution, vehicles, depotLat, depotLon, startTime, config);

  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const driverConstraintsMap = new Map<string, ALNSDriverConstraints>();
  if (config.driverConstraints) {
    for (const dc of config.driverConstraints) {
      driverConstraintsMap.set(dc.vehicleId, dc);
    }
  }
  const routeEvaluations = new Map<string, RouteEvaluation>();

  for (const route of bestSolution.routes) {
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle || route.nodes.length === 0) continue;
    const constraints = driverConstraintsMap.get(route.vehicleId);
    const evalResult = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
    routeEvaluations.set(route.vehicleId, evalResult);
  }

  return {
    routes: bestSolution.routes,
    unassigned: bestSolution.unassigned,
    costBreakdown: bestSolution.costBreakdown,
    routeEvaluations,
  };
}

export function reoptimizeAffectedRoutes(
  currentRoutes: ALNSRoute[],
  affectedVehicleIds: string[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {}
): ALNSResult {
  const affectedSet = new Set(affectedVehicleIds);
  const stableRoutes = currentRoutes.filter(r => !affectedSet.has(r.vehicleId));
  const affectedRoutes = currentRoutes.filter(r => affectedSet.has(r.vehicleId));
  const affectedVehicles = vehicles.filter(v => affectedSet.has(v.id));

  const allNodes: ALNSNode[] = [];
  for (const route of affectedRoutes) {
    allNodes.push(...route.nodes.filter(n => !n.isChargingStation));
  }

  const reoptConfig: Partial<ALNSConfig> = {
    ...config,
    timeLimitMs: Math.min(config.timeLimitMs ?? 15000, 15000),
  };

  const result = optimizeWithALNS(allNodes, affectedVehicles, depotLat, depotLon, startTime, reoptConfig);

  return {
    routes: [...stableRoutes, ...result.routes],
    unassigned: result.unassigned,
    costBreakdown: result.costBreakdown,
    routeEvaluations: result.routeEvaluations,
  };
}

export { haversineDistance, estimateCo2, evaluateRoute, cachedDistance };
