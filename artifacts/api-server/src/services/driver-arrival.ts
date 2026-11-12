import { and, eq } from "drizzle-orm";
import { db, routesTable, stopsTable } from "@workspace/db";
import { liveSnapshot, roadArrival } from "./customer-live-tracking";
import { outgoingRoute } from "./outgoing-route-service";

type Stop = typeof stopsTable.$inferSelect;
type Route = typeof routesTable.$inferSelect;
export interface DriverArrival {
  plannedAt: string | null;
  estimatedAt: string | null;
  calculatedAt: string | null;
  positionAt: string | null;
  source: "road" | "plan_shift" | null;
}
const unresolved = (stop: Pick<Stop, "status">) => !["completed", "failed", "skipped"].includes(stop.status);

/** Read projection only: never edits itinerary, actual times, order, or approval. */
export function projectDriverArrivals(
  route: Pick<Route, "plannerItinerary"> & Partial<Pick<Route, "executionProjection">>, stops: Array<Pick<Stop, "id" | "status">>,
  live: DriverArrival,
): Record<string, DriverArrival> {
  const planned = new Map((route.plannerItinerary ?? [])
    .filter(item => item.stopId && !item.isChargingStop)
    .map(item => [item.stopId, item.estimatedArrival]));
  const next = stops.find(unresolved);
  const delta = live.plannedAt && live.estimatedAt
    ? Date.parse(live.estimatedAt) - Date.parse(live.plannedAt) : null;
  return Object.fromEntries(stops.map(stop => {
    const at = planned.get(stop.id);
    const plannedAt = at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
    const shifted = !route.executionProjection?.selectionChangedAt
      && unresolved(stop) && plannedAt && delta !== null && Number.isFinite(delta);
    return [stop.id, {
      plannedAt,
      estimatedAt: stop.id === next?.id ? live.estimatedAt
        : shifted ? new Date(Date.parse(plannedAt!) + delta!).toISOString() : null,
      calculatedAt: unresolved(stop) ? live.calculatedAt : null,
      positionAt: unresolved(stop) ? live.positionAt : null,
      source: stop.id === next?.id ? live.source : shifted ? "plan_shift" : null,
    }];
  }));
}

export async function driverArrivals(routeId: string, organizationId: string, stops: Stop[]) {
  let [route] = await db.select().from(routesTable).where(and(
    eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return {};
  if (route.dispatchSnapshotVersion != null) route = await outgoingRoute(route);
  const next = stops.find(unresolved);
  let live: DriverArrival = { plannedAt: null, estimatedAt: null, calculatedAt: null, positionAt: null, source: null };
  // The customer-tracking road projection targets the delivery address. Do not
  // present it as a pickup ETA while the pickup leg remains unresolved.
  if (next && !(next.pickupAddress && next.status === "pending") &&
    route.status !== "completed" && route.status !== "cancelled") {
    const snapshot = await liveSnapshot(next);
    const arrival = await roadArrival(snapshot, next);
    live = { ...arrival, positionAt: snapshot.tracking.lastUpdatedAt };
  }
  const [current] = await db.select().from(routesTable).where(and(
    eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  const currentOutgoing = current?.dispatchSnapshotVersion != null ? await outgoingRoute(current) : current;
  if (currentOutgoing?.handoffVersion !== route.planRevision
    || currentOutgoing?.executionProjection?.selectionRevision !== route.executionProjection?.selectionRevision) {
    live = { ...live, estimatedAt: null, source: null, calculatedAt: null };
  }
  return projectDriverArrivals(route, stops, live);
}
