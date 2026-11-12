import type { ALNSDriverConstraints, ALNSNode, ALNSRoute, ALNSSolution, ALNSVehicle, OptimizationWeights } from "../types";
import { buildNeighborhood, localAssignmentCost } from "../geographic-neighborhood";
import { computeSolutionCost, evaluateRoute, compareSolutionScores } from "../cost";
import { hasPlanningLock } from "../planning-locks";
import { chargingStationInsertion } from "./repair";

/** A bounded neighborhood operator, not another reseeding/postprocessing pass.
 * Proposes coherent same-owner groups around split edges; swaps can escape the
 * workload barrier that makes either single relocation unattractive.
 */
export async function geographicGroupSearch(
  solution: ALNSSolution, vehicles: ALNSVehicle[], depotLat: number, depotLon: number,
  startTime: Date, weights: OptimizationWeights, constraints: Map<string, ALNSDriverConstraints>,
  mode: "balance" | "minimize", offset = 0, shouldStop: () => boolean = () => false,
): Promise<boolean> {
  if (weights.geographicCohesionWeight <= 0 || shouldStop()) return false;
  const graph = buildNeighborhood(solution.routes.flatMap(r => r.nodes));
  const vehicleMap = new Map(vehicles.map(v => [v.id, v]));
  const owners = new Map(solution.routes.flatMap((r, i) => r.nodes.map(n => [n.id, i] as const)));
  const seeds = [...graph.keys()].sort();
  const baseline = computeSolutionCost(solution, vehicles, depotLat, depotLon, startTime, weights, constraints, mode);
  let bestScore = baseline;
  let bestCohesion = localAssignmentCost(solution.routes);
  let best: ALNSSolution | undefined;
  let proposals = 0;
  const group = (seed: string, owner: number): ALNSNode[] => {
    const ids = new Set([seed, ...(graph.get(seed) ?? []).map(item => item.node.id)]);
    return solution.routes[owner].nodes.filter(n => ids.has(n.id) && !n.isChargingStation && !hasPlanningLock(n)
      && n.id !== solution.routes[owner].lockedFirstStopId);
  };
  const build = (original: ALNSRoute, removed: ALNSNode[], added: ALNSNode[]): ALNSRoute => {
    const ids = new Set(removed.map(n => n.id));
    const nodes = original.nodes.filter(n => !ids.has(n.id) && !n.isChargingStation);
    // Cheapest-position ordering is only a proposal. Final acceptance below
    // uses the entire repaired plan and canonical full-workday feasibility.
    for (const node of added) {
      let position = nodes.length;
      let score = Infinity;
      for (let i = 0; i <= nodes.length; i++) {
        if (shouldStop()) break;
        const trial = [...nodes.slice(0, i), node, ...nodes.slice(i)];
        const route = { ...original, nodes: trial, totalWeight: trial.reduce((s, n) => s + n.weightKg, 0), totalVolume: trial.reduce((s, n) => s + n.volumeM3, 0) };
        const vehicle = vehicleMap.get(original.vehicleId);
        if (!vehicle) continue;
        const evaluation = evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints.get(vehicle.id));
        if (evaluation.feasible && evaluation.totalDistanceKm < score) {
          score = evaluation.totalDistanceKm;
          position = i;
        }
      }
      nodes.splice(position, 0, node);
    }
    return { ...original, nodes, totalWeight: nodes.reduce((s, n) => s + n.weightKg, 0), totalVolume: nodes.reduce((s, n) => s + n.volumeM3, 0) };
  };
  for (let s = 0; s < seeds.length && proposals < 24; s++) {
    const seed = seeds[(s + offset) % seeds.length];
    const source = owners.get(seed)!;
    if (solution.routes[source].optimizationFrozen) continue;
    for (const neighbor of graph.get(seed) ?? []) {
      const target = owners.get(neighbor.node.id)!;
      if (source === target || solution.routes[target].optimizationFrozen) continue;
      const outgoing = group(seed, source);
      if (!outgoing.length) continue;
      // Swap with a different neighborhood on the target, not the very
      // neighborhood being consolidated. Include relocation as first option.
      const returnSeeds = solution.routes[target].nodes.filter(n => !n.isChargingStation && !hasPlanningLock(n));
      const returns = [[], ...returnSeeds.slice(0, 6).map(n => group(n.id, target))];
      for (const incoming of returns) {
        if (proposals++ >= 24 || shouldStop()) break;
        const left = build(solution.routes[source], outgoing, incoming);
        const right = build(solution.routes[target], incoming, outgoing);
        if (shouldStop()) break;
        // Preserve each currently active selected resource, even in minimize
        // mode: this operator improves area ownership, not fleet size.
        if (!left.nodes.length || !right.nodes.length) continue;
        const candidate = { ...solution, routes: solution.routes.map((r, i) => i === source ? left : i === target ? right : r), unassigned: [...solution.unassigned] };
        chargingStationInsertion({ ...candidate, routes: [left, right] }, vehicles, depotLat, depotLon, startTime, constraints);
        const valid = candidate.routes.every(route => {
          if (!route.nodes.length) return true;
          if (route.lockedFirstStopId && route.nodes.find(n => !n.isChargingStation)?.id !== route.lockedFirstStopId) return false;
          const vehicle = vehicleMap.get(route.vehicleId);
          return vehicle && evaluateRoute(route, vehicle, depotLat, depotLon, startTime, constraints.get(vehicle.id)).feasible;
        });
        if (valid) {
          const cohesion = localAssignmentCost(candidate.routes);
          if (cohesion > bestCohesion + 1e-12) continue;
          const scored = computeSolutionCost(candidate, vehicles, depotLat, depotLon, startTime, weights, constraints, mode);
          if (Number.isFinite(scored.cost) && compareSolutionScores(scored, bestScore) < -1e-9) {
            best = { ...candidate, cost: scored.cost, costBreakdown: scored.breakdown };
            bestScore = scored;
            bestCohesion = cohesion;
          }
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  }
  if (!best || shouldStop()) return false;
  solution.routes = best.routes;
  solution.cost = best.cost;
  solution.costBreakdown = best.costBreakdown;
  return true;
}
