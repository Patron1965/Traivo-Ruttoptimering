import assert from "node:assert/strict";
import { test } from "node:test";
import { clearOsrmCache, precomputeDistanceMatrix } from "../osrm";
import { withRequiredRoadData } from "../road-data-policy";
import { globalDistanceCache } from "./distance-cache";
import { buildNeighborhood, localAssignmentCost } from "./geographic-neighborhood";
import { evaluateRoute, computeSolutionCost } from "./cost";
import { buildInitialSolutionFromCW, buildInitialSolutionFromCWAsync } from "./runner";
import { geographicGroupSearch } from "./operators/geographic-search";
import { DEFAULT_WEIGHTS, type ALNSNode, type ALNSRoute, type ALNSSolution, type ALNSVehicle } from "./types";

const START = new Date("2026-01-01T07:00:00Z");
const DEPOT = { latitude: 59.30, longitude: 18 };
const stops: ALNSNode[] = Array.from({ length: 8 }, (_, i) => {
  const latitude = (i < 4 ? 59.40 : 59.20) + (i % 4) * 0.0001;
  return {
    id: `${i < 4 ? "north" : "south"}-${i}`, latitude, longitude: 18,
    timeWindowStart: null, timeWindowEnd: null, serviceDurationMin: 29,
    weightKg: 1, volumeM3: 0.1, jobType: "pickup_delivery",
    pickupLat: latitude, pickupLon: 18, pickupServiceMin: 1,
  };
});
const vehicles: ALNSVehicle[] = ["one", "two"].map(id => ({
  id, vehicleType: "fossil", capacityKg: 1000, capacityVolume: 100, rangeKm: null,
  maxDriverOvertimeMin: 0, allowLateStopsMin: 0,
  canonicalDriverConstraints: {
    vehicleId: id, driverName: id, preferredStartTime: "08:00", preferredEndTime: "10:10",
    maxDrivingHoursPerDay: 8, avoidNightDriving: false, breakFrequencyMinutes: 240, preferredBreakDurationMin: 0,
  },
}));
const weights = { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 0.5 };
function route(vehicleId: string, nodes: ALNSNode[]): ALNSRoute {
  return { vehicleId, nodes, totalWeight: nodes.reduce((s, n) => s + n.weightKg, 0), totalVolume: nodes.reduce((s, n) => s + n.volumeM3, 0) };
}
function crossed(): ALNSSolution {
  return { routes: [route("one", [stops[0], stops[1], stops[4], stops[5]]), route("two", [stops[2], stops[3], stops[6], stops[7]])],
    unassigned: [], cost: 0, costBreakdown: {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0,
      totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    } };
}
async function withMatrix(operation: () => Promise<void>, matrixStops: ALNSNode[] = stops): Promise<void> {
  const originalFetch = globalThis.fetch, provider = process.env.OPERATIONAL_ROAD_PROVIDER;
  process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
  clearOsrmCache(); globalDistanceCache.clear();
  const coords = [DEPOT, ...matrixStops];
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "Ok",
    distances: coords.map((_, i) => coords.map((_, j) => i === j ? 0 : 1000)),
    durations: coords.map((_, i) => coords.map((_, j) => i === j ? 0 : 60)),
  }))) as typeof fetch;
  try {
    await precomputeDistanceMatrix(coords.map(n => ({ lat: n.latitude, lon: n.longitude })));
    globalThis.fetch = (async () => { throw new Error("no requests permitted after fixture warmup"); }) as typeof fetch;
    await withRequiredRoadData(operation);
  } finally {
    globalThis.fetch = originalFetch;
    if (provider === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER;
    else process.env.OPERATIONAL_ROAD_PROVIDER = provider;
    clearOsrmCache(); globalDistanceCache.clear();
  }
}

test("tight workday requires two-way coherent group swap; every single relocation fails", async () => withMatrix(async () => {
  const solution = crossed();
  assert.ok(solution.routes.every((r, i) => evaluateRoute(r, vehicles[i], DEPOT.latitude, DEPOT.longitude, START).feasible));
  for (let source = 0; source < 2; source++) {
    const target = 1 - source;
    for (const node of solution.routes[source].nodes) {
      for (let pos = 0; pos <= solution.routes[target].nodes.length; pos++) {
        const nodes = [...solution.routes[target].nodes];
        nodes.splice(pos, 0, node);
        assert.equal(evaluateRoute(route(vehicles[target].id, nodes), vehicles[target], DEPOT.latitude, DEPOT.longitude, START).feasible, false);
      }
    }
  }
  const before = computeSolutionCost(solution, vehicles, DEPOT.latitude, DEPOT.longitude, START, weights, new Map(), "balance").cost;
  assert.ok(localAssignmentCost(solution.routes) > 0);
  assert.equal(await geographicGroupSearch(solution, vehicles, DEPOT.latitude, DEPOT.longitude, START, weights, new Map(), "balance"), true);
  assert.equal(localAssignmentCost(solution.routes), 0);
  assert.ok(solution.cost < before);
  assert.deepEqual(solution.routes.map(r => r.nodes.length), [4, 4]);
  assert.equal(solution.unassigned.length, 0);
  assert.ok(solution.routes.every((r, i) => evaluateRoute(r, vehicles[i], DEPOT.latitude, DEPOT.longitude, START).feasible));
  for (const original of stops) {
    const retained = solution.routes.flatMap(r => r.nodes).filter(n => n.id === original.id);
    assert.equal(retained.length, 1);
    assert.equal(retained[0], original, "composite pickup/delivery identity and fields survive intact");
  }
}));

test("first geographic construction is coherent and synchronous/cooperative results agree on identical roads", async () => withMatrix(async () => {
  const shortStops = stops.map(n => ({ ...n, serviceDurationMin: 4 }));
  const sync = buildInitialSolutionFromCW(shortStops, vehicles, DEPOT.latitude, DEPOT.longitude, START, "balance", [], weights);
  const cooperative = await buildInitialSolutionFromCWAsync(shortStops, vehicles, DEPOT.latitude, DEPOT.longitude, START, "balance", [], weights);
  assert.deepEqual(cooperative, sync);
  assert.equal(sync.unassigned.length, 0);
  assert.ok(sync.routes.every(r => r.nodes.length > 0));
  assert.equal(localAssignmentCost(sync.routes), 0);
  assert.ok(sync.routes.every((r, i) => evaluateRoute(r, vehicles[i], DEPOT.latitude, DEPOT.longitude, START).feasible));
}));

test("group cancellation cannot commit a partially explored candidate, including after a feasible proposal", async () => withMatrix(async () => {
  const solution = crossed(), before = structuredClone(solution);
  let cancelled = false;
  // The operator yields between proposals, allowing cancellation without
  // exposing in-progress candidate mutations.
  setImmediate(() => { cancelled = true; });
  assert.equal(await geographicGroupSearch(solution, vehicles, DEPOT.latitude, DEPOT.longitude, START,
    weights, new Map(), "balance", 0, () => cancelled), false);
  assert.deepEqual(solution, before);
  assert.equal(cancelled, true);
}));

test("cached topology rehydrates current composite nodes instead of stale object references", async () => withMatrix(async () => {
  buildNeighborhood(stops);
  const changed = stops.map(n => ({ ...n, pickupServiceMin: 42 }));
  const graph = buildNeighborhood(changed);
  assert.ok([...graph.values()].flat().every(item => item.node.pickupServiceMin === 42));
}));

test("distance-dominant objective never authorizes worsening local assignment cohesion", async () => withMatrix(async () => {
  for (const geographicWeight of [0.00001, 0.5, 10]) {
    const solution = crossed();
    const objective = { ...weights, distanceWeight: 1000, geographicCohesionWeight: geographicWeight };
    const beforeCohesion = localAssignmentCost(solution.routes);
    const beforeCost = computeSolutionCost(solution, vehicles, DEPOT.latitude, DEPOT.longitude, START, objective, new Map(), "balance").cost;
    await geographicGroupSearch(solution, vehicles, DEPOT.latitude, DEPOT.longitude, START, objective, new Map(), "balance");
    assert.ok(localAssignmentCost(solution.routes) <= beforeCohesion);
    assert.ok(computeSolutionCost(solution, vehicles, DEPOT.latitude, DEPOT.longitude, START, objective, new Map(), "balance").cost <= beforeCost);
  }
}));

test("a cheaper whole-plan group proposal is rejected when it worsens local ownership", async () => {
  const dense = Array.from({ length: 20 }, (_, i) => ({
    ...stops[i < 10 ? 0 : 4], id: `dense-${i}`,
    latitude: (i < 10 ? 59.40 : 59.20) + (i % 10) * 0.0001,
    pickupLat: (i < 10 ? 59.40 : 59.20) + (i % 10) * 0.0001,
    serviceDurationMin: i < 10 ? 20 : 1,
  }));
  await withMatrix(async () => {
    const flexible = vehicles.map(v => ({ ...v, canonicalDriverConstraints: undefined }));
    const solution = crossed();
    solution.routes = [route("one", [...dense.slice(0, 9), dense[10]]),
      route("two", [dense[9], ...dense.slice(11)])];
    const objective = { distanceWeight: 0, co2Weight: 0, etaPrecisionWeight: 0, driverHappinessWeight: 0, geographicCohesionWeight: 0.00001 };
    const trial = { ...solution, routes: [route("one", [...dense.slice(7, 9), dense[10], ...dense.slice(11, 18)]),
      route("two", [...dense.slice(0, 7), dense[9], ...dense.slice(18)])] };
    const score = (s: ALNSSolution) => computeSolutionCost(s, flexible, DEPOT.latitude, DEPOT.longitude, START, objective, new Map(), "balance").cost;
    const beforeCost = score(solution), beforeCohesion = localAssignmentCost(solution.routes);
    assert.ok(score(trial) < beforeCost, "workload balancing alone prefers this group swap");
    assert.ok(localAssignmentCost(trial.routes) > beforeCohesion, "but it splits previously coherent local ownership");
    await geographicGroupSearch(solution, flexible, DEPOT.latitude, DEPOT.longitude, START, objective, new Map(), "balance");
    assert.ok(localAssignmentCost(solution.routes) <= beforeCohesion);
    assert.ok(score(solution) <= beforeCost);
  }, dense);
});
