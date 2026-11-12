import assert from "node:assert/strict";
import { RoadDataUnavailableError } from "../road-data-policy";
import { test } from "node:test";
import {
  clearOsrmCache,
} from "../osrm";
import {
  buildInitialSolutionFromCW,
  computeGeographicCohesionCost,
  computeSolutionCost,
  DEFAULT_WEIGHTS,
  evaluateRoute,
  getDistanceCache,
  haversineDistance,
  optimizeWithALNS,
  type ALNSDriverConstraints,
  type ALNSNode,
  type ALNSRoute,
  type ALNSVehicle,
  type OptimizationWeights,
} from "./index";
import { stockholmClock } from "../route-workday";
import { fillExplicitlySelectedEmptyRoutes } from "../import-route-workflow";

/**
 * Acceptance fixture only. Coordinates and road legs are synthetic and do not
 * represent customer data, a database, or an external routing integration.
 */
const DEPOT = { latitude: 59.3293, longitude: 18.0686 };
const START = new Date("2026-09-01T00:00:00.000Z");

type Neighborhood = "north" | "west" | "southeast";

type FixtureStop = ALNSNode & { neighborhood: Neighborhood };

type RoadCoordinate = {
  latitude: number;
  longitude: number;
  neighborhood: Neighborhood | "depot";
};

type NearbyPairReport = {
  nearbyPairs: number;
  splitNearbyPairs: number;
  splitFraction: number;
};

type AcceptanceSnapshot = {
  mode: "balance" | "minimize";
  distanceModel: "mocked-road" | "simplified";
  usedVehicles: string[];
  routeStopIds: Record<string, string[]>;
  nearbyPairs: NearbyPairReport;
  distanceKm: number;
  workMinutes: Record<string, number>;
  score: number;
  geographicCohesionCost: number;
  roadMatrixRequests: number;
  distanceSource: string;
  occupancyHelperUsedVehicles: string[];
};

const freeVehicles: ALNSVehicle[] = [
  {
    id: "north-driver",
    vehicleType: "fossil",
    capacityKg: 10_000,
    capacityVolume: 100,
    rangeKm: null,
  },
  {
    id: "west-driver",
    vehicleType: "fossil",
    capacityKg: 10_000,
    capacityVolume: 100,
    rangeKm: null,
  },
  {
    id: "southeast-driver",
    vehicleType: "fossil",
    capacityKg: 10_000,
    capacityVolume: 100,
    rangeKm: null,
  },
];

const freeStopCoordinates: Array<[Neighborhood, number, number]> = [
  ["north", 59.4000, 18.0500],
  ["north", 59.4020, 18.0520],
  ["north", 59.3980, 18.0480],
  ["west", 59.3200, 17.9000],
  ["west", 59.3220, 17.9020],
  ["west", 59.3180, 17.8980],
  ["southeast", 59.2500, 18.1500],
  ["southeast", 59.2520, 18.1520],
  ["southeast", 59.2480, 18.1480],
];

const freeStops: FixtureStop[] = freeStopCoordinates.map(([neighborhood, latitude, longitude], index) => ({
  id: `${neighborhood}-free-${index + 1}`,
  neighborhood,
  latitude,
  longitude,
  timeWindowStart: null,
  timeWindowEnd: null,
  serviceDurationMin: 5,
  weightKg: 10,
  volumeM3: 0.1,
}));

const constrainedVehicles: ALNSVehicle[] = [
  {
    id: "north-short-shift",
    vehicleType: "fossil",
    capacityKg: 20,
    capacityVolume: 2,
    rangeKm: null,
    ineligibleStopIds: new Set([
      "north-long",
      "south-constrained-1",
      "south-constrained-2",
      "east-constrained-1",
      "east-constrained-2",
    ]),
  },
  {
    id: "south-capacity",
    vehicleType: "fossil",
    capacityKg: 20,
    capacityVolume: 2,
    rangeKm: null,
    ineligibleStopIds: new Set(["north-window", "north-long", "east-constrained-1", "east-constrained-2"]),
  },
  {
    id: "flex-constrained",
    vehicleType: "fossil",
    capacityKg: 40,
    capacityVolume: 4,
    rangeKm: null,
  },
];

const constrainedDriverConstraints: ALNSDriverConstraints[] = [
  {
    vehicleId: "north-short-shift",
    driverName: "Synthetic north shift",
    preferredStartTime: "07:00",
    preferredEndTime: "08:00",
    maxDrivingHoursPerDay: 8,
    avoidNightDriving: false,
    breakFrequencyMinutes: 240,
    preferredBreakDurationMin: 30,
  },
  {
    vehicleId: "south-capacity",
    driverName: "Synthetic south shift",
    preferredStartTime: "07:00",
    preferredEndTime: "09:00",
    maxDrivingHoursPerDay: 8,
    avoidNightDriving: false,
    breakFrequencyMinutes: 240,
    preferredBreakDurationMin: 30,
  },
  {
    vehicleId: "flex-constrained",
    driverName: "Synthetic flex shift",
    preferredStartTime: "07:00",
    preferredEndTime: "18:00",
    maxDrivingHoursPerDay: 8,
    avoidNightDriving: false,
    breakFrequencyMinutes: 240,
    preferredBreakDurationMin: 30,
  },
];

const constrainedStops: FixtureStop[] = [
  {
    id: "north-window",
    neighborhood: "north",
    latitude: 59.4000,
    longitude: 18.0500,
    timeWindowStart: new Date("2026-09-01T07:20:00+02:00"),
    timeWindowEnd: new Date("2026-09-01T07:50:00+02:00"),
    serviceDurationMin: 10,
    weightKg: 10,
    volumeM3: 0.1,
  },
  {
    id: "north-long",
    neighborhood: "north",
    latitude: 59.4020,
    longitude: 18.0520,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 40,
    weightKg: 10,
    volumeM3: 0.1,
  },
  {
    id: "south-constrained-1",
    neighborhood: "west",
    latitude: 59.3200,
    longitude: 17.9000,
    timeWindowStart: new Date("2026-09-01T07:40:00+02:00"),
    timeWindowEnd: new Date("2026-09-01T08:20:00+02:00"),
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  },
  {
    id: "south-constrained-2",
    neighborhood: "west",
    latitude: 59.3220,
    longitude: 17.9020,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  },
  {
    id: "east-constrained-1",
    neighborhood: "southeast",
    latitude: 59.2500,
    longitude: 18.1500,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  },
  {
    id: "east-constrained-2",
    neighborhood: "southeast",
    latitude: 59.2520,
    longitude: 18.1520,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  },
];

const geographicWeights: OptimizationWeights = {
  ...DEFAULT_WEIGHTS,
  distanceWeight: 0.30,
  co2Weight: 0.10,
  etaPrecisionWeight: 0.05,
  driverHappinessWeight: 0.05,
  geographicCohesionWeight: 0.50,
};

function coordinateKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

function fixtureCoordinates(stops: FixtureStop[]): Map<string, RoadCoordinate> {
  const coordinates = new Map<string, RoadCoordinate>([
    [coordinateKey(DEPOT.latitude, DEPOT.longitude), { ...DEPOT, neighborhood: "depot" }],
  ]);
  for (const stop of stops) {
    coordinates.set(coordinateKey(stop.latitude, stop.longitude), {
      latitude: stop.latitude,
      longitude: stop.longitude,
      neighborhood: stop.neighborhood,
    });
  }
  return coordinates;
}

/**
 * The matrix deliberately differs from haversine:
 * - same-neighborhood legs are 1.2–1.8 km regardless of their geographic
 *   distance;
 * - depot legs are 8–11 km;
 * - cross-neighborhood legs are 43–59 km and asymmetric.
 *
 * Distances and durations are therefore controlled road evidence, while
 * nearby-pair reporting continues to use the simplified haversine geometry.
 */
function roadLeg(
  from: RoadCoordinate,
  to: RoadCoordinate,
): { distanceKm: number; durationMin: number } {
  if (from.neighborhood === to.neighborhood) {
    const distanceKm = from.latitude === to.latitude && from.longitude === to.longitude
      ? 0
      : 1.2 + Math.abs(from.latitude - to.latitude) * 100
        + Math.abs(from.longitude - to.longitude) * 50;
    return { distanceKm, durationMin: distanceKm * 3 };
  }

  if (from.neighborhood === "depot" || to.neighborhood === "depot") {
    const stop = from.neighborhood === "depot" ? to : from;
    const distanceKm = 8 + Math.abs(stop.latitude * 10 + stop.longitude * 3) % 3;
    return { distanceKm, durationMin: distanceKm * 2 };
  }

  const directionalOffset = (
    from.latitude * 17
    + from.longitude * 13
    + to.latitude * 7
    + to.longitude * 5
  ) % 7;
  const distanceKm = 43 + directionalOffset;
  return { distanceKm, durationMin: distanceKm * 2.5 };
}

function installRoadMatrixMock(stops: FixtureStop[]): { requestCount: () => number; restore: () => void } {
  const coordinates = fixtureCoordinates(stops);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.match(url.pathname, /\/table\/v1\/driving\//, "fixture must not call a route or non-table endpoint");
    requestCount++;

    const coordinateText = url.pathname.split("/").pop() ?? "";
    const requestCoordinates = coordinateText.split(";").map((pair) => {
      const [longitude, latitude] = pair.split(",").map(Number);
      return { latitude, longitude };
    });
    const matrix = requestCoordinates.map((from) => requestCoordinates.map((to) => {
      const fromKnown = coordinates.get(coordinateKey(from.latitude, from.longitude));
      const toKnown = coordinates.get(coordinateKey(to.latitude, to.longitude));
      assert.ok(fromKnown, `unexpected synthetic matrix coordinate ${coordinateKey(from.latitude, from.longitude)}`);
      assert.ok(toKnown, `unexpected synthetic matrix coordinate ${coordinateKey(to.latitude, to.longitude)}`);
      return roadLeg(fromKnown, toKnown).distanceKm * 1000;
    }));
    const durations = requestCoordinates.map((from) => requestCoordinates.map((to) => {
      const fromKnown = coordinates.get(coordinateKey(from.latitude, from.longitude));
      const toKnown = coordinates.get(coordinateKey(to.latitude, to.longitude));
      assert.ok(fromKnown);
      assert.ok(toKnown);
      return roadLeg(fromKnown, toKnown).durationMin * 60;
    }));

    return new Response(JSON.stringify({ code: "Ok", distances: matrix, durations }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    requestCount: () => requestCount,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/**
 * The simplified-distance run still exercises the optimizer. It only denies
 * road pairs in the table response, so the production fallback is Haversine
 * and a network request cannot accidentally escape this fixture.
 */
function installSimplifiedDistanceMock(): { requestCount: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestCount++;
    const url = new URL(String(input));
    assert.match(url.pathname, /\/table\/v1\/driving\//);
    const coordinateCount = (url.pathname.split("/").pop() ?? "").split(";").filter(Boolean).length;
    const emptyMatrix = Array.from(
      { length: coordinateCount },
      () => Array.from({ length: coordinateCount }, () => null),
    );
    return new Response(JSON.stringify({
      code: "Ok",
      distances: emptyMatrix,
      durations: emptyMatrix,
    }), { status: 200 });
  }) as typeof fetch;
  return {
    requestCount: () => requestCount,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function withSeedAsync<T>(seed: number, operation: () => Promise<T>): Promise<T> {
  const originalRandom = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  try {
    return await operation();
  } finally {
    Math.random = originalRandom;
  }
}

function exerciseSelectedPairOccupancy(
  stops: FixtureStop[],
  vehicles: ALNSVehicle[],
  constraints: ALNSDriverConstraints[] = [],
): string[] {
  const routes: ALNSRoute[] = [{
    vehicleId: vehicles[0].id,
    nodes: stops.map((stop) => ({ ...stop })),
    totalWeight: stops.reduce((sum, stop) => sum + stop.weightKg, 0),
    totalVolume: stops.reduce((sum, stop) => sum + stop.volumeM3, 0),
  }];
  const occupancyResult = {
    routes,
    unassigned: [] as ALNSNode[],
    routeEvaluations: new Map<string, ReturnType<typeof evaluateRoute>>(),
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
  const constraintsMap = new Map(
    constraints.map((constraint) => [constraint.vehicleId, constraint]),
  );
  const filled = fillExplicitlySelectedEmptyRoutes(
    occupancyResult,
    vehicles,
    constraintsMap,
    DEPOT.latitude,
    DEPOT.longitude,
    START,
    {
      weights: geographicWeights,
      vehicleDistributionMode: "balance",
    },
  );
  assert.equal(filled, true, "the pure selected-pair occupancy helper must fill every feasible pair");

  const assigned = occupancyResult.routes.flatMap((route) =>
    route.nodes.filter((node) => !node.isChargingStation),
  );
  assert.equal(occupancyResult.unassigned.length, 0);
  assert.deepEqual(
    assigned.map((node) => node.id).sort(),
    stops.map((stop) => stop.id).sort(),
  );
  assert.equal(
    occupancyResult.routes.filter((route) =>
      route.nodes.some((node) => !node.isChargingStation),
    ).length,
    vehicles.length,
    "selected-pair occupancy must be enforced by the import helper, not ALNS preference",
  );

  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  for (const route of occupancyResult.routes) {
    const vehicle = vehicleMap.get(route.vehicleId)!;
    if (route.nodes.length === 0) continue;
    const evaluation = evaluateRoute(
      route,
      vehicle,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      constraintsMap.get(route.vehicleId),
    );
    assert.equal(evaluation.feasible, true);
  }
  return occupancyResult.routes
    .filter((route) => route.nodes.some((node) => !node.isChargingStation))
    .map((route) => route.vehicleId)
    .sort();
}

function nearbyPairReport(routes: ALNSRoute[]): NearbyPairReport {
  const assigned = routes.flatMap((route) =>
    route.nodes
      .filter((node) => !node.isChargingStation)
      .map((node) => ({ node, vehicleId: route.vehicleId })),
  );
  let nearbyPairs = 0;
  let splitNearbyPairs = 0;

  for (let left = 0; left < assigned.length; left++) {
    for (let right = left + 1; right < assigned.length; right++) {
      const distance = haversineDistance(
        assigned[left].node.latitude,
        assigned[left].node.longitude,
        assigned[right].node.latitude,
        assigned[right].node.longitude,
      );
      if (distance >= 10) continue;
      nearbyPairs++;
      if (assigned[left].vehicleId !== assigned[right].vehicleId) splitNearbyPairs++;
    }
  }

  return {
    nearbyPairs,
    splitNearbyPairs,
    splitFraction: nearbyPairs === 0 ? 0 : splitNearbyPairs / nearbyPairs,
  };
}

function routeWorkMinutes(
  route: ALNSRoute,
  endTime: Date,
  constraints: ALNSDriverConstraints | undefined,
): number {
  const effectiveStart = constraints?.preferredStartTime
    ? stockholmClock(START, constraints.preferredStartTime)
    : START;
  return Math.max(0, (endTime.getTime() - effectiveStart.getTime()) / 60_000);
}

function assertConservationAndValidity(
  result: Awaited<ReturnType<typeof optimizeWithALNS>>,
  stops: FixtureStop[],
  vehicles: ALNSVehicle[],
  constraints: ALNSDriverConstraints[] = [],
): void {
  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const constraintsMap = new Map(constraints.map((constraint) => [constraint.vehicleId, constraint]));
  const assigned = result.routes.flatMap((route) =>
    route.nodes.filter((node) => !node.isChargingStation),
  );
  const expectedIds = stops.map((stop) => stop.id).sort();
  const assignedIds = assigned.map((stop) => stop.id).sort();

  assert.equal(result.unassigned.length, 0, "every synthetic stop should be assigned");
  assert.equal(assigned.length, stops.length, "customer stops must be conserved exactly once");
  assert.deepEqual(assignedIds, expectedIds, "assigned stop IDs must match the fixture exactly");
  assert.equal(new Set(assignedIds).size, stops.length, "a stop must not appear on two routes");

  for (const route of result.routes) {
    const vehicle = vehicleMap.get(route.vehicleId);
    assert.ok(vehicle, `unknown route vehicle ${route.vehicleId}`);
    assert.equal(
      route.totalWeight,
      route.nodes.reduce((sum, node) => sum + node.weightKg, 0),
      `${route.vehicleId} weight total`,
    );
    assert.equal(
      route.totalVolume,
      route.nodes.reduce((sum, node) => sum + node.volumeM3, 0),
      `${route.vehicleId} volume total`,
    );
    if (route.nodes.length === 0) continue;

    const evaluation = evaluateRoute(
      route,
      vehicle,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      constraintsMap.get(route.vehicleId),
    );
    assert.equal(evaluation.feasible, true, `${route.vehicleId} must satisfy hard route constraints`);
    assert.ok(route.totalWeight <= vehicle.capacityKg, `${route.vehicleId} capacity`);
    assert.ok(route.totalVolume <= vehicle.capacityVolume, `${route.vehicleId} volume capacity`);
    for (const node of route.nodes) {
      assert.equal(
        vehicle.ineligibleStopIds?.has(node.id) ?? false,
        false,
        `${route.vehicleId} must not receive an ineligible stop`,
      );
    }
  }
}

async function runFreeScenario(
  mode: "balance" | "minimize",
  seed: number,
  distanceModel: "mocked-road" | "simplified" = "mocked-road",
): Promise<AcceptanceSnapshot> {
  clearOsrmCache();
  getDistanceCache().clear();
  const matrixMock = distanceModel === "mocked-road"
    ? installRoadMatrixMock(freeStops)
    : installSimplifiedDistanceMock();
  try {
    const result = await withSeedAsync(seed, () => optimizeWithALNS(
      freeStops,
      freeVehicles,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      {
        timeLimitMs: 10_000,
        maxIterations: 300,
        maxNoImprovementIterations: 150,
        minIterationsBeforeEarlyStop: 0,
        localSearchTimeLimitMs: 0,
        distanceMatrixTimeoutMs: 100,
        vehicleDistributionMode: mode,
        weights: geographicWeights,
      },
    ));
    assertConservationAndValidity(result, freeStops, freeVehicles);
    const occupancyHelperUsedVehicles = mode === "balance"
      ? exerciseSelectedPairOccupancy(freeStops, freeVehicles)
      : [];

    const constraintsMap = new Map<string, ALNSDriverConstraints>();
    const score = computeSolutionCost(
      { routes: result.routes, unassigned: result.unassigned, cost: 0, costBreakdown: result.costBreakdown },
      freeVehicles,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      geographicWeights,
      constraintsMap,
      mode,
    ).cost;
    const workMinutes = Object.fromEntries(
      result.routes
        .filter((route) => route.nodes.some((node) => !node.isChargingStation))
        .map((route) => [route.vehicleId, routeWorkMinutes(
          route,
          result.routeEvaluations.get(route.vehicleId)!.endTime,
          undefined,
        )]),
    );

    return {
      mode,
      distanceModel,
      usedVehicles: result.routes
        .filter((route) => route.nodes.some((node) => !node.isChargingStation))
        .map((route) => route.vehicleId)
        .sort(),
      routeStopIds: Object.fromEntries(
        result.routes
          .filter((route) => route.nodes.some((node) => !node.isChargingStation))
          .map((route) => [route.vehicleId, route.nodes.map((node) => node.id)]),
      ),
      nearbyPairs: nearbyPairReport(result.routes),
      distanceKm: result.costBreakdown.totalDistanceKm,
      workMinutes,
      score,
      geographicCohesionCost: result.costBreakdown.geographicCohesionCost,
      roadMatrixRequests: matrixMock.requestCount(),
      distanceSource: result.performance.distanceSource,
      occupancyHelperUsedVehicles,
    };
  } finally {
    matrixMock.restore();
    clearOsrmCache();
    getDistanceCache().clear();
  }
}

test("three synthetic neighborhoods are reproducible and cohesive in all-pairs and minimize modes", async () => {
  const balanceFirst = await runFreeScenario("balance", 74_001, "mocked-road");
  const balanceSecond = await runFreeScenario("balance", 74_001, "mocked-road");
  const minimizeFirst = await runFreeScenario("minimize", 74_001, "mocked-road");
  const minimizeSecond = await runFreeScenario("minimize", 74_001, "mocked-road");
  // Operational optimization now requires road coverage. Analytical metric
  // tests remain separate; a missing matrix must never silently downgrade.
  await assert.rejects(() => runFreeScenario("balance", 74_001, "simplified"), RoadDataUnavailableError);
  await assert.rejects(() => runFreeScenario("minimize", 74_001, "simplified"), RoadDataUnavailableError);

  // Exclude wall-clock performance from the reproducibility comparison.
  assert.deepEqual(
    { ...balanceFirst, roadMatrixRequests: 1 },
    { ...balanceSecond, roadMatrixRequests: 1 },
  );
  assert.deepEqual(
    { ...minimizeFirst, roadMatrixRequests: 1 },
    { ...minimizeSecond, roadMatrixRequests: 1 },
  );

  assert.equal(balanceFirst.roadMatrixRequests, 1, "free scenario must use its controlled road matrix");
  assert.equal(balanceFirst.distanceSource, "osrm");
  assert.equal(minimizeFirst.distanceSource, "osrm");
  assert.equal(balanceFirst.usedVehicles.length, 3, "all selected pairs must be used in balance mode");
  assert.deepEqual(balanceFirst.occupancyHelperUsedVehicles, balanceFirst.usedVehicles);
  assert.ok(minimizeFirst.usedVehicles.length <= balanceFirst.usedVehicles.length);
  assert.ok(balanceFirst.nearbyPairs.nearbyPairs > 0);
  assert.ok(balanceFirst.nearbyPairs.splitNearbyPairs <= 2, "nearby stops should remain mostly together");
  assert.ok(minimizeFirst.nearbyPairs.splitNearbyPairs <= 2, "minimization must not destroy local cohesion");
  assert.ok(balanceFirst.distanceKm > 0);
  assert.ok(Object.values(balanceFirst.workMinutes).every((minutes) => minutes > 0));
  assert.ok(Number.isFinite(balanceFirst.score));
  assert.equal(
    balanceFirst.geographicCohesionCost,
    balanceFirst.nearbyPairs.splitFraction,
    "fully separated fixture should have zero local ownership splits",
  );

  console.log("[geographic acceptance] free", JSON.stringify({
    mockedRoad: {
      balance: balanceFirst,
      minimize: minimizeFirst,
    },
  }));
});

test("constrained synthetic routes conserve stops and keep capacity, time windows, shifts, and eligibility valid", async () => {
  clearOsrmCache();
  getDistanceCache().clear();
  const matrixMock = installRoadMatrixMock(constrainedStops);
  try {
    const northVehicle = constrainedVehicles[0];
    const southVehicle = constrainedVehicles[1];
    const flexVehicle = constrainedVehicles[2];
    const northShiftProbeVehicle: ALNSVehicle = {
      ...northVehicle,
      capacityKg: 20,
      capacityVolume: 2,
      ineligibleStopIds: new Set(),
    };
    const northPair: ALNSRoute = {
      vehicleId: northVehicle.id,
      nodes: [constrainedStops[0], constrainedStops[1]],
      totalWeight: 20,
      totalVolume: 0.2,
    };
    const overCapacity: ALNSRoute = {
      vehicleId: flexVehicle.id,
      nodes: constrainedStops.slice(0, 5),
      totalWeight: 50,
      totalVolume: 0.5,
    };
    const ineligible: ALNSRoute = {
      vehicleId: northVehicle.id,
      nodes: [constrainedStops[2]],
      totalWeight: 10,
      totalVolume: 0.1,
    };
    const timeWindowRoute: ALNSRoute = {
      vehicleId: southVehicle.id,
      nodes: [constrainedStops[2]],
      totalWeight: 10,
      totalVolume: 0.1,
    };
    assert.equal(
      evaluateRoute(
        northPair,
        northShiftProbeVehicle,
        DEPOT.latitude,
        DEPOT.longitude,
        START,
        constrainedDriverConstraints[0],
      ).feasible,
      false,
      "the north short shift must reject both north stops together",
    );
    assert.equal(
      evaluateRoute(overCapacity, flexVehicle, DEPOT.latitude, DEPOT.longitude, START).feasible,
      false,
      "capacity must be a hard constraint",
    );
    assert.equal(
      evaluateRoute(
        ineligible,
        northVehicle,
        DEPOT.latitude,
        DEPOT.longitude,
        START,
        constrainedDriverConstraints[0],
      ).feasible,
      false,
      "an ineligible vehicle-stop pair must be rejected",
    );
    assert.equal(
      evaluateRoute(
        timeWindowRoute,
        southVehicle,
        DEPOT.latitude,
        DEPOT.longitude,
        START,
        constrainedDriverConstraints[1],
      ).feasible,
      true,
      "the synthetic time-window stop must be serviceable by an eligible vehicle",
    );

    const result = await withSeedAsync(74_074, () => optimizeWithALNS(
      constrainedStops,
      constrainedVehicles,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      {
        timeLimitMs: 10_000,
        maxIterations: 400,
        maxNoImprovementIterations: 200,
        minIterationsBeforeEarlyStop: 0,
        localSearchTimeLimitMs: 0,
        distanceMatrixTimeoutMs: 100,
        vehicleDistributionMode: "balance",
        weights: geographicWeights,
        driverConstraints: constrainedDriverConstraints,
      },
    ));
    const constraintsMap = new Map(
      constrainedDriverConstraints.map((constraint) => [constraint.vehicleId, constraint]),
    );
    assert.equal(
      fillExplicitlySelectedEmptyRoutes(
        result,
        constrainedVehicles,
        constraintsMap,
        DEPOT.latitude,
        DEPOT.longitude,
        START,
        {
          weights: geographicWeights,
          vehicleDistributionMode: "balance",
        },
      ),
      true,
      "selected-pair occupancy helper must fill the eligible short-shift vehicle",
    );
    assertConservationAndValidity(result, constrainedStops, constrainedVehicles, constrainedDriverConstraints);
    assert.equal(matrixMock.requestCount(), 1);
    assert.equal(result.performance.distanceSource, "osrm");

    const score = computeSolutionCost(
      { routes: result.routes, unassigned: result.unassigned, cost: 0, costBreakdown: result.costBreakdown },
      constrainedVehicles,
      DEPOT.latitude,
      DEPOT.longitude,
      START,
      geographicWeights,
      constraintsMap,
      "balance",
    ).cost;
    const usedVehicles = result.routes.filter((route) =>
      route.nodes.some((node) => !node.isChargingStation),
    );
    const workMinutes = Object.fromEntries(
      usedVehicles.map((route) => [
        route.vehicleId,
        routeWorkMinutes(
          route,
          result.routeEvaluations.get(route.vehicleId)!.endTime,
          constraintsMap.get(route.vehicleId),
        ),
      ]),
    );

    assert.equal(usedVehicles.length, 3, "capacity and eligibility must force all selected pairs to carry work");
    assert.ok(Object.values(workMinutes).every((minutes) => minutes > 0 && minutes <= 660));
    assert.ok(Number.isFinite(score));
    assert.ok(result.routes.some((route) => route.nodes.some((node) => node.id === "north-window")));
    assert.ok(result.routes.some((route) => route.nodes.some((node) => node.id === "south-constrained-1")));
    const constrainedNearbyPairs = nearbyPairReport(result.routes);
    assert.ok(
      constrainedNearbyPairs.splitNearbyPairs >= 1,
      "north nearby stops must split because no eligible single vehicle can carry both",
    );

    console.log("[geographic acceptance] constrained", JSON.stringify({
      splitNearbyStops: constrainedNearbyPairs.splitNearbyPairs,
      nearbyPairs: constrainedNearbyPairs.nearbyPairs,
      usedVehicles: usedVehicles.map((route) => route.vehicleId).sort(),
      routeStopIds: Object.fromEntries(
        usedVehicles.map((route) => [route.vehicleId, route.nodes.map((node) => node.id)]),
      ),
      distanceKm: result.costBreakdown.totalDistanceKm,
      workMinutes,
      score,
      geographicCohesionCost: result.costBreakdown.geographicCohesionCost,
    }));
  } finally {
    matrixMock.restore();
    clearOsrmCache();
    getDistanceCache().clear();
  }
});

test("the acceptance fixture keeps road distance independent from simplified geographic distance", () => {
  const sameNeighborhood = haversineDistance(
    freeStops[0].latitude,
    freeStops[0].longitude,
    freeStops[1].latitude,
    freeStops[1].longitude,
  );
  const roadDistance = 1.2
    + Math.abs(freeStops[0].latitude - freeStops[1].latitude) * 100
    + Math.abs(freeStops[0].longitude - freeStops[1].longitude) * 50;

  assert.notEqual(Math.round(sameNeighborhood * 1000), Math.round(roadDistance * 1000));
  assert.ok(sameNeighborhood > 0);
  assert.ok(roadDistance > 0);

  const initial = buildInitialSolutionFromCW(
    freeStops.slice(0, 3),
    [freeVehicles[0]],
    DEPOT.latitude,
    DEPOT.longitude,
    START,
  );
  assert.equal(computeGeographicCohesionCost(initial.routes), 0);
});