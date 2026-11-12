import type { ALNSRoute, RouteEvaluation, ALNSSolution, ALNSNode, ALNSVehicle, ALNSDriverConstraints, OptimizationWeights } from "../types";
import { computeSolutionCost, compareSolutionScores, evaluateRoute } from "../cost";
import { chargingStationInsertion } from "./repair";
import { cachedDistance } from "../distance-cache";

/** Bounded road-insertion proposals; final ranking still uses the hierarchy.
 * Small routes and exact/time-window obligations keep exhaustive positions.
 */
export function areasInsertionPositions(route: ALNSRoute, node: ALNSNode, vehicle: ALNSVehicle, lat: number, lon: number): number[] {
  const positions = Array.from({ length: route.nodes.length + 1 }, (_, i) => i);
  if (positions.length <= 10 || node.timeWindowStart || node.timeWindowEnd || node.lockedServiceStartAt
    || route.nodes.some(n => n.lockedServiceStartAt || n.timeWindowStart || n.timeWindowEnd)) return positions;
  const costs = positions.map(position => {
    const previous = route.nodes[position - 1], next = route.nodes[position];
    const fromLat = previous?.latitude ?? vehicle.startLatitude ?? lat;
    const fromLon = previous?.longitude ?? vehicle.startLongitude ?? lon;
    const toLat = next?.pickupLat ?? next?.latitude ?? vehicle.endLatitude ?? vehicle.startLatitude ?? lat;
    const toLon = next?.pickupLon ?? next?.longitude ?? vehicle.endLongitude ?? vehicle.startLongitude ?? lon;
    return { position, distance: cachedDistance(fromLat, fromLon, node.pickupLat ?? node.latitude, node.pickupLon ?? node.longitude)
      + cachedDistance(node.latitude, node.longitude, toLat, toLon) - cachedDistance(fromLat, fromLon, toLat, toLon) };
  }).sort((a, b) => a.distance - b.distance || a.position - b.position);
  return [...new Set([0, route.nodes.length, ...costs.slice(0, 4).map(item => item.position)])].sort((a, b) => a - b);
}

/** All insertion positions use the same full-plan hierarchy as acceptance. */
export async function areasInsertion(
  solution: ALNSSolution, nodes: ALNSNode[], vehicles: ALNSVehicle[],
  lat: number, lon: number, start: Date, weights: OptimizationWeights,
  constraints: Map<string, ALNSDriverConstraints>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const pending = [...nodes].sort((a, b) => (b.planningPriority ?? 0) - (a.planningPriority ?? 0));
  solution.unassigned.push(...pending);
  let proposals = 0;
  for (const node of pending) {
    if (shouldStop()) return;
    const evaluations = new WeakMap<ALNSRoute, RouteEvaluation>();
    let best: ALNSSolution | undefined;
    let bestScore: ReturnType<typeof computeSolutionCost> | undefined;
    for (let r = 0; r < solution.routes.length; r++) {
      let geographicCohesionCost: number | undefined;
      const route = solution.routes[r];
      const vehicle = vehicles.find(v => v.id === route.vehicleId);
      if (!vehicle || route.optimizationFrozen) continue;
      for (const position of areasInsertionPositions(route, node, vehicle, lat, lon)) {
        if (++proposals % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        if (shouldStop()) return;
        const candidate = { ...solution, routes: solution.routes.map((route, index) =>
          index === r ? { ...route, nodes: [...route.nodes] } : route), unassigned: [...solution.unassigned] };
        const target = candidate.routes[r];
        target.nodes.splice(position, 0, node);
        target.totalWeight += node.weightKg;
        target.totalVolume += node.volumeM3;
        candidate.unassigned = candidate.unassigned.filter(n => n.id !== node.id);
        chargingStationInsertion({ ...candidate, routes: [target] }, vehicles, lat, lon, start, constraints);
        if (target.lockedFirstStopId && target.nodes.find(n => !n.isChargingStation)?.id !== target.lockedFirstStopId) continue;
        const evaluation = evaluateRoute(target, vehicle, lat, lon, start, constraints.get(vehicle.id));
        if (!evaluation.feasible) continue;
        evaluations.set(target, evaluation);
        const score = computeSolutionCost(candidate, vehicles, lat, lon, start, weights, constraints, "balance",
          { evaluations, geographicCohesionCost });
        geographicCohesionCost = score.breakdown.geographicCohesionCost;
        if (!bestScore || compareSolutionScores(score, bestScore) < 0) {
          best = candidate;
          bestScore = score;
        }
      }
    }
    if (best && bestScore) {
      solution.routes = best.routes;
      solution.unassigned = best.unassigned;
      solution.cost = bestScore.cost;
      solution.costBreakdown = bestScore.breakdown;
    }
  }
}
