import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSolutionCost,
  DEFAULT_WEIGHTS,
  evaluateRoute,
  getDistanceCache,
  optimizeWithALNS,
  type ALNSNode,
  type ALNSDriverConstraints,
  type ALNSRoute,
  type ALNSSolution,
  type ALNSVehicle,
  type OptimizationWeights,
} from "./index";
import {
  crossClusterImprove,
  crossClusterImproveCooperative,
} from "./clustering";
import {
  localSearchPostProcess,
  localSearchPostProcessCancellable,
} from "./operators/local-search";
import {
  clearOsrmCache,
  getDistanceMatrixCacheCoverage,
  precomputeDistanceMatrix,
} from "../osrm";
import { reinsertUnassignedNodes } from "../import-route-workflow";

const DEPOT = { latitude: 59.3293, longitude: 18.0686 };
const START = new Date("2026-08-19T07:00:00.000Z");
const BROAD_START = new Date("2026-08-19T05:00:00.000Z");
const BROAD_END = new Date("2026-08-19T22:00:00.000Z");

async function withRandom<T>(random: () => number, operation: () => Promise<T>): Promise<T> {
  const originalRandom = Math.random;
  Math.random = random;
  try {
    return await operation();
  } finally {
    Math.random = originalRandom;
  }
}

function roadDistanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const latitudeKm = (to.latitude - from.latitude) * 111.32;
  const longitudeKm = (to.longitude - from.longitude) * 111.32 * Math.cos(from.latitude * Math.PI / 180);
  return Math.sqrt(latitudeKm ** 2 + longitudeKm ** 2) * 1.18;
}

function makeNode(
  id: string,
  latitude: number,
  longitude: number,
  serviceDurationMin = 2,
): ALNSNode {
  return {
    id,
    latitude,
    longitude,
    timeWindowStart: BROAD_START,
    timeWindowEnd: BROAD_END,
    serviceDurationMin,
    weightKg: 5,
    volumeM3: 0.05,
  };
}

function makeVehicle(id: string, ineligibleStopIds?: Set<string>): ALNSVehicle {
  return {
    id,
    vehicleType: "fossil",
    capacityKg: 1_000,
    capacityVolume: 100,
    rangeKm: null,
    ineligibleStopIds,
  };
}

/**
 * All distances in this test are synthetic and deterministic. Installing the
 * table response before optimizeWithALNS starts leaves a complete road matrix
 * in the same cache used by production, then the fetch implementation is
 * blocked so a hidden external request fails the test.
 */
async function warmSyntheticRoadMatrix(stops: ALNSNode[]): Promise<void> {
  clearOsrmCache();
  getDistanceCache().clear();
  const coordinates = [
    { lat: DEPOT.latitude, lon: DEPOT.longitude },
    ...stops.map((stop) => ({ lat: stop.latitude, lon: stop.longitude })),
  ];
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (input) => {
    requests++;
    const coordinateText = new URL(String(input)).pathname.split("/").pop() ?? "";
    const matrixCoordinates = coordinateText.split(";").filter(Boolean).map((pair) => {
      const [longitude, latitude] = pair.split(",").map(Number);
      return { latitude, longitude };
    });
    const distances = matrixCoordinates.map((from) =>
      matrixCoordinates.map((to) =>
        from === to ? 0 : roadDistanceKm(from, to) * 1_000));
    const durations = matrixCoordinates.map((from, row) =>
      matrixCoordinates.map((to, column) =>
        row === column ? 0 : roadDistanceKm(from, to) / 35 * 3_600));
    return new Response(JSON.stringify({ code: "Ok", distances, durations }), { status: 200 });
  }) as typeof fetch;

  try {
    assert.equal(await precomputeDistanceMatrix(coordinates, { timeoutMs: 1_000 }), true);
    const coverage = getDistanceMatrixCacheCoverage(coordinates);
    assert.equal(coverage.complete, true);
    assert.equal(coverage.cachedPairs, coverage.totalPairs);
    assert.ok(requests >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function fullPathStops(): ALNSNode[] {
  const centers = [
    [59.50, 17.95],
    [59.31, 17.70],
    [59.12, 18.22],
    [59.43, 18.43],
  ] as const;
  return centers.flatMap(([centerLatitude, centerLongitude], clusterIndex) =>
    Array.from({ length: 57 }, (_, index) => {
      const row = Math.floor(index / 8);
      const column = index % 8;
      return makeNode(
        `full-cluster-${clusterIndex}-stop-${index}`,
        centerLatitude + (row - 3) * 0.0011,
        centerLongitude + (column - 3.5) * 0.0011,
        2,
      );
    }));
}

function route(nodes: ALNSNode[], vehicleId: string): ALNSRoute {
  return {
    vehicleId,
    nodes,
    totalWeight: nodes.reduce((sum, node) => sum + node.weightKg, 0),
    totalVolume: nodes.reduce((sum, node) => sum + node.volumeM3, 0),
  };
}

function solution(routes: ALNSRoute[]): ALNSSolution {
  return {
    routes,
    unassigned: [],
    cost: 0,
    costBreakdown: {
      distanceCost: 0,
      co2Cost: 0,
      etaPrecisionCost: 0,
      driverPenaltyCost: 0,
      geographicCohesionCost: 0,
      totalDistanceKm: 0,
      totalCo2Kg: 0,
      totalTimeWindowSlackMin: 0,
      totalDriverPenalty: 0,
    },
  };
}

function routeSnapshot(result: ALNSSolution): Record<string, string[]> {
  return Object.fromEntries(result.routes.map((item) => [
    item.vehicleId,
    item.nodes.map((node) => node.id),
  ]));
}

function assertFiniteSolution(
  result: { routes: ALNSRoute[]; unassigned: ALNSNode[] },
  vehicles: ALNSVehicle[],
  weights: OptimizationWeights = DEFAULT_WEIGHTS,
  expectedIds?: Set<string>,
  driverConstraintsMap: Map<string, ALNSDriverConstraints> = new Map(),
): void {
  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const ids = new Map<string, number>();
  const knownIds = expectedIds ?? new Set([
    ...result.routes.flatMap((item) => item.nodes.filter((node) => !node.isChargingStation).map((node) => node.id)),
    ...result.unassigned.map((node) => node.id),
  ]);
  for (const item of result.routes) {
    const vehicle = vehicleMap.get(item.vehicleId);
    assert.ok(vehicle, `unknown vehicle ${item.vehicleId}`);
    assert.ok(Number.isFinite(item.totalWeight));
    assert.ok(Number.isFinite(item.totalVolume));
    assert.ok(Math.abs(
      item.totalWeight
      - item.nodes.reduce((sum, node) => sum + (node.isChargingStation ? 0 : node.weightKg), 0),
    ) < 0.000_001);
    assert.ok(Math.abs(
      item.totalVolume
      - item.nodes.reduce((sum, node) => sum + (node.isChargingStation ? 0 : node.volumeM3), 0),
    ) < 0.000_001);
    assert.ok(item.totalWeight <= vehicle!.capacityKg + 0.000_001);
    assert.ok(item.totalVolume <= vehicle!.capacityVolume + 0.000_001);
    const evaluation = evaluateRoute(
      item,
      vehicle!,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      driverConstraintsMap.get(item.vehicleId),
    );
    assert.equal(evaluation.feasible, true, `${item.vehicleId} must be feasible`);
    assert.ok(Number.isFinite(evaluation.totalDistanceKm));
    assert.ok(Number.isFinite(evaluation.endTime.getTime()));
    for (const node of item.nodes) {
      if (!node.isChargingStation) ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
    }
  }
  for (const node of result.unassigned) ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
  assert.equal(ids.size, knownIds.size);
  for (const [id, count] of ids) {
    assert.ok(knownIds.has(id), `${id} must not be introduced by optimization`);
    assert.equal(count, 1, `${id} must occur exactly once`);
  }
  for (const id of knownIds) assert.equal(ids.get(id), 1, `${id} must be conserved exactly once`);
  const rescored = computeSolutionCost(
    solution(result.routes),
    vehicles,
    DEPOT.latitude,
    DEPOT.longitude,
    START,
    weights,
    new Map(),
  );
  assert.ok(Number.isFinite(rescored.cost));
  assert.ok(Object.values(rescored.breakdown).every((value) => Number.isFinite(value)));
}

test("minimum-vehicle planning consolidates across cluster boundaries without dropping jobs", async () => {
  const stops = fullPathStops().slice(0, 101).map(stop => ({
    ...stop, serviceDurationMin: 0.5, weightKg: 0, volumeM3: 0,
    timeWindowStart: null, timeWindowEnd: null,
  }));
  const vehicles = Array.from({length: 9}, (_, index) => makeVehicle(`global-minimum-${index}`));
  const originalFetch = globalThis.fetch;
  try {
    await warmSyntheticRoadMatrix(stops);
    globalThis.fetch = (async () => { throw new Error("External network disabled"); }) as typeof fetch;
    const result = await withRandom(() => 0.5, () => optimizeWithALNS(
      stops, vehicles, DEPOT.latitude, DEPOT.longitude, START, {
        timeLimitMs: 10_000, maxIterations: 0, localSearchTimeLimitMs: 0,
        vehicleDistributionMode: "minimize",
      }, () => {},
    ));
    assert.equal(result.unassigned.length, 0);
    assert.equal(result.routes.filter(route => route.nodes.some(node => !node.isChargingStation)).length, 1);
    assert.deepEqual(result.routes.flatMap(route => route.nodes.map(node => node.id)).sort(),
      stops.map(node => node.id).sort());
    for (const route of result.routes) {
      if (!route.nodes.length) continue;
      assert.equal(evaluateRoute(route, vehicles.find(vehicle => vehicle.id === route.vehicleId)!,
        DEPOT.latitude, DEPOT.longitude, START).feasible, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
    getDistanceCache().clear();
    clearOsrmCache();
  }
});

test("228-stop nine-resource planning respects unequal shifts and breaks in both distribution modes", async () => {
  const stops = fullPathStops().map(stop => ({
    ...stop, serviceDurationMin: 9, weightKg: 0, volumeM3: 0,
    timeWindowStart: null, timeWindowEnd: null,
  }));
  const shifts = [
    ["08:00", "15:30"], ["08:00", "15:30"], ["08:00", "15:30"],
    ["09:00", "15:30"], ["09:30", "15:30"], ["09:30", "16:00"],
    ["09:30", "16:00"], ["09:30", "16:30"], ["10:30", "16:00"],
  ];
  const vehicles = shifts.map((_, index) => makeVehicle(`shift-resource-${index}`));
  const driverConstraints: ALNSDriverConstraints[] = vehicles.map((vehicle, index) => ({
    vehicleId: vehicle.id, driverName: vehicle.id,
    preferredStartTime: shifts[index][0], preferredEndTime: shifts[index][1],
    breakStartTime: "12:00", breakEndTime: "12:45",
    maxDrivingHoursPerDay: 8, avoidNightDriving: false,
    breakFrequencyMinutes: 120, preferredBreakDurationMin: 15,
  }));
  const originalFetch = globalThis.fetch;
  try {
    for (const vehicleDistributionMode of ["balance", "minimize"] as const) {
      await warmSyntheticRoadMatrix(stops);
      globalThis.fetch = (async () => { throw new Error("External network disabled in synthetic acceptance"); }) as typeof fetch;
      const result = await withRandom(() => 0.5, () => optimizeWithALNS(
        stops, vehicles, DEPOT.latitude, DEPOT.longitude, START, {
          timeLimitMs: 2000, maxIterations: 4, localSearchTimeLimitMs: 50,
          vehicleDistributionMode, driverConstraints,
        }, () => {},
      ));
      const constraintsMap = new Map(driverConstraints.map(driver => [driver.vehicleId, driver]));
      const repairStartedAt = Date.now();
      reinsertUnassignedNodes(result, vehicles, constraintsMap,
        DEPOT.latitude, DEPOT.longitude, START,
        {weights: DEFAULT_WEIGHTS, vehicleDistributionMode});
      const repairMs = Date.now() - repairStartedAt;
      const allIds = [...result.routes.flatMap(route => route.nodes.filter(n => !n.isChargingStation)),
        ...result.unassigned].map(node => node.id);
      assert.equal(allIds.length, 228);
      assert.equal(new Set(allIds).size, 228);
      assert.deepEqual([...allIds].sort(), stops.map(node => node.id).sort());
      for (const route of result.routes) {
        if (!route.nodes.length) continue;
        assert.equal(evaluateRoute(route, vehicles.find(vehicle => vehicle.id === route.vehicleId)!,
          DEPOT.latitude, DEPOT.longitude, START, constraintsMap.get(route.vehicleId)).feasible, true);
      }
      assert.equal(result.performance.distanceSource, "cache");
      assert.equal(result.unassigned.length, 0, "synthetic workload fits after full-fleet reinsertion");
      assert.ok(result.performance.totalMs < 15_000, `synthetic planning took ${result.performance.totalMs}ms`);
      console.log("[nine-shift synthetic acceptance]", JSON.stringify({
        mode: vehicleDistributionMode, stops: allIds.length, unassigned: result.unassigned.length,
        activeResources: result.routes.filter(route => route.nodes.some(node => !node.isChargingStation)).length,
        solverMs: result.performance.totalMs, repairMs,
      }));
      globalThis.fetch = originalFetch;
    }
  } finally {
    globalThis.fetch = originalFetch;
    getDistanceCache().clear();
    clearOsrmCache();
  }
});

test("228-stop cooperative optimizer completes the real clustered path without starving timers", async () => {
  const stops = fullPathStops();
  const vehicles = Array.from({ length: 4 }, (_, index) => makeVehicle(`full-vehicle-${index}`));
  const driverConstraints = vehicles.map((vehicle) => ({
    vehicleId: vehicle.id,
    driverName: `Synthetic driver ${vehicle.id}`,
    preferredStartTime: "07:00",
    preferredEndTime: "19:00",
    maxDrivingHoursPerDay: 12,
    avoidNightDriving: false,
    breakFrequencyMinutes: 240,
    preferredBreakDurationMin: 30,
  }));

  await warmSyntheticRoadMatrix(stops);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("unexpected external road-matrix request");
  }) as typeof fetch;

  const progress: Array<{ phase: string; completedClusters: number; totalClusters: number; iterations: number }> = [];
  let maxGapMs = 0;
  let timerTicksBeforeCompletion = 0;
  let previousTick = Date.now();
  let completed = false;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - previousTick);
    previousTick = now;
    if (!completed) timerTicksBeforeCompletion++;
  }, 10);

  try {
    const result = await withRandom(() => 0, () => optimizeWithALNS(
      stops,
      vehicles,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      {
        timeLimitMs: 450,
        maxIterations: 1,
        maxNoImprovementIterations: 100,
        removalFraction: 0.05,
        localSearchTimeLimitMs: 25,
        distanceMatrixTimeoutMs: 1_000,
        driverConstraints,
      },
      (update) => progress.push({
        phase: update.phase,
        completedClusters: update.completedClusters,
        totalClusters: update.totalClusters,
        iterations: update.iterations,
      }),
    ));
    completed = true;

    const stats = result.performance.runStats;
    assert.ok(stats && "totalClusters" in stats);
    assert.ok(stats.totalClusters >= 2);
    assert.equal(stats.optimizedClusters, stats.totalClusters);
    assert.equal(result.performance.distanceSource, "cache");
    assert.ok(stats.iterations > 0);
    assert.ok(stats.improvements >= 0);
    assert.ok(Object.values(stats.clusterStopReasons).some((count) => (count ?? 0) > 0));
    assert.deepEqual(
      [...new Set(progress.map((update) => update.phase))],
      ["distance_matrix", "clustering", "optimizing", "merging", "complete"],
    );
    assert.ok(progress.some((update) =>
      update.phase === "optimizing"
      && update.completedClusters > 0
      && update.completedClusters < update.totalClusters
      && update.iterations > 0,
    ), "expected iteration telemetry before all clusters completed");
    assert.equal(progress.at(-1)?.phase, "complete");

    const assigned = result.routes.flatMap((item) => item.nodes.filter((node) => !node.isChargingStation));
    assert.equal(result.unassigned.length, 0);
    assert.equal(assigned.length, stops.length);
    assert.deepEqual(
      [...new Set(assigned.map((node) => node.id))].sort(),
      stops.map((node) => node.id).sort(),
    );
    assertFiniteSolution(
      result,
      vehicles,
      DEFAULT_WEIGHTS,
      new Set(stops.map((stop) => stop.id)),
      new Map(driverConstraints.map((constraints) => [constraints.vehicleId, constraints])),
    );
    assert.ok(maxGapMs < 500, `event-loop max gap was ${maxGapMs}ms`);
    assert.ok(timerTicksBeforeCompletion >= 2, "timers must run before optimization completion");
    console.log("[cooperative full path]", JSON.stringify({
      stopCount: stops.length,
      phases: [...new Set(progress.map((update) => update.phase))],
      totalClusters: stats.totalClusters,
      iterations: stats.iterations,
      improvements: stats.improvements,
      progressCount: progress.length,
      timerTicksBeforeCompletion,
      maxGapMs,
      performance: result.performance,
    }));
  } finally {
    completed = true;
    clearInterval(timer);
    globalThis.fetch = originalFetch;
    clearOsrmCache();
    getDistanceCache().clear();
  }
});

function localSearchFixture(): { candidate: ALNSSolution; vehicles: ALNSVehicle[] } {
  const route0Nodes = Array.from({ length: 5 }, (_, index) =>
    makeNode(`local-r0-${index}`, 59.33 + index * 0.002, 18.10 + index * 0.001));
  const route1Nodes = Array.from({ length: 5 }, (_, index) =>
    makeNode(`local-r1-${index}`, 59.33 + index * 0.002, 17.98 - index * 0.001));
  const route2Nodes = [
    makeNode("local-r2-0", 59.380, 18.050),
    makeNode("local-r2-4", 59.460, 18.080),
    makeNode("local-r2-1", 59.400, 18.055),
    makeNode("local-r2-3", 59.440, 18.075),
    makeNode("local-r2-2", 59.420, 18.065),
  ];
  const routeIds = [
    route0Nodes.map((node) => node.id),
    route1Nodes.map((node) => node.id),
    route2Nodes.map((node) => node.id),
  ];
  const vehicles = routeIds.map((ids, index) => makeVehicle(
    `local-vehicle-${index}`,
    new Set(routeIds.flatMap((otherIds, otherIndex) => otherIndex === index ? [] : otherIds)),
  ));
  return {
    candidate: solution([
      route(route0Nodes, vehicles[0].id),
      route(route1Nodes, vehicles[1].id),
      route(route2Nodes, vehicles[2].id),
    ]),
    vehicles,
  };
}

test("local-search synchronous and cooperative paths preserve candidate order and improve a later route", async () => {
  clearOsrmCache();
  getDistanceCache().clear();
  const { candidate, vehicles } = localSearchFixture();
  const sync = structuredClone(candidate) as ALNSSolution;
  const cooperative = structuredClone(candidate) as ALNSSolution;
  const beforeCost = computeSolutionCost(
    sync, vehicles, DEPOT.latitude, DEPOT.longitude, START, DEFAULT_WEIGHTS, new Map(),
  ).cost;

  localSearchPostProcess(
    sync, vehicles, DEPOT.latitude, DEPOT.longitude, START, DEFAULT_WEIGHTS, new Map(), 2_000,
  );
  const completed = await localSearchPostProcessCancellable(
    cooperative,
    vehicles,
    DEPOT.latitude,
    DEPOT.longitude,
    START,
    DEFAULT_WEIGHTS,
    new Map(),
    2_000,
    () => false,
  );

  assert.equal(completed, true);
  assert.deepEqual(cooperative, sync);
  assert.deepEqual(routeSnapshot(cooperative), routeSnapshot(sync));
  assert.notDeepEqual(
    cooperative.routes[2].nodes.map((node) => node.id),
    candidate.routes[2].nodes.map((node) => node.id),
    "the later route must receive a local-search improvement",
  );
  const afterCost = computeSolutionCost(
    cooperative, vehicles, DEPOT.latitude, DEPOT.longitude, START, DEFAULT_WEIGHTS, new Map(),
  ).cost;
  assert.ok(afterCost < beforeCost - 0.001);
  assertFiniteSolution(
    cooperative,
    vehicles,
    DEFAULT_WEIGHTS,
    new Set(candidate.routes.flatMap((item) => item.nodes.map((node) => node.id))),
  );
  console.log("[local-search cooperative parity]", JSON.stringify({
    beforeCost,
    afterCost,
    laterRoute: cooperative.routes[2].nodes.map((node) => node.id),
  }));
});

function crossClusterFixture(): { candidate: ALNSRoute[]; vehicles: ALNSVehicle[] } {
  const route0Nodes = [
    makeNode("merge-r0-0", 59.340, 18.100),
    makeNode("merge-r0-1", 59.350, 18.110),
    makeNode("merge-r0-2", 59.360, 18.120),
  ];
  const route1Nodes = [
    makeNode("merge-r1-0", 59.320, 17.980),
    makeNode("merge-r1-1", 59.310, 17.970),
    makeNode("merge-r1-2", 59.300, 17.960),
  ];
  const route2Nodes = [
    makeNode("merge-r2-far-0", 59.500, 18.500),
    makeNode("merge-border-late", 59.345, 18.105),
    makeNode("merge-r2-far-1", 59.510, 18.510),
  ];
  const vehicles = Array.from({ length: 3 }, (_, index) => makeVehicle(`merge-vehicle-${index}`));
  return {
    candidate: [
      route(route0Nodes, vehicles[0].id),
      route(route1Nodes, vehicles[1].id),
      route(route2Nodes, vehicles[2].id),
    ],
    vehicles,
  };
}

test("cross-cluster synchronous and cooperative paths match for a later border candidate", async () => {
  clearOsrmCache();
  getDistanceCache().clear();
  const { candidate, vehicles } = crossClusterFixture();
  const sync = structuredClone(candidate) as ALNSRoute[];
  const cooperative = structuredClone(candidate) as ALNSRoute[];
  const borderStopIds = new Set(["merge-border-late"]);
  const constraints = new Map();

  const beforeCost = computeSolutionCost(
    solution(sync), vehicles, DEPOT.latitude, DEPOT.longitude, START, DEFAULT_WEIGHTS, constraints,
  ).cost;
  crossClusterImprove(
    sync,
    borderStopIds,
    vehicles,
    DEPOT.latitude,
    DEPOT.longitude,
    START,
    DEFAULT_WEIGHTS,
    constraints,
    2_000,
  );
  await crossClusterImproveCooperative(
    cooperative,
    borderStopIds,
    vehicles,
    DEPOT.latitude,
    DEPOT.longitude,
    START,
    DEFAULT_WEIGHTS,
    constraints,
    2_000,
  );

  assert.deepEqual(cooperative, sync);
  const afterCost = computeSolutionCost(
    solution(cooperative), vehicles, DEPOT.latitude, DEPOT.longitude, START, DEFAULT_WEIGHTS, constraints,
  ).cost;
  assert.ok(afterCost < beforeCost - 0.01);
  assert.equal(
    cooperative[2].nodes.some((node) => node.id === "merge-border-late"),
    true,
  );
  assert.notDeepEqual(
    cooperative[2].nodes.map((node) => node.id),
    candidate[2].nodes.map((node) => node.id),
    "the later border candidate must be reconsidered",
  );
  assertFiniteSolution(
    { routes: cooperative, unassigned: [] },
    vehicles,
    DEFAULT_WEIGHTS,
    new Set(candidate.flatMap((item) => item.nodes.map((node) => node.id))),
  );
  console.log("[cross-cluster cooperative parity]", JSON.stringify({
    beforeCost,
    afterCost,
    routeSnapshot: routeSnapshot(solution(cooperative)),
  }));
});