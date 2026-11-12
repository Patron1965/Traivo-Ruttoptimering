import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSolutionFromCW,
  computeSolutionCost,
  DEFAULT_WEIGHTS,
  optimizeWithALNS,
  runALNS,
  type ALNSNode,
  type ALNSVehicle,
} from "./alns";
import { clearOsrmCache } from "./osrm";

const DEPOT = { lat: 59.3293, lon: 18.0686 };

test("clustered jobs expose aggregate search metrics without changing assignments", async () => {
  const nodes: ALNSNode[] = Array.from({ length: 101 }, (_, index) => ({
    id: `cluster-stop-${index}`,
    latitude: DEPOT.lat + (index % 10) * 0.002,
    longitude: DEPOT.lon + Math.floor(index / 10) * 0.002,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 2,
    weightKg: 1,
    volumeM3: 0.01,
  }));
  const vehicles: ALNSVehicle[] = Array.from({ length: 3 }, (_, index) => ({
    id: `cluster-vehicle-${index}`,
    vehicleType: "fossil",
    capacityKg: 1_000,
    capacityVolume: 100,
    rangeKm: null,
  }));
  const originalFetch = globalThis.fetch;
  const progressUpdates: Parameters<NonNullable<Parameters<typeof optimizeWithALNS>[6]>>[0][] = [];

  globalThis.fetch = (async (input) => {
    const coordinateText = new URL(String(input)).pathname.split("/").pop() ?? "";
    const coordinateCount = coordinateText.split(";").filter(Boolean).length;
    const distances = Array.from({ length: coordinateCount }, (_, row) =>
      Array.from({ length: coordinateCount }, (_, column) => row === column ? 0 : 1_000));
    const durations = Array.from({ length: coordinateCount }, (_, row) =>
      Array.from({ length: coordinateCount }, (_, column) => row === column ? 0 : 120));
    return new Response(JSON.stringify({ code: "Ok", distances, durations }), { status: 200 });
  }) as typeof fetch;

  try {
    clearOsrmCache();
    const result = await optimizeWithALNS(
      nodes, vehicles, DEPOT.lat, DEPOT.lon, new Date("2026-08-19T07:00:00.000Z"),
      { timeLimitMs: 5_000, maxIterations: 1, localSearchTimeLimitMs: 0 },
      progress => progressUpdates.push(progress),
    );
    const stats = result.performance.runStats;

    assert.ok(stats && "totalClusters" in stats);
    assert.equal(stats.totalClusters, 2);
    assert.equal(stats.optimizedClusters, 2);
    assert.equal(stats.iterations, 2);
    assert.equal(stats.clusterStopReasons.max_iterations, 2);
    assert.equal(stats.stopReason, "max_iterations");
    assert.deepEqual(
      [...new Set(progressUpdates.map(update => update.phase))],
      ["distance_matrix", "clustering", "optimizing", "merging", "complete"],
    );
    assert.ok(
      progressUpdates.some(update =>
        update.phase === "optimizing"
        && update.completedClusters > 0
        && update.completedClusters < update.totalClusters
        && update.iterations > 0
      ),
      "expected aggregate iteration telemetry before the final cluster completed",
    );
    assert.deepEqual(progressUpdates.at(-1), {
      totalClusters: 2,
      completedClusters: 2,
      phase: "complete",
      elapsedMs: progressUpdates.at(-1)?.elapsedMs,
      iterations: 2,
      improvements: stats.improvements,
      stopReason: "max_iterations",
      clusterStopReasons: { max_iterations: 2 },
    });
    assert.equal(result.performance.searchMs, result.performance.alnsSearchMs);
    assert.ok(result.performance.distanceMatrixMs >= 0);
    assert.ok(result.performance.clusteringMs >= 0);
    assert.ok(result.performance.alnsSearchMs >= 0);
    assert.ok(result.performance.mergingMs >= 0);

    const assigned = result.routes.flatMap(route => route.nodes.filter(node => !node.isChargingStation));
    assert.equal(result.unassigned.length, 0);
    assert.equal(assigned.length, nodes.length);
    assert.equal(new Set(assigned.map(node => node.id)).size, nodes.length);

    const rescored = computeSolutionCost(
      {
        routes: result.routes,
        unassigned: result.unassigned,
        cost: 0,
        costBreakdown: result.costBreakdown,
      },
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      new Date("2026-08-19T07:00:00.000Z"),
      DEFAULT_WEIGHTS,
    );
    assert.deepEqual(result.costBreakdown, rescored.breakdown);
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});

test("ALNS yields while publishing live iteration progress", async () => {
  const nodes: ALNSNode[] = Array.from({ length: 30 }, (_, index) => ({
    id: `live-stop-${index}`,
    latitude: DEPOT.lat + (index % 6) * 0.003,
    longitude: DEPOT.lon + Math.floor(index / 6) * 0.003,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 2,
    weightKg: 1,
    volumeM3: 0.01,
  }));
  const vehicles: ALNSVehicle[] = [{
    id: "live-vehicle",
    vehicleType: "fossil",
    capacityKg: 1_000,
    capacityVolume: 100,
    rangeKm: null,
  }];
  const startTime = new Date("2026-08-19T07:00:00.000Z");
  const initial = buildInitialSolutionFromCW(nodes, vehicles, DEPOT.lat, DEPOT.lon, startTime);
  const progress: { iterations: number; improvements: number; elapsedMs: number }[] = [];
  let timerTicks = 0;
  const timer = setInterval(() => { timerTicks++; }, 20);

  try {
    await runALNS(
      initial,
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      startTime,
      {
        timeLimitMs: 700,
        maxIterations: 1_000_000,
        maxNoImprovementIterations: 1_000_000,
        localSearchTimeLimitMs: 0,
      },
      update => progress.push(update),
    );
  } finally {
    clearInterval(timer);
  }

  assert.ok(progress.length >= 2, "expected multiple progress snapshots during the search");
  assert.ok(progress.at(-1)!.iterations > progress[0].iterations, "expected iterations to increase between snapshots");
  assert.ok(timerTicks >= 2, "expected the event loop to service timers during the search");
});