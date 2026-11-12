import { randomUUID } from "node:crypto";
import { usesRoadSeed } from "./planning-profiles";
import { roadMedoidClusters } from "./profile-clustering";
import { getDistanceMatrixCacheCoverage, precomputeDistanceMatrix } from "../osrm";
import { logger } from "../../lib/logger";
import { recordUsage } from "../usage";
import { getUsageContext } from "../usage-context";
import { ensureOrganizationServicePolicy } from "../organization-service-policy";
import { withRequiredRoadData, RoadDataUnavailableError, assertOperationalRoadProvider } from "../road-data-policy";
import type {
  ALNSNode, ALNSVehicle, ALNSRoute, ALNSSolution, ALNSDriverConstraints,
  ALNSConfig, ALNSResult, OptimizationWeights, OperatorStats,
  RouteEvaluation, ClusteredOptimizationProgress,
  ClusterStopReason, OptimizationStopReason,
} from "./types";
import {
  CHARGING_STATIONS, DEFAULT_CONFIG, DEFAULT_WEIGHTS, DEFAULT_ENV_CTX,
  deepCloneSolution, setEnvCtx, withOptimizationEnvironment,
} from "./types";
import { globalDistanceCache, cachedDistance } from "./distance-cache";
import { evaluateRoute, computeSolutionCost, compareSolutions, compareSolutionScores } from "./cost";
import { areasInsertion, areasInsertionPositions } from "./operators/areas-repair";
import {
  randomRemoval, worstRemoval, shawRemoval, relatednessRemoval,
  worstRemovalCooperative, routeRemoval, timeWindowRemoval, chargingStationRemoval,
} from "./operators/destroy";
import {
  greedyInsertion, regretKInsertion, greedyInsertionCooperative,
  regretKInsertionCooperative, chargingStationInsertion, removeUnusedChargingStations,
} from "./operators/repair";
import {
  localSearchPostProcess,
  localSearchPostProcessCancellable,
} from "./operators/local-search";
import { enforcePdIntegrity, buildPdReferenceMap } from "./operators/pd-integrity";
import { geographicGroupSearch } from "./operators/geographic-search";
import { consensusClustering, crossClusterImprove, crossClusterImproveCooperative } from "./clustering";
import { allocateClusterVehicles, compareUnassignedCoverage } from "./fleet-coverage";
import { assertFrozenRouteFeasible, assertLockedJobsRetained, assertPlanningLockResult, comparePlanningLockAdmission, hasPlanningLock, OptimizerPlanningLockConflict } from "./planning-locks";

function summarizeClusterStopReasons(
  clusterStopReasons: Partial<Record<ClusterStopReason, number>>,
): OptimizationStopReason | null {
  const stopReasons = Object.keys(clusterStopReasons) as ClusterStopReason[];
  if (stopReasons.length === 0) return null;
  return stopReasons.length === 1 ? stopReasons[0] : "mixed";
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

function hasSameRealStopMultiset(left: ALNSSolution, right: ALNSSolution): boolean {
  const countStops = (solution: ALNSSolution): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const node of [
      ...solution.routes.flatMap((route) => route.nodes),
      ...solution.unassigned,
    ]) {
      if (node.isChargingStation) continue;
      counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    }
    return counts;
  };

  const leftCounts = countStops(left);
  const rightCounts = countStops(right);
  if (leftCounts.size !== rightCounts.size) return false;
  for (const [id, count] of leftCounts) {
    if (rightCounts.get(id) !== count) return false;
  }
  return true;
}

function hasHardValidRoutes(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
): boolean {
  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  for (const route of solution.routes) {
    if (route.nodes.length === 0) continue;
    const vehicle = vehicleMap.get(route.vehicleId);
    if (!vehicle) return false;
    if (!evaluateRoute(
      route,
      vehicle,
      depotLat,
      depotLon,
      startTime,
      driverConstraintsMap.get(route.vehicleId),
    ).feasible) {
      return false;
    }
  }
  return true;
}

async function consolidateRoutes(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  weights: OptimizationWeights,
  shouldCancel?: () => boolean,
): Promise<boolean> {
  let operations = 0;
  const checkCancellation = (): boolean => {
    if (!shouldCancel) return false;
    if (shouldCancel()) return true;
    operations++;
    return operations % 8 === 0;
  };
  const yieldForCancellation = async (): Promise<boolean> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return shouldCancel?.() ?? false;
  };

  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const sourceRoutes = [...solution.routes]
    .filter((route) => route.nodes.some((node) => !node.isChargingStation))
    .sort((a, b) => a.nodes.length - b.nodes.length);

  for (const source of sourceRoutes) {
    if (shouldCancel && checkCancellation() && await yieldForCancellation()) return false;
    const realNodes = source.nodes.filter((node) => !node.isChargingStation);
    if (realNodes.length === 0) continue;
    const snapshot = solution.routes.map((route) => ({
      route,
      nodes: [...route.nodes],
      totalWeight: route.totalWeight,
      totalVolume: route.totalVolume,
    }));
    source.nodes = [];
    source.totalWeight = 0;
    source.totalVolume = 0;
    let consolidated = true;

    for (let nodeIndex = 0; nodeIndex < realNodes.length; nodeIndex++) {
      if (shouldCancel && checkCancellation() && await yieldForCancellation()) return false;
      const node = realNodes[nodeIndex];
      let best: { route: ALNSRoute; position: number; cost: number } | null = null;
      for (const target of solution.routes) {
        if (shouldCancel && checkCancellation() && await yieldForCancellation()) return false;
        if (target === source || !target.nodes.some((candidate) => !candidate.isChargingStation)) continue;
        const vehicle = vehicleMap.get(target.vehicleId);
        if (!vehicle || target.totalWeight + node.weightKg > vehicle.capacityKg || target.totalVolume + node.volumeM3 > vehicle.capacityVolume) continue;
        for (let position = 0; position <= target.nodes.length; position++) {
          if (shouldCancel && checkCancellation() && await yieldForCancellation()) return false;
          const nodes = [...target.nodes];
          nodes.splice(position, 0, node);
          const candidate = {
            ...target,
            nodes,
            totalWeight: target.totalWeight + node.weightKg,
            totalVolume: target.totalVolume + node.volumeM3,
          };
          const evaluation = evaluateRoute(candidate, vehicle, depotLat, depotLon, startTime, driverConstraintsMap.get(vehicle.id));
          if (!evaluation.feasible) continue;

          // Consolidation is part of the final objective pass. Selecting
          // only by distance can reject a longer route that is better under
          // the configured time-window, driver, emissions, or cohesion
          // weights.
          const candidateRoutes = solution.routes.map((route) =>
            route === target ? candidate : route,
          );
          const candidateCost = computeSolutionCost(
            {
              routes: candidateRoutes,
              unassigned: [
                ...solution.unassigned,
                ...realNodes.slice(nodeIndex + 1),
              ],
              cost: 0,
              costBreakdown: solution.costBreakdown,
            },
            vehicles,
            depotLat,
            depotLon,
            startTime,
            weights,
            driverConstraintsMap,
            "minimize",
          ).cost;
          if (!best || candidateCost < best.cost) {
            best = { route: target, position, cost: candidateCost };
          }
        }
      }
      if (!best) {
        consolidated = false;
        break;
      }
      best.route.nodes.splice(best.position, 0, node);
      best.route.totalWeight += node.weightKg;
      best.route.totalVolume += node.volumeM3;
    }

    if (!consolidated) {
      for (const saved of snapshot) {
        saved.route.nodes = saved.nodes;
        saved.route.totalWeight = saved.totalWeight;
        saved.route.totalVolume = saved.totalVolume;
      }
    }
  }
  return true;
}

export function buildInitialSolutionFromCW(
  stops: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  vehicleDistributionMode: "minimize" | "balance" = "minimize",
  driverConstraints: ALNSDriverConstraints[] = [],
  weights: OptimizationWeights = DEFAULT_WEIGHTS,
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
      costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
    };
  }

  if (weights.objectivePriority === "areas_worktime" || vehicleDistributionMode === "balance" || stops.some(hasPlanningLock)) {
    const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const constraintsMap = new Map(driverConstraints.map((constraints) => [constraints.vehicleId, constraints]));
    const unassigned: ALNSNode[] = [];

    const sortedStops = [...stops].sort((a, b) =>
      (weights.objectivePriority === "areas_worktime" ? (b.planningPriority ?? 0) - (a.planningPriority ?? 0) : 0)
      || comparePlanningLockAdmission(a, b));
    for (let stopIndex = 0; stopIndex < sortedStops.length; stopIndex++) {
      const stop = sortedStops[stopIndex];
      let selected: { route: ALNSRoute; position: number; score: ReturnType<typeof computeSolutionCost> } | null = null;
      for (const route of [...routes].sort((a, b) => a.nodes.length - b.nodes.length)) {
        const vehicle = vehicleMap.get(route.vehicleId);
        if (!vehicle || route.totalWeight + stop.weightKg > vehicle.capacityKg || route.totalVolume + stop.volumeM3 > vehicle.capacityVolume) continue;
        const positions = weights.objectivePriority === "areas_worktime" || (!!weights.searchProfile && stops.length > 100)
          ? areasInsertionPositions(route, stop, vehicle, depotLat, depotLon)
          : Array.from({ length: route.nodes.length + 1 }, (_, i) => i);
        for (const position of positions) {
          const nodes = [...route.nodes];
          nodes.splice(position, 0, stop);
          const candidate = {
            ...route,
            nodes,
            totalWeight: route.totalWeight + stop.weightKg,
            totalVolume: route.totalVolume + stop.volumeM3,
          };
          const evaluation = evaluateRoute(candidate, vehicle, depotLat, depotLon, startTime, constraintsMap.get(vehicle.id));
          if (!evaluation.feasible) continue;

          // Initial balance construction must use the same effective
          // objective as ALNS search.  Balancing only by work time can
          // repeatedly assign adjacent stops to different vehicles before
          // the cohesion term has any chance to recover the assignment.
          const candidateSolution: ALNSSolution = {
            routes: routes.map((currentRoute) => currentRoute === route
              ? candidate
              : currentRoute),
            unassigned: [
              ...unassigned,
              ...sortedStops.slice(stopIndex + 1),
            ],
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
          const candidateCost = computeSolutionCost(
            candidateSolution,
            vehicles,
            depotLat,
            depotLon,
            startTime,
            weights,
            constraintsMap,
            "balance",
          );
          const fillSelectedResource = weights.objectivePriority === "areas_worktime" && vehicleDistributionMode === "balance" && selected
            && route.nodes.length === 0 && selected.route.nodes.length > 0;
          const keepSelectedResource = weights.objectivePriority === "areas_worktime" && vehicleDistributionMode === "balance" && selected
            && route.nodes.length > 0 && selected.route.nodes.length === 0;
          if (!selected || fillSelectedResource || (!keepSelectedResource && compareSolutionScores(candidateCost, selected.score) < 0)) {
            selected = { route, position, score: candidateCost };
          }
        }
      }
      if (!selected) {
        unassigned.push(stop);
        continue;
      }
      selected.route.nodes.splice(selected.position, 0, stop);
      selected.route.totalWeight += stop.weightKg;
      selected.route.totalVolume += stop.volumeM3;
    }

    const balancedSolution: ALNSSolution = {
      routes,
      unassigned,
      cost: 0,
      costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
    };
    chargingStationInsertion(balancedSolution, vehicles, depotLat, depotLon, startTime, constraintsMap);
    return balancedSolution;
  }

  interface CWRoute { stops: ALNSNode[]; weight: number; volume: number }
  const constraintsMap = new Map(driverConstraints.map(driver => [driver.vehicleId, driver]));
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

    let mergedStops: ALNSNode[];
    if (lastI.id === stops[saving.i].id && firstJ.id === stops[saving.j].id) {
      mergedStops = [...rI.stops, ...rJ.stops];
    } else if (rJ.stops[rJ.stops.length - 1].id === stops[saving.j].id && rI.stops[0].id === stops[saving.i].id) {
      mergedStops = [...rJ.stops, ...rI.stops];
    } else {
      continue;
    }
    if (!vehicles.some(vehicle => feasibleConstructionRoute(
      mergedStops, vehicle, depotLat, depotLon, startTime, constraintsMap,
    ))) continue;
    rI.stops = mergedStops;

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
      if (!feasibleConstructionRoute(cwRoute.stops, v, depotLat, depotLon, startTime, constraintsMap)) continue;
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
      routes[routeIdx] = feasibleConstructionRoute(
        cwRoute.stops, vehicle, depotLat, depotLon, startTime, constraintsMap,
      )!;
    }
  }

  const initialSolution: ALNSSolution = {
    routes,
    unassigned,
    cost: 0,
    costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
  };

  chargingStationInsertion(initialSolution, vehicles, depotLat, depotLon, startTime, constraintsMap);

  return initialSolution;
}

function feasibleConstructionRoute(
  nodes: ALNSNode[], vehicle: ALNSVehicle, depotLat: number, depotLon: number,
  startTime: Date, constraints: Map<string, ALNSDriverConstraints>,
): ALNSRoute | null {
  const route: ALNSRoute = {
    vehicleId: vehicle.id, nodes: [...nodes],
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
  if (route.totalWeight > vehicle.capacityKg || route.totalVolume > vehicle.capacityVolume) return null;
  if (evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints.get(vehicle.id)).feasible) return route;
  if (vehicle.vehicleType !== "electric" || vehicle.rangeKm == null) return null;
  chargingStationInsertion({
    routes: [route], unassigned: [], cost: 0,
    costBreakdown: {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0,
      totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    },
  }, [vehicle], depotLat, depotLon, startTime, constraints);
  return evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints.get(vehicle.id)).feasible ? route : null;
}

/**
 * Cooperative counterpart used by the import-sized optimizer.  The
 * construction algorithm intentionally mirrors buildInitialSolutionFromCW:
 * yielding is the only behavioural difference.  In particular, the loops
 * retain their original ordering so the same road matrix produces the same
 * candidate and assignment decisions.
 */
export async function buildInitialSolutionFromCWAsync(
  stops: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  vehicleDistributionMode: "minimize" | "balance" = "minimize",
  driverConstraints: ALNSDriverConstraints[] = [],
  weights: OptimizationWeights = DEFAULT_WEIGHTS,
  shouldStop: () => boolean = () => false,
): Promise<ALNSSolution> {
  await ensureOrganizationServicePolicy();
  const routes: ALNSRoute[] = vehicles.map(v => ({
    vehicleId: v.id,
    nodes: [],
    totalWeight: 0,
    totalVolume: 0,
  }));
  const yieldEvery = 8;
  let work = 0;
  const checkpoint = async (): Promise<void> => {
    work++;
    if (work % yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const emptyBreakdown = () => ({
    distanceCost: 0,
    co2Cost: 0,
    etaPrecisionCost: 0,
    driverPenaltyCost: 0,
    geographicCohesionCost: 0,
    totalDistanceKm: 0,
    totalCo2Kg: 0,
    totalTimeWindowSlackMin: 0,
    totalDriverPenalty: 0,
  });

  if (stops.length === 0) {
    return { routes, unassigned: [], cost: 0, costBreakdown: emptyBreakdown() };
  }

  if (weights.objectivePriority === "areas_worktime" || vehicleDistributionMode === "balance" || stops.some(hasPlanningLock)) {
    const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const constraintsMap = new Map(driverConstraints.map((constraints) => [constraints.vehicleId, constraints]));
    const unassigned: ALNSNode[] = [];
    const sortedStops = [...stops].sort((a, b) =>
      (weights.objectivePriority === "areas_worktime" ? (b.planningPriority ?? 0) - (a.planningPriority ?? 0) : 0)
      || comparePlanningLockAdmission(a, b));

    admission: for (let stopIndex = 0; stopIndex < sortedStops.length; stopIndex++) {
      const stop = sortedStops[stopIndex];
      // Scoped to this admission only: original routes are mutated on commit.
      const evaluations = new WeakMap<ALNSRoute, RouteEvaluation>();
      let selected: { route: ALNSRoute; position: number; score: ReturnType<typeof computeSolutionCost> } | null = null;
      for (const route of [...routes].sort((a, b) => a.nodes.length - b.nodes.length)) {
        let geographicCohesionCost: number | undefined;
        const vehicle = vehicleMap.get(route.vehicleId);
        if (!vehicle || route.totalWeight + stop.weightKg > vehicle.capacityKg || route.totalVolume + stop.volumeM3 > vehicle.capacityVolume) continue;
        const positions = weights.objectivePriority === "areas_worktime" || (!!weights.searchProfile && stops.length > 100)
          ? areasInsertionPositions(route, stop, vehicle, depotLat, depotLon)
          : Array.from({ length: route.nodes.length + 1 }, (_, i) => i);
        for (const position of positions) {
          if (shouldStop()) {
            unassigned.push(...sortedStops.slice(stopIndex));
            break admission;
          }
          await checkpoint();
          const nodes = [...route.nodes];
          nodes.splice(position, 0, stop);
          const candidate = {
            ...route,
            nodes,
            totalWeight: route.totalWeight + stop.weightKg,
            totalVolume: route.totalVolume + stop.volumeM3,
          };
          const evaluation = evaluateRoute(candidate, vehicle, depotLat, depotLon, startTime, constraintsMap.get(vehicle.id));
          if (!evaluation.feasible) continue;
          evaluations?.set(candidate, evaluation);
          const candidateSolution: ALNSSolution = {
            routes: routes.map((currentRoute) => currentRoute === route ? candidate : currentRoute),
            unassigned: [...unassigned, ...sortedStops.slice(stopIndex + 1)],
            cost: 0,
            costBreakdown: emptyBreakdown(),
          };
          const candidateCost = computeSolutionCost(
            candidateSolution, vehicles, depotLat, depotLon, startTime, weights, constraintsMap, "balance",
            evaluations ? { evaluations, geographicCohesionCost } : undefined,
          );
          geographicCohesionCost = candidateCost.breakdown.geographicCohesionCost;
          const fillSelectedResource = weights.objectivePriority === "areas_worktime" && vehicleDistributionMode === "balance" && selected
            && route.nodes.length === 0 && selected.route.nodes.length > 0;
          const keepSelectedResource = weights.objectivePriority === "areas_worktime" && vehicleDistributionMode === "balance" && selected
            && route.nodes.length > 0 && selected.route.nodes.length === 0;
          if (!selected || fillSelectedResource || (!keepSelectedResource && compareSolutionScores(candidateCost, selected.score) < 0)) {
            selected = { route, position, score: candidateCost };
          }
        }
      }
      if (!selected) {
        unassigned.push(stop);
        continue;
      }
      selected.route.nodes.splice(selected.position, 0, stop);
      selected.route.totalWeight += stop.weightKg;
      selected.route.totalVolume += stop.volumeM3;
    }

    const balancedSolution: ALNSSolution = {
      routes,
      unassigned,
      cost: 0,
      costBreakdown: emptyBreakdown(),
    };
    chargingStationInsertion(balancedSolution, vehicles, depotLat, depotLon, startTime, constraintsMap);
    return balancedSolution;
  }

  interface AsyncCWRoute { stops: ALNSNode[]; weight: number; volume: number }
  const constraintsMap = new Map(driverConstraints.map(driver => [driver.vehicleId, driver]));
  const cwRoutes: AsyncCWRoute[] = stops.map(s => ({ stops: [s], weight: s.weightKg, volume: s.volumeM3 }));
  const stopToRoute = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) {
    stopToRoute.set(stops[i].id, i);
    await checkpoint();
  }

  const distFromDepot = new Map<string, number>();
  for (const s of stops) {
    distFromDepot.set(s.id, cachedDistance(depotLat, depotLon, s.latitude, s.longitude));
    await checkpoint();
  }

  interface AsyncSaving { i: number; j: number; value: number }
  const savings: AsyncSaving[] = [];
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      await checkpoint();
      const dI = distFromDepot.get(stops[i].id)!;
      const dJ = distFromDepot.get(stops[j].id)!;
      const dIJ = cachedDistance(stops[i].latitude, stops[i].longitude, stops[j].latitude, stops[j].longitude);
      const saving = dI + dJ - dIJ;
      if (saving > 0) savings.push({ i, j, value: saving });
    }
  }
  savings.sort((a, b) => b.value - a.value);

  for (const saving of savings) {
    await checkpoint();
    const rIdxI = stopToRoute.get(stops[saving.i].id)!;
    const rIdxJ = stopToRoute.get(stops[saving.j].id)!;
    if (rIdxI === rIdxJ) continue;
    const rI = cwRoutes[rIdxI];
    const rJ = cwRoutes[rIdxJ];
    if (rI.stops.length === 0 || rJ.stops.length === 0) continue;
    const mergedWeight = rI.weight + rJ.weight;
    const mergedVolume = rI.volume + rJ.volume;
    if (!vehicles.some(v => mergedWeight <= v.capacityKg && mergedVolume <= v.capacityVolume)) continue;
    const lastI = rI.stops[rI.stops.length - 1];
    const firstJ = rJ.stops[0];
    let mergedStops: ALNSNode[];
    if (lastI.id === stops[saving.i].id && firstJ.id === stops[saving.j].id) {
      mergedStops = [...rI.stops, ...rJ.stops];
    } else if (rJ.stops[rJ.stops.length - 1].id === stops[saving.j].id && rI.stops[0].id === stops[saving.i].id) {
      mergedStops = [...rJ.stops, ...rI.stops];
    } else {
      continue;
    }
    let feasible = false;
    for (const vehicle of vehicles) {
      await checkpoint();
      if (feasibleConstructionRoute(mergedStops, vehicle, depotLat, depotLon, startTime, constraintsMap)) {
        feasible = true;
        break;
      }
    }
    if (!feasible) continue;
    rI.stops = mergedStops;
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
    await checkpoint();
    let bestVehicleIdx = -1;
    for (let vi = 0; vi < sortedVehicles.length; vi++) {
      await checkpoint();
      const v = sortedVehicles[vi];
      if (usedVehicles.has(v.id)) continue;
      if (cwRoute.weight > v.capacityKg || cwRoute.volume > v.capacityVolume) continue;
      if (!feasibleConstructionRoute(cwRoute.stops, v, depotLat, depotLon, startTime, constraintsMap)) continue;
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
      routes[routeIdx] = feasibleConstructionRoute(
        cwRoute.stops, vehicle, depotLat, depotLon, startTime, constraintsMap,
      )!;
    }
  }

  const initialSolution: ALNSSolution = {
    routes,
    unassigned,
    cost: 0,
    costBreakdown: emptyBreakdown(),
  };
  chargingStationInsertion(initialSolution, vehicles, depotLat, depotLon, startTime, constraintsMap);
  return initialSolution;
}

export async function runALNS(
  initialSolution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {},
  onSearchProgress?: (progress: { iterations: number; improvements: number; elapsedMs: number }) => void,
  shouldCancel?: () => boolean,
): Promise<ALNSSolution> {
  await ensureOrganizationServicePolicy();
  if (initialSolution.routes.some(route => route.optimizationFrozen)) {
    throw new OptimizerPlanningLockConflict("Frysta rutter måste avskiljas före muterbar ALNS-sökning.");
  }
  const cfg: ALNSConfig = { ...DEFAULT_CONFIG, ...config };
  const weights = cfg.weights;
  const startMs = Date.now();

  setEnvCtx(cfg.environment ?? DEFAULT_ENV_CTX);

  const driverConstraintsMap = new Map<string, ALNSDriverConstraints>();
  if (cfg.driverConstraints) {
    for (const dc of cfg.driverConstraints) {
      driverConstraintsMap.set(dc.vehicleId, dc);
    }
  }

  const hasEvVehicles = vehicles.some(v => v.vehicleType === "electric" && v.rangeKm);
  const destroyOps = hasEvVehicles
    ? ["random", "worst", "shaw", "relatedness", "route_remove", "timewindow", "charging_remove"] as const
    : ["random", "worst", "shaw", "relatedness", "route_remove", "timewindow"] as const;
  const repairOps = hasEvVehicles
    ? ["greedy", "regret3", "charging_insert"] as const
    : ["greedy", "regret3"] as const;

  const destroyStats: Record<string, OperatorStats> = {};
  const repairStats: Record<string, OperatorStats> = {};

  for (const op of destroyOps) destroyStats[op] = { score: 0, uses: 0, weight: 1 };
  for (const op of repairOps) repairStats[op] = { score: 0, uses: 0, weight: 1 };

  // Reference map of composite P&D nodes, used to repair any operator bug
  // that would strip a node's embedded pickup leg (same-vehicle guarantee).
  const pdReference = buildPdReferenceMap([
    ...initialSolution.routes.flatMap(r => r.nodes),
    ...initialSolution.unassigned,
  ]);

  let currentSolution = deepCloneSolution(initialSolution);
  let { cost: currentCost, breakdown } = computeSolutionCost(currentSolution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap, cfg.vehicleDistributionMode);
  currentSolution.cost = currentCost;
  currentSolution.costBreakdown = breakdown;

  let bestSolution = deepCloneSolution(currentSolution);
  let bestCost = currentCost;

  let temperature = cfg.initialTemperature;
  let iteration = 0;
  let improvements = 0;
  let lastImprovementIteration = 0;
  let lastProgressAt = startMs;
  let stopReason: NonNullable<ALNSSolution["runStats"]>["stopReason"] = "max_iterations";
  const SEGMENT_LENGTH = 100;
  // Continuous optimization supplies a cancellation predicate. Keep those
  // passes observable at a tighter cadence than the batch optimizer so a stop
  // request gets a macrotask opportunity before another expensive iteration.
  const progressIntervalMs = shouldCancel ? 50 : 250;

  while (iteration < cfg.maxIterations) {
    if (shouldCancel?.()) break;
    if (Date.now() - startMs >= cfg.timeLimitMs) {
      stopReason = "time_limit";
      break;
    }
    if (
      cfg.maxNoImprovementIterations != null
      && iteration >= cfg.minIterationsBeforeEarlyStop
      && iteration - lastImprovementIteration >= cfg.maxNoImprovementIterations
    ) {
      stopReason = "no_improvement";
      break;
    }

    iteration++;
    const candidate = deepCloneSolution(currentSolution);

    // Geographic moves consume existing iteration/time budgets. No additional
    // construction or reseeding pass, and no change for zero-weight profiles.
    if (weights.geographicCohesionWeight > 0 && iteration % 10 === 0) {
      const improved = await geographicGroupSearch(
        candidate, vehicles, depotLat, depotLon, startTime, weights,
        driverConstraintsMap, cfg.vehicleDistributionMode, iteration,
        () => Boolean(shouldCancel?.()) || Date.now() - startMs >= cfg.timeLimitMs,
      );
      const areasWarmValid = weights.objectivePriority !== "areas_worktime" || (
        candidate.unassigned.length <= currentSolution.unassigned.length
        && (cfg.vehicleDistributionMode !== "balance" || candidate.routes.filter(r => r.nodes.some(n => !n.isChargingStation)).length
          >= currentSolution.routes.filter(r => r.nodes.some(n => !n.isChargingStation)).length)
        && hasSameRealStopMultiset(initialSolution, candidate)
        && hasHardValidRoutes(candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap)
        && candidate.routes.every(r => !r.lockedFirstStopId || r.nodes.find(n => !n.isChargingStation)?.id === r.lockedFirstStopId)
        && compareSolutions(candidate, currentSolution) < 0
      );
      if (improved && areasWarmValid) {
        currentSolution = candidate;
        currentCost = candidate.cost;
        if (weights.objectivePriority === "areas_worktime"
          ? candidate.unassigned.length <= bestSolution.unassigned.length && compareSolutions(candidate, bestSolution) < 0
          : compareUnassignedCoverage(candidate.unassigned, bestSolution.unassigned) <= 0 &&
            (weights.searchProfile ? compareSolutions(candidate, bestSolution) < 0 : candidate.cost < bestCost)) {
          bestSolution = deepCloneSolution(candidate);
          bestCost = candidate.cost;
          improvements++;
          lastImprovementIteration = iteration;
        }
      }
      onSearchProgress?.({ iterations: iteration, improvements, elapsedMs: Date.now() - startMs });
      continue;
    }

    const totalDeliveryNodes = candidate.routes.reduce(
      (sum, r) => sum + r.nodes.filter(n => !n.isChargingStation).length, 0
    );
    const removalCount = Math.max(1, Math.min(
      Math.floor(totalDeliveryNodes * cfg.removalFraction),
      totalDeliveryNodes - 1
    ));

    if (removalCount <= 0 || totalDeliveryNodes <= 0) {
      stopReason = "no_nodes";
      break;
    }

    const destroyOp = selectOperator(destroyStats);
    let removedNodes: ALNSNode[];

    switch (destroyOp) {
      case "random":
        removedNodes = randomRemoval(candidate, removalCount);
        break;
      case "worst":
        removedNodes = onSearchProgress || weights.objectivePriority === "areas_worktime"
          ? await worstRemovalCooperative(candidate, removalCount, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
            weights.objectivePriority === "areas_worktime"
              ? () => Boolean(shouldCancel?.()) || Date.now() - startMs >= cfg.timeLimitMs : undefined)
          : worstRemoval(candidate, removalCount, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap);
        break;
      case "shaw":
        removedNodes = shawRemoval(candidate, removalCount);
        break;
      case "relatedness":
        removedNodes = relatednessRemoval(candidate, removalCount);
        break;
      case "route_remove":
        removedNodes = routeRemoval(candidate, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap);
        break;
      case "timewindow":
        removedNodes = timeWindowRemoval(candidate, removalCount, depotLat, depotLon, startTime);
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

    if (weights.objectivePriority === "areas_worktime") {
      await areasInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
        () => Boolean(shouldCancel?.()) || Date.now() - startMs >= cfg.timeLimitMs);
    } else switch (repairOp) {
      case "greedy":
        if (onSearchProgress) {
          await greedyInsertionCooperative(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
        } else {
          greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
        }
        break;
      case "regret3":
        if (onSearchProgress) {
          await regretKInsertionCooperative(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, 3, driverConstraintsMap);
        } else {
          regretKInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, 3, driverConstraintsMap);
        }
        break;
      case "charging_insert":
        if (onSearchProgress) {
          await greedyInsertionCooperative(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
        } else {
          greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
        }
        chargingStationInsertion(candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
        break;
      default:
        greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
    }

    if (weights.objectivePriority === "areas_worktime" && Date.now() - startMs >= cfg.timeLimitMs) {
      stopReason = "time_limit";
      break; // Discard interrupted proposal; never publish partial repair.
    }
    if (repairOp !== "charging_insert") {
      chargingStationInsertion(candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
    }
    removeUnusedChargingStations(candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);

    // Hard P&D constraint: a pickup and its delivery must stay on one vehicle.
    // Composite nodes make splits structurally impossible; this guard repairs
    // any duplicate/corrupted node an operator might produce.
    enforcePdIntegrity(candidate, pdReference);

    const { cost: candidateCost, breakdown: candidateBreakdown } = computeSolutionCost(
      candidate, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap, cfg.vehicleDistributionMode
    );
    candidate.cost = candidateCost;
    candidate.costBreakdown = candidateBreakdown;

    const areas = weights.objectivePriority === "areas_worktime";
    const namedProfile = !!weights.searchProfile;
    const costDiff = areas || namedProfile ? compareSolutions(candidate, currentSolution) : candidateCost - currentCost;
    const coverageComparison = compareUnassignedCoverage(candidate.unassigned, bestSolution.unassigned);
    const preservesResources = !areas || cfg.vehicleDistributionMode !== "balance" || candidate.routes.filter(r => r.nodes.some(n => !n.isChargingStation)).length
      >= bestSolution.routes.filter(r => r.nodes.some(n => !n.isChargingStation)).length;
    const hardValid = !areas || (hasHardValidRoutes(candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap)
      && candidate.routes.every(r => !r.lockedFirstStopId || r.nodes.find(n => !n.isChargingStation)?.id === r.lockedFirstStopId)
      && hasSameRealStopMultiset(initialSolution, candidate));
    const improvesBest = hardValid && preservesResources && Number.isFinite(candidateCost) &&
      (!namedProfile || candidateBreakdown.profileScore?.[0] === 0) &&
      (areas || namedProfile ? compareSolutions(candidate, bestSolution) < 0
        && candidate.unassigned.length <= bestSolution.unassigned.length
        : (coverageComparison < 0 || (coverageComparison === 0 && candidateCost < bestCost)));
    if (improvesBest) {
      bestSolution = deepCloneSolution(candidate);
      bestCost = candidateCost;
      improvements++;
      lastImprovementIteration = iteration;
      updateOperatorScore(destroyStats, destroyOp, 3);
      updateOperatorScore(repairStats, repairOp, 3);
    }

    let accepted = false;
    if (costDiff < 0 || improvesBest) {
      accepted = true;
      if (!improvesBest) {
        updateOperatorScore(destroyStats, destroyOp, 2);
        updateOperatorScore(repairStats, repairOp, 2);
      }
    } else if (!areas) {
      const acceptProb = Math.exp(-costDiff / temperature);
      if (Math.random() < acceptProb) {
        accepted = true;
        updateOperatorScore(destroyStats, destroyOp, 1);
        updateOperatorScore(repairStats, repairOp, 1);
      }
    }

    if (areas && (!hardValid || !preservesResources || candidate.unassigned.length > currentSolution.unassigned.length
      || candidate.costBreakdown.areasWorktime!.infeasibleRoutes > 0)) accepted = false;
    if (accepted) {
      currentSolution = candidate;
      currentCost = candidateCost;
    }

    temperature *= cfg.coolingRate;

    if (iteration % SEGMENT_LENGTH === 0) {
      updateOperatorWeights(destroyStats);
      updateOperatorWeights(repairStats);
    }

    const now = Date.now();
    if (
      (onSearchProgress || shouldCancel) &&
      now - lastProgressAt >= progressIntervalMs
    ) {
      onSearchProgress?.({ iterations: iteration, improvements, elapsedMs: now - startMs });
      lastProgressAt = now;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (shouldCancel?.()) break;
    }
  }

  const searchMs = Date.now() - startMs;
  if (onSearchProgress || shouldCancel) {
    onSearchProgress?.({ iterations: iteration, improvements, elapsedMs: searchMs });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (shouldCancel?.()) return bestSolution;
  // Legacy route-only local search and fleet consolidation optimize a scalar
  // objective. The areas search has already compared repaired full plans;
  // do not let those final passes undo its hierarchy or selected resources.
  if (weights.objectivePriority === "areas_worktime") {
    bestSolution.runStats = { iterations: iteration, improvements, searchMs, localSearchMs: 0, stopReason };
    return bestSolution;
  }
  // Local search operators compare individual route costs while exploring.
  // That is sufficient for minimize mode, but balance mode also scores the
  // solution-wide longest workday. Keep a valid pre-postprocess snapshot
  // so route-only improvements cannot worsen the configured global objective.
  const prePostProcessSolution = deepCloneSolution(bestSolution);
  const {
    cost: prePostProcessCost,
    breakdown: prePostProcessBreakdown,
  } = computeSolutionCost(
    prePostProcessSolution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    weights,
    driverConstraintsMap,
    cfg.vehicleDistributionMode,
  );
  const prePostProcessHardValid = hasHardValidRoutes(
    prePostProcessSolution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    driverConstraintsMap,
  );

  const localSearchStartedAt = Date.now();
  const retainBeforePostProcessing = () => {
    if (!shouldCancel?.()) {
      prePostProcessSolution.runStats = {
        iterations: iteration, improvements, searchMs,
        localSearchMs: Date.now() - localSearchStartedAt, stopReason,
      };
    }
    return prePostProcessSolution;
  };
  const postProcessDeadline = startMs + cfg.timeLimitMs + cfg.localSearchTimeLimitMs;
  const stopPostProcessing = () => Boolean(shouldCancel?.()) || Date.now() >= postProcessDeadline;
  // Import-sized runs also provide search progress. Use the sliced async
  // post-process in that path even without cancellation: a synchronous local
  // search can otherwise monopolize the event loop between progress updates.
  if (shouldCancel || onSearchProgress) {
    const localSearchCompleted = await localSearchPostProcessCancellable(
      bestSolution,
      vehicles,
      depotLat,
      depotLon,
      startTime,
      weights,
      driverConstraintsMap,
      Math.max(0, Math.min(cfg.localSearchTimeLimitMs, postProcessDeadline - Date.now())),
      stopPostProcessing,
    );
    if (!localSearchCompleted || shouldCancel?.()) return retainBeforePostProcessing();
  } else {
    localSearchPostProcess(
      bestSolution,
      vehicles,
      depotLat,
      depotLon,
      startTime,
      weights,
      driverConstraintsMap,
      Math.max(0, Math.min(cfg.localSearchTimeLimitMs, postProcessDeadline - Date.now())),
    );
  }
  if (cfg.vehicleDistributionMode === "minimize") {
    if (Date.now() < postProcessDeadline && !shouldCancel?.()) {
      const consolidationCompleted = await consolidateRoutes(
        bestSolution,
        vehicles,
        depotLat,
        depotLon,
        startTime,
        driverConstraintsMap,
        weights,
        stopPostProcessing,
      );
      if (!consolidationCompleted || stopPostProcessing()) return retainBeforePostProcessing();
    } else {
      // Do not start an unbounded fleet consolidation after exhausting the budget.
      return retainBeforePostProcessing();
    }
    removeUnusedChargingStations(bestSolution, vehicles, depotLat, depotLon, startTime, driverConstraintsMap);
  }
  if (shouldCancel?.()) return retainBeforePostProcessing();
  const localSearchMs = Date.now() - localSearchStartedAt;
  enforcePdIntegrity(bestSolution, pdReference);

  const { cost: finalCost, breakdown: finalBreakdown } = computeSolutionCost(
    bestSolution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap, cfg.vehicleDistributionMode
  );
  const finalHardValid = hasHardValidRoutes(
    bestSolution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    driverConstraintsMap,
  );
  const keepPostProcess = finalHardValid
    && (!prePostProcessHardValid || finalCost <= prePostProcessCost + 0.000_001)
    && hasSameRealStopMultiset(prePostProcessSolution, bestSolution);

  if (keepPostProcess) {
    bestSolution.cost = finalCost;
    bestSolution.costBreakdown = finalBreakdown;
  } else {
    bestSolution = prePostProcessSolution;
    bestSolution.cost = prePostProcessCost;
    bestSolution.costBreakdown = prePostProcessBreakdown;
  }
  bestSolution.runStats = {
    iterations: iteration,
    improvements,
    searchMs,
    localSearchMs,
    stopReason,
  };

  return bestSolution;
}

export async function optimizeWithALNS(
  stops: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {},
  onProgress?: (progress: ClusteredOptimizationProgress) => void
): Promise<ALNSResult> {
  await ensureOrganizationServicePolicy();
  const usageContext = getUsageContext();
  const startedAt = Date.now();
  const stopCount = stops.filter((stop) => !stop.isChargingStation).length;
  let outcome = "success";

  try {
    const result = await withOptimizationEnvironment(config.environment ?? DEFAULT_ENV_CTX,
      () => withRequiredRoadData(() => optimizeWithALNSImpl(
      stops,
      vehicles,
      depotLat,
      depotLon,
      startTime,
      config,
      onProgress,
    )));
    assertPlanningLockResult(stops, result.routes, result.unassigned, vehicles, depotLat, depotLon, startTime,
      new Map((config.driverConstraints ?? []).map(item => [item.vehicleId, item])));
    return { ...result, environment: { ...(config.environment ?? DEFAULT_ENV_CTX) } };
  } catch (error) {
    outcome = "failure";
    throw error;
  } finally {
    if (usageContext) {
      const durationMs = Date.now() - startedAt;
      try {
        await recordUsage({
          organizationId: usageContext.organizationId,
          jobId: usageContext.jobId,
          eventKey: randomUUID(),
          category: "optimization",
          provider: "internal",
          operation: "alns",
          outcome,
          units: durationMs / 1000,
          durationMs,
          stopCount,
          sizeClass: stopCount > 100 ? "large" : "small",
          engine: "alns",
        });
      } catch (error) {
        logger.error(
          { event: "usage_ledger_write_failed", provider: "internal", operation: "alns", error },
          "Could not persist optimization usage event",
        );
      }
    }
  }
}

async function optimizeWithALNSImpl(
  stops: ALNSNode[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {},
  onProgress?: (progress: ClusteredOptimizationProgress) => void
): Promise<ALNSResult> {
  // Geographic cluster fleet allocation must not strand an exact/resource lock
  // in a cluster without its selected pair. Keep a single bounded search until
  // the cluster allocator supports cross-cluster lock groups.
  const CLUSTER_THRESHOLD = stops.some(node =>
    node.lockedVehicleId || node.lockedDriverId || node.lockedServiceStartAt,
  ) ? Infinity : 100;
  const startMs = Date.now();
  assertOperationalRoadProvider();

  globalDistanceCache.clear();

  const reportProgress = async (progress: ClusteredOptimizationProgress) => {
    if (!onProgress) return;
    onProgress(progress);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const hasEvVehicles = vehicles.some(v => v.vehicleType === "electric" && v.rangeKm);
  const allCoords = [
    { lat: depotLat, lon: depotLon },
    ...vehicles.flatMap(vehicle => [
      { lat: vehicle.startLatitude ?? depotLat, lon: vehicle.startLongitude ?? depotLon },
      { lat: vehicle.endLatitude ?? depotLat, lon: vehicle.endLongitude ?? depotLon },
    ]),
    ...stops.flatMap(s => [
      { lat: s.latitude, lon: s.longitude },
      ...(s.pickupLat != null && s.pickupLon != null
        ? [{ lat: s.pickupLat, lon: s.pickupLon }]
        : []),
    ]),
    ...(hasEvVehicles
      ? CHARGING_STATIONS.map(s => ({ lat: s.latitude, lon: s.longitude }))
      : []),
  ];
  const cacheWasComplete = getDistanceMatrixCacheCoverage(allCoords).complete;
  const distanceStartedAt = Date.now();
  await reportProgress({
    totalClusters: 0,
    completedClusters: 0,
    phase: "distance_matrix",
    elapsedMs: distanceStartedAt - startMs,
    iterations: 0,
    improvements: 0,
    stopReason: null,
    clusterStopReasons: {},
  });
  const completeRoadMatrix = await precomputeDistanceMatrix(allCoords, {
    timeoutMs: config.distanceMatrixTimeoutMs,
  });
  const distanceMatrixMs = Date.now() - distanceStartedAt;
  const coverageAfterPrecompute = getDistanceMatrixCacheCoverage(allCoords);
  // A one-coordinate itinerary needs no external road leg.
  if (coverageAfterPrecompute.totalPairs > 0 && !coverageAfterPrecompute.complete) {
    throw new RoadDataUnavailableError();
  }
  const distanceSource = cacheWasComplete || coverageAfterPrecompute.totalPairs === 0
    ? "cache"
    : coverageAfterPrecompute.complete
      ? "osrm"
      : coverageAfterPrecompute.cachedPairs > 0
        ? "mixed"
        : "haversine";
  if (coverageAfterPrecompute.totalPairs === 0) {
    console.log(`Road matrix: ${stops.length} coincident stops need no external road legs`);
  } else if (completeRoadMatrix) {
    console.log(`OSRM: Using real road distances for ${stops.length} stops${hasEvVehicles ? ` + ${CHARGING_STATIONS.length} charging stations` : ""}`);
  } else if (coverageAfterPrecompute.cachedPairs > 0) {
    console.warn(`OSRM: Using a mixed road-distance matrix for ${stops.length} stops`);
  } else {
    console.log(`OSRM: Falling back to Haversine distances for ${stops.length} stops`);
  }

  // Neighborhood ownership and fleet workload are global objectives. Independent
  // cluster incumbents cannot implement this hierarchy.
  if (config.weights?.objectivePriority !== "areas_worktime" && stops.length > CLUSTER_THRESHOLD && vehicles.length >= 2) {
    await reportProgress({
      totalClusters: 0,
      completedClusters: 0,
      phase: "clustering",
      elapsedMs: 0,
      iterations: 0,
      improvements: 0,
      stopReason: null,
      clusterStopReasons: {},
    });

    const targetClusterSize = 60;
    const clusteringStartedAt = Date.now();
    // Let the HTTP progress endpoint and heartbeat run before the bounded but
    // CPU-heavy consensus pass begins.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const { clusters, borderStopIds } = usesRoadSeed(config.weights?.searchProfile)
      ? roadMedoidClusters(stops, targetClusterSize)
      : consensusClustering(stops, targetClusterSize);
    const clusteringMs = Date.now() - clusteringStartedAt;
    console.log(`Clustering: ${clusters.length} clusters from ${stops.length} stops (${usesRoadSeed(config.weights?.searchProfile) ? "road medoids" : "DBSCAN consensus"}, ${borderStopIds.size} border stops)`);

    const vehiclesPerCluster = allocateClusterVehicles(clusters, vehicles, startTime, config.driverConstraints);
    const timeBudget = config.timeLimitMs ?? 30000;
    const mergeDeadline = Date.now() + timeBudget;
    // Keep room for fleet-wide consolidation rather than optimizing each
    // cluster in isolation and then claiming a minimum-vehicle result.
    const searchDeadline = mergeDeadline - Math.floor(timeBudget * 0.2);

    const allRoutes: ALNSRoute[] = [];
    const allUnassigned: ALNSNode[] = [];
    let alnsSearchMs = 0;
    let totalIterations = 0;
    let totalImprovements = 0;
    const clusterStopReasons: Partial<Record<ClusterStopReason, number>> = {};

    for (let ci = 0; ci < clusters.length; ci++) {
      const clusterVehicles = vehiclesPerCluster[ci];
      if (clusterVehicles.length === 0) {
        allUnassigned.push(...clusters[ci]);
        clusterStopReasons.no_vehicles = (clusterStopReasons.no_vehicles ?? 0) + 1;
        await reportProgress({
          totalClusters: clusters.length,
          completedClusters: ci + 1,
          phase: "optimizing",
          elapsedMs: Date.now() - startMs,
          iterations: totalIterations,
          improvements: totalImprovements,
          stopReason: summarizeClusterStopReasons(clusterStopReasons),
          clusterStopReasons: { ...clusterStopReasons },
        });
        continue;
      }

      await reportProgress({
        totalClusters: clusters.length,
        completedClusters: ci,
        phase: "optimizing",
        elapsedMs: Date.now() - startMs,
        iterations: totalIterations,
        improvements: totalImprovements,
        stopReason: summarizeClusterStopReasons(clusterStopReasons),
        clusterStopReasons: { ...clusterStopReasons },
      });

      const perClusterTime = Math.max(0, Math.floor((searchDeadline - Date.now()) / (clusters.length - ci)));
      const clusterConfig = {
        ...config,
        timeLimitMs: perClusterTime,
        localSearchTimeLimitMs: Math.min(config.localSearchTimeLimitMs ?? 5000, Math.floor(perClusterTime * 0.2)),
      };
      const clusterSearchStartedAt = Date.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const initial = await buildInitialSolutionFromCWAsync(
        clusters[ci],
        clusterVehicles,
        depotLat,
        depotLon,
        startTime,
        clusterConfig.vehicleDistributionMode,
        clusterConfig.driverConstraints,
        clusterConfig.weights ?? DEFAULT_WEIGHTS,
      );
      const best = await runALNS(
        initial,
        clusterVehicles,
        depotLat,
        depotLon,
        startTime,
        {
          ...clusterConfig,
          timeLimitMs: Math.max(0, perClusterTime - (Date.now() - clusterSearchStartedAt)
            - (clusterConfig.localSearchTimeLimitMs ?? 0)),
        },
        (clusterProgress) => {
          onProgress?.({
            totalClusters: clusters.length,
            completedClusters: ci,
            phase: "optimizing",
            elapsedMs: Date.now() - startMs,
            iterations: totalIterations + clusterProgress.iterations,
            improvements: totalImprovements + clusterProgress.improvements,
            stopReason: summarizeClusterStopReasons(clusterStopReasons),
            clusterStopReasons: { ...clusterStopReasons },
          });
        },
      );
      alnsSearchMs += Date.now() - clusterSearchStartedAt;
      if (best.runStats) {
        totalIterations += best.runStats.iterations;
        totalImprovements += best.runStats.improvements;
        clusterStopReasons[best.runStats.stopReason] = (clusterStopReasons[best.runStats.stopReason] ?? 0) + 1;
      }

      allRoutes.push(...best.routes.filter(r => r.nodes.length > 0));
      allUnassigned.push(...best.unassigned);

      await reportProgress({
        totalClusters: clusters.length,
        completedClusters: ci + 1,
        phase: "optimizing",
        elapsedMs: Date.now() - startMs,
        iterations: totalIterations,
        improvements: totalImprovements,
        stopReason: summarizeClusterStopReasons(clusterStopReasons),
        clusterStopReasons: { ...clusterStopReasons },
      });
    }

    await reportProgress({
      totalClusters: clusters.length,
      completedClusters: clusters.length,
      phase: "merging",
      elapsedMs: Date.now() - startMs,
      iterations: totalIterations,
      improvements: totalImprovements,
      stopReason: summarizeClusterStopReasons(clusterStopReasons),
      clusterStopReasons: { ...clusterStopReasons },
    });

    const mergingStartedAt = Date.now();
    const weights = config.weights ?? DEFAULT_WEIGHTS;
    const driverConstraintsMap = new Map<string, ALNSDriverConstraints>();
    if (config.driverConstraints) {
      for (const dc of config.driverConstraints) driverConstraintsMap.set(dc.vehicleId, dc);
    }

    if (borderStopIds.size > 0) {
      if (onProgress) {
        await crossClusterImproveCooperative(
          allRoutes,
          borderStopIds,
          vehicles,
          depotLat,
          depotLon,
          startTime,
          weights,
          driverConstraintsMap,
          Math.max(0, Math.min(2000, mergeDeadline - Date.now())),
          config.vehicleDistributionMode ?? "minimize",
        );
      } else {
        crossClusterImprove(
          allRoutes,
          borderStopIds,
          vehicles,
          depotLat,
          depotLon,
          startTime,
          weights,
          driverConstraintsMap,
          Math.max(0, Math.min(2000, mergeDeadline - Date.now())),
          config.vehicleDistributionMode ?? "minimize",
        );
      }
    }

    for (const v of vehicles) {
      if (!allRoutes.some(r => r.vehicleId === v.id)) {
        allRoutes.push({ vehicleId: v.id, nodes: [], totalWeight: 0, totalVolume: 0 });
      }
    }

    if (config.vehicleDistributionMode === "minimize" && Date.now() < mergeDeadline) {
      const merged: ALNSSolution = {
        routes: allRoutes, unassigned: allUnassigned, cost: 0,
        costBreakdown: {
          distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
          geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0,
          totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
        },
      };
      // Consolidation may stop halfway through a source route. Work on a
      // clone and admit only a complete, hard-valid, stop-conserving result.
      const candidate = deepCloneSolution(merged);
      const completed = await consolidateRoutes(
        candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap,
        weights, () => Date.now() >= mergeDeadline,
      );
      if (completed && hasSameRealStopMultiset(merged, candidate) &&
        hasHardValidRoutes(candidate, vehicles, depotLat, depotLon, startTime, driverConstraintsMap)) {
        const before = computeSolutionCost(merged, vehicles, depotLat, depotLon, startTime,
          weights, driverConstraintsMap, "minimize").cost;
        const after = computeSolutionCost(candidate, vehicles, depotLat, depotLon, startTime,
          weights, driverConstraintsMap, "minimize").cost;
        if (after <= before) allRoutes.splice(0, allRoutes.length, ...candidate.routes);
      }
    }

    const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
    const routeEvaluations = new Map<string, RouteEvaluation>();

    for (const route of allRoutes) {
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle || route.nodes.length === 0) continue;
      const constraints = driverConstraintsMap.get(route.vehicleId);
      const evalResult = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
      if (!evalResult.feasible) {
        allUnassigned.push(...route.nodes.filter((node) => !node.isChargingStation));
        route.nodes = [];
        route.totalWeight = 0;
        route.totalVolume = 0;
        continue;
      }
      routeEvaluations.set(route.vehicleId, evalResult);

    }
    // Re-score the merged/pruned routes as one solution. Summing cluster
    // components is not equivalent to the global objective: cross-cluster
    // moves, active-route distribution, cohesion, unassigned stops, and
    // infeasibility penalties all depend on the final merged assignment.
    const mergedSolution: ALNSSolution = {
      routes: allRoutes,
      unassigned: allUnassigned,
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
    const { breakdown: finalBreakdown } = computeSolutionCost(
      mergedSolution,
      vehicles,
      depotLat,
      depotLon,
      startTime,
      weights,
      driverConstraintsMap,
      config.vehicleDistributionMode,
    );
    const mergingMs = Date.now() - mergingStartedAt;
    const stopReason: OptimizationStopReason = summarizeClusterStopReasons(clusterStopReasons) ?? "mixed";

    await reportProgress({
      totalClusters: clusters.length,
      completedClusters: clusters.length,
      phase: "complete",
      elapsedMs: Date.now() - startMs,
      iterations: totalIterations,
      improvements: totalImprovements,
      stopReason,
      clusterStopReasons: { ...clusterStopReasons },
    });

    return {
      routes: allRoutes,
      unassigned: allUnassigned,
      costBreakdown: finalBreakdown,
      routeEvaluations,
      performance: {
        distanceMatrixMs,
        clusteringMs,
        alnsSearchMs,
        mergingMs,
        searchMs: alnsSearchMs,
        totalMs: Date.now() - startMs,
        distanceSource,
        runStats: {
          totalClusters: clusters.length,
          optimizedClusters: clusters.length - (clusterStopReasons.no_vehicles ?? 0),
          iterations: totalIterations,
          improvements: totalImprovements,
          stopReason,
          clusterStopReasons,
        },
      },
    };
  }

  await reportProgress({
    totalClusters: 1,
    completedClusters: 0,
    phase: "optimizing",
    elapsedMs: Date.now() - startMs,
    iterations: 0,
    improvements: 0,
    stopReason: null,
    clusterStopReasons: {},
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const initialSolution = await buildInitialSolutionFromCWAsync(
    stops,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    config.vehicleDistributionMode,
    config.driverConstraints,
    config.weights ?? DEFAULT_WEIGHTS,
    config.weights?.objectivePriority === "areas_worktime"
      ? () => Date.now() - startMs >= (config.timeLimitMs ?? DEFAULT_CONFIG.timeLimitMs)
      : undefined,
  );
  const bestSolution = await runALNS(
    initialSolution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    config.weights?.objectivePriority === "areas_worktime"
      ? { ...config, timeLimitMs: Math.max(0, (config.timeLimitMs ?? DEFAULT_CONFIG.timeLimitMs) - (Date.now() - startMs)) }
      : config,
    onProgress
      ? (searchProgress) =>
          onProgress({
            totalClusters: 1,
            completedClusters: 0,
            phase: "optimizing",
            elapsedMs: Date.now() - startMs,
            iterations: searchProgress.iterations,
            improvements: searchProgress.improvements,
            stopReason: null,
            clusterStopReasons: {},
          })
      : undefined,
  );

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
    if (!evalResult.feasible) {
      bestSolution.unassigned.push(...route.nodes.filter((node) => !node.isChargingStation));
      route.nodes = [];
      route.totalWeight = 0;
      route.totalVolume = 0;
      continue;
    }
    routeEvaluations.set(route.vehicleId, evalResult);
  }

  // Route validation above can prune a route and move its stops to
  // `unassigned`. Recompute from that final assignment so the reported score
  // cannot describe the pre-pruning solution.
  bestSolution.costBreakdown = computeSolutionCost(
    bestSolution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    config.weights ?? DEFAULT_WEIGHTS,
    driverConstraintsMap,
    config.vehicleDistributionMode,
  ).breakdown;

  return {
    routes: bestSolution.routes,
    unassigned: bestSolution.unassigned,
    costBreakdown: bestSolution.costBreakdown,
    routeEvaluations,
    performance: {
      distanceMatrixMs,
      clusteringMs: 0,
      alnsSearchMs: bestSolution.runStats
        ? bestSolution.runStats.searchMs + bestSolution.runStats.localSearchMs
        : Date.now() - startMs - distanceMatrixMs,
      mergingMs: 0,
      searchMs: bestSolution.runStats
        ? bestSolution.runStats.searchMs + bestSolution.runStats.localSearchMs
        : Date.now() - startMs - distanceMatrixMs,
      totalMs: Date.now() - startMs,
      distanceSource,
      runStats: bestSolution.runStats,
    },
  };
}

export async function reoptimizeAffectedRoutes(
  currentRoutes: ALNSRoute[],
  affectedVehicleIds: string[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {}
): Promise<ALNSResult> {
  await ensureOrganizationServicePolicy();
  const frozenVehicles = new Set(currentRoutes.filter(route => route.optimizationFrozen).map(route => route.vehicleId));
  const constraintsByVehicle = new Map((config.driverConstraints ?? []).map(item => [item.vehicleId, item]));
  for (const route of currentRoutes.filter(item => item.optimizationFrozen)) {
    withOptimizationEnvironment(config.environment ?? DEFAULT_ENV_CTX, () => assertFrozenRouteFeasible(
      route, vehicles.find(vehicle => vehicle.id === route.vehicleId), depotLat, depotLon, startTime,
      constraintsByVehicle.get(route.vehicleId),
    ));
  }
  const affectedSet = new Set(affectedVehicleIds.filter(id => !frozenVehicles.has(id)));
  const stableRoutes = currentRoutes.filter(r => !affectedSet.has(r.vehicleId));
  const affectedRoutes = currentRoutes.filter(r => affectedSet.has(r.vehicleId));
  const affectedVehicles = vehicles.filter(v => affectedSet.has(v.id));
  const lockedFirstByVehicle = new Map(
    affectedRoutes
      .filter((route) => route.lockedFirstStopId != null)
      .map((route) => [route.vehicleId, route.lockedFirstStopId!] as const),
  );

  const allNodes: ALNSNode[] = [];
  for (const route of affectedRoutes) {
    allNodes.push(...route.nodes.filter(n =>
      !n.isChargingStation && n.id !== route.lockedFirstStopId,
    ));
  }

  const reoptConfig: Partial<ALNSConfig> = {
    ...config,
    timeLimitMs: Math.min(config.timeLimitMs ?? 15000, 15000),
  };

  const result = await optimizeWithALNS(allNodes, affectedVehicles, depotLat, depotLon, startTime, reoptConfig);
  for (const [vehicleId, lockedStopId] of lockedFirstByVehicle) {
    const sourceRoute = affectedRoutes.find((route) => route.vehicleId === vehicleId);
    const lockedNode = sourceRoute?.nodes.find((node) => node.id === lockedStopId);
    if (!lockedNode) {
      const conflict = new Error(
        "Den låsta första kundjobbsnoden saknas i omplaneringsunderlaget. Ladda om planen och försök igen.",
      ) as Error & { statusCode: number };
      conflict.statusCode = 409;
      throw conflict;
    }
    const destination = result.routes.find((route) => route.vehicleId === vehicleId)
      ?? {
        vehicleId,
        nodes: [],
        totalWeight: 0,
        totalVolume: 0,
      };
    if (!result.routes.includes(destination)) result.routes.push(destination);
    destination.nodes = [
      lockedNode,
      ...destination.nodes.filter((node) => node.id !== lockedStopId),
    ];
    destination.totalWeight = destination.nodes.reduce(
      (sum, node) => sum + (node.weightKg ?? 0),
      0,
    );
    destination.totalVolume = destination.nodes.reduce(
      (sum, node) => sum + (node.volumeM3 ?? 0),
      0,
    );
    destination.lockedFirstStopId = lockedStopId;
  }

  // Chargers may be inserted before a pinned customer job when needed for EV
  // range safety. Reassert the customer position after insertion and fail
  // closed if the pinned assignment is infeasible.
  const affectedSolution: ALNSSolution = {
    routes: result.routes,
    unassigned: result.unassigned,
    cost: 0,
    costBreakdown: result.costBreakdown,
  };
  chargingStationInsertion(affectedSolution, affectedVehicles, depotLat, depotLon, startTime);
  for (const [vehicleId, lockedStopId] of lockedFirstByVehicle) {
    const destination = result.routes.find((route) => route.vehicleId === vehicleId);
    const firstCustomer = destination?.nodes.find((node) => !node.isChargingStation);
    const vehicle = affectedVehicles.find((candidate) => candidate.id === vehicleId);
    const constraints = new Map(
      (reoptConfig.driverConstraints ?? []).map((item) => [item.vehicleId, item]),
    );
    if (
      !destination
      || firstCustomer?.id !== lockedStopId
      || !vehicle
      || !evaluateRoute(
        destination,
        vehicle,
        depotLat,
        depotLon,
        startTime,
        constraints.get(vehicleId),
      ).feasible
    ) {
      const conflict = new Error(
        "Den låsta första kundjobbsnoden kan inte behållas säkert med vald bil och planens hårda villkor.",
      ) as Error & { statusCode: number };
      conflict.statusCode = 409;
      throw conflict;
    }
  }
  const combinedRoutes = [...stableRoutes, ...result.routes];
  assertLockedJobsRetained(currentRoutes.flatMap(route => route.nodes), combinedRoutes, result.unassigned);
  for (const route of combinedRoutes.filter(item => item.nodes.some(hasPlanningLock))) {
    const vehicle = vehicles.find(item => item.id === route.vehicleId);
    if (!vehicle || !evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraintsByVehicle.get(route.vehicleId)).feasible) {
      throw new OptimizerPlanningLockConflict(`Den låsta rutten för ${route.vehicleId} kunde inte behållas säkert.`);
    }
  }
  const combinedSolution: ALNSSolution = {
    routes: combinedRoutes,
    unassigned: result.unassigned,
    cost: 0,
    costBreakdown: result.costBreakdown,
  };
  const combinedBreakdown = computeSolutionCost(
    combinedSolution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    config.weights ?? DEFAULT_WEIGHTS,
    (() => {
      const constraints = new Map<string, ALNSDriverConstraints>();
      for (const driverConstraint of config.driverConstraints ?? []) {
        constraints.set(driverConstraint.vehicleId, driverConstraint);
      }
      return constraints;
    })(),
    config.vehicleDistributionMode ?? "minimize",
  ).breakdown;

  return {
    routes: combinedRoutes,
    unassigned: result.unassigned,
    costBreakdown: combinedBreakdown,
    routeEvaluations: result.routeEvaluations,
    performance: result.performance,
  };
}
