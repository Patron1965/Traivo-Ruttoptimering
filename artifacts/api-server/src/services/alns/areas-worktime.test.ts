import assert from "node:assert/strict";
import { test } from "node:test";
import { clearOsrmCache, precomputeDistanceMatrix } from "../osrm";
import { withRequiredRoadData } from "../road-data-policy";
import { evaluateRouteWorkday } from "../route-workday";
import { computeSolutionCost, compareSolutionScores, evaluateRoute } from "./cost";
import { globalDistanceCache, haversineDistance } from "./distance-cache";
import { runALNS } from "./runner";
import { DEFAULT_WEIGHTS, type ALNSNode, type ALNSSolution, type ALNSVehicle, type OptimizationWeights } from "./types";

const weights: OptimizationWeights = { ...DEFAULT_WEIGHTS, geographicCohesionWeight: 0.5, objectivePriority: "areas_worktime" };
const empty = { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 };

test("areas hierarchy is lexicographic, independent of arbitrary scalar costs", () => {
  const score = (mandatory: number, missing: number, cohesion: number, spread: number, distance: number, invalid = 0) => ({
    cost: 1e99,
    breakdown: { ...empty, geographicCohesionCost: cohesion, totalDistanceKm: distance,
      areasWorktime: { infeasibleRoutes: invalid, unassignedMandatory: mandatory, unassignedCustomers: missing, worktimeSpreadMin: spread, routeWorkMinutes: { one: spread, two: 0 } } },
  });
  assert.ok(compareSolutionScores(score(0, 0, 1, 1000, 100000), score(0, 1, 0, 0, 0)) < 0);
  assert.ok(compareSolutionScores(score(0, 1, 1, 1000, 100000), score(1, 1, 0, 0, 0)) < 0);
  assert.ok(compareSolutionScores(score(0, 0, 0, 1000, 100000), score(0, 0, 0.01, 0, 0)) < 0);
  assert.ok(compareSolutionScores(score(0, 0, 0, 1, 100000), score(0, 0, 0, 2, 0)) < 0);
  assert.ok(compareSolutionScores(score(0, 0, 0, 1, 10), score(0, 0, 0, 1, 11)) < 0);
  assert.ok(compareSolutionScores(score(0, 2, 1, 1000, 100000), score(0, 0, 0, 0, 0, 1)) < 0);
});

test("deterministic same-matrix noncoincident acceptance reports coverage, cohesion, real work, distance and runtime", async () => {
  // Explicit synthetic road fixture, not customer data or a live-plan claim.
  const depot = { latitude: 59.3293, longitude: 18.0686 };
  const start = new Date("2026-09-01T06:00:00Z");
  const nodes: ALNSNode[] = Array.from({ length: 12 }, (_, i) => ({
    id: `fixture-${i}`, latitude: (i < 6 ? 59.40 : 59.28) + (i % 6) * 0.0012,
    longitude: (i < 6 ? 18.02 : 18.13) + (i % 3) * 0.002,
    timeWindowStart: null, timeWindowEnd: null, serviceDurationMin: i < 6 ? 30 : 8,
    weightKg: 1, volumeM3: 1, planningPriority: i === 0 ? 2 : 0,
  }));
  const vehicles: ALNSVehicle[] = ["north", "south"].map(id => ({
    id, vehicleType: "fossil", capacityKg: 6, capacityVolume: 6, rangeKm: null,
    canonicalDriverConstraints: { vehicleId: id, driverName: id, preferredStartTime: "08:00", preferredEndTime: "16:00",
      maxDrivingHoursPerDay: 8, avoidNightDriving: false, breakFrequencyMinutes: 240, preferredBreakDurationMin: 30 },
  }));
  const initial: ALNSSolution = { routes: vehicles.map((v, index) => ({
    vehicleId: v.id, nodes: nodes.filter((_, i) => i % 2 === index), totalWeight: 6, totalVolume: 6,
  })), unassigned: [], cost: 0, costBreakdown: empty };
  const originalFetch = globalThis.fetch, originalRandom = Math.random, provider = process.env.OPERATIONAL_ROAD_PROVIDER;
  process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
  clearOsrmCache(); globalDistanceCache.clear();
  const coords = [depot, ...nodes];
  const distances = coords.map((a, i) => coords.map((b, j) =>
    i === j ? 0 : haversineDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1350 + 120 + (i < j ? 80 : 0)));
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "Ok", distances,
    durations: distances.map(row => row.map(m => m / 9)) }))) as typeof fetch;
  try {
    await precomputeDistanceMatrix(coords.map(n => ({ lat: n.latitude, lon: n.longitude })));
    globalThis.fetch = (async () => { throw new Error("provider calls forbidden after fixture warmup"); }) as typeof fetch;
    await withRequiredRoadData(async () => {
      const run = async (objective: OptimizationWeights) => {
        let seed = 81;
        Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const began = performance.now();
        const result = await runALNS(initial, vehicles, depot.latitude, depot.longitude, start,
          { weights: objective, vehicleDistributionMode: "balance", maxIterations: 100, timeLimitMs: 30000, localSearchTimeLimitMs: 0 });
        const score = computeSolutionCost(result, vehicles, depot.latitude, depot.longitude, start, weights);
        return { result, score, runtimeMs: Math.round(performance.now() - began) };
      };
      const before = await run({ ...DEFAULT_WEIGHTS, geographicCohesionWeight: 0.5 });
      const after = await run(weights);
      const repeated = await run(weights);
      assert.deepEqual(after.result.routes, repeated.result.routes);
      for (const { result } of [before, after]) {
        assert.equal(result.unassigned.length, 0);
        assert.equal(result.routes.filter(r => r.nodes.length).length, 2);
        assert.deepEqual(result.routes.flatMap(r => r.nodes.map(n => n.id)).sort(), nodes.map(n => n.id).sort());
        assert.ok(result.routes.every((r, i) => evaluateRoute(r, vehicles[i], depot.latitude, depot.longitude, start).feasible));
      }
      // Minimax can also let the scalar objective find separated areas; the
      // explicit geographic hierarchy must improve the interleaved input and
      // be at least as cohesive as that now-corrected scalar objective.
      const initialScore = computeSolutionCost(initial, vehicles, depot.latitude, depot.longitude, start, weights);
      assert.ok(after.score.breakdown.geographicCohesionCost < initialScore.breakdown.geographicCohesionCost);
      assert.ok(after.score.breakdown.geographicCohesionCost <= before.score.breakdown.geographicCohesionCost);
      // Waiting, lunch and planning reserves must not masquerade as work.
      const delayed = { ...nodes[0], timeWindowStart: new Date("2026-09-01T09:00:00Z"), stopReserveMin: 20 };
      const delayedRoute = { ...initial.routes[0], nodes: [delayed], totalWeight: 1, totalVolume: 1 };
      const reservedVehicle = { ...vehicles[0], travelReservePercent: 30 };
      const workday = evaluateRouteWorkday(delayedRoute.nodes, reservedVehicle, depot.latitude, depot.longitude, start);
      const evaluation = evaluateRoute(delayedRoute, reservedVehicle, depot.latitude, depot.longitude, start);
      assert.ok(workday.summary.waitingMin > 0);
      assert.ok(workday.summary.travelReserveMin > 0);
      assert.ok(Math.abs(evaluation.actualWorkMinutes! -
        (workday.summary.nonReturnDrivingMin + workday.summary.returnMin + workday.summary.serviceMin)) < 1e-9);
      assert.ok(evaluation.actualWorkMinutes! < workday.summary.totalMin);
      console.log("AREAS_WORKTIME_SYNTHETIC_SAME_MATRIX", JSON.stringify(Object.fromEntries(
        Object.entries({ before, after }).map(([name, value]) => [name, {
          coverage: 12 - value.result.unassigned.length, cohesion: value.score.breakdown.geographicCohesionCost,
          workMinutes: value.score.breakdown.areasWorktime!.routeWorkMinutes,
          workSpreadMin: value.score.breakdown.areasWorktime!.worktimeSpreadMin,
          distanceKm: value.score.breakdown.totalDistanceKm, runtimeMs: value.runtimeMs,
        }]))));
    });
  } finally {
    globalThis.fetch = originalFetch; Math.random = originalRandom;
    if (provider === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER; else process.env.OPERATIONAL_ROAD_PROVIDER = provider;
    clearOsrmCache(); globalDistanceCache.clear();
  }
});
