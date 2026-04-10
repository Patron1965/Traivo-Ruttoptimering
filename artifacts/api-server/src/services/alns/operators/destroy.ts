import type { ALNSNode, ALNSRoute, ALNSVehicle, ALNSSolution, OptimizationWeights } from "../types";
import { randomInt } from "../types";
import { cachedDistance, estimateDuration } from "../distance-cache";
import { evaluateRoute } from "../cost";

export function randomRemoval(solution: ALNSSolution, count: number): ALNSNode[] {
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

export function worstRemoval(
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

function timeWindowOverlap(a: ALNSNode, b: ALNSNode): number {
  if (!a.timeWindowStart || !a.timeWindowEnd || !b.timeWindowStart || !b.timeWindowEnd) return 1.0;
  const overlapStart = Math.max(a.timeWindowStart.getTime(), b.timeWindowStart.getTime());
  const overlapEnd = Math.min(a.timeWindowEnd.getTime(), b.timeWindowEnd.getTime());
  if (overlapEnd <= overlapStart) return 0;
  const aLen = a.timeWindowEnd.getTime() - a.timeWindowStart.getTime();
  const bLen = b.timeWindowEnd.getTime() - b.timeWindowStart.getTime();
  const minLen = Math.min(aLen, bLen);
  return minLen > 0 ? (overlapEnd - overlapStart) / minLen : 0;
}

function computeRelatednessScore(seed: ALNSNode, other: ALNSNode, maxDist: number, maxWeight: number): number {
  const spatialDist = cachedDistance(seed.latitude, seed.longitude, other.latitude, other.longitude);
  const normalizedSpatial = maxDist > 0 ? spatialDist / maxDist : 0;
  const temporalSim = 1 - timeWindowOverlap(seed, other);
  const weightDiff = maxWeight > 0 ? Math.abs(seed.weightKg - other.weightKg) / maxWeight : 0;
  return 0.4 * normalizedSpatial + 0.3 * temporalSim + 0.2 * weightDiff + 0.1 * Math.random();
}

function precomputeRelatednessScores(
  seed: ALNSNode,
  candidates: { node: ALNSNode; route: ALNSRoute }[],
  maxDist: number,
  maxWeight: number
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { node } of candidates) {
    scores.set(node.id, computeRelatednessScore(seed, node, maxDist, maxWeight));
  }
  return scores;
}

export function shawRemoval(solution: ALNSSolution, count: number): ALNSNode[] {
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
  let maxDist = 0;
  let maxWeight = 0;
  for (const r of solution.routes) {
    for (const n of r.nodes) {
      if (!n.isChargingStation) {
        allDeliveryNodes.push({ node: n, route: r });
        const d = cachedDistance(seedNode.latitude, seedNode.longitude, n.latitude, n.longitude);
        if (d > maxDist) maxDist = d;
        if (n.weightKg > maxWeight) maxWeight = n.weightKg;
      }
    }
  }

  const scores = precomputeRelatednessScores(seedNode, allDeliveryNodes, maxDist, maxWeight);
  allDeliveryNodes.sort((a, b) => (scores.get(a.node.id) ?? Infinity) - (scores.get(b.node.id) ?? Infinity));

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

export function relatednessRemoval(solution: ALNSSolution, count: number): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const allDelivery: { node: ALNSNode; route: ALNSRoute }[] = [];
  for (const r of solution.routes) {
    for (const n of r.nodes) {
      if (!n.isChargingStation) allDelivery.push({ node: n, route: r });
    }
  }
  if (allDelivery.length === 0) return removed;

  const seedIdx = randomInt(allDelivery.length);
  const seed = allDelivery[seedIdx];
  seed.route.nodes = seed.route.nodes.filter(n => n.id !== seed.node.id);
  seed.route.totalWeight -= seed.node.weightKg;
  seed.route.totalVolume -= seed.node.volumeM3;
  removed.push(seed.node);

  let maxDist = 0;
  let maxWeight = 0;
  for (const { node } of allDelivery) {
    const d = cachedDistance(seed.node.latitude, seed.node.longitude, node.latitude, node.longitude);
    if (d > maxDist) maxDist = d;
    if (node.weightKg > maxWeight) maxWeight = node.weightKg;
  }

  const remaining = allDelivery.filter(d => d.node.id !== seed.node.id);
  const scores = precomputeRelatednessScores(seed.node, remaining, maxDist, maxWeight);
  remaining.sort((a, b) => (scores.get(a.node.id) ?? Infinity) - (scores.get(b.node.id) ?? Infinity));

  for (const { node, route } of remaining) {
    if (removed.length >= count) break;
    route.nodes = route.nodes.filter(n => n.id !== node.id);
    route.totalWeight -= node.weightKg;
    route.totalVolume -= node.volumeM3;
    removed.push(node);
  }

  return removed;
}

export function routeRemoval(solution: ALNSSolution, vehicles: ALNSVehicle[], depotLat: number, depotLon: number, startTime: Date, weights: OptimizationWeights): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));

  const routeCosts = solution.routes
    .filter(r => r.nodes.filter(n => !n.isChargingStation).length > 0)
    .map(r => {
      const v = vehicleMap.get(r.vehicleId);
      if (!v) return { route: r, costPerStop: 0 };
      const evalR = evaluateRoute(r, v, depotLat, depotLon, startTime);
      const deliveryCount = r.nodes.filter(n => !n.isChargingStation).length;
      return { route: r, costPerStop: deliveryCount > 0 ? evalR.totalDistanceKm / deliveryCount : 0 };
    })
    .sort((a, b) => b.costPerStop - a.costPerStop);

  if (routeCosts.length === 0) return removed;

  const worstRoute = routeCosts[0].route;
  const deliveryNodes = worstRoute.nodes.filter(n => !n.isChargingStation);
  for (const node of deliveryNodes) {
    removed.push(node);
  }
  worstRoute.nodes = worstRoute.nodes.filter(n => n.isChargingStation);
  worstRoute.totalWeight = 0;
  worstRoute.totalVolume = 0;

  return removed;
}

export function timeWindowRemoval(solution: ALNSSolution, count: number, depotLat: number, depotLon: number, startTime: Date): ALNSNode[] {
  const removed: ALNSNode[] = [];
  const tightNodes: { node: ALNSNode; route: ALNSRoute; slack: number }[] = [];

  for (const route of solution.routes) {
    let currentTime = new Date(startTime);
    let prevLat = depotLat;
    let prevLon = depotLon;

    for (const node of route.nodes) {
      const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);
      const travelMin = estimateDuration(dist, currentTime, prevLat, prevLon, node.latitude, node.longitude);
      currentTime = new Date(currentTime.getTime() + travelMin * 60000);

      if (node.isChargingStation) {
        currentTime = new Date(currentTime.getTime() + (node.chargingDurationMin ?? 30) * 60000);
        prevLat = node.latitude;
        prevLon = node.longitude;
        continue;
      }

      const arrival = currentTime;

      let slack = Infinity;
      if (node.timeWindowEnd) {
        slack = (node.timeWindowEnd.getTime() - arrival.getTime()) / 60000;
        if (slack < 0) slack = -Math.abs(slack) * 2;
      }

      tightNodes.push({ node, route, slack });

      const effectiveStart = node.timeWindowStart && node.timeWindowStart.getTime() > arrival.getTime()
        ? node.timeWindowStart : arrival;
      currentTime = new Date(effectiveStart.getTime() + node.serviceDurationMin * 60000);
      prevLat = node.latitude;
      prevLon = node.longitude;
    }
  }

  tightNodes.sort((a, b) => a.slack - b.slack);

  for (const { node, route } of tightNodes) {
    if (removed.length >= count) break;
    if (removed.some(r => r.id === node.id)) continue;
    route.nodes = route.nodes.filter(n => n.id !== node.id);
    route.totalWeight -= node.weightKg;
    route.totalVolume -= node.volumeM3;
    removed.push(node);
  }

  return removed;
}

export function chargingStationRemoval(
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
