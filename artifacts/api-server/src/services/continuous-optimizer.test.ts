import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContinuousOptimizer,
  type ImprovementEvent,
} from "./continuous-optimizer";
import {
  runALNS,
  type ALNSNode,
  type ALNSRoute,
  type ALNSSolution,
  type ALNSVehicle,
} from "./alns";
import { clearOsrmCache } from "./osrm";

const DEPOT = { lat: 59.3293, lon: 18.0686 };

function fixtureNodes(count: number): ALNSNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `continuous-test-stop-${index}`,
    latitude: DEPOT.lat + (index % 8) * 0.001,
    longitude: DEPOT.lon + Math.floor(index / 8) * 0.001,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 2,
    weightKg: 1,
    volumeM3: 0.01,
  }));
}

const vehicles: ALNSVehicle[] = [{
  id: "continuous-test-vehicle",
  vehicleType: "fossil",
  capacityKg: 1_000,
  capacityVolume: 100,
  rangeKm: null,
}];

async function withMockedOsrm(run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const coordinateText = new URL(String(input)).pathname.split("/").pop() ?? "";
    const coordinateCount = coordinateText.split(";").filter(Boolean).length;
    const distances = Array.from({ length: coordinateCount }, (_, row) =>
      Array.from({ length: coordinateCount }, (_, column) => row === column ? 0 : 1_000));
    const durations = Array.from({ length: coordinateCount }, (_, row) =>
      Array.from({ length: coordinateCount }, (_, column) => row === column ? 0 : 120));
    return new Response(JSON.stringify({ code: "Ok", distances, durations }), { status: 200 });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
}

test("stop during initial setup prevents started and iteration events", async () => {
  await withMockedOsrm(async () => {
    clearOsrmCache();
    const optimizer = new ContinuousOptimizer(
      "00000000-0000-0000-0000-000000000101",
      fixtureNodes(12),
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      { microIterationMs: 100, maxIdleMinutes: 1, maxTotalMinutes: 1 },
    );
    let started = 0;
    let stopped = 0;
    optimizer.on("started", () => { started++; });
    optimizer.on("stopped", () => { stopped++; });

    const startPromise = optimizer.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    optimizer.stop();
    await startPromise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(started, 0);
    assert.equal(stopped, 1);
    assert.equal(optimizer.getStatus().running, false);
    assert.equal(optimizer.getStatus().iteration, 0);
  });
});

test("stop during live passes is idempotent and prevents later improvements", async () => {
  await withMockedOsrm(async () => {
    clearOsrmCache();
    const optimizer = new ContinuousOptimizer(
      "00000000-0000-0000-0000-000000000102",
      fixtureNodes(24),
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      { microIterationMs: 100, maxIdleMinutes: 1, maxTotalMinutes: 1 },
    );
    const improvements: ImprovementEvent[] = [];
    let stopped = 0;
    optimizer.on("improvement", (event: ImprovementEvent) => improvements.push(event));
    optimizer.on("stopped", () => { stopped++; });

    await optimizer.start();
    const iterationAtStop = optimizer.getStatus().iteration;
    optimizer.stop();
    optimizer.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(stopped, 1);
    assert.equal(optimizer.getStatus().running, false);
    assert.equal(optimizer.getStatus().iteration, iterationAtStop);
    assert.equal(
      improvements.some((event) => event.iteration > iterationAtStop),
      false,
    );
  });
});

test("automatic stop cannot be turned into a second manual stop", async () => {
  await withMockedOsrm(async () => {
    clearOsrmCache();
    const optimizer = new ContinuousOptimizer(
      "00000000-0000-0000-0000-000000000103",
      fixtureNodes(8),
      vehicles,
      DEPOT.lat,
      DEPOT.lon,
      { microIterationMs: 50, maxIdleMinutes: 1, maxTotalMinutes: 0.0001 },
    );
    let terminalEvents = 0;
    optimizer.on("timeout", () => { terminalEvents++; });
    optimizer.on("idle-timeout", () => { terminalEvents++; });

    await optimizer.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    optimizer.stop();

    assert.equal(terminalEvents, 1);
    assert.equal(optimizer.getStatus().running, false);
  });
});

test("cancellation yields through post-processing consolidation", async () => {
  await withMockedOsrm(async () => {
    const postProcessNodes = fixtureNodes(120);
    const postProcessVehicles: ALNSVehicle[] = Array.from({ length: 12 }, (_, index) => ({
      ...vehicles[0],
      id: `continuous-postprocess-vehicle-${index}`,
    }));
    const routes: ALNSRoute[] = postProcessVehicles.map((vehicle, index) => {
      const nodes = postProcessNodes.slice(index * 10, (index + 1) * 10);
      return {
        vehicleId: vehicle.id,
        nodes,
        totalWeight: nodes.reduce((total, node) => total + node.weightKg, 0),
        totalVolume: nodes.reduce((total, node) => total + node.volumeM3, 0),
      };
    });
    const initialSolution: ALNSSolution = {
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

    let cancel = false;
    let cancellationScheduled = false;
    const result = await runALNS(
      initialSolution,
      postProcessVehicles,
      DEPOT.lat,
      DEPOT.lon,
      new Date(),
      { maxIterations: 0, timeLimitMs: 100, localSearchTimeLimitMs: 0 },
      () => {
        if (!cancellationScheduled) {
          cancellationScheduled = true;
          setImmediate(() => setImmediate(() => { cancel = true; }));
        }
      },
      () => cancel,
    );

    assert.equal(cancel, true);
    assert.equal(result.runStats, undefined);
  });
});