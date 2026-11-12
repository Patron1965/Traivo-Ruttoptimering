import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNeighborhood, NEIGHBOR_COUNT } from "./geographic-neighborhood";
import { haversineDistance } from "./distance-cache";
import { withRequiredRoadData, RoadDataUnavailableError } from "../road-data-policy";
import { geographicGroupSearch } from "./operators/geographic-search";
import { clearOsrmCache, precomputeDistanceMatrix } from "../osrm";
import { globalDistanceCache } from "./distance-cache";
import { evaluateRoute } from "./cost";
import {
  computeGeographicCohesionCost,
  computeSolutionCost,
  DEFAULT_WEIGHTS,
  type ALNSNode,
  type ALNSSolution,
  type ALNSVehicle,
} from "./index";

const startTime = new Date("2026-01-01T07:00:00.000Z");
const vehicles: ALNSVehicle[] = ["one", "two"].map((id) => ({
  id,
  vehicleType: "electric",
  capacityKg: 10_000,
  capacityVolume: 100,
  rangeKm: null,
}));

const stops: ALNSNode[] = [
  ["north-a", 59.3300, 18.0600],
  ["north-b", 59.3310, 18.0610],
  ["south-a", 59.2000, 18.0600],
  ["south-b", 59.2010, 18.0610],
].map(([id, latitude, longitude]) => ({
  id: id as string,
  latitude: latitude as number,
  longitude: longitude as number,
  timeWindowStart: null,
  timeWindowEnd: null,
  serviceDurationMin: 5,
  weightKg: 10,
  volumeM3: 0.1,
}));

function solution(routeStopIndexes: number[][], sourceStops = stops): ALNSSolution {
  return {
    routes: routeStopIndexes.map((indexes, index) => {
      const nodes = indexes.map((stopIndex) => sourceStops[stopIndex]);
      return {
        vehicleId: vehicles[index].id,
        nodes,
        totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
        totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
      };
    }),
    unassigned: [],
    cost: 0,
    costBreakdown: {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0,
      totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    },
  };
}

function bruteForceCohesionCost(routes: ALNSSolution["routes"]): number {
  const assigned = routes.flatMap((route) => route.nodes
    .filter((node) => !node.isChargingStation)
    .map((node) => ({ node, vehicleId: route.vehicleId })));
  let votes = 0;
  let splitWeight = 0;
  for (let i = 0; i < assigned.length; i++) {
    const left = assigned[i];
    const neighbors = assigned.filter((_, j) => i !== j).map(right => ({
      right,
      distance: haversineDistance(left.node.latitude, left.node.longitude, right.node.latitude, right.node.longitude),
    })).filter(item => item.distance < 10).sort((a, b) => a.distance - b.distance).slice(0, NEIGHBOR_COUNT);
    const total = neighbors.reduce((sum, item) => sum + 1 / (0.1 + item.distance), 0);
    if (!total) continue;
    votes++;
    splitWeight += neighbors.reduce((sum, item) => sum + (left.vehicleId !== item.right.vehicleId ? 1 / (0.1 + item.distance) : 0), 0) / total;
  }
  return votes === 0 ? 0 : splitWeight / votes;
}

test("geographically grouped routes have lower cohesion cost than crossed assignments", () => {
  const grouped = solution([[0, 1], [2, 3]]);
  const crossed = solution([[0, 2], [1, 3]]);

  assert.equal(computeGeographicCohesionCost(grouped.routes), 0);
  assert.ok(computeGeographicCohesionCost(crossed.routes) > 0);
  assert.ok(computeGeographicCohesionCost(grouped.routes) < computeGeographicCohesionCost(crossed.routes));
});

test("a zero geographic cohesion weight leaves total cost unchanged", () => {
  const crossed = solution([[0, 2], [1, 3]]);
  const zeroWeight = { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 0 };
  const result = computeSolutionCost(crossed, vehicles, 59.30, 18.06, startTime, zeroWeight);
  const expectedWithoutCohesion =
    zeroWeight.distanceWeight * result.breakdown.totalDistanceKm
    + zeroWeight.co2Weight * result.breakdown.totalCo2Kg * 100
    + zeroWeight.etaPrecisionWeight * (result.breakdown.totalTimeWindowSlackMin / 60) * 10
    + zeroWeight.driverHappinessWeight * result.breakdown.totalDriverPenalty
    + 2_000;

  assert.equal(result.cost, expectedWithoutCohesion);
});

test("bounded nearest neighbors equal an independent all-pairs oracle across grid boundaries", () => {
  // The points straddle both latitude and latitude-scaled longitude cell
  // boundaries around Stockholm, with pairs both inside and outside 10 km.
  const gridStops: ALNSNode[] = [
    [59.274, 17.895], [59.277, 17.905], [59.365, 18.070], [59.368, 18.080],
    [59.320, 18.245], [59.325, 18.255], [59.410, 18.000], [59.415, 18.010],
    [59.275, 18.150], [59.365, 17.820], [59.330, 18.060], [59.335, 18.065],
  ].map(([latitude, longitude], index) => ({
    id: `grid-${index}`,
    latitude,
    longitude,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
  }));
  const candidate = solution([[0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9, 11]], gridStops);

  assert.equal(
    computeGeographicCohesionCost(candidate.routes),
    bruteForceCohesionCost(candidate.routes),
  );
});

test("dense coincident neighborhoods retain at most six edges per stop", () => {
  const dense = Array.from({ length: 500 }, (_, i) => ({ ...stops[0], id: `dense-${i}` }));
  const graph = buildNeighborhood(dense);
  assert.equal(graph.size, 500);
  assert.equal([...graph.values()].reduce((sum, edges) => sum + edges.length, 0), 3000);
});

test("required-road neighborhood scoring fails explicitly rather than fetching or falling back", () => {
  assert.throws(() => withRequiredRoadData(() => buildNeighborhood(stops)), RoadDataUnavailableError);
});

test("coherent group swaps improve crossed areas without dropping fleet or stops", async () => {
  const crossed = solution([[0, 2], [1, 3]]);
  const weights = { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 100 };
  const before = computeSolutionCost(crossed, vehicles, 59.30, 18.06, startTime, weights, new Map(), "balance").cost;
  assert.equal(await geographicGroupSearch(crossed, vehicles, 59.30, 18.06, startTime, weights, new Map(), "balance"), true);
  assert.equal(computeGeographicCohesionCost(crossed.routes), 0);
  assert.ok(crossed.cost < before);
  assert.deepEqual(crossed.routes.flatMap(r => r.nodes.map(n => n.id)).sort(), stops.map(n => n.id).sort());
  assert.ok(crossed.routes.every(r => r.nodes.length > 0));
  assert.equal(crossed.unassigned.length, 0);
});

test("group search leaves zero-weight and hard-ineligible assignments unchanged", async () => {
  for (const zero of [true, false]) {
    const crossed = solution([[0, 2], [1, 3]]);
    const before = structuredClone(crossed);
    const restricted = vehicles.map((v, i) => ({ ...v, ineligibleStopIds: new Set(crossed.routes[1 - i].nodes.map(n => n.id)) }));
    assert.equal(await geographicGroupSearch(crossed, restricted, 59.30, 18.06, startTime,
      { ...DEFAULT_WEIGHTS, geographicCohesionWeight: zero ? 0 : 100 }, new Map(), "balance"), false);
    assert.deepEqual(crossed, before);
  }
});

test("cached directional roads exclude barriers and group search uses the same matrix without fetches", async () => {
  const originalFetch = globalThis.fetch;
  const provider = process.env.OPERATIONAL_ROAD_PROVIDER;
  process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
  clearOsrmCache();
  globalDistanceCache.clear();
  const coordinates = [{ latitude: 59.30, longitude: 18.06 }, ...stops];
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    const distances = coordinates.map((a, i) => coordinates.map((b, j) => i === j ? 0
      : haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1300));
    return new Response(JSON.stringify({ code: "Ok", distances, durations: distances.map(row => row.map(m => m / 10)) }));
  }) as typeof fetch;
  try {
    await precomputeDistanceMatrix(coordinates.map(n => ({ lat: n.latitude, lon: n.longitude })));
    const crossed = solution([[0, 2], [1, 3]]);
    const weights = { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 100 };
    const before = withRequiredRoadData(() => computeSolutionCost(crossed, vehicles, 59.30, 18.06, startTime, weights, new Map(), "balance").cost);
    globalThis.fetch = (async () => { throw new Error("search must use cached roads only"); }) as typeof fetch;
    assert.equal(await withRequiredRoadData(() => geographicGroupSearch(crossed, vehicles, 59.30, 18.06, startTime, weights, new Map(), "balance")), true);
    assert.ok(crossed.cost < before);
    assert.equal(requests, 1);
    assert.equal(computeGeographicCohesionCost(crossed.routes), 0);
    assert.ok(crossed.routes.every((r, i) => withRequiredRoadData(() => evaluateRoute(r, vehicles[i], 59.30, 18.06, startTime)).feasible));

    // Two physically adjacent stops separated by a one-way return detour.
    assert.ok([...withRequiredRoadData(() => buildNeighborhood(stops.slice(0, 2))).values()].every(edges => edges.length === 1));
    clearOsrmCache();
    assert.throws(() => withRequiredRoadData(() => buildNeighborhood(stops.slice(0, 2))), RoadDataUnavailableError,
      "same coordinate set must not reuse cached topology after road eviction/clear");
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: "Ok", distances: [[0, 100], [20_000, 0]], durations: [[0, 10], [2000, 0]],
    }))) as typeof fetch;
    await precomputeDistanceMatrix(stops.slice(0, 2).map(n => ({ lat: n.latitude, lon: n.longitude })));
    const barrier = withRequiredRoadData(() => buildNeighborhood(stops.slice(0, 2)));
    assert.ok([...barrier.values()].every(edges => edges.length === 0));
    process.env.OPERATIONAL_ROAD_PROVIDER = "geoapify";
    assert.throws(() => withRequiredRoadData(() => buildNeighborhood(stops.slice(0, 2))), RoadDataUnavailableError,
      "same coordinate set must not reuse another provider's road topology");
  } finally {
    globalThis.fetch = originalFetch;
    if (provider === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER;
    else process.env.OPERATIONAL_ROAD_PROVIDER = provider;
    clearOsrmCache();
    globalDistanceCache.clear();
  }
});

test("group proposals preserve shift return, fixed first customer, capacity, and frozen routes", async () => {
  for (const constraint of ["shift", "capacity", "first", "frozen"] as const) {
    const crossed = solution([[0, 2], [1, 3]]);
    const before = structuredClone(crossed);
    const constrained = vehicles.map(v => ({
      ...v,
      capacityKg: constraint === "capacity" ? 10 : v.capacityKg,
      maxDriverOvertimeMin: 0,
      ...(constraint === "shift" ? { canonicalDriverConstraints: {
        vehicleId: v.id, driverName: v.id, preferredStartTime: "08:00", preferredEndTime: "08:01",
        maxDrivingHoursPerDay: 1, avoidNightDriving: false, breakFrequencyMinutes: 120, preferredBreakDurationMin: 15,
      } } : {}),
    }));
    if (constraint === "first") crossed.routes.forEach(r => { r.lockedFirstStopId = r.nodes[0].id; });
    if (constraint === "frozen") crossed.routes.forEach(r => { r.optimizationFrozen = true; });
    const snapshot = structuredClone(crossed);
    const improved = await geographicGroupSearch(crossed, constrained, 59.30, 18.06, startTime,
      { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 100 }, new Map(), "balance");
    if (constraint !== "first") {
      assert.equal(improved, false);
      assert.deepEqual(crossed, snapshot);
    } else {
      assert.ok(crossed.routes.every(r => r.nodes[0].id === r.lockedFirstStopId));
      assert.deepEqual(crossed.routes.flatMap(r => r.nodes.map(n => n.id)).sort(), before.routes.flatMap(r => r.nodes.map(n => n.id)).sort());
    }
  }
});