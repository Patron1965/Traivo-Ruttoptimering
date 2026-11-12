import type { ALNSNode, ALNSRoute, ALNSVehicle, ALNSSolution, ALNSDriverConstraints, OptimizationWeights } from "../types";
import { evaluateRoute, computeSolutionCost, evaluateRouteCost } from "../cost";

function twoOptImprove(
  route: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  deadlineMs = Number.POSITIVE_INFINITY,
  constraints?: ALNSDriverConstraints,
): boolean {
  const deliveryIndices: number[] = [];
  for (let i = 0; i < route.nodes.length; i++) {
    if (!route.nodes[i].isChargingStation) deliveryIndices.push(i);
  }
  if (deliveryIndices.length < 3) return false;

  let improved = false;
  let bestCost = evaluateRouteCost(
    evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints),
    weights,
  );

  for (let i = 0; i < deliveryIndices.length - 1; i++) {
    if (Date.now() >= deadlineMs) break;
    for (let j = i + 1; j < deliveryIndices.length; j++) {
      if (Date.now() >= deadlineMs) break;
      const si = deliveryIndices[i];
      const sj = deliveryIndices[j];

      const newNodes = [...route.nodes];
      const segment = newNodes.slice(si, sj + 1).reverse();
      for (let k = 0; k < segment.length; k++) {
        newNodes[si + k] = segment[k];
      }

      const testRoute: ALNSRoute = { ...route, nodes: newNodes };
      const evalR = evaluateRoute(testRoute, vehicle, depotLat, depotLon, startTime, constraints);
      if (!evalR.feasible) continue;

      const newCost = evaluateRouteCost(evalR, weights);
      if (newCost < bestCost - 0.001) {
        route.nodes = newNodes;
        bestCost = newCost;
        improved = true;
      }
    }
  }

  return improved;
}

function orOptImprove(
  route: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  deadlineMs = Number.POSITIVE_INFINITY,
  constraints?: ALNSDriverConstraints,
): boolean {
  const deliveryIndices: number[] = [];
  for (let i = 0; i < route.nodes.length; i++) {
    if (!route.nodes[i].isChargingStation) deliveryIndices.push(i);
  }
  if (deliveryIndices.length < 3) return false;

  let improved = false;

  for (let segLen = 1; segLen <= 3; segLen++) {
    if (Date.now() >= deadlineMs) break;
    for (let i = 0; i <= deliveryIndices.length - segLen; i++) {
      if (Date.now() >= deadlineMs) break;
      const segStart = deliveryIndices[i];
      const segEnd = deliveryIndices[i + segLen - 1];

      const segment = route.nodes.slice(segStart, segEnd + 1);
      if (segment.some(n => n.isChargingStation)) continue;

      const remaining = [...route.nodes.slice(0, segStart), ...route.nodes.slice(segEnd + 1)];

      const baseCost = evaluateRouteCost(
        evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints),
        weights,
      );

      for (let j = 0; j <= remaining.length; j++) {
        if (Date.now() >= deadlineMs) break;
        if (j === segStart) continue;

        const candidate = [...remaining.slice(0, j), ...segment, ...remaining.slice(j)];
        const testRoute: ALNSRoute = { ...route, nodes: candidate };
        const evalR = evaluateRoute(testRoute, vehicle, depotLat, depotLon, startTime, constraints);
        if (!evalR.feasible) continue;

        const newCost = evaluateRouteCost(evalR, weights);
        if (newCost < baseCost - 0.001) {
          route.nodes = candidate;
          improved = true;
          break;
        }
      }

      if (improved) break;
    }
    if (improved) break;
  }

  return improved;
}

export function relocateImprove(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  timeBudgetMs = 2000
): boolean {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const lsStart = Date.now();
  let improved = false;

  for (let ri = 0; ri < solution.routes.length; ri++) {
    if (Date.now() - lsStart >= timeBudgetMs) break;
    const srcRoute = solution.routes[ri];
    const srcVehicle = vehicleMap.get(srcRoute.vehicleId);
    if (!srcVehicle) continue;

    for (let ni = srcRoute.nodes.length - 1; ni >= 0; ni--) {
      if (Date.now() - lsStart >= timeBudgetMs) break;
      const node = srcRoute.nodes[ni];
      if (node.isChargingStation) continue;

      const { cost: costBefore } = computeSolutionCost(
        solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap
      );

      let bestCost = costBefore;
      let bestTargetIdx = -1;
      let bestInsertPos = -1;

      for (let rj = 0; rj < solution.routes.length; rj++) {
        if (Date.now() - lsStart >= timeBudgetMs) break;
        if (rj === ri) continue;
        const dstRoute = solution.routes[rj];
        const dstVehicle = vehicleMap.get(dstRoute.vehicleId);
        if (!dstVehicle) continue;

        if (dstRoute.totalWeight + node.weightKg > dstVehicle.capacityKg) continue;
        if (dstRoute.totalVolume + node.volumeM3 > dstVehicle.capacityVolume) continue;

        for (let pos = 0; pos <= dstRoute.nodes.length; pos++) {
          if (Date.now() - lsStart >= timeBudgetMs) break;
          const testDstNodes = [...dstRoute.nodes.slice(0, pos), node, ...dstRoute.nodes.slice(pos)];
          const testDstRoute: ALNSRoute = {
            ...dstRoute,
            nodes: testDstNodes,
            totalWeight: dstRoute.totalWeight + node.weightKg,
            totalVolume: dstRoute.totalVolume + node.volumeM3,
          };

          const dstEval = evaluateRoute(testDstRoute, dstVehicle, depotLat, depotLon, startTime,
            driverConstraintsMap.get(dstRoute.vehicleId));
          if (!dstEval.feasible) continue;

          const savedSrcNodes = srcRoute.nodes;
          const savedDstNodes = dstRoute.nodes;
          const savedSrcW = srcRoute.totalWeight;
          const savedDstW = dstRoute.totalWeight;
          const savedSrcV = srcRoute.totalVolume;
          const savedDstV = dstRoute.totalVolume;

          srcRoute.nodes = [...savedSrcNodes.slice(0, ni), ...savedSrcNodes.slice(ni + 1)];
          srcRoute.totalWeight = savedSrcW - node.weightKg;
          srcRoute.totalVolume = savedSrcV - node.volumeM3;
          dstRoute.nodes = testDstNodes;
          dstRoute.totalWeight = testDstRoute.totalWeight;
          dstRoute.totalVolume = testDstRoute.totalVolume;

          const { cost: candidateCost } = computeSolutionCost(
            solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap
          );

          srcRoute.nodes = savedSrcNodes;
          srcRoute.totalWeight = savedSrcW;
          srcRoute.totalVolume = savedSrcV;
          dstRoute.nodes = savedDstNodes;
          dstRoute.totalWeight = savedDstW;
          dstRoute.totalVolume = savedDstV;

          if (candidateCost < bestCost - 0.01) {
            bestCost = candidateCost;
            bestTargetIdx = rj;
            bestInsertPos = pos;
          }
        }
      }

      if (bestTargetIdx >= 0 && bestInsertPos >= 0) {
        const dstRoute = solution.routes[bestTargetIdx];
        srcRoute.nodes.splice(ni, 1);
        srcRoute.totalWeight -= node.weightKg;
        srcRoute.totalVolume -= node.volumeM3;
        dstRoute.nodes.splice(bestInsertPos, 0, node);
        dstRoute.totalWeight += node.weightKg;
        dstRoute.totalVolume += node.volumeM3;
        improved = true;
      }
    }
  }

  return improved;
}

export function crossExchangeImprove(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  timeBudgetMs = 2000
): boolean {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const lsStart = Date.now();
  let improved = false;

  const { cost: baseCost } = computeSolutionCost(
    solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap
  );
  let currentBest = baseCost;

  for (let ri = 0; ri < solution.routes.length - 1; ri++) {
    if (Date.now() - lsStart >= timeBudgetMs) break;
    for (let rj = ri + 1; rj < solution.routes.length; rj++) {
      if (Date.now() - lsStart >= timeBudgetMs) break;

      const routeA = solution.routes[ri];
      const routeB = solution.routes[rj];
      const vehicleA = vehicleMap.get(routeA.vehicleId);
      const vehicleB = vehicleMap.get(routeB.vehicleId);
      if (!vehicleA || !vehicleB) continue;

      const deliveryA = routeA.nodes.filter(n => !n.isChargingStation);
      const deliveryB = routeB.nodes.filter(n => !n.isChargingStation);
      if (deliveryA.length < 1 || deliveryB.length < 1) continue;

      for (let segLenA = 1; segLenA <= Math.min(2, deliveryA.length); segLenA++) {
        if (Date.now() - lsStart >= timeBudgetMs) break;
        for (let segLenB = 1; segLenB <= Math.min(2, deliveryB.length); segLenB++) {
          if (Date.now() - lsStart >= timeBudgetMs) break;

          for (let sa = 0; sa <= deliveryA.length - segLenA; sa++) {
            if (Date.now() - lsStart >= timeBudgetMs) break;
            const segA = deliveryA.slice(sa, sa + segLenA);
            const segAWeight = segA.reduce((s, n) => s + n.weightKg, 0);
            const segAVol = segA.reduce((s, n) => s + n.volumeM3, 0);
            const segAIds = new Set(segA.map(n => n.id));

            for (let sb = 0; sb <= deliveryB.length - segLenB; sb++) {
              if (Date.now() - lsStart >= timeBudgetMs) break;
              const segB = deliveryB.slice(sb, sb + segLenB);
              const segBWeight = segB.reduce((s, n) => s + n.weightKg, 0);
              const segBVol = segB.reduce((s, n) => s + n.volumeM3, 0);
              const segBIds = new Set(segB.map(n => n.id));

              const newWeightA = routeA.totalWeight - segAWeight + segBWeight;
              const newWeightB = routeB.totalWeight - segBWeight + segAWeight;
              const newVolA = routeA.totalVolume - segAVol + segBVol;
              const newVolB = routeB.totalVolume - segBVol + segAVol;

              if (newWeightA > vehicleA.capacityKg || newWeightB > vehicleB.capacityKg) continue;
              if (newVolA > vehicleA.capacityVolume || newVolB > vehicleB.capacityVolume) continue;

              const newNodesA = routeA.nodes.filter(n => !segAIds.has(n.id));
              const insertPosA = Math.min(sa, newNodesA.length);
              newNodesA.splice(insertPosA, 0, ...segB);

              const newNodesB = routeB.nodes.filter(n => !segBIds.has(n.id));
              const insertPosB = Math.min(sb, newNodesB.length);
              newNodesB.splice(insertPosB, 0, ...segA);

              const testA: ALNSRoute = { ...routeA, nodes: newNodesA, totalWeight: newWeightA, totalVolume: newVolA };
              const testB: ALNSRoute = { ...routeB, nodes: newNodesB, totalWeight: newWeightB, totalVolume: newVolB };

              const evalA = evaluateRoute(testA, vehicleA, depotLat, depotLon, startTime,
                driverConstraintsMap.get(routeA.vehicleId));
              const evalB = evaluateRoute(testB, vehicleB, depotLat, depotLon, startTime,
                driverConstraintsMap.get(routeB.vehicleId));

              if (!evalA.feasible || !evalB.feasible) continue;

              const savedA = routeA.nodes;
              const savedB = routeB.nodes;
              const savedWA = routeA.totalWeight;
              const savedWB = routeB.totalWeight;
              const savedVA = routeA.totalVolume;
              const savedVB = routeB.totalVolume;

              routeA.nodes = newNodesA;
              routeA.totalWeight = newWeightA;
              routeA.totalVolume = newVolA;
              routeB.nodes = newNodesB;
              routeB.totalWeight = newWeightB;
              routeB.totalVolume = newVolB;

              const { cost: candidateCost } = computeSolutionCost(
                solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap
              );

              if (candidateCost < currentBest - 0.01) {
                currentBest = candidateCost;
                improved = true;
                break;
              } else {
                routeA.nodes = savedA;
                routeA.totalWeight = savedWA;
                routeA.totalVolume = savedVA;
                routeB.nodes = savedB;
                routeB.totalWeight = savedWB;
                routeB.totalVolume = savedVB;
              }
            }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (improved) break;
  }

  return improved;
}

export function localSearchPostProcess(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  timeBudgetMs = 5000,
  maxPasses = 3
): void {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const lsStart = Date.now();
  const deadlineMs = lsStart + timeBudgetMs;

  relocateImprove(solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
    Math.max(0, Math.min(2000, timeBudgetMs / 3, deadlineMs - Date.now())));

  crossExchangeImprove(solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
    Math.max(0, Math.min(2000, timeBudgetMs / 3, deadlineMs - Date.now())));

  for (let pass = 0; pass < maxPasses; pass++) {
    if (Date.now() - lsStart >= timeBudgetMs) break;
    let anyImproved = false;

    for (const route of solution.routes) {
      if (Date.now() - lsStart >= timeBudgetMs) break;
      if (route.nodes.filter(n => !n.isChargingStation).length < 3) continue;
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle) continue;

      const constraints = driverConstraintsMap?.get(route.vehicleId);
      const evalBefore = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
      const costBefore = evaluateRouteCost(evalBefore, weights);
      const savedNodes = [...route.nodes.map(n => ({ ...n }))];

       if (twoOptImprove(route, vehicle, depotLat, depotLon, startTime, weights, deadlineMs, constraints)) {
        const evalAfter = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
        const costAfter = evaluateRouteCost(evalAfter, weights);
        if (costAfter < costBefore - 0.001) {
          anyImproved = true;
        } else {
          route.nodes = savedNodes;
        }
      }

      const savedNodes2 = [...route.nodes.map(n => ({ ...n }))];
      const evalBefore2 = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
      const costBefore2 = evaluateRouteCost(evalBefore2, weights);

       if (orOptImprove(route, vehicle, depotLat, depotLon, startTime, weights, deadlineMs, constraints)) {
        const evalAfter2 = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
        const costAfter2 = evaluateRouteCost(evalAfter2, weights);
        if (costAfter2 < costBefore2 - 0.001) {
          anyImproved = true;
        } else {
          route.nodes = savedNodes2;
        }
      }
    }

    if (!anyImproved) break;
  }
}

type CooperativeSearchContext = {
  deadlineMs: number;
  shouldCancel: () => boolean;
  work: number;
};

async function cooperativeCheckpoint(context: CooperativeSearchContext): Promise<boolean> {
  if (Date.now() >= context.deadlineMs || context.shouldCancel()) return false;
  context.work++;
  if (context.work % 8 === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (context.shouldCancel()) return false;
  }
  return Date.now() < context.deadlineMs;
}

async function relocateImproveCooperative(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  context: CooperativeSearchContext,
): Promise<boolean> {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  let improved = false;
  for (let ri = 0; ri < solution.routes.length; ri++) {
    const srcRoute = solution.routes[ri];
    const srcVehicle = vehicleMap.get(srcRoute.vehicleId);
    if (!srcVehicle) continue;
    for (let ni = srcRoute.nodes.length - 1; ni >= 0; ni--) {
      if (!(await cooperativeCheckpoint(context))) return improved;
      const node = srcRoute.nodes[ni];
      if (node.isChargingStation) continue;
      const { cost: costBefore } = computeSolutionCost(
        solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
      );
      let bestCost = costBefore;
      let bestTargetIdx = -1;
      let bestInsertPos = -1;
      for (let rj = 0; rj < solution.routes.length; rj++) {
        if (!(await cooperativeCheckpoint(context))) return improved;
        if (rj === ri) continue;
        const dstRoute = solution.routes[rj];
        const dstVehicle = vehicleMap.get(dstRoute.vehicleId);
        if (!dstVehicle) continue;
        if (dstRoute.totalWeight + node.weightKg > dstVehicle.capacityKg) continue;
        if (dstRoute.totalVolume + node.volumeM3 > dstVehicle.capacityVolume) continue;
        for (let pos = 0; pos <= dstRoute.nodes.length; pos++) {
          if (!(await cooperativeCheckpoint(context))) return improved;
          const testDstNodes = [...dstRoute.nodes.slice(0, pos), node, ...dstRoute.nodes.slice(pos)];
          const testDstRoute: ALNSRoute = {
            ...dstRoute,
            nodes: testDstNodes,
            totalWeight: dstRoute.totalWeight + node.weightKg,
            totalVolume: dstRoute.totalVolume + node.volumeM3,
          };
          const dstEval = evaluateRoute(
            testDstRoute, dstVehicle, depotLat, depotLon, startTime,
            driverConstraintsMap.get(dstRoute.vehicleId),
          );
          if (!dstEval.feasible) continue;
          const savedSrcNodes = srcRoute.nodes;
          const savedDstNodes = dstRoute.nodes;
          const savedSrcW = srcRoute.totalWeight;
          const savedDstW = dstRoute.totalWeight;
          const savedSrcV = srcRoute.totalVolume;
          const savedDstV = dstRoute.totalVolume;
          srcRoute.nodes = [...savedSrcNodes.slice(0, ni), ...savedSrcNodes.slice(ni + 1)];
          srcRoute.totalWeight = savedSrcW - node.weightKg;
          srcRoute.totalVolume = savedSrcV - node.volumeM3;
          dstRoute.nodes = testDstNodes;
          dstRoute.totalWeight = testDstRoute.totalWeight;
          dstRoute.totalVolume = testDstRoute.totalVolume;
          const { cost: candidateCost } = computeSolutionCost(
            solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
          );
          srcRoute.nodes = savedSrcNodes;
          srcRoute.totalWeight = savedSrcW;
          srcRoute.totalVolume = savedSrcV;
          dstRoute.nodes = savedDstNodes;
          dstRoute.totalWeight = savedDstW;
          dstRoute.totalVolume = savedDstV;
          if (candidateCost < bestCost - 0.01) {
            bestCost = candidateCost;
            bestTargetIdx = rj;
            bestInsertPos = pos;
          }
        }
      }
      if (bestTargetIdx >= 0 && bestInsertPos >= 0) {
        const dstRoute = solution.routes[bestTargetIdx];
        srcRoute.nodes.splice(ni, 1);
        srcRoute.totalWeight -= node.weightKg;
        srcRoute.totalVolume -= node.volumeM3;
        dstRoute.nodes.splice(bestInsertPos, 0, node);
        dstRoute.totalWeight += node.weightKg;
        dstRoute.totalVolume += node.volumeM3;
        improved = true;
      }
    }
  }
  return improved;
}

async function crossExchangeImproveCooperative(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  context: CooperativeSearchContext,
): Promise<boolean> {
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const { cost: baseCost } = computeSolutionCost(
    solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
  );
  let currentBest = baseCost;
  let improved = false;
  for (let ri = 0; ri < solution.routes.length - 1; ri++) {
    for (let rj = ri + 1; rj < solution.routes.length; rj++) {
      if (!(await cooperativeCheckpoint(context))) return improved;
      const routeA = solution.routes[ri];
      const routeB = solution.routes[rj];
      const vehicleA = vehicleMap.get(routeA.vehicleId);
      const vehicleB = vehicleMap.get(routeB.vehicleId);
      if (!vehicleA || !vehicleB) continue;
      const deliveryA = routeA.nodes.filter(n => !n.isChargingStation);
      const deliveryB = routeB.nodes.filter(n => !n.isChargingStation);
      if (deliveryA.length < 1 || deliveryB.length < 1) continue;
      for (let segLenA = 1; segLenA <= Math.min(2, deliveryA.length); segLenA++) {
        for (let segLenB = 1; segLenB <= Math.min(2, deliveryB.length); segLenB++) {
          for (let sa = 0; sa <= deliveryA.length - segLenA; sa++) {
            for (let sb = 0; sb <= deliveryB.length - segLenB; sb++) {
              if (!(await cooperativeCheckpoint(context))) return improved;
              const segA = deliveryA.slice(sa, sa + segLenA);
              const segB = deliveryB.slice(sb, sb + segLenB);
              const segAWeight = segA.reduce((s, n) => s + n.weightKg, 0);
              const segAVol = segA.reduce((s, n) => s + n.volumeM3, 0);
              const segBWeight = segB.reduce((s, n) => s + n.weightKg, 0);
              const segBVol = segB.reduce((s, n) => s + n.volumeM3, 0);
              const newWeightA = routeA.totalWeight - segAWeight + segBWeight;
              const newWeightB = routeB.totalWeight - segBWeight + segAWeight;
              const newVolA = routeA.totalVolume - segAVol + segBVol;
              const newVolB = routeB.totalVolume - segBVol + segAVol;
              if (newWeightA > vehicleA.capacityKg || newWeightB > vehicleB.capacityKg) continue;
              if (newVolA > vehicleA.capacityVolume || newVolB > vehicleB.capacityVolume) continue;
              const segAIds = new Set(segA.map(n => n.id));
              const segBIds = new Set(segB.map(n => n.id));
              const newNodesA = routeA.nodes.filter(n => !segAIds.has(n.id));
              newNodesA.splice(Math.min(sa, newNodesA.length), 0, ...segB);
              const newNodesB = routeB.nodes.filter(n => !segBIds.has(n.id));
              newNodesB.splice(Math.min(sb, newNodesB.length), 0, ...segA);
              const testA: ALNSRoute = { ...routeA, nodes: newNodesA, totalWeight: newWeightA, totalVolume: newVolA };
              const testB: ALNSRoute = { ...routeB, nodes: newNodesB, totalWeight: newWeightB, totalVolume: newVolB };
              const evalA = evaluateRoute(testA, vehicleA, depotLat, depotLon, startTime, driverConstraintsMap.get(routeA.vehicleId));
              const evalB = evaluateRoute(testB, vehicleB, depotLat, depotLon, startTime, driverConstraintsMap.get(routeB.vehicleId));
              if (!evalA.feasible || !evalB.feasible) continue;
              const savedA = routeA.nodes;
              const savedB = routeB.nodes;
              const savedWA = routeA.totalWeight;
              const savedWB = routeB.totalWeight;
              const savedVA = routeA.totalVolume;
              const savedVB = routeB.totalVolume;
              routeA.nodes = newNodesA;
              routeA.totalWeight = newWeightA;
              routeA.totalVolume = newVolA;
              routeB.nodes = newNodesB;
              routeB.totalWeight = newWeightB;
              routeB.totalVolume = newVolB;
              const { cost: candidateCost } = computeSolutionCost(
                solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap,
              );
              if (candidateCost < currentBest - 0.01) {
                currentBest = candidateCost;
                improved = true;
                break;
              }
              routeA.nodes = savedA;
              routeA.totalWeight = savedWA;
              routeA.totalVolume = savedVA;
              routeB.nodes = savedB;
              routeB.totalWeight = savedWB;
              routeB.totalVolume = savedVB;
            }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (improved) break;
  }
  return improved;
}

async function twoOptImproveCooperative(
  route: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  constraints: ALNSDriverConstraints | undefined,
  context: CooperativeSearchContext,
): Promise<boolean> {
  const deliveryIndices = route.nodes.flatMap((node, index) => node.isChargingStation ? [] : [index]);
  if (deliveryIndices.length < 3) return false;
  let improved = false;
  let bestCost = evaluateRouteCost(evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints), weights);
  for (let i = 0; i < deliveryIndices.length - 1; i++) {
    for (let j = i + 1; j < deliveryIndices.length; j++) {
      if (!(await cooperativeCheckpoint(context))) return improved;
      const si = deliveryIndices[i];
      const sj = deliveryIndices[j];
      const newNodes = [...route.nodes];
      newNodes.splice(si, sj - si + 1, ...newNodes.slice(si, sj + 1).reverse());
      const evalR = evaluateRoute({ ...route, nodes: newNodes }, vehicle, depotLat, depotLon, startTime, constraints);
      if (!evalR.feasible) continue;
      const newCost = evaluateRouteCost(evalR, weights);
      if (newCost < bestCost - 0.001) {
        route.nodes = newNodes;
        bestCost = newCost;
        improved = true;
      }
    }
  }
  return improved;
}

async function orOptImproveCooperative(
  route: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  constraints: ALNSDriverConstraints | undefined,
  context: CooperativeSearchContext,
): Promise<boolean> {
  const deliveryIndices = route.nodes.flatMap((node, index) => node.isChargingStation ? [] : [index]);
  if (deliveryIndices.length < 3) return false;
  let improved = false;
  for (let segLen = 1; segLen <= 3; segLen++) {
    for (let i = 0; i <= deliveryIndices.length - segLen; i++) {
      if (!(await cooperativeCheckpoint(context))) return improved;
      const segStart = deliveryIndices[i];
      const segEnd = deliveryIndices[i + segLen - 1];
      const segment = route.nodes.slice(segStart, segEnd + 1);
      if (segment.some(n => n.isChargingStation)) continue;
      const remaining = [...route.nodes.slice(0, segStart), ...route.nodes.slice(segEnd + 1)];
      const baseCost = evaluateRouteCost(evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints), weights);
      for (let j = 0; j <= remaining.length; j++) {
        if (!(await cooperativeCheckpoint(context))) return improved;
        if (j === segStart) continue;
        const candidate = [...remaining.slice(0, j), ...segment, ...remaining.slice(j)];
        const evalR = evaluateRoute({ ...route, nodes: candidate }, vehicle, depotLat, depotLon, startTime, constraints);
        if (!evalR.feasible) continue;
        if (evaluateRouteCost(evalR, weights) < baseCost - 0.001) {
          route.nodes = candidate;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (improved) break;
  }
  return improved;
}

async function localSearchPostProcessCooperative(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  timeBudgetMs: number,
  shouldCancel: () => boolean,
): Promise<boolean> {
  const startedAt = Date.now();
  const context: CooperativeSearchContext = {
    deadlineMs: startedAt + timeBudgetMs,
    shouldCancel,
    work: 0,
  };
  const phaseBudget = Math.max(0, Math.min(2000, timeBudgetMs / 3));
  await relocateImproveCooperative(solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap, {
    ...context,
    deadlineMs: Math.min(context.deadlineMs, startedAt + phaseBudget),
  });
  if (shouldCancel()) return false;
  await crossExchangeImproveCooperative(solution, vehicles, depotLat, depotLon, startTime, weights, driverConstraintsMap, {
    ...context,
    deadlineMs: Math.min(context.deadlineMs, startedAt + phaseBudget * 2),
  });
  if (shouldCancel()) return false;
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  for (let pass = 0; pass < 3; pass++) {
    if (Date.now() >= context.deadlineMs || shouldCancel()) break;
    let anyImproved = false;
    for (const route of solution.routes) {
      if (!(await cooperativeCheckpoint(context))) break;
      if (route.nodes.filter(n => !n.isChargingStation).length < 3) continue;
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle) continue;
      const constraints = driverConstraintsMap.get(route.vehicleId);
      const evalBefore = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints);
      const costBefore = evaluateRouteCost(evalBefore, weights);
      const savedNodes = [...route.nodes.map(n => ({ ...n }))];
      if (await twoOptImproveCooperative(route, vehicle, depotLat, depotLon, startTime, weights, constraints, context)) {
        const costAfter = evaluateRouteCost(evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints), weights);
        if (costAfter < costBefore - 0.001) anyImproved = true;
        else route.nodes = savedNodes;
      }
      const savedNodes2 = [...route.nodes.map(n => ({ ...n }))];
      const costBefore2 = evaluateRouteCost(evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints), weights);
      if (await orOptImproveCooperative(route, vehicle, depotLat, depotLon, startTime, weights, constraints, context)) {
        const costAfter2 = evaluateRouteCost(evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints), weights);
        if (costAfter2 < costBefore2 - 0.001) anyImproved = true;
        else route.nodes = savedNodes2;
      }
    }
    if (!anyImproved) break;
  }
  return !shouldCancel();
}

/**
 * Continuous optimization needs the post-process phase to remain
 * interruptible as well as the ALNS search. Run the existing scoring logic in
 * short slices and yield between them; the normal batch path keeps using the
 * synchronous implementation above.
 */
export async function localSearchPostProcessCancellable(
  solution: ALNSSolution,
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  weights: OptimizationWeights,
  driverConstraintsMap: Map<string, ALNSDriverConstraints>,
  timeBudgetMs = 5000,
  shouldCancel: () => boolean,
): Promise<boolean> {
  return localSearchPostProcessCooperative(
    solution,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    weights,
    driverConstraintsMap,
    timeBudgetMs,
    shouldCancel,
  );
}
