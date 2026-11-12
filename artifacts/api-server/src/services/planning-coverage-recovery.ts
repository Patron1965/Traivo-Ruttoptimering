import { createHash } from "node:crypto";
import { evaluateRoute, computeSolutionCost, compareSolutionScores } from "./alns/cost";
import { compareUnassignedCoverage } from "./alns/fleet-coverage";
import { DEFAULT_WEIGHTS, getEnvCtx, type ALNSResult, type ALNSNode, type ALNSVehicle, type ALNSDriverConstraints, type OptimizationWeights } from "./alns/types";
import { retainRuntimeState } from "./planning-runtime-store";
import { withRequiredRoadData } from "./road-data-policy";

type RecoveryInput = {
  organizationId?: string;
  nodes: ALNSNode[];
  vehicles: ALNSVehicle[];
  constraints: Map<string, ALNSDriverConstraints>;
  depotLatitude: number;
  depotLongitude: number;
  start: Date;
  weights?: OptimizationWeights;
  vehicleDistributionMode: "balance" | "minimize";
  repairIncumbent?: (candidate: ALNSResult) => void;
};

/** Call only AFTER the normal complete fleet-wide repair stages. Preserve a
 * better verified result for the exact same input without another slow search.
 * An incumbent is revalidated and rescored; it is never blindly replayed. */
export async function recoverPlanningCoverage(result: ALNSResult, input: RecoveryInput): Promise<ALNSResult> {
  return withRequiredRoadData(async () => {
    const { nodes, vehicles, constraints, depotLatitude: lat, depotLongitude: lon, start } = input;
    const weights = input.weights ?? DEFAULT_WEIGHTS;
    const expectedIds = nodes.filter(n => !n.isChargingStation).map(n => n.id).sort();
    const locks = result.routes.filter(r => r.lockedFirstStopId).map(r => [r.vehicleId, r.lockedFirstStopId] as const);
    const vehicleById = new Map(vehicles.map(v => [v.id, v]));
    const valid = (candidate: ALNSResult) => {
      const ids = [...candidate.routes.flatMap(r => r.nodes), ...candidate.unassigned]
        .filter(n => !n.isChargingStation).map(n => n.id).sort();
      if (ids.length !== expectedIds.length || ids.some((id, i) => id !== expectedIds[i])) return false;
      const routeVehicles = candidate.routes.map(r => r.vehicleId);
      if (new Set(routeVehicles).size !== routeVehicles.length) return false;
      if (locks.some(([id, stopId]) => {
        const route = candidate.routes.find(r => r.vehicleId === id);
        return !route || route.lockedFirstStopId !== stopId || route.nodes.find(n => !n.isChargingStation)?.id !== stopId;
      })) return false;
      return candidate.routes.every(route => {
        const vehicle = vehicleById.get(route.vehicleId);
        return vehicle != null && evaluateRoute(route, vehicle, lat, lon, start, constraints.get(vehicle.id)).feasible;
      });
    };
    const score = (candidate: ALNSResult) => computeSolutionCost(
      { ...candidate, cost: 0 }, vehicles, lat, lon, start, weights, constraints, input.vehicleDistributionMode,
    );
    const choose = (previous: ALNSResult, candidate: ALNSResult): ALNSResult => {
      if (!valid(previous)) return candidate;
      if (!valid(candidate)) return previous;
      const coverage = compareUnassignedCoverage(previous.unassigned, candidate.unassigned);
      return coverage < 0 || (coverage === 0 && compareSolutionScores(score(previous), score(candidate)) <= 0) ? previous : candidate;
    };
    if (!valid(result)) throw new Error("Planeringsresultatet saknar giltig stopptäckning eller bryter mot hårda villkor.");
    let best = result;
    if (input.organizationId) {
      const fingerprint = createHash("sha256").update(JSON.stringify(
        {
          nodes: [...nodes].sort((a, b) => a.id.localeCompare(b.id)),
          vehicles, constraints: [...constraints].sort(([a], [b]) => a.localeCompare(b)),
          locks, lat, lon, start, environment: getEnvCtx(),
        },
        (_key, value) => value instanceof Set ? [...value].sort() : value,
      )).digest("hex");
      const retained = await retainRuntimeState(
        input.organizationId, "best-planning-result", fingerprint, best, 24 * 60 * 60_000,
        (previous, candidate) => {
          // Soft objectives may differ, but feasibility inputs may not. A known
          // solution is only a candidate: repeat the current mode's canonical
          // repairs (including explicit fleet use) and score its current goal.
          if (compareUnassignedCoverage(previous.unassigned, candidate.unassigned) <= 0) {
            input.repairIncumbent?.(previous);
          }
          return choose(previous, candidate);
        },
      );
      // Archived plans are revalidated against today's road matrix and hard
      // evaluator. Performance telemetry must still describe the current run.
      best = { ...retained, performance: result.performance };
    }
    best.routeEvaluations = new Map(best.routes.flatMap(route => {
      const vehicle = vehicleById.get(route.vehicleId)!;
      return route.nodes.length ? [[route.vehicleId, evaluateRoute(route, vehicle, lat, lon, start, constraints.get(vehicle.id))] as const] : [];
    }));
    best.costBreakdown = computeSolutionCost({ ...best, cost: 0 }, vehicles, lat, lon, start, weights, constraints, input.vehicleDistributionMode).breakdown;
    return best;
  });
}
