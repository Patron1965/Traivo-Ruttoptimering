import { evaluateRoute } from "./cost";
import { cachedDistance } from "./distance-cache";
import { stockholmClock } from "../route-workday";
import type { ALNSDriverConstraints, ALNSNode, ALNSRoute, ALNSSolution, ALNSVehicle } from "./types";

/** Negative means left retains better priority/coverage. Soft route costs break ties only. */
export function compareUnassignedCoverage(left: ALNSNode[], right: ALNSNode[]): number {
  const lockedCount = (nodes: ALNSNode[]) => nodes.filter(
    node => node.lockedVehicleId || node.lockedDriverId || node.lockedServiceStartAt,
  ).length;
  const lockDifference = lockedCount(left) - lockedCount(right);
  if (lockDifference !== 0) return lockDifference;
  for (const priority of [2, 1, 0]) {
    const count = (nodes: ALNSNode[]) => nodes.filter(
      node => !node.isChargingStation && (node.planningPriority ?? 0) === priority,
    ).length;
    const difference = count(left) - count(right);
    if (difference !== 0) return difference;
  }
  return 0;
}

function withNodes(route: ALNSRoute, nodes: ALNSNode[]): ALNSRoute {
  return {
    ...route, nodes,
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
}

/** Coverage repair only: move an existing job, then admit an additional job.
 * Never drop a job, weaken constraints, split a composite job or move charging waypoints.
 * Failed candidates own their arrays and cannot mutate the accepted solution.
 */
export function repairFleetCoverage(
  solution: Pick<ALNSSolution, "routes" | "unassigned">,
  vehicles: ALNSVehicle[], depotLat: number, depotLon: number, start: Date,
  constraints: Map<string, ALNSDriverConstraints>, budgetMs = 2000,
): number {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const valid = (route: ALNSRoute) => {
    const vehicle = vehicleById.get(route.vehicleId);
    return vehicle != null && evaluateRoute(
      route, vehicle, depotLat, depotLon, start, constraints.get(vehicle.id),
    ).feasible;
  };
  const candidates = solution.unassigned.filter(node => !node.isChargingStation).sort(
    (a, b) => (b.planningPriority ?? 0) - (a.planningPriority ?? 0)
      || cachedDistance(depotLat, depotLon, a.latitude, a.longitude)
        - cachedDistance(depotLat, depotLon, b.latitude, b.longitude)
      || a.id.localeCompare(b.id),
  );
  let admitted = 0;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    let repaired = false;
    const nearbyRoutes = solution.routes.map((route, index) => ({
      index,
      distance: Math.min(...route.nodes.map(node =>
        cachedDistance(candidate.latitude, candidate.longitude, node.latitude, node.longitude))),
    })).sort((a, b) => a.distance - b.distance || a.index - b.index);
    for (const { index: sourceIndex } of nearbyRoutes) {
      if (repaired) break;
      const source = solution.routes[sourceIndex];
      // Changing charging slots needs the EV itinerary repair; do not invent it here.
      if (source.nodes.some(node => node.isChargingStation)) continue;
      for (let remove = 0; remove < source.nodes.length && !repaired; remove++) {
        const displaced = source.nodes[remove];
        const reduced = source.nodes.filter((_, index) => index !== remove);
        // First establish that the new job fits the source after removal.
        // Previously every target insertion was evaluated before this check,
        // exhausting the budget on sources that could never admit the job.
        let nextSource: ALNSRoute | undefined;
        for (let sourceSlot = 0; sourceSlot <= reduced.length; sourceSlot++) {
          if (Date.now() >= deadline) return admitted;
          const sourceNodes = [...reduced];
          sourceNodes.splice(sourceSlot, 0, candidate);
          const proposed = withNodes(source, sourceNodes);
          if (valid(proposed)) { nextSource = proposed; break; }
        }
        if (!nextSource) continue;
        for (let targetIndex = 0; targetIndex < solution.routes.length && !repaired; targetIndex++) {
          if (sourceIndex === targetIndex) continue;
          const target = solution.routes[targetIndex];
          if (target.nodes.some(node => node.isChargingStation)) continue;
          for (let slot = 0; slot <= target.nodes.length && !repaired; slot++) {
            if (Date.now() >= deadline) return admitted;
            const targetNodes = [...target.nodes];
            targetNodes.splice(slot, 0, displaced);
            const nextTarget = withNodes(target, targetNodes);
            if (!valid(nextTarget)) continue;
            solution.routes[sourceIndex] = nextSource;
            solution.routes[targetIndex] = nextTarget;
            solution.unassigned = solution.unassigned.filter(node => node.id !== candidate.id);
            admitted++;
            repaired = true;
          }
        }
      }
    }
  }
  return admitted;
}

/** Work availability, not capacity/round-robin alone, governs the initial fleet split. */
export function allocateClusterVehicles(
  clusters: ALNSNode[][], vehicles: ALNSVehicle[], start: Date,
  driverConstraints: ALNSDriverConstraints[] = [],
): ALNSVehicle[][] {
  const result: ALNSVehicle[][] = clusters.map(() => []);
  const constraints = new Map(driverConstraints.map(driver => [driver.vehicleId, driver]));
  const minutes = new Map(vehicles.map(vehicle => {
    const driver = constraints.get(vehicle.id);
    const clock = (value: string) => {
      const [hours, mins] = value.split(":").map(Number);
      return hours * 60 + mins;
    };
    const breakMinutes = driver?.breakStartTime && driver.breakEndTime
      ? Math.max(0, clock(driver.breakEndTime) - clock(driver.breakStartTime)) : 0;
    const shiftStart = driver?.preferredStartTime ? stockholmClock(start, driver.preferredStartTime) : start;
    const shiftEnd = driver?.preferredEndTime ? stockholmClock(start, driver.preferredEndTime)
      : new Date(shiftStart.getTime() + 480 * 60_000);
    return [vehicle.id, Math.max(1, (shiftEnd.getTime() - shiftStart.getTime()) / 60_000 - breakMinutes)] as const;
  }));
  const effort = clusters.map(nodes => nodes.reduce(
    (sum, node) => sum + node.serviceDurationMin + (node.pickupServiceMin ?? 0)
      + (node.stopReserveMin ?? 0), 0,
  ));
  const remaining = [...vehicles];
  const ordered = effort.map((work, index) => ({work, index})).sort(
    (a, b) => b.work - a.work || a.index - b.index,
  );
  for (const {index} of ordered) {
    if (!remaining.length) break;
    remaining.sort((a, b) => {
      const eligible = (vehicle: ALNSVehicle) => clusters[index].filter(
        node => !vehicle.ineligibleStopIds?.has(node.id)).length;
      return eligible(b) - eligible(a)
        || minutes.get(b.id)! - minutes.get(a.id)!
        || b.capacityKg - a.capacityKg || a.id.localeCompare(b.id);
    });
    result[index].push(remaining.shift()!);
  }
  for (const vehicle of remaining) {
    const eligible = effort.map((work, index) => ({
      index,
      load: clusters[index].some(node => !vehicle.ineligibleStopIds?.has(node.id))
        ? work / Math.max(1, result[index].reduce((sum, v) => sum + minutes.get(v.id)!, 0))
        : -1,
    })).sort((a, b) => b.load - a.load || a.index - b.index);
    if (eligible[0]) result[eligible[0].index].push(vehicle);
  }
  return result;
}
