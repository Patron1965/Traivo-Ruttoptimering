import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSolutionCost, evaluateRoute, evaluateRouteCost } from "./cost";
import { localSearchPostProcess } from "./operators/local-search";
import { buildInitialSolutionFromCW, optimizeWithALNS, runALNS } from "./runner";
import { evaluateRouteWorkday } from "../route-workday";
import { DEFAULT_WEIGHTS } from "./types";
import type { ALNSNode, ALNSRoute, ALNSSolution, ALNSVehicle, OptimizationWeights } from "./types";

const DEPOT = { lat: 59.3293, lon: 18.0686 };
const START = new Date("2026-01-01T07:00:00.000Z");
const vehicle: ALNSVehicle = {
  id: "objective-vehicle",
  vehicleType: "fossil",
  capacityKg: 1_000,
  capacityVolume: 100,
  rangeKm: null,
};
const weights: OptimizationWeights = {
  distanceWeight: 0.001,
  co2Weight: 0,
  etaPrecisionWeight: 1,
  driverHappinessWeight: 0,
  geographicCohesionWeight: 0,
};

function node(
  id: string,
  latitude: number,
  longitude: number,
  timeWindowStart: string | null,
  timeWindowEnd: string | null,
): ALNSNode {
  return {
    id,
    latitude,
    longitude,
    timeWindowStart: timeWindowStart ? new Date(timeWindowStart) : null,
    timeWindowEnd: timeWindowEnd ? new Date(timeWindowEnd) : null,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
  };
}

test("route evaluation waits through a delivery closure before accepting the route", () => {
  const closureNode = {
    ...node("closed", DEPOT.lat, DEPOT.lon, null, null),
    serviceDurationMin: 20,
    unavailablePeriods: [{
      start: new Date(START.getTime() + 5 * 60_000).toISOString(),
      end: new Date(START.getTime() + 15 * 60_000).toISOString(),
    }],
  };
  const route: ALNSRoute = {
    vehicleId: vehicle.id,
    nodes: [closureNode],
    totalWeight: 1,
    totalVolume: 0.1,
  };
  const evaluation = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, START);
  assert.equal(evaluation.feasible, true);
  assert.equal(
    evaluation.endTime.toISOString(),
    new Date(START.getTime() + 35 * 60_000).toISOString(),
  );
});

test("balanced costs use canonical driver shifts, not midnight or a stale constraint map", () => {
  const shift = {
    vehicleId: vehicle.id, driverName: "Synthetic driver",
    preferredStartTime: "08:00", preferredEndTime: "16:00",
    maxDrivingHoursPerDay: 8, avoidNightDriving: false,
    breakFrequencyMinutes: 120, preferredBreakDurationMin: 15,
  };
  const second = { ...vehicle, id: "second" };
  const shifts = [shift, { ...shift, vehicleId: second.id, preferredStartTime: "10:00", preferredEndTime: "18:00" }];
  const vehicles = [vehicle, second];
  const solution: ALNSSolution = {
    routes: vehicles.map(v => ({
      vehicleId: v.id, totalWeight: 1, totalVolume: 0.1,
      nodes: [{ ...node(v.id, DEPOT.lat, DEPOT.lon, null, null), serviceDurationMin: 60 }],
    })),
    unassigned: [], cost: 0,
    costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
  };
  const date = new Date("2026-01-01T00:00:00Z");
  const expected = computeSolutionCost(solution, vehicles, DEPOT.lat, DEPOT.lon, date, weights,
    new Map(shifts.map(s => [s.vehicleId, s])), "balance");
  const canonicalVehicles = vehicles.map((v, index) => ({ ...v, canonicalDriverConstraints: shifts[index] }));
  for (const map of [undefined, new Map(shifts.map(s => [s.vehicleId, { ...s, preferredStartTime: "06:00" }]))]) {
    assert.deepEqual(computeSolutionCost(solution, canonicalVehicles, DEPOT.lat, DEPOT.lon, date, weights, map, "balance"), expected);
  }
});

test("both distribution modes retain feasible coverage without overtime after lunch deferral", async () => {
  // Co-located synthetic visits: no matrix provider or external API is needed.
  const vehicles = ["one", "two"].map(id => ({
    ...vehicle, id, maxDriverOvertimeMin: 0,
    canonicalDriverConstraints: {
      vehicleId: id, driverName: id, preferredStartTime: "08:00", preferredEndTime: "10:00",
      maxDrivingHoursPerDay: 2, avoidNightDriving: false,
      breakFrequencyMinutes: 120, preferredBreakDurationMin: 15,
      breakStartTime: "08:30", breakEndTime: "08:45",
    },
  }));
  const stops = ["a", "b", "c"].map(id => ({
    ...node(id, DEPOT.lat, DEPOT.lon, null, null), serviceDurationMin: 60,
  }));
  for (const mode of ["minimize", "balance"] as const) {
    const initial = buildInitialSolutionFromCW(stops, vehicles, DEPOT.lat, DEPOT.lon, START, mode);
    const result = await runALNS(initial, vehicles, DEPOT.lat, DEPOT.lon, START, {
      maxIterations: 10, timeLimitMs: 500, localSearchTimeLimitMs: 0, vehicleDistributionMode: mode,
    });
    assert.equal(result.unassigned.length, 1, `${mode}: only two complete visits fit`);
    assert.equal(result.routes.flatMap(route => route.nodes).length, 2);
    for (const route of result.routes) {
      const workday = evaluateRouteWorkday(route.nodes, vehicles.find(v => v.id === route.vehicleId)!,
        DEPOT.lat, DEPOT.lon, START);
      assert.equal(workday.feasible, true);
      assert.equal(workday.summary.overtimeMin, 0);
      assert.ok(workday.summary.totalMin <= workday.summary.shiftMin);
      assert.ok(workday.events.filter(event => event.type === "service")
        .every(event => event.durationMin === 60));
    }
  }
});

test("local search accepts a feasible composite improvement despite longer distance", () => {
  const nodes = [
    node("a", 59.297674663032595, 18.047683307795225, null, null),
    node(
      "b",
      59.32980904387608,
      18.101381322188676,
      "2026-01-01T07:29:05.871Z",
      "2026-01-01T10:01:17.642Z",
    ),
    node(
      "c",
      59.3622715554975,
      18.077590171290932,
      "2026-01-01T07:22:58.126Z",
      "2026-01-01T11:00:38.047Z",
    ),
  ];
  const route: ALNSRoute = {
    vehicleId: vehicle.id,
    nodes,
    totalWeight: 3,
    totalVolume: 0.3,
  };
  const solution: ALNSSolution = {
    routes: [route],
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

  const before = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, START);
  const beforeCost = evaluateRouteCost(before, weights);
  localSearchPostProcess(
    solution,
    [vehicle],
    DEPOT.lat,
    DEPOT.lon,
    START,
    weights,
    new Map(),
    1_000,
    1,
  );
  const after = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, START);
  const afterCost = evaluateRouteCost(after, weights);

  assert.equal(before.feasible, true);
  assert.equal(after.feasible, true);
  assert.ok(after.totalDistanceKm > before.totalDistanceKm);
  assert.ok(afterCost < beforeCost);
  assert.deepEqual(
    route.nodes.map((currentNode) => currentNode.id),
    ["a", "c", "b"],
  );
});

test("non-clustered final score is recomputed after an invalid route is pruned", async () => {
  const blockedNode = node("blocked", 59.4101, 18.2011, null, null);
  const blockedVehicle: ALNSVehicle = {
    ...vehicle,
    id: "blocked-vehicle",
    ineligibleStopIds: new Set(["blocked"]),
  };
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.OPERATIONAL_ROAD_PROVIDER;
  process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "Ok",
    distances: [[0, 1_000], [1_000, 0]],
    durations: [[0, 60], [60, 0]],
  }), { status: 200 })) as typeof fetch;

  try {
    const result = await optimizeWithALNS(
      [blockedNode],
      [blockedVehicle],
      DEPOT.lat,
      DEPOT.lon,
      START,
      {
        distanceMatrixTimeoutMs: 100,
        maxIterations: 1,
        localSearchTimeLimitMs: 0,
      },
    );
    const expected = computeSolutionCost(
      {
        routes: result.routes,
        unassigned: result.unassigned,
        cost: 0,
        costBreakdown: result.costBreakdown,
      },
      [blockedVehicle],
      DEPOT.lat,
      DEPOT.lon,
      START,
      DEFAULT_WEIGHTS,
    );

    assert.deepEqual(result.costBreakdown, expected.breakdown);
    assert.deepEqual(result.unassigned.map((currentNode) => currentNode.id), ["blocked"]);
    assert.equal(
      result.routes.flatMap((route) => route.nodes).filter((currentNode) => !currentNode.isChargingStation).length,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER;
    else process.env.OPERATIONAL_ROAD_PROVIDER = originalProvider;
  }
});

test("balance-mode postprocess cannot trade a global work-spread regression for a route-only gain", async () => {
  const balanceWeights: OptimizationWeights = {
    distanceWeight: 0.001,
    co2Weight: 0,
    etaPrecisionWeight: 1,
    driverHappinessWeight: 0,
    geographicCohesionWeight: 0,
  };
  const firstVehicle: ALNSVehicle = {
    ...vehicle,
    id: "balance-first",
    capacityKg: 3,
  };
  const secondVehicle: ALNSVehicle = {
    ...vehicle,
    id: "balance-second",
    capacityKg: 3,
  };
  const firstRouteNodes = [
    node("balance-a", 59.297674663032595, 18.047683307795225, null, null),
    node(
      "balance-b",
      59.32980904387608,
      18.101381322188676,
      "2026-01-01T07:29:05.871Z",
      "2026-01-01T10:01:17.642Z",
    ),
    node(
      "balance-c",
      59.3622715554975,
      18.077590171290932,
      "2026-01-01T07:22:58.126Z",
      "2026-01-01T11:00:38.047Z",
    ),
  ];
  const secondRouteNodes = [
    node("balance-d", 59.34, 18.08, null, null),
    node("balance-e", 59.35, 18.09, null, null),
    node("balance-f", 59.36, 18.1, null, null),
  ];
  const route = (vehicleId: string, nodes: ALNSNode[]): ALNSRoute => ({
    vehicleId,
    nodes,
    totalWeight: nodes.reduce((sum, currentNode) => sum + currentNode.weightKg, 0),
    totalVolume: nodes.reduce((sum, currentNode) => sum + currentNode.volumeM3, 0),
  });
  const initial: ALNSSolution = {
    routes: [
      route(firstVehicle.id, firstRouteNodes),
      route(secondVehicle.id, secondRouteNodes),
    ],
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
  const vehicles = [firstVehicle, secondVehicle];
  const baseline = computeSolutionCost(
    initial,
    vehicles,
    DEPOT.lat,
    DEPOT.lon,
    START,
    balanceWeights,
    new Map(),
    "balance",
  );
  const locallyBetterRoute = route(firstVehicle.id, [
    firstRouteNodes[0],
    firstRouteNodes[2],
    firstRouteNodes[1],
  ]);
  const routeBefore = evaluateRoute(initial.routes[0], firstVehicle, DEPOT.lat, DEPOT.lon, START);
  const routeAfter = evaluateRoute(locallyBetterRoute, firstVehicle, DEPOT.lat, DEPOT.lon, START);
  assert.ok(evaluateRouteCost(routeAfter, balanceWeights) < evaluateRouteCost(routeBefore, balanceWeights));
  const globallyWorse = computeSolutionCost(
    {
      ...initial,
      routes: [locallyBetterRoute, initial.routes[1]],
    },
    vehicles,
    DEPOT.lat,
    DEPOT.lon,
    START,
    balanceWeights,
    new Map(),
    "balance",
  );
  assert.ok(globallyWorse.cost > baseline.cost);

  const result = await runALNS(
    initial,
    vehicles,
    DEPOT.lat,
    DEPOT.lon,
    START,
    {
      maxIterations: 0,
      timeLimitMs: 1_000,
      localSearchTimeLimitMs: 1_000,
      weights: balanceWeights,
      vehicleDistributionMode: "balance",
    },
  );
  const rescored = computeSolutionCost(
    result,
    vehicles,
    DEPOT.lat,
    DEPOT.lon,
    START,
    balanceWeights,
    new Map(),
    "balance",
  );

  assert.deepEqual(
    result.routes[0].nodes.map((currentNode) => currentNode.id),
    initial.routes[0].nodes.map((currentNode) => currentNode.id),
  );
  assert.ok(rescored.cost <= baseline.cost + 0.000_001);
  assert.equal(result.cost, rescored.cost);
});