import assert from "node:assert/strict";
import test from "node:test";
import type { Driver, Route, Stop, Vehicle } from "@workspace/db";
import { evaluateRouteWorkday } from "./route-workday";
import { evaluateRoute } from "./alns/cost";
import { compareUnassignedCoverage } from "./alns/fleet-coverage";
import { buildInitialSolutionFromCWAsync, runALNS } from "./alns/runner";
import { assertLockedJobsRetained, OptimizerPlanningLockConflict } from "./alns/planning-locks";
import type { ALNSDriverConstraints, ALNSNode, ALNSRoute, ALNSVehicle } from "./alns/types";
import { DEFAULT_WEIGHTS, deepCloneSolution } from "./alns/types";
import { enrichPlanningLockInputs, optimizeWithPlanningLocks, type LockAwareOptimizer, type PlanningLockInputs } from "./planner-lock-aware-optimizer";

// Every coordinate is identical: exact zero-length legs, no matrices/providers,
// random seeds, wall-clock-sensitive travel estimates, DB connections or I/O.
const date = new Date("2026-02-02T08:00:00.000Z");
const at = (clock: string) => new Date(`2026-02-02T${clock}:00.000Z`);
const vehicle: ALNSVehicle = { id: "v", driverId: "d", vehicleType: "fossil", capacityKg: 100, capacityVolume: 10, rangeKm: null };
const node = (id = "s"): ALNSNode => ({
  id, latitude: 59, longitude: 18, serviceDurationMin: 10, weightKg: 1, volumeM3: 1,
  timeWindowStart: null, timeWindowEnd: null,
});
const routingRoute = (nodes: ALNSNode[]): ALNSRoute => ({
  vehicleId: "v", nodes, totalWeight: nodes.reduce((sum, item) => sum + item.weightKg, 0),
  totalVolume: nodes.reduce((sum, item) => sum + item.volumeM3, 0),
});
const workday = (nodes: ALNSNode[], overrides: Partial<ALNSVehicle> = {}, constraints?: ALNSDriverConstraints) =>
  evaluateRouteWorkday(nodes, { ...vehicle, ...overrides }, 59, 18, date, constraints);

function input(frozen = false): PlanningLockInputs {
  const job = { ...node(), lockedVehicleId: "v", lockedDriverId: "d", lockedServiceStartAt: at("09:00") };
  const timeline = workday([job]).events;
  return {
    stops: [{
      id: "s", organizationId: "org", routeId: "r", sequenceOrder: 1,
      lockedVehicleId: "v", lockedDriverId: "d", lockedServiceStartAt: at("09:00"),
    } as Stop],
    routes: [{
      id: "r", organizationId: "org", vehicleId: "v", lockedFirstStopId: null,
      optimizationFrozen: frozen, frozenDriverId: frozen ? "d" : null,
      plannerItinerary: [{ stopId: "s", sequenceOrder: 1, estimatedArrival: date.toISOString(), distanceFromPreviousKm: 0 }],
      workdayTimeline: timeline,
    } as Route],
    vehicles: [{ id: "v", organizationId: "org", isActive: true, vehicleType: "fossil",
      capacityKg: 100, capacityVolume: 10, rangeKm: null } as Vehicle],
    drivers: [{ id: "d", organizationId: "org", vehicleId: "v", isActive: true } as Driver],
    nodes: [node()], routingVehicles: [{ ...vehicle, driverId: undefined }],
    currentRoutes: [routingRoute([node()])],
  };
}

test("exact lock waits without changing requested minute, raw duration or post-service reserve", () => {
  const job = { ...node(), lockedServiceStartAt: at("09:00"), stopReserveMin: 4 };
  const result = workday([job]);
  assert.equal(result.feasible, true);
  assert.equal(result.summary.waitingMin, 60);
  assert.equal(result.summary.serviceMin, 10);
  assert.equal(result.summary.stopReserveMin, 4);
  assert.equal(result.events.find(event => event.type === "service")?.startAt, at("09:00").toISOString());
  assert.equal(job.lockedServiceStartAt.getTime(), at("09:00").getTime());
  assert.equal(result.endTime.getTime(), at("09:14").getTime());
});

test("one millisecond late and fractional-minute requests remain hard despite late-stop allowance", () => {
  const late = { ...node(), serviceDurationMin: 0.000016666666666666667 };
  const result = workday([late, { ...node("locked"), lockedServiceStartAt: date }], { allowLateStopsMin: 120 });
  assert.equal(result.feasible, false);
  assert.equal(result.reasonCode, "PLANNING_LOCK");
  assert.equal(workday([{ ...node(), lockedServiceStartAt: new Date(date.getTime() + 1) }]).reasonCode, "PLANNING_LOCK");
});

test("resource pair checks both vehicle and linked driver", () => {
  const job = { ...node(), lockedVehicleId: "v", lockedDriverId: "d" };
  assert.equal(workday([job]).feasible, true);
  assert.equal(workday([job], { driverId: "other" }).reasonCode, "PLANNING_LOCK");
  assert.equal(workday([job], { id: "other" }).reasonCode, "PLANNING_LOCK");
  assert.equal(evaluateRoute(routingRoute([job]), { ...vehicle, driverId: undefined }, 59, 18, date).feasible, false);
});

test("hard closures and customer windows cannot be bypassed by exact start", () => {
  const job = {
    ...node(), lockedServiceStartAt: at("09:00"),
    unavailablePeriods: [{ start: at("09:05").toISOString(), end: at("09:30").toISOString() }],
  };
  const result = workday([job]);
  assert.equal(result.reasonCode, "PLANNING_LOCK");
  assert.equal(result.summary.serviceMin, 10);
  assert.equal(result.events.find(event => event.type === "service")?.startAt, at("09:30").toISOString());
  assert.equal(workday([{ ...node(), lockedServiceStartAt: at("09:00"), timeWindowStart: at("09:01") }]).reasonCode, "PLANNING_LOCK");
});

test("waiting observes complete fixed breaks; exact start inside break conflicts", () => {
  const constraints: ALNSDriverConstraints = {
    vehicleId: "v", driverName: "D", preferredStartTime: "09:00", preferredEndTime: "17:00",
    maxDrivingHoursPerDay: 8, avoidNightDriving: false, breakFrequencyMinutes: 120,
    preferredBreakDurationMin: 30, breakStartTime: "10:00", breakEndTime: "10:30",
  };
  const good = workday([{ ...node(), lockedServiceStartAt: at("09:30") }], {}, constraints);
  assert.equal(good.feasible, true);
  assert.equal(good.summary.breakMin, 30);
  const bad = workday([{ ...node(), lockedServiceStartAt: at("09:15") }], {}, constraints);
  assert.equal(bad.reasonCode, "PLANNING_LOCK");
  assert.equal(bad.summary.breakMin, 30);
  assert.equal(bad.summary.serviceMin, 10);
});

test("composite pickup locks first service exactly; delivery, reserves and charger remain intact", () => {
  const job = { ...node(), pickupLat: 59, pickupLon: 18, pickupServiceMin: 7,
    lockedServiceStartAt: at("09:00"), stopReserveMin: 2 };
  const charger = { ...node("charge"), isChargingStation: true, chargingDurationMin: 12, weightKg: 0, volumeM3: 0 };
  const result = workday([charger, job]);
  assert.equal(result.feasible, true);
  const service = result.events.filter(event => event.type === "service");
  assert.equal(service[0].startAt, at("09:00").toISOString());
  assert.equal(service[0].durationMin, 7);
  assert.equal(service[1].durationMin, 10);
  assert.equal(result.summary.stopReserveMin, 4);
  assert.equal(result.events.find(event => event.type === "charging")?.durationMin, 12);
});

test("canonical enrichment clones inputs, rejects omitted locked jobs and changed pair", () => {
  const original = input();
  const enriched = enrichPlanningLockInputs(original);
  assert.equal(enriched.nodes[0].lockedVehicleId, "v");
  assert.equal(enriched.nodes[0].lockedDriverId, "d");
  assert.equal(enriched.vehicles[0].driverId, "d");
  assert.equal(original.nodes[0].lockedVehicleId, undefined);
  assert.throws(() => enrichPlanningLockInputs({ ...original, nodes: [] }), OptimizerPlanningLockConflict);
  assert.throws(() => enrichPlanningLockInputs({ ...original, drivers: [] }), OptimizerPlanningLockConflict);
  assert.throws(() => enrichPlanningLockInputs({ ...original, stops: [{ ...original.stops[0], lockedDriverId: null }] }), OptimizerPlanningLockConflict);
});

test("time-only canonical lock retains original vehicle without inventing a driver lock", () => {
  const original = input();
  const enriched = enrichPlanningLockInputs({ ...original,
    stops: [{ ...original.stops[0], lockedVehicleId: null, lockedDriverId: null }] });
  assert.equal(enriched.nodes[0].lockedVehicleId, "v");
  assert.equal(enriched.nodes[0].lockedDriverId, null);
});

test("deterministic bounded construction/search admits exact locked jobs first on selected pair", async () => {
  const locked = { ...node("locked"), lockedVehicleId: "v", lockedDriverId: "d", lockedServiceStartAt: at("08:05") };
  const optional = { ...node("optional"), serviceDurationMin: 60 };
  const vehicles = [{ ...vehicle, id: "other", driverId: "other-driver" }, vehicle];
  const initial = await buildInitialSolutionFromCWAsync([optional, locked], vehicles, 59, 18, date);
  const initialRoute = initial.routes.find(route => route.nodes.some(item => item.id === locked.id));
  assert.equal(initialRoute?.vehicleId, "v");
  assert.equal(initial.unassigned.length, 0);
  assert.equal(evaluateRoute(initialRoute!, vehicle, 59, 18, date).feasible, true);
  const result = await runALNS(initial, vehicles, 59, 18, date, {
    maxIterations: 0, timeLimitMs: 10, localSearchTimeLimitMs: 0, weights: DEFAULT_WEIGHTS,
  });
  assertLockedJobsRetained([locked], result.routes, result.unassigned);
  assert.ok(compareUnassignedCoverage([locked], [optional]) > 0);
  assert.throws(() => assertLockedJobsRetained([locked], [], []), OptimizerPlanningLockConflict);
  assert.throws(() => assertLockedJobsRetained([locked], result.routes, [locked]), OptimizerPlanningLockConflict);
});

test("frozen-only optimization preserves canonical route and never invokes mutable search", async () => {
  const original = input(true);
  const untouched = JSON.stringify(original);
  const never: LockAwareOptimizer = async () => { throw new Error("Frozen route entered mutable search"); };
  const result = await optimizeWithPlanningLocks(original, never, 59, 18, date);
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].sourceRouteId, "r");
  assert.equal(result.frozenRouteSnapshots[0], original.routes[0]);
  assert.equal(JSON.stringify(original), untouched);
  assert.equal(result.routes[0].nodes[0].lockedServiceStartAt?.getTime(), at("09:00").getTime());
});

test("frozen route changing facts, missing membership or changed charging itinerary conflicts explicitly", async () => {
  const original = input(true);
  const never: LockAwareOptimizer = async () => { throw new Error("Unexpected search"); };
  await assert.rejects(optimizeWithPlanningLocks({
    ...original, nodes: [{ ...original.nodes[0], serviceDurationMin: 11 }],
  }, never, 59, 18, date), OptimizerPlanningLockConflict);
  assert.throws(() => enrichPlanningLockInputs({
    ...original, stops: [], nodes: [], currentRoutes: [routingRoute([])],
  }), OptimizerPlanningLockConflict);
  assert.throws(() => enrichPlanningLockInputs({
    ...original, routes: [{ ...original.routes[0],
      plannerItinerary: [...original.routes[0].plannerItinerary!, {
        stopId: "missing-charger", sequenceOrder: 2, estimatedArrival: date.toISOString(),
        distanceFromPreviousKm: 0, isChargingStop: true,
      }],
    }],
  }), OptimizerPlanningLockConflict);
});

test("solution cloning retains route identity, frozen metadata and the existing first-stop pin", () => {
  const route = { ...routingRoute([node()]), lockedFirstStopId: "s", sourceRouteId: "r",
    optimizationFrozen: true, frozenTimeline: workday([node()]).events };
  const solution = deepCloneSolution({
    routes: [route], unassigned: [], cost: 0,
    costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
  });
  assert.equal(solution.routes[0].lockedFirstStopId, "s");
  assert.equal(solution.routes[0].sourceRouteId, "r");
  assert.equal(solution.routes[0].optimizationFrozen, true);
});

test("full lock-aware search excludes frozen fleet, preserves source identity and refuses dropped locks", async () => {
  const original = input(true);
  const extra = node("mutable");
  const mixed: PlanningLockInputs = {
    ...original,
    nodes: [...original.nodes, extra],
    stops: [...original.stops, { id: "mutable", organizationId: "org", routeId: "r2", sequenceOrder: 1,
      lockedVehicleId: "v2", lockedDriverId: "d2", lockedServiceStartAt: null } as Stop],
    routes: [...original.routes, { id: "r2", organizationId: "org", vehicleId: "v2", optimizationFrozen: false } as Route],
    vehicles: [...original.vehicles, { ...original.vehicles[0], id: "v2" }],
    drivers: [...original.drivers!, { ...original.drivers![0], id: "d2", vehicleId: "v2" }],
    routingVehicles: [...original.routingVehicles, { ...vehicle, id: "v2", driverId: undefined }],
  };
  const optimizer: LockAwareOptimizer = async (nodes, vehicles) => {
    assert.deepEqual(nodes.map(item => item.id), ["mutable"]);
    assert.deepEqual(vehicles.map(item => item.id), ["v2"]);
    const solution = await buildInitialSolutionFromCWAsync(nodes, vehicles, 59, 18, date);
    return { routes: solution.routes, unassigned: solution.unassigned, costBreakdown: solution.costBreakdown,
      routeEvaluations: new Map(), performance: {
        distanceMatrixMs: 0, clusteringMs: 0, alnsSearchMs: 0, mergingMs: 0,
        searchMs: 0, totalMs: 0, distanceSource: "cache",
      } };
  };
  const result = await optimizeWithPlanningLocks(mixed, optimizer, 59, 18, date);
  assert.equal(result.routes.find(route => route.vehicleId === "v2")?.sourceRouteId, "r2");
  assert.equal(result.routes.find(route => route.vehicleId === "v")?.sourceRouteId, "r");
  assert.equal(result.unassigned.length, 0);
  await assert.rejects(optimizeWithPlanningLocks(mixed, async (...args) => {
    const result = await optimizer(...args);
    return { ...result, routes: [], unassigned: [] };
  }, 59, 18, date), OptimizerPlanningLockConflict);
});

test("enrichment retains existing first-customer rule while permitting charging before it", () => {
  const original = input();
  const enriched = enrichPlanningLockInputs({
    ...original, routes: [{ ...original.routes[0], lockedFirstStopId: "s" }],
  });
  assert.equal(enriched.nodes[0].mustBeFirstCustomer, true);
  const charger = { ...node("charger"), isChargingStation: true };
  assert.equal(workday([charger, enriched.nodes[0]]).feasible, true);
  assert.equal(workday([node("other"), enriched.nodes[0]]).reasonCode, "PLANNING_LOCK");
});
