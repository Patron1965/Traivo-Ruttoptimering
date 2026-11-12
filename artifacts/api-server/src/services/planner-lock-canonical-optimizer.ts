import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, stopsTable, routesTable, vehiclesTable, driversTable, driverPreferencesTable, driverCertificationsTable, organizationsTable, type Stop, type Route } from "@workspace/db";
import { optimizeWithALNS as engineOptimize, reoptimizeAffectedRoutes as engineReoptimize } from "./alns/runner";
import { CHARGING_STATIONS, type ALNSNode, type ALNSRoute, type ALNSVehicle, type ALNSConfig } from "./alns/types";
import { enrichPlanningLockInputs, optimizeWithPlanningLocks, OptimizerPlanningLockConflict, type PlanningLockInputs } from "./planner-lock-aware-optimizer";
import { preparePersistedRouteRoadData } from "./operational-road-preparation";
import { applyDriverRoutingProfile } from "./driver-routing-profile";
import { checkFieldServiceEligibility } from "./field-service";
import { assertPlanningLockOrder, assertPlanningLockTimes } from "./planning-lock-invariants";
import { effectivePlanningPolicy } from "./planning-policy";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CanonicalLockContext = PlanningLockInputs & {
  organizationId: string;
  organizationSnapshot?: typeof organizationsTable.$inferSelect;
  preferences?: Array<typeof driverPreferencesTable.$inferSelect>;
  certifications?: Array<typeof driverCertificationsTable.$inferSelect>;
  routeSnapshots?: readonly Route[];
};
const contexts = new WeakMap<object, CanonicalLockContext>();
export function canonicalLockContext(result: object) { return contexts.get(result); }
export async function assertCanonicalInputsFresh(input: PlanningLockInputs): Promise<void> {
  const context = input as Partial<CanonicalLockContext>;
  const snapshots = context.routeSnapshots ?? input.routes;
  const routeIds = snapshots.map(route => route.id);
  const current = routeIds.length ? await db.select().from(routesTable).where(inArray(routesTable.id, routeIds)) : [];
  if (current.length !== snapshots.length || current.some(route =>
    JSON.stringify(route) !== JSON.stringify(snapshots.find(original => original.id === route.id)))) {
    conflict("Planen ändrades under kontinuerlig optimering. Starta om med den nya versionen.");
  }
  const stopIds = input.stops.map(stop => stop.id);
  const stops = stopIds.length ? await db.select().from(stopsTable).where(inArray(stopsTable.id, stopIds)) : [];
  if (stops.length !== input.stops.length || stops.some(stop =>
    JSON.stringify(stop) !== JSON.stringify(input.stops.find(original => original.id === stop.id)))) {
    conflict("Uppdragen ändrades under kontinuerlig optimering. Starta om med den nya versionen.");
  }
  for (const [table, originals] of [[vehiclesTable, input.vehicles], [driversTable, input.drivers ?? []]] as const) {
    const ids = originals.map(row => row.id);
    const rows = ids.length ? await db.select().from(table).where(inArray(table.id, ids)) : [];
    if (rows.length !== originals.length || rows.some(row =>
      JSON.stringify(row) !== JSON.stringify(originals.find(original => original.id === row.id)))) {
      conflict("Resurserna ändrades under kontinuerlig optimering. Starta om med den nya versionen.");
    }
  }
  if (context.organizationSnapshot) {
    const [organization] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, context.organizationSnapshot.id));
    if (JSON.stringify(organization) !== JSON.stringify(context.organizationSnapshot)) {
      conflict("Organisationens planeringsregler ändrades. Starta om optimeringen.");
    }
  }
  if (context.preferences && input.drivers?.length) {
    const currentPreferences = await db.select().from(driverPreferencesTable)
      .where(inArray(driverPreferencesTable.driverId, input.drivers.map(driver => driver.id))).orderBy(driverPreferencesTable.id);
    const stable = (rows: typeof currentPreferences) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(stable(currentPreferences)) !== JSON.stringify(stable(context.preferences))) {
      conflict("Chaufförens arbetstidsregler ändrades. Starta om optimeringen.");
    }
  }
  if (context.certifications && input.drivers?.length) {
    const certifications = await db.select().from(driverCertificationsTable)
      .where(inArray(driverCertificationsTable.driverId, input.drivers.map(driver => driver.id)));
    const stable = (rows: typeof certifications) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(stable(certifications)) !== JSON.stringify(stable(context.certifications))) {
      conflict("Chaufförens behörighetsunderlag ändrades. Starta om optimeringen.");
    }
  }
}

function conflict(message: string): never { throw new OptimizerPlanningLockConflict(message); }

/** Also used by route mutation owners: constraints are copied from DB, not request flags. */
export function nodeWithCanonicalPlanningLocks(node: ALNSNode, stop: Stop): ALNSNode {
  return { ...node, lockedVehicleId: stop.lockedVehicleId, lockedDriverId: stop.lockedDriverId,
    lockedServiceStartAt: stop.lockedServiceStartAt ? new Date(stop.lockedServiceStartAt) : null };
}
function nodeWithCanonicalFacts(node: ALNSNode, stop: Stop): ALNSNode {
  return nodeWithCanonicalPlanningLocks({
    ...node, jobType: stop.jobType, latitude: stop.latitude, longitude: stop.longitude,
    timeWindowStart: stop.timeWindowStart, timeWindowEnd: stop.timeWindowEnd,
    weightKg: Number(stop.weightKg), volumeM3: Number(stop.volumeM3),
    unavailablePeriods: stop.unavailablePeriods ?? undefined,
    requiredSkills: stop.requiredSkills ?? undefined, requiredCertifications: stop.requiredCertifications ?? undefined,
    requiredEquipment: stop.requiredEquipment ?? undefined,
    pickupLat: stop.pickupAddress ? stop.pickupLatitude ?? undefined : undefined,
    pickupLon: stop.pickupAddress ? stop.pickupLongitude ?? undefined : undefined,
    pickupServiceMin: stop.pickupAddress ? node.pickupServiceMin ?? stop.serviceDurationMin : undefined,
  }, stop);
}

function nodeForSavedStop(stop: Stop, route: Route, template?: ALNSNode): ALNSNode {
  const planning = route.optimizationPlanningSnapshot as { stopReserveMin?: number; travelReservePercent?: number } | null;
  if (!planning || !Number.isFinite(planning.stopReserveMin) || !Number.isFinite(planning.travelReservePercent)) {
    conflict(`Den frysta rutten ${route.id} saknar sparade reserver.`);
  }
  return nodeWithCanonicalFacts({
    id: stop.id, jobType: stop.jobType, latitude: stop.latitude, longitude: stop.longitude,
    timeWindowStart: stop.timeWindowStart, timeWindowEnd: stop.timeWindowEnd,
    serviceDurationMin: stop.serviceDurationMin, weightKg: Number(stop.weightKg), volumeM3: Number(stop.volumeM3),
    unavailablePeriods: stop.unavailablePeriods ?? undefined,
    requiredSkills: stop.requiredSkills ?? undefined, requiredCertifications: stop.requiredCertifications ?? undefined,
    requiredEquipment: stop.requiredEquipment ?? undefined,
    ...(stop.pickupAddress && stop.pickupLatitude != null && stop.pickupLongitude != null ? {
      pickupLat: stop.pickupLatitude, pickupLon: stop.pickupLongitude, pickupServiceMin: stop.serviceDurationMin,
    } : {}),
    ...template,
    // Frozen routes keep saved planning reserves, not new whole-plan preferences.
    stopReserveMin: planning.stopReserveMin, travelReservePercent: planning.travelReservePercent,
  }, stop);
}

/** Reconstruct the saved itinerary, never customer-only order or fresh chargers. */
export function canonicalFrozenItinerary(
  route: Route, stops: readonly Stop[], mappedNodes: readonly ALNSNode[],
): ALNSRoute {
  if (!route.vehicleId || !route.depotSnapshot || !route.plannerItinerary || !route.workdayTimeline) {
    conflict(`Den frysta rutten ${route.id} saknar auktoritativ resväg/depå/tidslinje.`);
  }
  const byId = new Map(stops.map(stop => [stop.id, stop]));
  const templates = new Map(mappedNodes.map(node => [node.id, node]));
  const chargingVisits = new Map<string, number[]>();
  let activeCharge: { stopId: string; index: number } | undefined;
  for (const event of route.workdayTimeline) {
    if (event.type === "charging" && event.stopId) {
      const visits = chargingVisits.get(event.stopId) ?? [];
      if (activeCharge?.stopId !== event.stopId) {
        visits.push(0);
        activeCharge = { stopId: event.stopId, index: visits.length - 1 };
      }
      visits[activeCharge.index] += event.durationMin;
      chargingVisits.set(event.stopId, visits);
    } else if (event.type !== "break") {
      // A break can split one visit. A new driving/service/wait activity
      // separates repeated visits, even when the station ID is reused.
      activeCharge = undefined;
    }
  }
  const usedChargingVisits = new Map<string, number>();
  const nodes = route.plannerItinerary.map(entry => {
    if (!entry.isChargingStop) {
      const stop = byId.get(entry.stopId);
      if (!stop) conflict(`Stoppet ${entry.stopId} saknas från den frysta rutten ${route.id}.`);
      return nodeForSavedStop(stop, route, templates.get(stop.id));
    }
    const station = CHARGING_STATIONS.find(node => node.id === entry.stopId);
    if (!station) conflict(`Den sparade laddstationen ${entry.stopId} är okänd.`);
    // A break can split a charging visit. Sum only charging activity, not break.
    const visitIndex = usedChargingVisits.get(entry.stopId) ?? 0;
    const chargingDurationMin = chargingVisits.get(entry.stopId)?.[visitIndex] ?? 0;
    usedChargingVisits.set(entry.stopId, visitIndex + 1);
    if (!(chargingDurationMin > 0)) conflict(`Laddtiden för ${entry.stopId} saknas.`);
    return { ...station, chargingDurationMin };
  });
  return { vehicleId: route.vehicleId, sourceRouteId: route.id, optimizationFrozen: true,
    lockedFirstStopId: route.lockedFirstStopId, frozenTimeline: route.workdayTimeline.map(event => ({ ...event })),
    nodes, totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0) };
}

/** Load canonical evidence once, prepare all real legs, and enrich all search paths. */
export async function loadCanonicalLockInputs(
  nodes: ALNSNode[], routingVehicles: ALNSVehicle[], depotLat: number, depotLon: number,
  date: Date, config: Partial<ALNSConfig> = {}, sourceRouteIds: string[] = [],
  provisionalStops: Stop[] = [],
): Promise<{ input: CanonicalLockContext; config: Partial<ALNSConfig> }> {
  const ids = nodes.filter(node => !node.isChargingStation).map(node => node.id);
  const selected = ids.length ? await db.select().from(stopsTable).where(inArray(stopsTable.id, ids)) : [];
  if (provisionalStops.some(stop => selected.some(saved => saved.id === stop.id) || !ids.includes(stop.id))) {
    conflict("Nya importstopp måste ha unika, ännu ej sparade identiteter.");
  }
  selected.push(...provisionalStops);
  if (selected.length !== new Set(ids).size) conflict("Optimeringsunderlaget innehåller okända eller dubbla uppdrag.");
  const orgs = new Set(selected.map(stop => stop.organizationId));
  const explicitRoutes = sourceRouteIds.length ? await db.select().from(routesTable).where(inArray(routesTable.id, sourceRouteIds)) : [];
  for (const route of explicitRoutes) orgs.add(route.organizationId);
  if (orgs.size !== 1) conflict("Optimeringsunderlaget måste tillhöra exakt en organisation.");
  const organizationId = [...orgs][0];
  const [organizationSnapshot] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
  if (!organizationSnapshot) conflict("Organisationens planeringsunderlag saknas.");
  const routeIds = [...new Set([...sourceRouteIds, ...selected.flatMap(stop => stop.routeId ? [stop.routeId] : [])])];
  const routes = routeIds.length ? await db.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), inArray(routesTable.id, routeIds),
  )) : [];
  if (routes.length !== routeIds.length) conflict("Ett kanoniskt ruttunderlag saknas.");
  const routeStops = routeIds.length ? await db.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, organizationId), inArray(stopsTable.routeId, routeIds), isNull(stopsTable.archivedAt),
  )) : [];
  const allStops = [...new Map([...routeStops, ...selected].map(stop => [stop.id, stop])).values()];
  // Match the existing fulfilled-first-stop rule in route-scoped recovery.
  // Keep raw rows separately for CAS; this does not clear a persistent pin.
  const searchRoutes = routes.map(route => !route.optimizationFrozen && route.lockedFirstStopId
    && allStops.some(stop => stop.id === route.lockedFirstStopId && ["completed", "failed", "skipped"].includes(stop.status))
    ? { ...route, lockedFirstStopId: null } : route);
  const vehicleIds = routingVehicles.map(vehicle => vehicle.id);
  const [vehicles, drivers] = await Promise.all([
    db.select().from(vehiclesTable).where(and(eq(vehiclesTable.organizationId, organizationId), inArray(vehiclesTable.id, vehicleIds))),
    db.select().from(driversTable).where(and(eq(driversTable.organizationId, organizationId),
      inArray(driversTable.vehicleId, vehicleIds), eq(driversTable.isActive, true))),
  ]);
  if (provisionalStops.length) {
    // Append planning must retain the route's explicit optimization recipient,
    // not the first of several active drivers linked to the vehicle.
    const selectedDrivers = new Set(routingVehicles.map(vehicle => vehicle.driverId));
    for (let index = drivers.length - 1; index >= 0; index--) {
      if (!selectedDrivers.has(drivers[index].id)) drivers.splice(index, 1);
    }
    if (drivers.length !== routingVehicles.length) conflict("Ruttens valda chaufför saknas.");
  }
  if (vehicles.length !== vehicleIds.length) conflict("Ett valt fordon saknas i organisationen.");
  const preferences = drivers.length ? await db.select().from(driverPreferencesTable)
    .where(inArray(driverPreferencesTable.driverId, drivers.map(driver => driver.id))) : [];
  const certifications = drivers.length ? await db.select().from(driverCertificationsTable).where(and(
    eq(driverCertificationsTable.organizationId, organizationId),
    inArray(driverCertificationsTable.driverId, drivers.map(driver => driver.id)),
  )) : [];
  const constraints = drivers.flatMap(driver => {
    if (!driver.vehicleId) return [];
    const preference = preferences.find(item => item.driverId === driver.id);
    return [{
      vehicleId: driver.vehicleId, driverName: driver.name,
      preferredStartTime: driver.workStartTime ?? preference?.preferredStartTime ?? "07:00:00",
      preferredEndTime: driver.workEndTime ?? preference?.preferredEndTime ?? "16:00:00",
      maxDrivingHoursPerDay: preference?.maxDrivingHoursPerDay ?? 8,
      avoidNightDriving: preference?.avoidNightDriving ?? false,
      breakFrequencyMinutes: preference?.breakFrequencyMinutes ?? 120,
      preferredBreakDurationMin: preference?.preferredBreakDurationMin ?? 15,
      breakStartTime: driver.breakStartTime, breakEndTime: driver.breakEndTime,
    }];
  });
  for (const supplied of config.driverConstraints ?? []) {
    const canonical = constraints.find(item => item.vehicleId === supplied.vehicleId);
    if (canonical) Object.assign(supplied, canonical);
  }
  const mapped = routingVehicles.map(vehicle => {
    const driver = drivers.find(item => item.vehicleId === vehicle.id);
    const canonical = vehicles.find(item => item.id === vehicle.id)!;
    const currentRange = canonical.vehicleType === "electric" && canonical.rangeKm != null
      ? canonical.rangeKm * Math.max(0, Math.min(100, canonical.currentBatteryPercent ?? 100)) / 100
      : canonical.rangeKm;
    const base = { ...vehicle, vehicleType: canonical.vehicleType, capacityKg: canonical.capacityKg,
      capacityVolume: canonical.capacityVolume, rangeKm: currentRange == null ? vehicle.rangeKm
        : vehicle.rangeKm == null ? currentRange : Math.min(currentRange, vehicle.rangeKm) };
    const result = { ...(driver ? applyDriverRoutingProfile(base, driver) : base),
      ...effectivePlanningPolicy(organizationSnapshot, vehicle),
      canonicalDriverConstraints: constraints.find(item => item.vehicleId === vehicle.id) };
    result.driverId = driver?.id ?? null;
    const saved = routes.find(route => route.vehicleId === vehicle.id && (route.optimizationFrozen
      || allStops.some(stop => stop.routeId === route.id && (stop.lockedVehicleId || stop.lockedServiceStartAt))
      || route.lockedFirstStopId));
    if (saved) {
      if (!saved.depotSnapshot) conflict(`Den frysta rutten ${saved.id} saknar depåunderlag.`);
      result.startLatitude = saved.depotSnapshot.start.latitude;
      result.startLongitude = saved.depotSnapshot.start.longitude;
      result.endLatitude = saved.depotSnapshot.end.latitude;
      result.endLongitude = saved.depotSnapshot.end.longitude;
      if (saved.optimizationFrozen) {
        const planning = saved.optimizationPlanningSnapshot as { travelReservePercent?: number } | null;
        result.travelReservePercent = planning?.travelReservePercent;
      }
    }
    return result;
  });
  const frozen = routes.filter(route => route.optimizationFrozen)
    .map(route => canonicalFrozenItinerary(route, allStops.filter(stop => stop.routeId === route.id), nodes));
  const frozenNodes = new Map(frozen.flatMap(route => route.nodes.filter(node => !node.isChargingStation)).map(node => [node.id, node]));
  const stopById = new Map(allStops.map(stop => [stop.id, stop]));
  const enrichedNodes = nodes.map(node => frozenNodes.get(node.id)
    ?? (node.isChargingStation ? node : nodeWithCanonicalFacts(node, stopById.get(node.id)!)));
  for (const [id, node] of frozenNodes) if (!enrichedNodes.some(item => item.id === id)) enrichedNodes.push(node);
  // Eligibility must include added frozen jobs and cannot be waived by a lock.
  for (const vehicle of mapped) {
    vehicle.ineligibleStopIds = new Set(vehicle.ineligibleStopIds ?? []);
    for (const node of enrichedNodes.filter(item => item.jobType === "field_service")) {
      const driver = drivers.find(item => item.vehicleId === vehicle.id);
      if (!driver || !(await checkFieldServiceEligibility(driver.id, vehicle.id, {
        requiredSkills: node.requiredSkills ?? [], requiredCertifications: node.requiredCertifications ?? [],
        requiredEquipment: node.requiredEquipment ?? [],
      }, date)).eligible) vehicle.ineligibleStopIds.add(node.id);
      else vehicle.ineligibleStopIds.delete(node.id);
    }
  }
  const input: CanonicalLockContext = { organizationId, stops: allStops, routes: searchRoutes, vehicles, drivers,
    nodes: enrichedNodes, routingVehicles: mapped, currentRoutes: frozen, organizationSnapshot, preferences, certifications, routeSnapshots: routes };
  const effective = enrichPlanningLockInputs(input);
  input.nodes = effective.nodes;
  input.routingVehicles = effective.vehicles;
  input.currentRoutes = effective.currentRoutes;
  // Copy canonical driver IDs/lock constraints back into caller-owned mapped
  // inputs: post-search repair and persistence must use the same constraints.
  for (const vehicle of routingVehicles) Object.assign(vehicle, effective.vehicles.find(item => item.id === vehicle.id));
  for (const node of nodes) Object.assign(node, effective.nodes.find(item => item.id === node.id));
  await preparePersistedRouteRoadData(organizationId, { routeIds, stopIds: allStops.map(stop => stop.id), vehicleIds,
    coordinates: [{ lat: depotLat, lon: depotLon }, ...mapped.flatMap(vehicle => [
      { lat: vehicle.startLatitude ?? depotLat, lon: vehicle.startLongitude ?? depotLon },
      { lat: vehicle.endLatitude ?? depotLat, lon: vehicle.endLongitude ?? depotLon },
    ])] });
  return { input, config: { ...config, driverConstraints: constraints } };
}

export const optimizeWithCanonicalPlanningLocks: typeof engineOptimize = async (nodes, vehicles, lat, lon, date, config = {}, progress) => {
  if (!nodes.length) return engineOptimize(nodes, vehicles, lat, lon, date, config, progress);
  const loaded = await loadCanonicalLockInputs(nodes, vehicles, lat, lon, date, config);
  const result = await optimizeWithPlanningLocks(loaded.input, engineOptimize, lat, lon, date, loaded.config, progress);
  contexts.set(result, loaded.input);
  return result;
};

/** Internal preview-only path: never persists provisional stop rows. */
export async function optimizeWithCanonicalAppendPlanningLocks(
  provisionalStops: Stop[],
  ...args: Parameters<typeof engineOptimize>
): ReturnType<typeof engineOptimize> {
  const [nodes, vehicles, lat, lon, date, config = {}, progress] = args;
  const loaded = await loadCanonicalLockInputs(nodes, vehicles, lat, lon, date, config, [], provisionalStops);
  return optimizeWithPlanningLocks(loaded.input, engineOptimize, lat, lon, date, loaded.config, progress);
}

export const reoptimizeWithCanonicalPlanningLocks: typeof engineReoptimize = async (current, affectedIds, vehicles, lat, lon, date, config = {}) => {
  const affected = current.filter(route => affectedIds.includes(route.vehicleId));
  const stable = current.filter(route => !affectedIds.includes(route.vehicleId));
  const nodes = affected.flatMap(route => route.nodes.filter(node => !node.isChargingStation));
  if (!nodes.length) return engineReoptimize(current, affectedIds, vehicles, lat, lon, date, config);
  const loaded = await loadCanonicalLockInputs(nodes, vehicles.filter(vehicle => affectedIds.includes(vehicle.id)),
    lat, lon, date, config, affected.flatMap(route => route.sourceRouteId ? [route.sourceRouteId] : []));
  const result = await optimizeWithPlanningLocks(loaded.input, engineOptimize, lat, lon, date, loaded.config);
  result.routes.push(...stable);
  contexts.set(result, loaded.input);
  return result;
};

/** Final CAS evidence for full-plan persistence; existing guards remain in place. */
export async function lockCanonicalOptimizationContext(tx: Tx, result: object): Promise<CanonicalLockContext | undefined> {
  const context = contexts.get(result);
  if (!context) return undefined;
  for (const original of [...(context.routeSnapshots ?? context.routes)].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + original.id}))`);
    const [current] = await tx.select().from(routesTable).where(and(
      eq(routesTable.organizationId, context.organizationId), eq(routesTable.id, original.id),
    )).for("update");
    if (!current || current.planRevision !== original.planRevision
      || JSON.stringify(current) !== JSON.stringify(original)) conflict("Rutten ändrades under låsmedveten optimering. Ladda om.");
  }
  for (const [table, rows] of [[vehiclesTable, context.vehicles], [driversTable, context.drivers ?? []]] as const) {
    for (const original of rows) {
      const [current] = await tx.select().from(table).where(and(
        eq(table.organizationId, context.organizationId), eq(table.id, original.id),
      )).for("update");
      if (JSON.stringify(current) !== JSON.stringify(original)) conflict("Resursunderlaget ändrades under optimeringen. Ladda om.");
    }
  }
  for (const original of [...context.stops].sort((a, b) => a.id.localeCompare(b.id))) {
    const [current] = await tx.select().from(stopsTable).where(and(
      eq(stopsTable.organizationId, context.organizationId), eq(stopsTable.id, original.id),
    )).for("update");
    if (JSON.stringify(current) !== JSON.stringify(original)) conflict("Uppdragsunderlaget ändrades under optimeringen. Ladda om.");
  }
  if (context.organizationSnapshot) {
    const [current] = await tx.select().from(organizationsTable)
      .where(eq(organizationsTable.id, context.organizationId)).for("update");
    if (JSON.stringify(current) !== JSON.stringify(context.organizationSnapshot)) {
      conflict("Organisationens planeringsregler ändrades under optimeringen. Ladda om.");
    }
  }
  if (context.drivers?.length) {
    const current = await tx.select().from(driverPreferencesTable).where(
      inArray(driverPreferencesTable.driverId, context.drivers.map(driver => driver.id)),
    ).orderBy(driverPreferencesTable.id).for("update");
    const stable = (rows: typeof current) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(stable(current)) !== JSON.stringify(stable(context.preferences ?? []))) {
      conflict("Chaufförens arbetstidsregler ändrades under optimeringen. Ladda om.");
    }
    const certifications = await tx.select().from(driverCertificationsTable).where(and(
      eq(driverCertificationsTable.organizationId, context.organizationId),
      inArray(driverCertificationsTable.driverId, context.drivers.map(driver => driver.id)),
    )).orderBy(driverCertificationsTable.id).for("update");
    const stableCertifications = (rows: typeof certifications) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(stableCertifications(certifications)) !== JSON.stringify(stableCertifications(context.certifications ?? []))) {
      conflict("Chaufförens behörighetsunderlag ändrades under optimeringen. Ladda om.");
    }
  }
  return context;
}

export function assertCanonicalRouteResult(context: CanonicalLockContext, route: Route, proposed: Stop[], events: Parameters<typeof assertPlanningLockTimes>[2]) {
  assertPlanningLockOrder(route, context.stops.filter(stop => stop.routeId === route.id), proposed);
  assertPlanningLockTimes(route, proposed, events);
}
