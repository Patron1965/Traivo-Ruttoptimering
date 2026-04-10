import type { ALNSNode, ALNSRoute, ALNSVehicle, ALNSSolution } from "../types";
import { CHARGING_STATIONS, FULL_CHARGE_DURATION_MIN, MIN_CHARGE_DURATION_MIN } from "../types";
import { cachedDistance } from "../distance-cache";
import { evaluateRoute } from "../cost";

export function chargingStationInsertion(
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

export function greedyInsertion(
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

      const origEval = evaluateRoute(route, vehicle, depotLat, depotLon, startTime);
      const origCost = origEval.feasible ? origEval.totalDistanceKm : 0;

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

        const costIncrease = evalResult.totalDistanceKm - origCost;

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

export function regretKInsertion(
  solution: ALNSSolution,
  nodesToInsert: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  k = 3
): void {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const remaining = [...nodesToInsert];

  while (remaining.length > 0) {
    let bestNodeIdx = -1;
    let bestRegretValue = -Infinity;
    let bestRoute: ALNSRoute | null = null;
    let bestPosition = -1;

    const routeBaseCosts = new Map<ALNSRoute, number>();
    for (const route of solution.routes) {
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle) continue;
      const origEval = evaluateRoute(route, vehicle, depotLat, depotLon, startTime);
      routeBaseCosts.set(route, origEval.feasible ? origEval.totalDistanceKm : 0);
    }

    for (let nIdx = 0; nIdx < remaining.length; nIdx++) {
      const node = remaining[nIdx];
      const insertionCosts: { route: ALNSRoute; position: number; cost: number }[] = [];

      for (const route of solution.routes) {
        const vehicle = vehicleMap.get(route.vehicleId);
        if (!vehicle) continue;
        if (route.totalWeight + node.weightKg > vehicle.capacityKg) continue;
        if (route.totalVolume + node.volumeM3 > vehicle.capacityVolume) continue;

        const origCost = routeBaseCosts.get(route) ?? 0;
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

          const costInc = evalResult.totalDistanceKm - origCost;
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

      let regretValue: number;
      if (insertionCosts.length >= k) {
        regretValue = insertionCosts[k - 1].cost - insertionCosts[0].cost;
      } else if (insertionCosts.length >= 2) {
        regretValue = insertionCosts[insertionCosts.length - 1].cost - insertionCosts[0].cost;
      } else {
        regretValue = 10000;
      }

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

export function removeUnusedChargingStations(
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
