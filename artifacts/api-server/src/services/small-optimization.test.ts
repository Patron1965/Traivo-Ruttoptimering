import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSolutionFromCW,
  computeSolutionCost,
  DEFAULT_WEIGHTS,
  optimizeWithALNS,
  policyToALNSConfig,
  resolveOptimizationPolicy,
  type ALNSNode,
  type ALNSVehicle,
} from "./alns";
import { clearOsrmCache } from "./osrm";

const DEPOT = { lat: 59.3293, lon: 18.0686 };

function totalCost(breakdown: {
  distanceCost: number;
  co2Cost: number;
  etaPrecisionCost: number;
  driverPenaltyCost: number;
}) {
  return breakdown.distanceCost
    + breakdown.co2Cost
    + breakdown.etaPrecisionCost
    + breakdown.driverPenaltyCost;
}

test("a cached nine-stop P&D and EV job finishes quickly without losing validity or quality", async () => {
  const nodes: ALNSNode[] = Array.from({ length: 9 }, (_, index) => ({
    id: `stop-${index + 1}`,
    latitude: DEPOT.lat + 0.006 * Math.sin(index),
    longitude: DEPOT.lon + 0.009 * Math.cos(index),
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 50,
    volumeM3: 0.2,
    ...(index === 0
      ? {
          pickupLat: DEPOT.lat - 0.004,
          pickupLon: DEPOT.lon - 0.006,
          pickupServiceMin: 5,
        }
      : {}),
  }));
  const vehicles: ALNSVehicle[] = [{
    id: "electric-vehicle",
    vehicleType: "electric",
    capacityKg: 2_000,
    capacityVolume: 20,
    rangeKm: 400,
  }];
  const startTime = new Date("2026-08-19T07:00:00.000Z");
  const policy = resolveOptimizationPolicy(nodes.length);
  const config = policyToALNSConfig(policy);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async (input) => {
    requestCount++;
    const coordinateText = new URL(String(input)).pathname.split("/").pop() ?? "";
    const coordinateCount = coordinateText.split(";").filter(Boolean).length;
    const distances = Array.from({ length: coordinateCount }, (_, row) =>
      Array.from({ length: coordinateCount }, (_, column) => row === column ? 0 : 1_000));
    const durations = Array.from({ length: coordinateCount }, (_, row) =>
      Array.from({ length: coordinateCount }, (_, column) => row === column ? 0 : 120));

    return new Response(JSON.stringify({ code: "Ok", distances, durations }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    clearOsrmCache();

    const first = await optimizeWithALNS(
      nodes,
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      startTime,
      config,
    );
    const firstRequestCount = requestCount;
    assert.equal(first.performance.distanceSource, "osrm");

    const second = await optimizeWithALNS(
      nodes,
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      startTime,
      config,
    );

    assert.equal(second.performance.distanceSource, "cache");
    assert.equal(requestCount, firstRequestCount, "warm optimization should not call OSRM again");
    assert.ok(second.performance.totalMs < 10_000, `optimization took ${second.performance.totalMs}ms`);
    assert.equal(second.performance.runStats?.stopReason, "no_improvement");
    assert.ok((second.performance.runStats?.iterations ?? 10_000) < 10_000);

    const assigned = second.routes.flatMap(route =>
      route.nodes.filter(node => !node.isChargingStation));
    assert.equal(second.unassigned.length, 0);
    assert.equal(assigned.length, nodes.length);
    assert.equal(new Set(assigned.map(node => node.id)).size, nodes.length);

    const pdOrder = assigned.filter(node => node.id === "stop-1");
    assert.equal(pdOrder.length, 1);
    assert.equal(pdOrder[0].pickupLat, nodes[0].pickupLat);
    assert.equal(pdOrder[0].pickupLon, nodes[0].pickupLon);

    for (const evaluation of second.routeEvaluations.values()) {
      assert.equal(evaluation.feasible, true);
      assert.ok(evaluation.rangeUsedKm <= vehicles[0].rangeKm!);
    }

    const initial = buildInitialSolutionFromCW(
      nodes,
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      startTime,
    );
    const initialCost = computeSolutionCost(
      initial,
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      startTime,
      DEFAULT_WEIGHTS,
      new Map(),
    ).cost;
    assert.ok(
      totalCost(second.costBreakdown) <= initialCost + 0.000_001,
      "the adaptive search must never return a solution worse than its valid starting solution",
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});