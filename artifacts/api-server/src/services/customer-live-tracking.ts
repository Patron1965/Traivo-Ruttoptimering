import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { operationalProviderKind } from "./operational-provider-config";
import { fetchGeoapifyRoute } from "./geoapify-road";
import { assertOperationalRoadProvider } from "./road-data-policy";
import { withOrganizationServicePolicy, servicePolicyCachePartition } from "./organization-service-policy";
import { db, routesTable, stopsTable, driversTable, vehiclesTable, routeExecutionsTable, vehiclePositionsTable } from "@workspace/db";
import { outgoingStopContext, outgoingStops } from "./outgoing-route-service";

export const PUBLIC_GPS_MAX_AGE_MS = 120_000;
type Tracking = {
  state: "live" | "stale" | "waiting" | "inactive" | "completed" | "unavailable";
  position: { latitude: number; longitude: number } | null;
  lastUpdatedAt: string | null; freshUntil: string | null;
  reason: "not_next" | "execution_inactive" | "gps_missing" | "gps_stale" | "plan_changed" | "service_pause" | null;
};
type Arrival = { plannedAt: string | null; estimatedAt: string | null; source: "road" | null; calculatedAt: string | null; reason: "not_live" | "road_unavailable" | "service_pause" | null };
const terminal = (status: string) => ["completed", "failed", "skipped"].includes(status);
type StopAnchor = { id: string; status: string; sequenceOrder: number | null };
export function hasUnresolvedServiceLeg(route: Pick<typeof routesTable.$inferSelect, "plannerItinerary" | "workdayTimeline">, stops: StopAnchor[], nextId: string): boolean {
  const byId = new Map(stops.map(s => [s.id, s]));
  const itinerary = [...(route.plannerItinerary ?? [])].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  const targetIndex = itinerary.findIndex(s => s.stopId === nextId && !s.isChargingStop);
  if (itinerary.some(s => s.isChargingStop)) {
    if (targetIndex < 0) return true;
    let passedIndex = -1;
    for (let i = 0; i < targetIndex; i++) {
      const anchor = byId.get(itinerary[i].stopId);
      if (!itinerary[i].isChargingStop && anchor && terminal(anchor.status)) passedIndex = i;
    }
    if (itinerary.slice(passedIndex + 1, targetIndex).some(s => s.isChargingStop || !byId.has(s.stopId))) return true;
  }
  const timeline = route.workdayTimeline ?? [];
  if (!timeline.some(e => e.type === "break" || e.type === "charging")) return false;
  const targetEvent = timeline.findIndex(e => e.type === "service" && e.stopId === nextId);
  // Missing customer anchors cannot establish which side of the customer a
  // synthetic leg belongs to. Planned wall-clock expiry is never completion.
  if (targetEvent < 0) return true;
  let passedEvent = -1;
  for (let i = 0; i < targetEvent; i++) {
    const event = timeline[i], anchor = event.stopId ? byId.get(event.stopId) : undefined;
    if (event.type === "service" && anchor && terminal(anchor.status)) passedEvent = i;
  }
  return timeline.slice(passedEvent + 1, targetEvent).some(e => e.type === "break" || e.type === "charging");
}
export function projectGps(sample: { latitude: number; longitude: number; recordedAt: Date } | undefined, now: number): Tracking {
  if (!sample) return { state: "waiting", position: null, lastUpdatedAt: null, freshUntil: null, reason: "gps_missing" };
  const time = sample.recordedAt.getTime();
  if (!Number.isFinite(time) || time > now || !Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude) || Math.abs(sample.latitude) > 90 || Math.abs(sample.longitude) > 180)
    return { state: "unavailable", position: null, lastUpdatedAt: null, freshUntil: null, reason: "gps_missing" };
  const live = now - time < PUBLIC_GPS_MAX_AGE_MS;
  return { state: live ? "live" : "stale", position: live ? { latitude: sample.latitude, longitude: sample.longitude } : null,
    lastUpdatedAt: sample.recordedAt.toISOString(), freshUntil: new Date(time + PUBLIC_GPS_MAX_AGE_MS).toISOString(), reason: live ? null : "gps_stale" };
}

// Read-only repeatable snapshot; no locks remain held while requesting roads.
export async function liveSnapshot(observedStop: typeof stopsTable.$inferSelect) {
  return db.transaction(async tx => {
    let tracking: Tracking = { state: "inactive", position: null, lastUpdatedAt: null, freshUntil: null, reason: "execution_inactive" };
    const arrival: Arrival = { plannedAt: null, estimatedAt: null, source: null, calculatedAt: null, reason: "not_live" };
    const result = (key = "", destination: { latitude: number; longitude: number } | null = null) => ({ tracking, arrival, key, destination });
    let [stop] = await tx.select().from(stopsTable).where(and(eq(stopsTable.id, observedStop.id), eq(stopsTable.organizationId, observedStop.organizationId), isNull(stopsTable.archivedAt)));
    if (!stop) return result();
    const completed = terminal(stop.status);
    if (completed) tracking = { ...tracking, state: "completed", reason: null };
    if (!stop.routeId) return result();
    let route: typeof routesTable.$inferSelect;
    try {
      const context = await outgoingStopContext(stop.organizationId, stop.id, null, tx);
      route = context.route; stop = context.stop;
    } catch {
      tracking.reason = "plan_changed"; return result();
    }
    const planned = route.plannerItinerary?.find(s => s.stopId === stop.id && !s.isChargingStop)?.estimatedArrival;
    if (planned && Number.isFinite(Date.parse(planned))) arrival.plannedAt = new Date(planned).toISOString();
    if (completed) return result();
    if (route.handoffStatus !== "accepted" || route.handoffVersion !== route.planRevision) {
      tracking.reason = "plan_changed"; return result();
    }
    if (!route.vehicleId || !route.handoffDriverId || route.status !== "in_progress") return result();
    const [driver] = await tx.select().from(driversTable).where(and(eq(driversTable.id, route.handoffDriverId), eq(driversTable.organizationId, stop.organizationId), eq(driversTable.isActive, true)));
    const [vehicle] = await tx.select().from(vehiclesTable).where(and(eq(vehiclesTable.id, route.vehicleId), eq(vehiclesTable.organizationId, stop.organizationId), eq(vehiclesTable.isActive, true)));
    if (!driver || !vehicle) return result();
    const [execution] = await tx.select().from(routeExecutionsTable).where(and(eq(routeExecutionsTable.organizationId, stop.organizationId), eq(routeExecutionsTable.routeId, route.id), eq(routeExecutionsTable.planVersion, route.planRevision), eq(routeExecutionsTable.driverId, driver.id), eq(routeExecutionsTable.status, "active"), isNull(routeExecutionsTable.endedAt)));
    if (!execution) return result();
    const stops = await outgoingStops(route, tx);
    const next = stops.find(s => !terminal(s.status));
    if (next?.id !== stop.id || next.sequenceOrder === null) { tracking.reason = "not_next"; return result(); }
    if (stops.some(s => !terminal(s.status) && (s.sequenceOrder === null || (s.id !== next.id && s.sequenceOrder === next.sequenceOrder)))) {
      tracking.reason = "plan_changed"; return result();
    }
    // The last terminal customer proves prior sequential synthetic legs passed;
    // future legs after this customer do not block disclosure for this customer.
    if (hasUnresolvedServiceLeg(route, stops, next.id)) {
      tracking.reason = "service_pause"; arrival.reason = "service_pause"; return result();
    }
    const [sample] = await tx.select().from(vehiclePositionsTable).where(and(
      eq(vehiclePositionsTable.organizationId, stop.organizationId), eq(vehiclePositionsTable.routeId, route.id),
      eq(vehiclePositionsTable.vehicleId, vehicle.id), eq(vehiclePositionsTable.executionId, execution.id),
      eq(vehiclePositionsTable.startClientEventId, execution.startClientEventId),
    )).orderBy(desc(vehiclePositionsTable.recordedAt)).limit(1);
    tracking = projectGps(sample, Date.now());
    return result(createHash("sha256").update(JSON.stringify([route.id, route.status, route.planRevision, route.updatedAt, route.handoffStatus, route.handoffVersion, route.plannerItinerary, route.workdayTimeline,
      driver.id, driver.isActive, driver.vehicleId, vehicle.id, vehicle.isActive, execution.id, execution.status, execution.startedAt, execution.endedAt, execution.startClientEventId,
      stops.map(s => [s.id, s.status, s.sequenceOrder]), next.id, next.latitude, next.longitude, sample?.id, sample?.recordedAt, sample?.latitude, sample?.longitude])).digest("hex"), { latitude: next.latitude, longitude: next.longitude });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export type RoadAdapter = (from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }, signal: AbortSignal) => Promise<number | null>;
export const directionalRoad: RoadAdapter = async (from, to, signal) => {
  assertOperationalRoadProvider();
  if (operationalProviderKind() === "geoapify") {
    const result = await fetchGeoapifyRoute([
      { lat: from.latitude, lon: from.longitude }, { lat: to.latitude, lon: to.longitude },
    ], signal);
    return result.routes[0].duration;
  }
  const base = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
  const response = await fetch(`${base}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`, { signal });
  if (!response.ok) return null;
  const body = await response.json() as { code?: string; routes?: { duration?: number }[] };
  const seconds = body.routes?.[0]?.duration;
  return body.code === "Ok" && typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
const cache = new Map<string, { until: number; promise: Promise<{ seconds: number | null; at: string }> }>();
let inFlight = 0;
export async function roadArrival(snapshot: Awaited<ReturnType<typeof liveSnapshot>>, stop: typeof stopsTable.$inferSelect, adapter: RoadAdapter = directionalRoad): Promise<Arrival> {
  const arrival = { ...snapshot.arrival };
  if (snapshot.tracking.state !== "live" || !snapshot.tracking.position || !snapshot.destination) return arrival;
  const position = snapshot.tracking.position;
  const destination = snapshot.destination;
  // Bearer tracking has no authenticated request context. The authoritative
  // persisted stop owns both provider selection and cache access.
  return withOrganizationServicePolicy(stop.organizationId, async () => {
  assertOperationalRoadProvider();
  const key = `${servicePolicyCachePartition()}:${snapshot.key}`;
  let entry = cache.get(key);
  if (!entry || entry.until <= Date.now()) {
    if (inFlight >= 16) return { ...arrival, reason: "road_unavailable" };
    inFlight++;
    const controller = new AbortController();
    const promise = new Promise<{ seconds: number | null; at: string }>(resolve => {
      const timer = setTimeout(() => { controller.abort(); resolve({ seconds: null, at: new Date().toISOString() }); }, 3000);
      Promise.resolve().then(() => adapter(position, destination, controller.signal)).catch(() => null).then(seconds => {
        clearTimeout(timer); resolve({ seconds, at: new Date().toISOString() });
      });
    }).finally(() => { inFlight--; });
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    entry = { until: Date.now() + 15_000, promise }; cache.set(key, entry);
  }
  const { seconds, at } = await entry.promise;
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0 || seconds > 7 * 86400) return { ...arrival, reason: "road_unavailable" };
  return { ...arrival, estimatedAt: new Date(Date.parse(snapshot.tracking.lastUpdatedAt!) + seconds * 1000).toISOString(), source: "road", calculatedAt: at, reason: null };
  });
}