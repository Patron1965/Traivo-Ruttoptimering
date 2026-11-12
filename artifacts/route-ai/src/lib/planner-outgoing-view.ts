import type { Route, Stop, Vehicle, Driver } from "@workspace/api-client-react";

export const PLANNER_OUTGOING_SCOPE_LIMIT = 100;
export interface PlannerOutgoingRouteResources {
  outgoingVersion: number;
  /** Immutable approved records; never current resource/linkage fallbacks. */
  vehicle: Vehicle;
  driver: Driver;
}
export interface PlannerOutgoingView {
  routes: Route[];
  stops: Stop[];
  /** Requested routes without a current handoff; never replaced with working data. */
  omittedRouteIds: string[];
  perRouteResources: Record<string, PlannerOutgoingRouteResources>;
}

export class PlannerOutgoingViewError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string, readonly routeId?: string) {
    super(message);
    this.name = "PlannerOutgoingViewError";
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Validate scope/identity coherence, not invent statuses or merge working fields.
 * The server owns the route/stop model and every operational projection.
 */
export function parsePlannerOutgoingView(value: unknown, organizationId: string, routeIds: readonly string[]): PlannerOutgoingView {
  const invalid = () => new PlannerOutgoingViewError(
    "Livevyn kunde inte verifieras för hela urvalet. Ingen arbetsplan visas som ersättning.",
    undefined, "OUTGOING_RESPONSE_INVALID",
  );
  if (!object(value) || !Array.isArray(value.routes) || !Array.isArray(value.stops)
    || !Array.isArray(value.omittedRouteIds) || !object(value.perRouteResources)) throw invalid();
  const scope = new Set(routeIds);
  const covered = new Set<string>();
  const outgoing = new Set<string>();
  for (const route of value.routes) {
    if (!object(route) || typeof route.id !== "string" || !scope.has(route.id) || covered.has(route.id)
      || route.organizationId !== organizationId || !Number.isInteger(route.planRevision)
      || Number(route.planRevision) < 0 || route.handoffVersion !== route.planRevision
      || route.dispatchSnapshotVersion !== route.planRevision || typeof route.handoffDriverId !== "string") throw invalid();
    const resources = value.perRouteResources[route.id];
    if (!object(resources) || resources.outgoingVersion !== route.planRevision
      || !object(resources.vehicle) || !object(resources.driver)
      || resources.vehicle.organizationId !== organizationId || resources.driver.organizationId !== organizationId
      || resources.vehicle.id !== route.vehicleId || resources.driver.id !== route.handoffDriverId
      || resources.driver.vehicleId !== resources.vehicle.id
      || typeof resources.vehicle.name !== "string" || typeof resources.vehicle.routeColor !== "string"
      || typeof resources.driver.name !== "string") throw invalid();
    covered.add(route.id); outgoing.add(route.id);
  }
  for (const id of value.omittedRouteIds) {
    if (typeof id !== "string" || !scope.has(id) || covered.has(id)) throw invalid();
    covered.add(id);
  }
  if (covered.size !== scope.size) throw invalid();
  if (Object.keys(value.perRouteResources).length !== outgoing.size
    || Object.keys(value.perRouteResources).some((id) => !outgoing.has(id))) throw invalid();
  const stops = new Set<string>();
  for (const stop of value.stops) {
    if (!object(stop) || typeof stop.id !== "string" || stops.has(stop.id)
      || typeof stop.routeId !== "string" || !outgoing.has(stop.routeId)
      || stop.organizationId !== organizationId
      || !["pending", "in_progress", "completed", "failed", "skipped"].includes(String(stop.status))) throw invalid();
    stops.add(stop.id);
  }
  return value as unknown as PlannerOutgoingView;
}
