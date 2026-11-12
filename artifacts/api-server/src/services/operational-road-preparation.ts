import { and, eq, inArray, or } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable, driversTable, organizationsTable } from "@workspace/db";
import { CHARGING_STATIONS } from "./alns/types";
import { precomputeDistanceMatrix, getDistanceMatrixCacheCoverage } from "./osrm";
import { getUsageContext } from "./usage-context";
import { withOrganizationServicePolicy } from "./organization-service-policy";
import { RoadDataUnavailableError, assertOperationalRoadProvider } from "./road-data-policy";

export type RoadCoordinate = { lat: number; lon: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function roadCoordinate(lat: unknown, lon: unknown): RoadCoordinate[] {
  return typeof lat === "number" && typeof lon === "number" &&
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [{ lat, lon }] : [];
}

/** Tenant-bound preparation shared by HTTP and direct mutation-service calls.
 * It does not authorize or change a route. Canonical transactional guards
 * still compare authoritative snapshots after the road-data wait. */
export async function preparePersistedRouteRoadData(organizationId: string, input: {
  routeIds?: string[]; planIds?: string[]; stopIds?: string[];
  driverIds?: string[]; vehicleIds?: string[]; coordinates?: RoadCoordinate[];
  chargingStationIds?: string[];
}): Promise<void> {
  const context = getUsageContext();
  if (context?.organizationId !== organizationId || !context.servicePolicy) {
    return withOrganizationServicePolicy(organizationId, () => preparePersistedRouteRoadData(organizationId, input));
  }
  const ids = (values: string[] = []) => [...new Set(values.filter(value => UUID.test(value)))];
  const routeIds = new Set(ids(input.routeIds));
  const stopIds = ids(input.stopIds), planIds = ids(input.planIds);
  if (stopIds.length) {
    const linked = await db.select({ routeId: stopsTable.routeId }).from(stopsTable).where(and(
      eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, stopIds),
    ));
    for (const stop of linked) if (stop.routeId) routeIds.add(stop.routeId);
  }
  const routeFilters = [
    ...(routeIds.size ? [inArray(routesTable.id, [...routeIds])] : []),
    ...(planIds.length ? [inArray(routesTable.planId, planIds)] : []),
  ];
  const routes = routeFilters.length ? await db.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), or(...routeFilters),
  )) : [];
  for (const route of routes) routeIds.add(route.id);
  const stopFilters = [
    ...(routeIds.size ? [inArray(stopsTable.routeId, [...routeIds])] : []),
    ...(stopIds.length ? [inArray(stopsTable.id, stopIds)] : []),
  ];
  const stops = stopFilters.length ? await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId), or(...stopFilters),
  )) : [];
  const points = [...(input.coordinates ?? [])];
  for (const stop of stops) points.push(...roadCoordinate(stop.latitude, stop.longitude), ...roadCoordinate(stop.pickupLatitude, stop.pickupLongitude));
  for (const route of routes) {
    if (route.depotSnapshot) points.push(
      ...roadCoordinate(route.depotSnapshot.start.latitude, route.depotSnapshot.start.longitude),
      ...roadCoordinate(route.depotSnapshot.end.latitude, route.depotSnapshot.end.longitude),
    );
  }
  const stationIds = new Set([
    ...(input.chargingStationIds ?? []),
    ...routes.flatMap(route => (route.plannerItinerary ?? []).filter(stop => stop.isChargingStop).map(stop => stop.stopId)),
  ]);
  for (const station of CHARGING_STATIONS) {
    if (stationIds.has(station.id)) points.push(...roadCoordinate(station.latitude, station.longitude));
  }
  const vehicleIds = ids([...(input.vehicleIds ?? []), ...routes.flatMap(r => r.vehicleId ? [r.vehicleId] : [])]);
  const driverIds = ids([...(input.driverIds ?? []), ...routes.flatMap(r => r.handoffDriverId ? [r.handoffDriverId] : [])]);
  const driverFilters = [
    ...(driverIds.length ? [inArray(driversTable.id, driverIds)] : []),
    ...(vehicleIds.length ? [inArray(driversTable.vehicleId, vehicleIds)] : []),
  ];
  if (driverFilters.length) {
    const drivers = await db.select().from(driversTable).where(and(
      eq(driversTable.organizationId, organizationId), or(...driverFilters),
    ));
    for (const driver of drivers) points.push(...roadCoordinate(driver.startLatitude, driver.startLongitude), ...roadCoordinate(driver.endLatitude, driver.endLongitude));
  }
  if (vehicleIds.length) {
    const vehicles = await db.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.organizationId, organizationId), inArray(vehiclesTable.id, vehicleIds),
    ));
    if (vehicles.some(v => v.vehicleType === "electric")) points.push(...CHARGING_STATIONS.map(s => ({ lat: s.latitude, lon: s.longitude })));
  }
  if (routes.length) {
    const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
    if (org) points.push(...roadCoordinate(org.depotStartLatitude, org.depotStartLongitude), ...roadCoordinate(org.depotEndLatitude, org.depotEndLongitude));
  }
  if (getDistanceMatrixCacheCoverage(points).totalPairs > 0) {
    assertOperationalRoadProvider();
    if (!(await precomputeDistanceMatrix(points))) throw new RoadDataUnavailableError();
  }
}
