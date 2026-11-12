import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  db, routesTable, stopsTable, vehiclesTable, driversTable, organizationsTable, auditLogTable,
  type Route, type Stop, type Vehicle, type Driver,
} from "@workspace/db";
import {
  applyRouteScopedReoptimization, previewRouteScopedReoptimization, toAlnsNode,
  normalizePlanningInputs, verifiedDepotSnapshot, routingConstraintsForDriver, itineraryForNodes,
  optimizationEvidenceForConfig,
  reoptimizeImportRoutePlanServiceTime,
} from "./import-route-workflow";
import {
  canonicalFrozenItinerary, loadCanonicalLockInputs, optimizeWithCanonicalPlanningLocks,
  reoptimizeWithCanonicalPlanningLocks,
} from "./planner-lock-canonical-optimizer";
import { setRoutePlanningLocks } from "./planning-lock-service";
import { plannedServiceStartForStop, evaluateRouteWorkday } from "./route-workday";
import { persistOptimizationResult } from "../routes/optimize";
import { ContinuousOptimizer } from "./continuous-optimizer";
import { DEFAULT_WEIGHTS, CHARGING_STATIONS, type ALNSVehicle } from "./alns/types";

// Integration through real exported API persistence / acquisition / workflow /
// optimizer functions. Only the DB boundary is in-memory; no DB, production,
// browser, Geoapify, external matrix or app-server mutations are made.
function row(table: any, values: Record<string, unknown>): any {
  const initial: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(table)) as Array<[string, any]>) {
    const value = column.default;
    initial[key] = value == null || typeof value === "object" ? null : value;
    if (column.dataType === "date" && column.notNull) initial[key] = new Date("2026-01-01T00:00:00Z");
  }
  return { ...initial, ...values };
}

function fixture(pickup = false) {
  const organizationId = randomUUID(), routeId = randomUUID(), vehicleId = randomUUID(), driverId = randomUUID(), stopId = randomUUID();
  const station = CHARGING_STATIONS[0], date = new Date("2026-10-19T00:00:00Z");
  const organization = row(organizationsTable, {
    id: organizationId, name: "Synthetic lock integration", email: "locks@example.test",
    depotStartLatitude: station.latitude, depotStartLongitude: station.longitude,
    depotEndLatitude: station.latitude, depotEndLongitude: station.longitude,
    depotStartVerifiedAt: date, depotEndVerifiedAt: date,
    maxDriverOvertimeMin: 0, allowLateStopsMin: 0,
  });
  const vehicle = row(vehiclesTable, {
    id: vehicleId, organizationId, name: "Synthetic vehicle", vehicleType: "fossil",
    licensePlate: "SYNTHETIC", isActive: true, capacityKg: 1000, capacityVolume: 10, rangeKm: null,
  }) as Vehicle;
  const driver = row(driversTable, {
    id: driverId, organizationId, name: "Synthetic driver", vehicleId, isActive: true,
    workStartTime: "08:00:00", workEndTime: "17:00:00",
  }) as Driver;
  const stop = row(stopsTable, {
    id: stopId, organizationId, routeId, address: "Synthetic address", status: "pending",
    latitude: station.latitude, longitude: station.longitude, sequenceOrder: 1,
    serviceDurationMin: 10, weightKg: 1, volumeM3: 1, planningDate: date,
    lockedVehicleId: null, lockedDriverId: null, lockedServiceStartAt: null,
    ...(pickup ? { pickupAddress: "Synthetic pickup", pickupLatitude: station.latitude, pickupLongitude: station.longitude,
      jobType: "pickup_delivery" } : { jobType: "delivery" }),
  }) as Stop;
  const planning = normalizePlanningInputs(null);
  const routingVehicle: ALNSVehicle = { id: vehicleId, driverId, vehicleType: "fossil", capacityKg: 1000, capacityVolume: 10,
    rangeKm: null, startLatitude: station.latitude, startLongitude: station.longitude,
    endLatitude: station.latitude, endLongitude: station.longitude };
  const constraints = routingConstraintsForDriver(driver);
  const nodes = [toAlnsNode(stop, planning)];
  const workday = evaluateRouteWorkday(nodes, routingVehicle, station.latitude, station.longitude, date, constraints);
  const route = row(routesTable, {
    id: routeId, organizationId, vehicleId, name: "Synthetic route", planId: randomUUID(), status: "optimized",
    date, totalStops: 1, planRevision: 0, optimizationFrozen: false, frozenDriverId: null,
    depotSnapshot: verifiedDepotSnapshot(organization), optimizationPlanningSnapshot: planning,
    plannerItinerary: itineraryForNodes(nodes, routingVehicle, driver, station.latitude, station.longitude, date),
    workdayTimeline: workday.events, workdaySummary: workday.summary,
    totalDistanceKm: 0, totalDurationMin: workday.summary.totalMin, co2EmissionsKg: 0,
  }) as Route;
  stop.planningPlanId = route.planId;
  return { organizationId, routeId, vehicleId, driverId, stopId, organization, vehicle, driver, stop, route,
    planning, routingVehicle, constraints, date, lat: station.latitude, lon: station.longitude };
}

/** Drizzle boundary double. Domain code, query selection, route computation,
 * enrichment, persistence guards and transaction callbacks are not replaced. */
function memoryDatabase(t: TestContext, state: ReturnType<typeof fixture>) {
  let tables = new Map<string, any[]>([
    [getTableName(organizationsTable), [structuredClone(state.organization)]],
    [getTableName(vehiclesTable), [structuredClone(state.vehicle)]],
    [getTableName(driversTable), [structuredClone(state.driver)]],
    [getTableName(stopsTable), [structuredClone(state.stop)]],
    [getTableName(routesTable), [structuredClone(state.route)]],
  ]);
  const writes: string[] = [];
  let beforeTransaction: (() => void) | undefined;
  const records = (table: any) => tables.get(getTableName(table)) ?? [];
  function query(table: any, projection?: Record<string, any>, operation?: () => void): any {
    let executed = false;
    let selected = projection;
    const result = () => {
      if (!executed) { operation?.(); executed = true; }
      const rows = records(table);
      if (!selected) return structuredClone(rows);
      const columns = getTableColumns(table);
      return rows.map(item => Object.fromEntries(Object.entries(selected!).map(([key, column]) => {
        if (column === table) return [key, structuredClone(item)];
        const property = Object.entries(columns).find(([, candidate]) => candidate === column)?.[0];
        return [key, property ? structuredClone(item[property]) : undefined];
      })));
    };
    const chain = {
      where: () => chain, for: () => chain, orderBy: () => chain, limit: () => chain, innerJoin: () => chain,
      returning: (value?: Record<string, any>) => { selected = value; return chain; },
      then: (resolve: (value: any) => void, reject: (error: unknown) => void) => Promise.resolve().then(result).then(resolve, reject),
    };
    return chain;
  }
  t.mock.method(db, "select", ((projection?: Record<string, any>) => ({
    from: (table: any) => query(table, projection),
  })) as never);
  t.mock.method(db, "update", ((table: any) => ({
    set: (values: Record<string, any>) => query(table, undefined, () => {
      writes.push(`update:${getTableName(table)}`);
      for (const current of records(table)) {
        for (const [key, value] of Object.entries(values)) {
          current[key] = key === "planRevision" && typeof value === "object" && !(value instanceof Date)
            ? current.planRevision + 1 : structuredClone(value);
        }
      }
    }),
  })) as never);
  t.mock.method(db, "insert", ((table: any) => ({
    values: (values: any) => query(table, undefined, () => {
      writes.push(`insert:${getTableName(table)}`);
      tables.set(getTableName(table), [...records(table), ...structuredClone(Array.isArray(values) ? values : [values])]);
    }),
  })) as never);
  t.mock.method(db, "delete", ((table: any) => query(table, undefined, () => {
    writes.push(`delete:${getTableName(table)}`); tables.set(getTableName(table), []);
  })) as never);
  t.mock.method(db, "execute", (async () => []) as never);
  t.mock.method(db, "transaction", (async (operation: (tx: typeof db) => Promise<unknown>) => {
    beforeTransaction?.();
    beforeTransaction = undefined;
    const before = structuredClone(tables), writeCount = writes.length;
    try { return await operation(db); }
    catch (error) { tables = before; writes.length = writeCount; throw error; }
  }) as never);
  // All physical legs share one coordinate. Any network call is a test failure.
  t.mock.method(globalThis, "fetch", (async () => { throw new Error("Unexpected external request in zero-distance lock integration"); }) as never);
  return { records, writes, beforeTransaction: (hook: () => void) => { beforeTransaction = hook; } };
}

async function persist(state: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof optimizeWithCanonicalPlanningLocks>>) {
  return persistOptimizationResult(result, [state.vehicle], [state.driver], [state.stop], [state.routingVehicle],
    state.organizationId, state.lat, state.lon, DEFAULT_WEIGHTS, [state.constraints], state.planning,
    optimizationEvidenceForConfig({ source: "planningInputs", planningInputs: state.planning, effectiveWeights: DEFAULT_WEIGHTS }),
    state.date, state.date.toISOString().slice(0, 10));
}

test("actual acquisition service evaluates a new requested minute and atomically saves pickup-start plus full delivery", async t => {
  const state = fixture(true), memory = memoryDatabase(t, state);
  const originalStart = plannedServiceStartForStop(state.route.workdayTimeline, state.stopId)!;
  const requested = new Date(new Date(originalStart).getTime() + 30 * 60_000);
  const saved = await setRoutePlanningLocks(state.organizationId, state.routeId, {
    planRevision: 0, stopId: state.stopId, serviceStartAt: requested,
  });
  assert.equal(saved?.planRevision, 1);
  assert.equal(plannedServiceStartForStop(saved?.workdayTimeline, state.stopId), requested.toISOString());
  const services = saved!.workdayTimeline!.filter(event => event.type === "service");
  assert.equal(services.length, 2);
  assert.equal(services[1].startAt, new Date(requested.getTime() + 10 * 60_000).toISOString());
  const finalArrival = new Date(saved!.plannerItinerary!.find(entry => entry.stopId === state.stopId)!.estimatedArrival);
  assert.equal(finalArrival.toISOString(), services[1].startAt);
  assert.notEqual(finalArrival.getTime(), requested.getTime());
  assert.equal(saved!.workdaySummary!.serviceMin, 20);
  assert.equal(saved!.workdaySummary!.waitingMin, 30);
  assert.equal(memory.records(stopsTable)[0].lockedServiceStartAt.toISOString(), requested.toISOString());
  assert.equal(memory.records(auditLogTable).length, 1);
});

test("late, fractional, replacement and frozen requested times reject without partial writes", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const start = new Date(plannedServiceStartForStop(state.route.workdayTimeline, state.stopId)!);
  await assert.rejects(setRoutePlanningLocks(state.organizationId, state.routeId,
    { planRevision: 0, stopId: state.stopId, serviceStartAt: new Date(start.getTime() - 60_000) }), { statusCode: 409 });
  assert.equal(memory.writes.length, 0);
  await assert.rejects(setRoutePlanningLocks(state.organizationId, state.routeId,
    { planRevision: 0, stopId: state.stopId, serviceStartAt: new Date(start.getTime() + 1) }));
  memory.records(stopsTable)[0].lockedServiceStartAt = start;
  await assert.rejects(setRoutePlanningLocks(state.organizationId, state.routeId,
    { planRevision: 0, stopId: state.stopId, serviceStartAt: new Date(start.getTime() + 60_000) }));
  memory.records(stopsTable)[0].lockedServiceStartAt = null;
  memory.records(routesTable)[0].optimizationFrozen = true;
  await assert.rejects(setRoutePlanningLocks(state.organizationId, state.routeId,
    { planRevision: 0, stopId: state.stopId, serviceStartAt: new Date(start.getTime() + 60_000) }));
  assert.equal(memory.writes.length, 0);
  assert.equal(memory.records(routesTable)[0].planRevision, 0);
});

test("full/background shared optimization and real API writer retain mutable locked route identity", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const start = new Date(plannedServiceStartForStop(state.route.workdayTimeline, state.stopId)!);
  const stop = memory.records(stopsTable)[0];
  stop.lockedVehicleId = state.vehicleId; stop.lockedDriverId = state.driverId; stop.lockedServiceStartAt = start;
  Object.assign(state.stop, stop);
  const result = await optimizeWithCanonicalPlanningLocks([toAlnsNode(state.stop, state.planning)],
    [state.routingVehicle], state.lat, state.lon, state.date, { maxIterations: 0, timeLimitMs: 20, localSearchTimeLimitMs: 0 });
  assert.equal(result.routes.find(route => route.nodes.length)?.sourceRouteId, state.routeId);
  await persist(state, result);
  assert.equal(memory.records(routesTable).length, 1, "must not insert replacement route");
  assert.equal(memory.records(stopsTable)[0].routeId, state.routeId);
  assert.equal(memory.records(stopsTable)[0].planningPlanId, state.route.planId);
  assert.equal(memory.records(routesTable)[0].planRevision, 1);
  assert.equal(plannedServiceStartForStop(memory.records(routesTable)[0].workdayTimeline, state.stopId), start.toISOString());
});

test("frozen full and affected-route paths preserve complete canonical snapshots with no planning writes", async t => {
  const state = fixture(true), memory = memoryDatabase(t, state);
  const route = memory.records(routesTable)[0];
  route.optimizationFrozen = true; route.frozenDriverId = state.driverId;
  const before = JSON.stringify(route), beforeStop = JSON.stringify(memory.records(stopsTable)[0]);
  const result = await optimizeWithCanonicalPlanningLocks([toAlnsNode(state.stop, state.planning)],
    [state.routingVehicle], state.lat, state.lon, state.date, { maxIterations: 0, timeLimitMs: 20, localSearchTimeLimitMs: 0 });
  await persist(state, result);
  assert.equal(JSON.stringify(memory.records(routesTable)[0]), before);
  assert.equal(JSON.stringify(memory.records(stopsTable)[0]), beforeStop);
  const reoptimized = await reoptimizeWithCanonicalPlanningLocks([{
    vehicleId: state.vehicleId, sourceRouteId: state.routeId, nodes: [toAlnsNode(state.stop, state.planning)],
    totalWeight: 1, totalVolume: 1,
  }], [state.vehicleId], [state.routingVehicle], state.lat, state.lon, state.date);
  assert.equal(reoptimized.routes[0].optimizationFrozen, true);
  assert.equal(reoptimized.routes[0].sourceRouteId, state.routeId);
  assert.equal(memory.writes.length, 0);
});

test("real route-scoped preview/apply keeps frozen revision, membership and clock untouched", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const route = memory.records(routesTable)[0];
  route.optimizationFrozen = true; route.frozenDriverId = state.driverId;
  const before = JSON.stringify(route);
  const preview = await previewRouteScopedReoptimization(state.organizationId, state.routeId, {
    planRevision: 0, depotLatitude: state.lat, depotLongitude: state.lon,
  });
  const saved = await applyRouteScopedReoptimization(state.organizationId, state.routeId, {
    planRevision: 0, depotLatitude: state.lat, depotLongitude: state.lon, optimizedStopIds: preview.optimizedStopIds,
  });
  assert.equal(saved.planRevision, 0);
  assert.equal(JSON.stringify(memory.records(routesTable)[0]), before);
  assert.equal(memory.writes.length, 0);
});

test("continuous initialization excludes frozen jobs and disruptions cannot remove them", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  memory.records(routesTable)[0].optimizationFrozen = true;
  memory.records(routesTable)[0].frozenDriverId = state.driverId;
  const loaded = await loadCanonicalLockInputs([toAlnsNode(state.stop, state.planning)],
    [state.routingVehicle], state.lat, state.lon, state.date);
  const optimizer = new ContinuousOptimizer(state.organizationId, [...loaded.input.nodes], [...loaded.input.routingVehicles],
    state.lat, state.lon, { planningLockInputs: loaded.input, planningDate: state.date,
      driverConstraints: loaded.config.driverConstraints, microIterationMs: 1 });
  await optimizer.start();
  assert.equal(optimizer.getSolution()?.routes[0].sourceRouteId, state.routeId);
  await assert.rejects(optimizer.injectDisruption([], [state.stopId]));
  assert.equal(optimizer.getSolution()?.routes[0].nodes[0].id, state.stopId);
  assert.equal(memory.writes.length, 0);
});

test("canonical frozen mapper retains repeated charger visits and their distinct durations", () => {
  const state = fixture(true);
  const station = CHARGING_STATIONS[0];
  const nodes = [{ ...station, chargingDurationMin: 11 }, toAlnsNode(state.stop, state.planning),
    { ...station, chargingDurationMin: 17 }];
  const events = evaluateRouteWorkday(nodes, state.routingVehicle, state.lat, state.lon, state.date, state.constraints).events;
  const route = { ...state.route, workdayTimeline: events,
    plannerItinerary: itineraryForNodes(nodes, state.routingVehicle, state.driver, state.lat, state.lon, state.date) };
  const mapped = canonicalFrozenItinerary(route, [state.stop], [toAlnsNode(state.stop, state.planning)]);
  assert.deepEqual(mapped.nodes.filter(node => node.isChargingStation).map(node => node.chargingDurationMin), [11, 17]);
  assert.equal(mapped.nodes[1].pickupLat, state.lat);
});

test("acquisition rechecks snapshot/CAS after evaluation and cannot partially save a stale request", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const requested = new Date(new Date(plannedServiceStartForStop(state.route.workdayTimeline, state.stopId)!).getTime() + 30 * 60_000);
  const originalClock = JSON.stringify(memory.records(routesTable)[0].workdayTimeline);
  memory.beforeTransaction(() => { memory.records(routesTable)[0].planRevision = 1; });
  await assert.rejects(setRoutePlanningLocks(state.organizationId, state.routeId, {
    planRevision: 0, stopId: state.stopId, serviceStartAt: requested,
  }));
  assert.equal(memory.records(routesTable)[0].planRevision, 1);
  assert.equal(JSON.stringify(memory.records(routesTable)[0].workdayTimeline), originalClock);
  assert.equal(memory.records(stopsTable)[0].lockedServiceStartAt, null);
  assert.equal(memory.writes.length, 0);
});

test("full API persistence rejects new resource facts after lock-aware search", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const stop = memory.records(stopsTable)[0];
  stop.lockedVehicleId = state.vehicleId; stop.lockedDriverId = state.driverId;
  Object.assign(state.stop, stop);
  const result = await optimizeWithCanonicalPlanningLocks([toAlnsNode(state.stop, state.planning)],
    [state.routingVehicle], state.lat, state.lon, state.date, { maxIterations: 0, timeLimitMs: 20, localSearchTimeLimitMs: 0 });
  memory.records(driversTable)[0].workStartTime = "09:00:00";
  await assert.rejects(persist(state, result));
  assert.equal(memory.writes.length, 0);
  assert.equal(memory.records(routesTable)[0].planRevision, 0);
});

test("whole-plan executable preview/apply retains frozen routes without revision or snapshot writes", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const route = memory.records(routesTable)[0];
  route.optimizationFrozen = true; route.frozenDriverId = state.driverId;
  const before = JSON.stringify(route);
  const input = { serviceDurationMin: 10, serviceTimeStrategy: "preserve_exact" as const,
    routes: [{ routeId: state.routeId, driverId: state.driverId, planRevision: 0 }],
    depotLatitude: state.lat, depotLongitude: state.lon, wholePlanOnly: true };
  const preview = await reoptimizeImportRoutePlanServiceTime(state.organizationId, state.route.planId, {
    ...input, previewOnly: true,
  });
  assert.equal(preview.routes[0].planRevision, 0);
  assert.ok(preview.proposalResult);
  const applied = await reoptimizeImportRoutePlanServiceTime(state.organizationId, state.route.planId, {
    ...input, cachedProposalResult: preview.proposalResult, expectedProposalHash: preview.proposalHash,
  });
  assert.equal(applied.routes[0].planRevision, 0);
  assert.equal(JSON.stringify(memory.records(routesTable)[0]), before);
  assert.equal(memory.writes.length, 0);
});

test("full optimizer retains the legacy first-customer pin and original mutable route identity", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  memory.records(routesTable)[0].lockedFirstStopId = state.stopId;
  const result = await optimizeWithCanonicalPlanningLocks([toAlnsNode(state.stop, state.planning)],
    [state.routingVehicle], state.lat, state.lon, state.date, { maxIterations: 0, timeLimitMs: 20, localSearchTimeLimitMs: 0 });
  assert.equal(result.routes[0].sourceRouteId, state.routeId);
  assert.equal(result.routes[0].nodes.find(node => !node.isChargingStation)?.id, state.stopId);
  await persist(state, result);
  assert.equal(memory.records(routesTable).length, 1);
  assert.equal(memory.records(routesTable)[0].lockedFirstStopId, state.stopId);
});

test("canonical frozen evaluation rejects new hard shift facts rather than replaying stale feasibility", async t => {
  const state = fixture(), memory = memoryDatabase(t, state);
  const route = memory.records(routesTable)[0];
  route.optimizationFrozen = true; route.frozenDriverId = state.driverId;
  memory.records(driversTable)[0].workStartTime = "09:00:00";
  await assert.rejects(optimizeWithCanonicalPlanningLocks([toAlnsNode(state.stop, state.planning)],
    [state.routingVehicle], state.lat, state.lon, state.date, { maxIterations: 0, timeLimitMs: 20 }));
  assert.equal(memory.writes.length, 0);
});
