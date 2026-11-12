import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateClusterVehicles, compareUnassignedCoverage, repairFleetCoverage } from "./fleet-coverage";
import { buildInitialSolutionFromCW, buildInitialSolutionFromCWAsync } from "./runner";
import { evaluateRoute, computeSolutionCost } from "./cost";
import { evaluateRouteWorkday, stockholmClock } from "../route-workday";
import { DEFAULT_WEIGHTS } from "./types";
import type { ALNSNode, ALNSRoute, ALNSVehicle, ALNSDriverConstraints } from "./types";

const DEPOT = {lat: 59.3293, lon: 18.0686};
const START = new Date("2026-10-15T00:00:00Z");
const node = (id: string, duration = 10): ALNSNode => ({
  id, latitude: DEPOT.lat, longitude: DEPOT.lon,
  serviceDurationMin: duration, timeWindowStart: null, timeWindowEnd: null,
  weightKg: 0, volumeM3: 0,
});
const vehicle = (id: string): ALNSVehicle => ({
  id, vehicleType: "fossil", capacityKg: 1000, capacityVolume: 100, rangeKm: null,
});
const driver = (id: string, end = "08:20", start = "08:00"): ALNSDriverConstraints => ({
  vehicleId: id, driverName: id, preferredStartTime: start, preferredEndTime: end,
  maxDrivingHoursPerDay: 8, avoidNightDriving: false,
  breakFrequencyMinutes: 120, preferredBreakDurationMin: 15,
});
const route = (id: string, nodes: ALNSNode[]): ALNSRoute => ({
  vehicleId: id, nodes, totalWeight: 0, totalVolume: 0,
});

test("best-result ranking keeps mandatory and high-priority coverage ahead of soft route costs", () => {
  const mandatory = {...node("mandatory"), planningPriority: 2 as const};
  const high = {...node("high"), planningPriority: 1 as const};
  const normals = Array.from({length: 200}, (_, index) => node(`normal-${index}`));
  assert.ok(compareUnassignedCoverage(normals, [mandatory]) < 0);
  assert.ok(compareUnassignedCoverage(normals, [high]) < 0);
  assert.ok(compareUnassignedCoverage([], [node("normal")]) < 0);
  assert.equal(compareUnassignedCoverage([node("x")], [node("y")]), 0);
});
test("coverage repair relocates a job to admit an eligible stop without losing or duplicating jobs", () => {
  const a = node("a"), movable = node("movable"), missing = node("missing");
  const fleet = [vehicle("v1"), {...vehicle("v2"), ineligibleStopIds: new Set(["a", "missing"])}];
  const constraints = new Map([["v1", driver("v1")], ["v2", driver("v2", "08:10")]]);
  const solution = {routes: [route("v1", [a, movable]), route("v2", [])], unassigned: [missing]};
  assert.equal(evaluateRoute(route("v1", [a, movable, missing]), fleet[0],
    DEPOT.lat, DEPOT.lon, START, constraints.get("v1")).feasible, false);
  assert.equal(repairFleetCoverage(solution, fleet, DEPOT.lat, DEPOT.lon, START, constraints), 1);
  assert.deepEqual(solution.routes[0].nodes.map(item => item.id), ["missing", "a"]);
  assert.deepEqual(solution.routes[1].nodes.map(item => item.id), ["movable"]);
  assert.equal(solution.unassigned.length, 0);
  assert.deepEqual(solution.routes.flatMap(item => item.nodes.map(n => n.id)).sort(), ["a", "missing", "movable"]);
  for (let index = 0; index < fleet.length; index++) assert.equal(
    evaluateRouteWorkday(solution.routes[index].nodes, fleet[index], DEPOT.lat, DEPOT.lon,
      START, constraints.get(fleet[index].id)).feasible, true,
  );
});

test("failed and timed-out repair does not mutate routes or relax working hours", () => {
  const fleet = [vehicle("v1"), vehicle("v2")];
  const constraints = new Map(fleet.map(v => [v.id, driver(v.id, "08:10")]));
  const solution = {routes: [route("v1", [node("a")]), route("v2", [node("b")])], unassigned: [node("c")]};
  const original = structuredClone(solution);
  assert.equal(repairFleetCoverage(solution, fleet, DEPOT.lat, DEPOT.lon, START, constraints), 0);
  assert.deepEqual(solution, original);
  assert.equal(repairFleetCoverage(solution, fleet, DEPOT.lat, DEPOT.lon, START, constraints, 0), 0);
  assert.deepEqual(solution, original);
});

test("coverage repair preserves composite pickup/delivery jobs and charging slots", () => {
  const pd = {...node("pd"), jobType: "pickup_delivery" as const,
    pickupLat: DEPOT.lat, pickupLon: DEPOT.lon, pickupServiceMin: 5};
  const fleet = [vehicle("v1"), {...vehicle("v2"), ineligibleStopIds: new Set(["missing"])}];
  const constraints = new Map([["v1", driver("v1", "08:25")], ["v2", driver("v2", "08:15")]]);
  const solution = {routes: [route("v1", [node("a"), pd]), route("v2", [])], unassigned: [node("missing")]};
  assert.equal(repairFleetCoverage(solution, fleet, DEPOT.lat, DEPOT.lon, START, constraints), 1);
  const savedPd = solution.routes.flatMap(r => r.nodes).find(n => n.id === "pd");
  assert.deepEqual(savedPd, pd);
  const charging = {...node("charge", 0), isChargingStation: true, chargingDurationMin: 20};
  const protectedSolution = {routes: [route("v1", [node("a"), charging]), route("v2", [])], unassigned: [node("missing", 40)]};
  const original = structuredClone(protectedSolution);
  repairFleetCoverage(protectedSolution, fleet, DEPOT.lat, DEPOT.lon, START, constraints);
  assert.deepEqual(protectedSolution, original);
});

test("cluster allocation uses actual shift availability and eligibility instead of round-robin", () => {
  const clusters = [[node("busy", 300)], [node("small", 60)]];
  const fleet = [vehicle("short"), vehicle("long"), vehicle("extra")];
  const allocation = allocateClusterVehicles(clusters, fleet, START,
    [driver("short", "10:00"), driver("long", "16:00"), driver("extra", "14:00")]);
  assert.equal(allocation[0][0].id, "long");
  assert.deepEqual(allocation.flat().map(v => v.id).sort(), fleet.map(v => v.id).sort());
  const restricted = allocateClusterVehicles([[node("a")], [node("b")]],
    [{...vehicle("only-a"), ineligibleStopIds: new Set(["b"])},
      {...vehicle("only-b"), ineligibleStopIds: new Set(["a"])}], START);
  assert.deepEqual(restricted.map(group => group[0].id), ["only-a", "only-b"]);
});

test("fewer-vehicles CW seeds respect shifts before merging, in both construction paths", async () => {
  const stops = Array.from({length: 8}, (_, index) => ({
    ...node(`stop-${index}`, 9), latitude: DEPOT.lat + 0.0001 * (index + 1),
  }));
  const fleet = [vehicle("v1"), vehicle("v2"), vehicle("v3")];
  const constraints = fleet.map(v => driver(v.id, "08:40"));
  const sync = buildInitialSolutionFromCW(stops, fleet, DEPOT.lat, DEPOT.lon, START, "minimize", constraints);
  const asyncResult = await buildInitialSolutionFromCWAsync(stops, fleet, DEPOT.lat, DEPOT.lon, START, "minimize", constraints);
  assert.deepEqual(asyncResult, sync);
  assert.equal(sync.unassigned.length, 0);
  assert.ok(sync.routes.filter(r => r.nodes.length).length >= 2);
  for (const r of sync.routes) {
    if (!r.nodes.length) continue;
    assert.equal(evaluateRoute(r, fleet.find(v => v.id === r.vehicleId)!,
      DEPOT.lat, DEPOT.lon, START, constraints.find(d => d.vehicleId === r.vehicleId)).feasible, true);
  }
});

test("CW seeds reject individually impossible stops instead of returning an invalid route", () => {
  const result = buildInitialSolutionFromCW([node("too-long", 60)], [vehicle("v1")],
    DEPOT.lat, DEPOT.lon, START, "minimize", [driver("v1")]);
  assert.equal(result.routes[0].nodes.length, 0);
  assert.equal(result.unassigned[0].id, "too-long");
});

test("balance measures the authoritative Stockholm workday, independently of server TZ", () => {
  const fleet = [vehicle("v1"), vehicle("v2")];
  const constraints = new Map(fleet.map(v => [v.id, driver(v.id, "16:00")]));
  const solution = {routes: [route("v1", [node("a")]), route("v2", [node("b", 20)])],
    unassigned: [], cost: 0, costBreakdown: {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0,
      totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    }};
  const cost = computeSolutionCost(solution, fleet, DEPOT.lat, DEPOT.lon, START,
    DEFAULT_WEIGHTS, constraints, "balance").cost;
  // Longest canonical workday is 20 minutes; shortening the other route must
  // not increase the score merely because it increases the duration spread.
  assert.equal(cost, 20 * 20);
});

test("memoized Stockholm clocks retain DST behavior and cannot be changed by a caller", () => {
  for (const [day, clock, expected] of [
    ["2026-03-29", "02:30", "2026-03-29T01:30:00.000Z"],
    ["2026-10-25", "02:30", "2026-10-25T00:30:00.000Z"],
    ["2026-10-15", "08:00", "2026-10-15T06:00:00.000Z"],
  ]) {
    const dayDate = new Date(`${day}T00:00:00Z`);
    const first = stockholmClock(dayDate, clock);
    assert.equal(first.toISOString(), expected);
    first.setTime(0);
    assert.equal(stockholmClock(dayDate, clock).toISOString(), expected);
  }
});
