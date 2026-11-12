import assert from "node:assert/strict";
import test from "node:test";
import type {
  ALNSNode,
  ALNSRoute,
  ALNSVehicle,
  CostBreakdown,
} from "./alns/types";
import {
  fillExplicitlySelectedEmptyRoutes,
  itineraryForNodes,
  reinsertUnassignedNodes,
} from "./import-route-workflow";

function node(id: string): ALNSNode {
  return {
    id,
    latitude: 59.3,
    longitude: 18.1,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 10,
    weightKg: 1,
    volumeM3: 0,
  };
}

test("persists optimizer charging stations with the canonical server name", () => {
  const itinerary = itineraryForNodes(
    [{
      ...node("cs-1"),
      isChargingStation: true,
      chargingStationName: "Untrusted optimizer label",
      chargingDurationMin: 20,
    }, node("customer-stop")],
    {
      id: "vehicle-1",
      vehicleType: "electric",
      capacityKg: 10,
      capacityVolume: 10,
      rangeKm: 100,
    },
    { workStartTime: "07:00:00" } as any,
    59.3,
    18.1,
    new Date("2026-09-02T06:00:00.000Z"),
  );

  assert.deepEqual(itinerary.map((entry) => ({
    stopId: entry.stopId,
    isChargingStop: entry.isChargingStop,
    chargingStationName: entry.chargingStationName,
  })), [
    { stopId: "cs-1", isChargingStop: true, chargingStationName: "Ionity Stockholm North" },
    { stopId: "customer-stop", isChargingStop: undefined, chargingStationName: undefined },
  ]);
});

test("final reinsertion recovers feasible nodes from a discarded mixed-infeasible route", () => {
  const vehicle: ALNSVehicle = {
    id: "vehicle-1",
    vehicleType: "fossil",
    capacityKg: 5,
    capacityVolume: 5,
    rangeKm: null,
  };
  const recoverable = node("recoverable");
  const impossible = { ...node("too-heavy"), weightKg: 10 };
  const result: {
    routes: ALNSRoute[];
    unassigned: ALNSNode[];
    routeEvaluations: Map<string, any>;
  } = {
    routes: [{ vehicleId: vehicle.id, nodes: [], totalWeight: 0, totalVolume: 0 }],
    unassigned: [impossible, recoverable],
    routeEvaluations: new Map(),
  };

  reinsertUnassignedNodes(
    result,
    [vehicle],
    new Map(),
    59.3,
    18.1,
    new Date("2026-09-02T06:00:00.000Z"),
  );

  assert.deepEqual(result.routes[0].nodes.map((item) => item.id), ["recoverable"]);
  assert.deepEqual(result.unassigned.map((item) => item.id), ["too-heavy"]);
});

test("final reinsertion repairs a recoverable EV stop with a canonical charger", () => {
  const vehicle: ALNSVehicle = {
    id: "ev-1",
    vehicleType: "electric",
    capacityKg: 100,
    capacityVolume: 10,
    rangeKm: 32,
  };
  const recoverable: ALNSNode = {
    ...node("ev-recoverable"),
    latitude: 59.45,
    longitude: 18.02,
  };
  const impossible = { ...node("ev-too-heavy"), weightKg: 200 };
  const result: {
    routes: ALNSRoute[];
    unassigned: ALNSNode[];
    routeEvaluations: Map<string, any>;
  } = {
    routes: [{ vehicleId: vehicle.id, nodes: [], totalWeight: 0, totalVolume: 0 }],
    unassigned: [impossible, recoverable],
    routeEvaluations: new Map(),
  };

  reinsertUnassignedNodes(
    result,
    [vehicle],
    new Map(),
    59.25,
    18.02,
    new Date("2026-09-02T06:00:00.000Z"),
  );

  assert.deepEqual(result.unassigned.map((item) => item.id), ["ev-too-heavy"]);
  assert.ok(result.routes[0].nodes.some((item) => item.id === recoverable.id));
  const chargers = result.routes[0].nodes.filter((item) => item.isChargingStation);
  assert.ok(chargers.length > 0);
  assert.ok(chargers.every((item) => item.id.startsWith("cs-")));
});

test("final reinsertion chooses the longer route when its effective composite is better", () => {
  const stop = {
    ...node("low-emission-stop"),
    latitude: 59.31,
    longitude: 18.11,
  };
  const fossil: ALNSVehicle = {
    id: "fossil-near",
    vehicleType: "fossil",
    capacityKg: 100,
    capacityVolume: 100,
    rangeKm: null,
  };
  const electric: ALNSVehicle = {
    id: "electric-far",
    vehicleType: "electric",
    capacityKg: 100,
    capacityVolume: 100,
    rangeKm: null,
    startLatitude: 59.3,
    startLongitude: 18.14,
    endLatitude: 59.3,
    endLongitude: 18.14,
  };
  const result: {
    routes: ALNSRoute[];
    unassigned: ALNSNode[];
    routeEvaluations: Map<string, any>;
    costBreakdown: CostBreakdown;
  } = {
    routes: [
      { vehicleId: fossil.id, nodes: [], totalWeight: 0, totalVolume: 0 },
      { vehicleId: electric.id, nodes: [], totalWeight: 0, totalVolume: 0 },
    ],
    unassigned: [stop],
    routeEvaluations: new Map(),
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

  reinsertUnassignedNodes(
    result,
    [fossil, electric],
    new Map(),
    59.3,
    18.1,
    new Date("2026-09-02T06:00:00.000Z"),
    {
      weights: {
        distanceWeight: 0,
        co2Weight: 1,
        etaPrecisionWeight: 0,
        driverHappinessWeight: 0,
        geographicCohesionWeight: 0,
      },
      vehicleDistributionMode: "minimize",
    },
  );

  assert.deepEqual(
    result.routes
      .filter((route) => route.nodes.some((item) => !item.isChargingStation))
      .map((route) => route.vehicleId),
    [electric.id],
  );
  const chosenEvaluation = result.routeEvaluations.get(electric.id);
  assert.ok(chosenEvaluation?.feasible);
  assert.ok(chosenEvaluation.totalDistanceKm > 2);
  assert.equal(
    result.costBreakdown.totalDistanceKm,
    chosenEvaluation.totalDistanceKm,
  );
  assert.equal(
    result.costBreakdown.totalCo2Kg,
    chosenEvaluation.totalCo2Kg,
  );
  assert.deepEqual(result.unassigned, []);
});

test("explicit selected-route fill refreshes the canonical final breakdown", () => {
  const target: ALNSVehicle = {
    id: "a-target",
    vehicleType: "fossil",
    capacityKg: 100,
    capacityVolume: 100,
    rangeKm: null,
  };
  const donor: ALNSVehicle = {
    id: "z-donor",
    vehicleType: "fossil",
    capacityKg: 100,
    capacityVolume: 100,
    rangeKm: null,
  };
  const first = node("first");
  const second = {
    ...node("second"),
    latitude: 59.32,
    longitude: 18.12,
  };
  const result = {
    routes: [
      { vehicleId: target.id, nodes: [], totalWeight: 0, totalVolume: 0 },
      {
        vehicleId: donor.id,
        nodes: [first, second],
        totalWeight: first.weightKg + second.weightKg,
        totalVolume: first.volumeM3 + second.volumeM3,
      },
    ],
    unassigned: [] as ALNSNode[],
    routeEvaluations: new Map<string, any>(),
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
    } satisfies CostBreakdown,
  };

  assert.equal(
    fillExplicitlySelectedEmptyRoutes(
      result,
      [target, donor],
      new Map(),
      59.3,
      18.1,
      new Date("2026-09-02T06:00:00.000Z"),
      {
        weights: {
          distanceWeight: 1,
          co2Weight: 0,
          etaPrecisionWeight: 0,
          driverHappinessWeight: 0,
          geographicCohesionWeight: 0,
        },
        vehicleDistributionMode: "balance",
      },
    ),
    true,
  );

  assert.equal(result.routes[0].nodes.length, 1);
  assert.equal(result.routes[1].nodes.length, 1);
  const evaluatedRoutes = [...result.routeEvaluations.values()];
  assert.ok(evaluatedRoutes.every((evaluation) => evaluation.feasible));
  assert.equal(
    result.costBreakdown.totalDistanceKm,
    evaluatedRoutes.reduce(
      (totalDistance, evaluation) => totalDistance + evaluation.totalDistanceKm,
      0,
    ),
  );
  assert.equal(
    result.costBreakdown.totalCo2Kg,
    evaluatedRoutes.reduce(
      (totalCo2, evaluation) => totalCo2 + evaluation.totalCo2Kg,
      0,
    ),
  );
});
