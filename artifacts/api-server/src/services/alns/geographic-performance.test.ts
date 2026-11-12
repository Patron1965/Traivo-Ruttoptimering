import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { clearOsrmCache, precomputeDistanceMatrix } from "../osrm";
import { withRequiredRoadData } from "../road-data-policy";
import { globalDistanceCache, haversineDistance } from "./distance-cache";
import { localAssignmentCost } from "./geographic-neighborhood";
import { computeSolutionCost } from "./cost";
import { geographicGroupSearch } from "./operators/geographic-search";
import { DEFAULT_WEIGHTS, type ALNSNode, type ALNSSolution, type ALNSVehicle } from "./types";

test("228-stop controlled-road scoring budget, with no provider requests during scoring", async () => {
  const provider = process.env.OPERATIONAL_ROAD_PROVIDER;
  const originalFetch = globalThis.fetch;
  process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
  clearOsrmCache();
  globalDistanceCache.clear();
  const nodes: ALNSNode[] = Array.from({ length: 228 }, (_, i) => ({
    id: `benchmark-${i}`, latitude: 59.25 + Math.floor(i / 19) * 0.008,
    longitude: 18 + (i % 19) * 0.001,
    timeWindowStart: null, timeWindowEnd: null, serviceDurationMin: 5,
    weightKg: 1, volumeM3: 0.01,
  }));
  const vehicles: ALNSVehicle[] = Array.from({ length: 9 }, (_, i) => ({
    id: `vehicle-${i}`, vehicleType: "fossil", capacityKg: 10000, capacityVolume: 100, rangeKm: null,
  }));
  const solution: ALNSSolution = {
    routes: vehicles.map((v, i) => {
      const assigned = nodes.filter((_, j) => j % vehicles.length === i);
      return { vehicleId: v.id, nodes: assigned, totalWeight: assigned.length, totalVolume: assigned.length * 0.01 };
    }),
    unassigned: [], cost: 0, costBreakdown: {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0,
      totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    },
  };
  let requests = 0;
  globalThis.fetch = (async input => {
    requests++;
    const coordinates = new URL(String(input)).pathname.split("/").pop()!.split(";").map(pair => pair.split(",").map(Number));
    const distances = coordinates.map(([lon, lat]) => coordinates.map(([otherLon, otherLat]) =>
      1300 * haversineDistance(lat, lon, otherLat, otherLon)));
    return new Response(JSON.stringify({ code: "Ok", distances, durations: distances.map(row => row.map(m => m / 10)) }));
  }) as typeof fetch;
  try {
    await precomputeDistanceMatrix(nodes.map(n => ({ lat: n.latitude, lon: n.longitude })));
    globalThis.fetch = (async () => { throw new Error("unexpected scoring request"); }) as typeof fetch;
    const weights = { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 10 };
    const start = new Date("2026-01-01T07:00:00Z");
    const samples = 100;
    const measure = (fn: () => number) => {
      const begin = performance.now();
      let value = 0;
      for (let i = 0; i < samples; i++) value = fn();
      return { meanMs: (performance.now() - begin) / samples, value };
    };
    const coldStarted = performance.now();
    withRequiredRoadData(() => localAssignmentCost(solution.routes));
    const coldGraphMs = performance.now() - coldStarted;
    const metric = withRequiredRoadData(() => measure(() => localAssignmentCost(solution.routes)));
    const wholePlan = withRequiredRoadData(() => measure(() => computeSolutionCost(solution, vehicles,
      nodes[0].latitude, nodes[0].longitude, start, weights, new Map(), "balance").cost));
    const disabledObjective = withRequiredRoadData(() => measure(() => computeSolutionCost(solution, vehicles,
      nodes[0].latitude, nodes[0].longitude, start, { ...weights, geographicCohesionWeight: 0 }, new Map(), "balance").cost));
    const candidate = structuredClone(solution);
    const groupStarted = performance.now();
    await withRequiredRoadData(() => geographicGroupSearch(candidate, vehicles, nodes[0].latitude, nodes[0].longitude,
      start, weights, new Map(), "balance", 0, () => performance.now() - groupStarted >= 100));
    const boundedGroupMs = performance.now() - groupStarted;
    console.log("[geographic scoring budget]", JSON.stringify({ stops: 228, samples, matrixRequests: requests, coldGraphMs, metric, wholePlan, disabledObjective, boundedGroupMs }));
    assert.ok(metric.value > 0 && metric.value <= 1);
    assert.ok(Number.isFinite(wholePlan.value));
    // Generous CI budget; measured values are reported, not treated as a real-plan SLA.
    assert.ok(metric.meanMs < 10);
    assert.ok(wholePlan.meanMs < 50);
    assert.ok(boundedGroupMs < 500, "100-ms cooperative budget may overrun by at most an in-flight bounded evaluation");
    assert.ok(localAssignmentCost(candidate.routes) <= metric.value);
  } finally {
    globalThis.fetch = originalFetch;
    if (provider === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER;
    else process.env.OPERATIONAL_ROAD_PROVIDER = provider;
    clearOsrmCache();
    globalDistanceCache.clear();
  }
});
