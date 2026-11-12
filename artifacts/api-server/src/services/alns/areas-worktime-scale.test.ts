import assert from "node:assert/strict";
import { test } from "node:test";
import { clearOsrmCache, precomputeDistanceMatrix } from "../osrm";
import { withRequiredRoadData } from "../road-data-policy";
import { globalDistanceCache, haversineDistance } from "./distance-cache";
import { optimizeWithALNS } from "./runner";
import { computeSolutionCost } from "./cost";
import type { ALNSNode, ALNSVehicle, OptimizationWeights } from "./types";

test("228 stops / nine shifts: bounded cached directional road benchmark", { timeout: 90000 }, async () => {
  const depot = { lat: 59.3293, lon: 18.0686 };
  const start = new Date("2026-09-01T06:00:00Z");
  const nodes: ALNSNode[] = Array.from({ length: 228 }, (_, i) => {
    const area = i % 9, cell = Math.floor(i / 9);
    return { id: `scale-${String(i).padStart(3, "0")}`,
      latitude: 59.27 + Math.floor(area / 3) * 0.048 + Math.floor(cell / 5) * 0.0013,
      longitude: 17.98 + (area % 3) * 0.075 + (cell % 5) * 0.0021,
      serviceDurationMin: 10 + (i * 7 % 9), weightKg: 1, volumeM3: 0.01,
      timeWindowStart: null, timeWindowEnd: null, planningPriority: i < 9 ? 2 : 0 };
  });
  const vehicles: ALNSVehicle[] = Array.from({ length: 9 }, (_, i) => ({
    id: `driver-${i}`, vehicleType: "fossil", capacityKg: 1e9, capacityVolume: 1e9, rangeKm: null,
    maxDriverOvertimeMin: 0,
    canonicalDriverConstraints: { vehicleId: `driver-${i}`, driverName: `driver-${i}`,
      preferredStartTime: "08:00", preferredEndTime: "16:00", maxDrivingHoursPerDay: 8,
      avoidNightDriving: false, breakFrequencyMinutes: 240, preferredBreakDurationMin: 30 },
  }));
  const originalFetch = globalThis.fetch, originalRandom = Math.random, provider = process.env.OPERATIONAL_ROAD_PROVIDER;
  process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
  clearOsrmCache(); globalDistanceCache.clear();
  let fixtureRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fixtureRequests++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const coordinates = url.pathname.split("/driving/")[1].split(";").map(pair => pair.split(",").map(Number));
    const distances = coordinates.map(([lon, lat]) => coordinates.map(([toLon, toLat]) =>
      lon === toLon && lat === toLat ? 0 : haversineDistance(lat, lon, toLat, toLon) * 1350 + 100 + (lat < toLat ? 90 : 0)));
    return new Response(JSON.stringify({ code: "Ok", distances, durations: distances.map(row => row.map(m => m / 9)) }));
  }) as typeof fetch;
  try {
    await precomputeDistanceMatrix([depot, ...nodes.map(n => ({ lat: n.latitude, lon: n.longitude }))]);
    globalThis.fetch = (async () => { throw new Error("external calls forbidden; matrix must already be complete"); }) as typeof fetch;
    const weights: OptimizationWeights = { distanceWeight: 0, co2Weight: 0, etaPrecisionWeight: 0,
      driverHappinessWeight: 0, geographicCohesionWeight: 1, objectivePriority: "areas_worktime" };
    await withRequiredRoadData(async () => {
      let baselineCoverage = 0;
      for (const [name, objective] of [["before", { ...weights, objectivePriority: undefined }], ["after", weights]] as const) {
        let seed = 81;
        Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const began = performance.now();
        const result = await optimizeWithALNS(nodes, vehicles, depot.lat, depot.lon, start, {
          weights: objective, vehicleDistributionMode: "balance", timeLimitMs: 12000,
          localSearchTimeLimitMs: 0, maxIterations: 10000,
        });
        const runtimeMs = Math.round(performance.now() - began);
        const score = computeSolutionCost({ ...result, cost: 0 }, vehicles, depot.lat, depot.lon, start, weights);
        const identities = [...result.routes.flatMap(r => r.nodes.filter(n => !n.isChargingStation)), ...result.unassigned];
        assert.deepEqual(identities.map(n => n.id).sort(), nodes.map(n => n.id).sort());
        assert.equal(score.breakdown.areasWorktime!.infeasibleRoutes, 0);
        console.log("AREAS_WORKTIME_SCALE_SYNTHETIC", JSON.stringify({
          name, stops: 228, coverage: 228 - result.unassigned.length, mandatoryMissing: score.breakdown.areasWorktime!.unassignedMandatory,
          activeResources: result.routes.filter(r => r.nodes.some(n => !n.isChargingStation)).length,
          cohesion: score.breakdown.geographicCohesionCost, workMinutes: score.breakdown.areasWorktime!.routeWorkMinutes,
          spreadMin: score.breakdown.areasWorktime!.worktimeSpreadMin, distanceKm: score.breakdown.totalDistanceKm,
          runtimeMs, constructionAndFinalMs: result.performance.totalMs - result.performance.distanceMatrixMs
            - result.performance.clusteringMs - result.performance.searchMs - result.performance.mergingMs,
          performance: result.performance, mockedWarmupRequests: fixtureRequests, providerRequests: 0,
        }));
        if (name === "before") baselineCoverage = 228 - result.unassigned.length;
        else {
          assert.ok(runtimeMs < 12500, `whole optimization exceeded budget plus final validation tolerance: ${runtimeMs}ms`);
          assert.ok(228 - result.unassigned.length >= baselineCoverage);
          assert.equal(result.routes.filter(r => r.nodes.some(n => !n.isChargingStation)).length, 9);
        }
      }
    });
  } finally {
    globalThis.fetch = originalFetch; Math.random = originalRandom;
    if (provider === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER; else process.env.OPERATIONAL_ROAD_PROVIDER = provider;
    clearOsrmCache(); globalDistanceCache.clear();
  }
});
