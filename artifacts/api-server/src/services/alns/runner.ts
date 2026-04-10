import { precomputeDistanceMatrix } from "../osrm";
import type {
  ALNSNode, ALNSVehicle, ALNSRoute, ALNSSolution, ALNSDriverConstraints,
  ALNSConfig, ALNSResult, OptimizationWeights, OperatorStats,
  CostBreakdown, RouteEvaluation, ClusteredOptimizationProgress,
} from "./types";
import {
  CHARGING_STATIONS, DEFAULT_CONFIG, DEFAULT_WEIGHTS, DEFAULT_ENV_CTX,
  deepCloneSolution, setEnvCtx,
} from "./types";
import { globalDistanceCache, cachedDistance } from "./distance-cache";
import { evaluateRoute, computeSolutionCost } from "./cost";
import {
  randomRemoval, worstRemoval, shawRemoval, relatednessRemoval,
  routeRemoval, timeWindowRemoval, chargingStationRemoval,
} from "./operators/destroy";
import {
  greedyInsertion, regretKInsertion, chargingStationInsertion, removeUnusedChargingStations,
} from "./operators/repair";
import { localSearchPostProcess } from "./operators/local-search";
import { consensusClustering, crossClusterImprove } from "./clustering";

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
      costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
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
    costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
  };

  chargingStationInsertion(initialSolution, vehicles, depotLat, depotLon, startTime);

  return initialSolution;
}

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
      case "relatedness":
        removedNodes = relatednessRemoval(candidate, removalCount);
        break;
      case "route_remove":
        removedNodes = routeRemoval(candidate, vehicles, depotLat, depotLon, startTime, weights);
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

    switch (repairOp) {
      case "greedy":
        greedyInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime);
        break;
      case "regret3":
        regretKInsertion(candidate, allToInsert, vehicles, depotLat, depotLon, startTime, 3);
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

  localSearchPostProcess(bestSolution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap);

  const { cost: finalCost, breakdown: finalBreakdown } = computeSolutionCost(
    bestSolution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap
  );
  bestSolution.cost = finalCost;
  bestSolution.costBreakdown = finalBreakdown;

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
  const CLUSTER_THRESHOLD = 100;
  const startMs = Date.now();

  globalDistanceCache.clear();

  const allCoords = [
    { lat: depotLat, lon: depotLon },
    ...stops.map(s => ({ lat: s.latitude, lon: s.longitude })),
    ...CHARGING_STATIONS.map(s => ({ lat: s.latitude, lon: s.longitude })),
  ];
  const osrmOk = await precomputeDistanceMatrix(allCoords);
  if (osrmOk) {
    console.log(`OSRM: Using real road distances for ${stops.length} stops + ${CHARGING_STATIONS.length} charging stations`);
  } else {
    console.log(`OSRM: Falling back to Haversine distances for ${stops.length} stops`);
  }

  if (stops.length > CLUSTER_THRESHOLD && vehicles.length >= 2) {
    onProgress?.({ totalClusters: 0, completedClusters: 0, phase: "clustering", elapsedMs: 0 });

    const targetClusterSize = 60;
    const { clusters, borderStopIds } = consensusClustering(stops, targetClusterSize);
    console.log(`Clustering: ${clusters.length} clusters from ${stops.length} stops (DBSCAN consensus, ${borderStopIds.size} border stops)`);

    const vehiclesPerCluster: ALNSVehicle[][] = Array.from({ length: clusters.length }, () => []);
    const sortedVehicles = [...vehicles].sort((a, b) => b.capacityKg - a.capacityKg);
    const clusterWeights = clusters.map(c => c.reduce((s, n) => s + n.weightKg, 0));

    const vehicleAssigned = new Set<string>();
    const clusterOrder = clusterWeights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);

    for (const { i: ci } of clusterOrder) {
      for (const v of sortedVehicles) {
        if (vehicleAssigned.has(v.id)) continue;
        vehicleAssigned.add(v.id);
        vehiclesPerCluster[ci].push(v);
        break;
      }
    }

    let extraIdx = 0;
    for (const v of sortedVehicles) {
      if (vehicleAssigned.has(v.id)) continue;
      vehiclesPerCluster[extraIdx % clusters.length].push(v);
      vehicleAssigned.add(v.id);
      extraIdx++;
    }

    const timeBudget = config.timeLimitMs ?? 30000;
    const perClusterTime = Math.max(5000, Math.floor(timeBudget / clusters.length));

    const allRoutes: ALNSRoute[] = [];
    const allUnassigned: ALNSNode[] = [];
    let mergedBreakdown: CostBreakdown = {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    };

    for (let ci = 0; ci < clusters.length; ci++) {
      const clusterVehicles = vehiclesPerCluster[ci];
      if (clusterVehicles.length === 0) {
        allUnassigned.push(...clusters[ci]);
        continue;
      }

      onProgress?.({
        totalClusters: clusters.length,
        completedClusters: ci,
        phase: "optimizing",
        elapsedMs: Date.now() - startMs,
      });

      const clusterConfig = { ...config, timeLimitMs: perClusterTime };
      const initial = buildInitialSolutionFromCW(clusters[ci], clusterVehicles, depotLat, depotLon, startTime);
      const best = runALNS(initial, clusterVehicles, depotLat, depotLon, startTime, clusterConfig);

      allRoutes.push(...best.routes.filter(r => r.nodes.length > 0));
      allUnassigned.push(...best.unassigned);

      const bd = best.costBreakdown;
      mergedBreakdown.distanceCost += bd.distanceCost;
      mergedBreakdown.co2Cost += bd.co2Cost;
      mergedBreakdown.etaPrecisionCost += bd.etaPrecisionCost;
      mergedBreakdown.driverPenaltyCost += bd.driverPenaltyCost ?? 0;
      mergedBreakdown.totalDistanceKm += bd.totalDistanceKm;
      mergedBreakdown.totalCo2Kg += bd.totalCo2Kg;
      mergedBreakdown.totalTimeWindowSlackMin += bd.totalTimeWindowSlackMin;
      mergedBreakdown.totalDriverPenalty += bd.totalDriverPenalty ?? 0;
    }

    onProgress?.({ totalClusters: clusters.length, completedClusters: clusters.length, phase: "merging", elapsedMs: Date.now() - startMs });

    const weights = config.weights ?? DEFAULT_WEIGHTS;
    const driverConstraintsMap = new Map<string, ALNSDriverConstraints>();
    if (config.driverConstraints) {
      for (const dc of config.driverConstraints) driverConstraintsMap.set(dc.vehicleId, dc);
    }

    if (borderStopIds.size > 0) {
      crossClusterImprove(allRoutes, borderStopIds, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap);
    }

    for (const v of vehicles) {
      if (!allRoutes.some(r => r.vehicleId === v.id)) {
        allRoutes.push({ vehicleId: v.id, nodes: [], totalWeight: 0, totalVolume: 0 });
      }
    }

    const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
    const routeEvaluations = new Map<string, RouteEvaluation>();

    let finalBreakdown: CostBreakdown = {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    };

    for (const route of allRoutes) {
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle || route.nodes.length === 0) continue;
      const constraints = driverConstraintsMap.get(route.vehicleId);
      const evalResult = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
      routeEvaluations.set(route.vehicleId, evalResult);

      finalBreakdown.totalDistanceKm += evalResult.totalDistanceKm;
      finalBreakdown.totalCo2Kg += evalResult.totalCo2Kg;
      finalBreakdown.totalTimeWindowSlackMin += evalResult.totalTimeWindowSlackMin;
      finalBreakdown.totalDriverPenalty += evalResult.driverPenalty;
      finalBreakdown.distanceCost += evalResult.totalDistanceKm * weights.distanceWeight;
      finalBreakdown.co2Cost += evalResult.totalCo2Kg * weights.co2Weight * 100;
      finalBreakdown.etaPrecisionCost += (evalResult.totalTimeWindowSlackMin / 60) * weights.etaPrecisionWeight * 10;
      finalBreakdown.driverPenaltyCost += evalResult.driverPenalty * weights.driverHappinessWeight;
    }

    onProgress?.({ totalClusters: clusters.length, completedClusters: clusters.length, phase: "complete", elapsedMs: Date.now() - startMs });

    return { routes: allRoutes, unassigned: allUnassigned, costBreakdown: finalBreakdown, routeEvaluations };
  }

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

export async function reoptimizeAffectedRoutes(
  currentRoutes: ALNSRoute[],
  affectedVehicleIds: string[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  config: Partial<ALNSConfig> = {}
): Promise<ALNSResult> {
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

  const result = await optimizeWithALNS(allNodes, affectedVehicles, depotLat, depotLon, startTime, reoptConfig);

  return {
    routes: [...stableRoutes, ...result.routes],
    unassigned: result.unassigned,
    costBreakdown: result.costBreakdown,
    routeEvaluations: result.routeEvaluations,
  };
}
