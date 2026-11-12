import assert from "node:assert/strict";
import test from "node:test";
import {
  explainGeographicRouteOverlap,
  explainGeographicRouteOverlapAsync,
  type RouteOverlapReasonCode,
} from "./route-overlap-explanations";
import type { ALNSNode, ALNSRoute, ALNSVehicle } from "./types";
import type { ALNSDriverConstraints } from "./types";

const startTime = new Date("2026-09-03T07:00:00.000Z");

function node(id: string, latitude: number, weightKg = 1): ALNSNode {
  return {
    id,
    latitude,
    longitude: 18,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 10,
    weightKg,
    volumeM3: 1,
  };
}

function route(vehicleId: string, nodes: ALNSNode[]): ALNSRoute {
  return {
    vehicleId,
    nodes,
    totalWeight: nodes.reduce((sum, item) => sum + item.weightKg, 0),
    totalVolume: nodes.reduce((sum, item) => sum + item.volumeM3, 0),
  };
}

function vehicle(id: string, overrides: Partial<ALNSVehicle> = {}): ALNSVehicle {
  return {
    id,
    vehicleType: "fossil",
    capacityKg: 100,
    capacityVolume: 100,
    rangeKm: null,
    ...overrides,
  };
}

function reasonFor(
  routes: ALNSRoute[],
  vehicles: ALNSVehicle[],
  vehicleId = "vehicle-a",
): RouteOverlapReasonCode | undefined {
  return explainGeographicRouteOverlap(routes, vehicles, 59, 18, startTime, [])
    .get(vehicleId)?.reasonCode;
}

test("reports capacity only when it actually blocks a nearby cross-route assignment", () => {
  const routes = [
    route("vehicle-a", [node("a", 59, 8)]),
    route("vehicle-b", [node("b", 59.01, 8)]),
  ];
  assert.equal(
    reasonFor(routes, [vehicle("vehicle-a", { capacityKg: 10 }), vehicle("vehicle-b", { capacityKg: 10 })]),
    "CAPACITY",
  );
});

test("does not invent a reason when nearby stops could feasibly share a route", () => {
  const routes = [
    route("vehicle-a", [node("a", 59)]),
    route("vehicle-b", [node("b", 59.01)]),
  ];
  const explanations = explainGeographicRouteOverlap(
    routes,
    [vehicle("vehicle-a"), vehicle("vehicle-b")],
    59,
    18,
    startTime,
    [],
  );
  assert.equal(explanations.get("vehicle-a")?.status, "unknown");
  assert.equal(explanations.get("vehicle-a")?.reasonCode, undefined);
  assert.deepEqual(explanations.get("vehicle-a")?.scope, {
    vehicleIds: ["vehicle-a", "vehicle-b"],
    stopIds: ["a", "b"],
  });
});

test("does not claim capacity forced the split when the larger vehicle can take both stops", () => {
  const routes = [
    route("vehicle-a", [node("a", 59, 8)]),
    route("vehicle-b", [node("b", 59.01, 8)]),
  ];
  const explanations = explainGeographicRouteOverlap(
    routes,
    [
      vehicle("vehicle-a", { capacityKg: 100 }),
      vehicle("vehicle-b", { capacityKg: 10 }),
    ],
    59,
    18,
    startTime,
    [],
  );
  assert.equal(explanations.get("vehicle-a")?.status, "unknown");
  assert.equal(explanations.get("vehicle-a")?.reasonCode, undefined);
});

test("ignores stops farther apart than the geographic cohesion radius", () => {
  const routes = [
    route("vehicle-a", [node("a", 59, 8)]),
    route("vehicle-b", [node("b", 59.2, 8)]),
  ];
  assert.equal(
    reasonFor(routes, [vehicle("vehicle-a", { capacityKg: 10 }), vehicle("vehicle-b", { capacityKg: 10 })]),
    undefined,
  );
});

test("reports field-service eligibility only for the affected nearby routes", () => {
  const routes = [
    route("vehicle-a", [node("a", 59)]),
    route("vehicle-b", [node("b", 59.01)]),
  ];
  assert.equal(
    reasonFor(routes, [
      vehicle("vehicle-a", { ineligibleStopIds: new Set(["b"]) }),
      vehicle("vehicle-b", { ineligibleStopIds: new Set(["a"]) }),
    ]),
    "SKILL",
  );
});

test("does not turn asymmetric directional causes into one shared explanation", () => {
  const explanations = explainGeographicRouteOverlap(
    [
      route("vehicle-a", [node("a", 59, 8)]),
      route("vehicle-b", [node("b", 59.01, 8)]),
    ],
    [
      vehicle("vehicle-a", { capacityKg: 10 }),
      vehicle("vehicle-b", {
        capacityKg: 100,
        ineligibleStopIds: new Set(["a"]),
      }),
    ],
    59,
    18,
    startTime,
    [],
  );
  assert.equal(explanations.get("vehicle-a")?.status, "unknown");
  assert.equal(explanations.get("vehicle-a")?.reasonCode, undefined);
  assert.equal(explanations.get("vehicle-b")?.status, "unknown");
  assert.equal(explanations.get("vehicle-b")?.reasonCode, undefined);
});

test("does not select a majority cause across different confirmed pair scopes", () => {
  const explanations = explainGeographicRouteOverlap(
    [
      route("vehicle-a", [node("a", 59, 8)]),
      route("vehicle-b", [node("b", 59.08, 8)]),
      route("vehicle-c", [node("c", 58.92)]),
    ],
    [
      vehicle("vehicle-a", {
        capacityKg: 10,
        ineligibleStopIds: new Set(["c"]),
      }),
      vehicle("vehicle-b", { capacityKg: 10 }),
      vehicle("vehicle-c", {
        capacityKg: 100,
        ineligibleStopIds: new Set(["a"]),
      }),
    ],
    59,
    18,
    startTime,
    [],
  );
  const explanation = explanations.get("vehicle-a");
  assert.equal(explanation?.status, "unknown");
  assert.equal(explanation?.reasonCode, undefined);
  assert.deepEqual(explanation?.scope.stopIds, ["a", "b", "c"]);
});

test("reports time windows only when no insertion order can satisfy them", () => {
  const deadline = new Date(startTime.getTime() + 5 * 60_000);
  const first = { ...node("a", 59), serviceDurationMin: 10, timeWindowEnd: deadline };
  const second = { ...node("b", 59.01), serviceDurationMin: 10, timeWindowEnd: deadline };
  assert.equal(
    reasonFor(
      [route("vehicle-a", [first]), route("vehicle-b", [second])],
      [vehicle("vehicle-a"), vehicle("vehicle-b")],
    ),
    "TIME_WINDOW",
  );
});

test("uses the driver's preferred start when verifying a time-window explanation", () => {
  const optimizerStart = new Date("2026-09-03T09:00:00.000Z");
  const deadline = new Date("2026-09-03T07:30:00.000Z");
  const first = { ...node("a", 59), timeWindowEnd: deadline };
  const second = { ...node("b", 59.001), timeWindowEnd: deadline };
  const constraints: ALNSDriverConstraints[] = ["vehicle-a", "vehicle-b"].map((vehicleId) => ({
    vehicleId,
    driverName: vehicleId,
    preferredStartTime: "07:00",
    preferredEndTime: "17:00",
    maxDrivingHoursPerDay: 8,
    avoidNightDriving: false,
    breakFrequencyMinutes: 240,
    preferredBreakDurationMin: 30,
  }));
  const explanations = explainGeographicRouteOverlap(
    [route("vehicle-a", [first]), route("vehicle-b", [second])],
    [vehicle("vehicle-a"), vehicle("vehicle-b")],
    59,
    18,
    optimizerStart,
    constraints,
  );
  assert.equal(explanations.get("vehicle-a")?.status, "unknown");
});

test("does not label a working-hours blocker when the actual route evaluator permits the insertion", () => {
  const first = { ...node("a", 59), serviceDurationMin: 100 };
  const second = { ...node("b", 59.01), serviceDurationMin: 100 };
  const constraints: ALNSDriverConstraints[] = ["vehicle-a", "vehicle-b"].map((vehicleId) => ({
    vehicleId,
    driverName: vehicleId,
    preferredStartTime: "07:00",
    preferredEndTime: "23:59",
    maxDrivingHoursPerDay: 1,
    avoidNightDriving: false,
    breakFrequencyMinutes: 120,
    preferredBreakDurationMin: 15,
  }));
  const explanations = explainGeographicRouteOverlap(
    [route("vehicle-a", [first]), route("vehicle-b", [second])],
    [vehicle("vehicle-a"), vehicle("vehicle-b")],
    59,
    18,
    startTime,
    constraints,
  );
  assert.equal(explanations.get("vehicle-a")?.status, "unknown");
  assert.equal(explanations.get("vehicle-a")?.reasonCode, undefined);
});

test("reports EV range when each separate trip fits but the combined trip does not", () => {
  const routes = [
    route("vehicle-a", [node("a", 59.036)]),
    route("vehicle-b", [node("b", 59.045)]),
  ];
  assert.equal(
    reasonFor(routes, [
      vehicle("vehicle-a", { vehicleType: "electric", rangeKm: 10 }),
      vehicle("vehicle-b", { vehicleType: "electric", rangeKm: 10 }),
    ]),
    "EV_RANGE",
  );
});

test("does not report EV range when the standard charging repair makes the combined route feasible", () => {
  const routes = [
    route("vehicle-a", [{ ...node("a", 59.38), longitude: 18 }]),
    route("vehicle-b", [{ ...node("b", 59.38), longitude: 18.1 }]),
  ];
  const explanations = explainGeographicRouteOverlap(
    routes,
    [
      vehicle("vehicle-a", { vehicleType: "electric", rangeKm: 50 }),
      vehicle("vehicle-b", { vehicleType: "electric", rangeKm: 50 }),
    ],
    59.2,
    18,
    startTime,
    [],
  );
  assert.equal(explanations.get("vehicle-a")?.status, "unknown");
});

test("marks bounded analysis incomplete instead of promoting earlier evidence", () => {
  const routes = Array.from({ length: 252 }, (_, index) =>
    route(`vehicle-${index}`, [node(`stop-${index}`, 59 + index / 100_000, 1)]),
  );
  const vehicles = routes.map((candidate) =>
    vehicle(candidate.vehicleId, { capacityKg: 1, capacityVolume: 1 }),
  );
  const explanations = explainGeographicRouteOverlap(
    routes,
    vehicles,
    59,
    18,
    startTime,
    [],
  );
  assert.equal(explanations.get("vehicle-0")?.status, "incomplete");
  assert.equal(explanations.get("vehicle-0")?.reasonCode, undefined);
});

test("async overlap analysis preserves sync evidence for a 228-route comparison case", async () => {
  const routes = Array.from({ length: 228 }, (_, index) =>
    route(`vehicle-${index}`, [
      node(`stop-${index}`, 59 + (index % 4) / 100_000, 8),
    ]),
  );
  const vehicles = routes.map((candidate) =>
    vehicle(candidate.vehicleId, { capacityKg: 10, capacityVolume: 10 }),
  );
  const syncResult = explainGeographicRouteOverlap(
    routes,
    vehicles,
    59,
    18,
    startTime,
    [],
  );
  let timerRanDuringExplanation = false;
  const timer = setTimeout(() => {
    timerRanDuringExplanation = true;
  }, 0);
  const asyncResult = await explainGeographicRouteOverlapAsync(
    routes,
    vehicles,
    59,
    18,
    startTime,
    [],
  );
  clearTimeout(timer);
  assert.equal(timerRanDuringExplanation, true);
  assert.deepEqual(asyncResult, syncResult);
});
