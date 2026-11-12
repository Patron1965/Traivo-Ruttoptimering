import { evaluateRoute } from "./cost";
import { evaluateRouteWorkday } from "../route-workday";
import { withRequiredRoadData } from "../road-data-policy";
import type { ALNSDriverConstraints, ALNSNode, ALNSRoute, ALNSVehicle } from "./types";

export class OptimizerPlanningLockConflict extends Error {
  readonly statusCode = 409;
  readonly code = "PLANNING_LOCK";
  constructor(message: string) { super(message); this.name = "OptimizerPlanningLockConflict"; }
}

export function hasPlanningLock(node: ALNSNode): boolean {
  return Boolean(node.lockedVehicleId || node.lockedDriverId || node.lockedServiceStartAt);
}

/** Admit hard obligations before optional work, then earliest exact minute. */
export function comparePlanningLockAdmission(a: ALNSNode, b: ALNSNode): number {
  return Number(hasPlanningLock(b)) - Number(hasPlanningLock(a))
    || (a.lockedServiceStartAt?.getTime() ?? Infinity) - (b.lockedServiceStartAt?.getTime() ?? Infinity)
    || b.serviceDurationMin - a.serviceDurationMin
    || a.id.localeCompare(b.id);
}

export function assertLockedJobsRetained(
  original: readonly ALNSNode[], routes: readonly ALNSRoute[], unassigned: readonly ALNSNode[],
): void {
  for (const node of original) {
    if (!node.lockedVehicleId && !node.lockedDriverId && !node.lockedServiceStartAt) continue;
    const destinations = routes.filter(route => route.nodes.some(item => item.id === node.id));
    if (destinations.length !== 1 || unassigned.some(item => item.id === node.id)
      || destinations[0].nodes.filter(item => item.id === node.id).length !== 1
      || (node.lockedVehicleId && destinations[0].vehicleId !== node.lockedVehicleId)) {
      throw new OptimizerPlanningLockConflict(`Det låsta uppdraget ${node.id} kunde inte behållas i en genomförbar rutt.`);
    }
  }
}

export function assertPlanningLockResult(
  original: readonly ALNSNode[], routes: readonly ALNSRoute[], unassigned: readonly ALNSNode[],
  vehicles: readonly ALNSVehicle[], depotLat: number, depotLon: number, date: Date,
  constraints: ReadonlyMap<string, ALNSDriverConstraints>,
): void {
  assertLockedJobsRetained(original, routes, unassigned);
  const obligations = new Map(original.filter(hasPlanningLock).map(node => [node.id, node]));
  for (const route of routes) {
    if (!route.nodes.some(node => obligations.has(node.id))) continue;
    const vehicle = vehicles.find(item => item.id === route.vehicleId);
    const authoritative = { ...route, nodes: route.nodes.map(node => obligations.get(node.id) ?? node) };
    if (!vehicle || !withRequiredRoadData(() =>
      evaluateRoute(authoritative, vehicle, depotLat, depotLon, date, constraints.get(route.vehicleId)),
    ).feasible) {
      throw new OptimizerPlanningLockConflict(`Det låsta optimeringsresultatet för ${route.vehicleId} är inte genomförbart.`);
    }
  }
}

/** Validate, never repair/re-clock a frozen itinerary. Includes charging and P&D. */
export function assertFrozenRouteFeasible(
  route: ALNSRoute, vehicle: ALNSVehicle | undefined,
  depotLat: number, depotLon: number, date: Date, constraints?: ALNSDriverConstraints,
): void {
  const conflict = () => new OptimizerPlanningLockConflict(
    `Den frysta rutten ${route.sourceRouteId ?? route.vehicleId} är inte längre genomförbar med aktuellt underlag. Lås upp före omplanering.`,
  );
  if (!vehicle || !route.frozenTimeline
    || !withRequiredRoadData(() => evaluateRoute(route, vehicle, depotLat, depotLon, date, constraints)).feasible) throw conflict();
  const clock = (events: typeof route.frozenTimeline) => JSON.stringify(events!.map(event => ({
    type: event.type, stopId: event.stopId ?? null, startAt: event.startAt, endAt: event.endAt,
  })));
  const actual = withRequiredRoadData(() => evaluateRouteWorkday(route.nodes, vehicle, depotLat, depotLon, date, constraints));
  if (!actual.feasible || clock(actual.events) !== clock(route.frozenTimeline)) throw conflict();
}
