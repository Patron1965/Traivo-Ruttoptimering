import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialSolutionFromCW,
  computeSolutionCost,
  DEFAULT_WEIGHTS,
  evaluateRoute,
  type ALNSNode,
  type ALNSVehicle,
} from "./alns";
import { admitPrioritizedUnassignedNodes } from "./import-route-workflow";

const depot = { lat: 59.3293, lon: 18.0686 };
const startTime = new Date("2026-09-01T07:00:00.000Z");

const vehicles: ALNSVehicle[] = Array.from({ length: 3 }, (_, index) => ({
  id: `vehicle-${index + 1}`,
  vehicleType: "fossil",
  capacityKg: 10_000,
  capacityVolume: 100,
  rangeKm: null,
}));

const stops: ALNSNode[] = [90, 80, 70, 60, 50, 40].map((serviceDurationMin, index) => ({
  id: `stop-${index + 1}`,
  latitude: depot.lat + index * 0.001,
  longitude: depot.lon + index * 0.001,
  timeWindowStart: null,
  timeWindowEnd: null,
  serviceDurationMin,
  weightKg: 10,
  volumeM3: 0.1,
}));

function workMinutesByVehicle(solution: ReturnType<typeof buildInitialSolutionFromCW>) {
  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  return solution.routes.map((route) => {
    if (route.nodes.length === 0) return 0;
    const evaluation = evaluateRoute(
      route,
      vehicleMap.get(route.vehicleId)!,
      depot.lat,
      depot.lon,
      startTime,
    );
    assert.equal(evaluation.feasible, true);
    return (evaluation.endTime.getTime() - startTime.getTime()) / 60000;
  });
}

test("vehicle distribution mode either minimizes active vehicles or balances estimated work time", () => {
  const minimized = buildInitialSolutionFromCW(
    stops,
    vehicles,
    depot.lat,
    depot.lon,
    startTime,
    "minimize",
  );
  const balanced = buildInitialSolutionFromCW(
    stops,
    vehicles,
    depot.lat,
    depot.lon,
    startTime,
    "balance",
  );

  assert.equal(minimized.unassigned.length, 0);
  assert.equal(balanced.unassigned.length, 0);
  assert.ok(minimized.routes.filter((route) => route.nodes.length > 0).length < 3);
  assert.equal(balanced.routes.filter((route) => route.nodes.length > 0).length, 3);

  const minimizedWork = workMinutesByVehicle(minimized);
  const balancedWork = workMinutesByVehicle(balanced);
  const minimizedSpread = Math.max(...minimizedWork) - Math.min(...minimizedWork);
  const balancedSpread = Math.max(...balancedWork) - Math.min(...balancedWork);
  assert.ok(balancedSpread < minimizedSpread);

  const minimizedModePackedCost = computeSolutionCost(
    minimized, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS, new Map(), "minimize",
  ).cost;
  const minimizedModeBalancedCost = computeSolutionCost(
    balanced, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS, new Map(), "minimize",
  ).cost;
  assert.ok(minimizedModePackedCost < minimizedModeBalancedCost);

  const balancedModePackedCost = computeSolutionCost(
    minimized, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS, new Map(), "balance",
  ).cost;
  const balancedModeBalancedCost = computeSolutionCost(
    balanced, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS, new Map(), "balance",
  ).cost;
  assert.ok(balancedModeBalancedCost < balancedModePackedCost);
});

test("unassigned mandatory and high priorities carry stronger optimizer penalties", () => {
  const normal = { ...stops[0], planningPriority: 0 as const };
  const high = { ...stops[0], id: "high", planningPriority: 1 as const };
  const mandatory = { ...stops[0], id: "mandatory", planningPriority: 2 as const };
  const base = { routes: [], cost: 0, costBreakdown: {} as any };
  const normalCost = computeSolutionCost({ ...base, unassigned: [normal] }, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS).cost;
  const highCost = computeSolutionCost({ ...base, unassigned: [high] }, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS).cost;
  const mandatoryCost = computeSolutionCost({ ...base, unassigned: [mandatory] }, vehicles, depot.lat, depot.lon, startTime, DEFAULT_WEIGHTS).cost;
  assert.ok(highCost > normalCost);
  assert.ok(mandatoryCost > highCost);
});

test("mandatory admission deterministically displaces a feasible lower-priority stop under scarcity", () => {
  const scarceVehicle: ALNSVehicle = { ...vehicles[0], id: "scarce", capacityKg: 10 };
  const normal: ALNSNode = { ...stops[0], id: "normal", weightKg: 10, planningPriority: 0 };
  const mandatory: ALNSNode = { ...stops[1], id: "must", weightKg: 10, planningPriority: 2 };
  const result = {
    routes: [{ vehicleId: scarceVehicle.id, nodes: [normal], totalWeight: 10, totalVolume: normal.volumeM3 }],
    unassigned: [mandatory],
    routeEvaluations: new Map(),
  };
  admitPrioritizedUnassignedNodes(
    result, [scarceVehicle], new Map(), depot.lat, depot.lon, startTime,
  );
  assert.deepEqual(result.routes[0].nodes.map((node) => node.id), ["must"]);
  assert.deepEqual(result.unassigned.map((node) => node.id), ["normal"]);
});