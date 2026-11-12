import { test } from "node:test";
import assert from "node:assert/strict";
import type { ALNSNode, ALNSSolution, ALNSVehicle } from "../types";
import { enforcePdIntegrity, buildPdReferenceMap } from "./pd-integrity";
import { runALNS } from "../runner";


function emptyBreakdown() {
  return {
    distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0,
    totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
  } as ALNSSolution["costBreakdown"];
}

const DEPOT = { lat: 59.3293, lon: 18.0686 }; // Stockholm

function pdNode(id: string, dLat: number, dLon: number, pLat: number, pLon: number): ALNSNode {
  return {
    id,
    latitude: dLat,
    longitude: dLon,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
    pickupLat: pLat,
    pickupLon: pLon,
    pickupServiceMin: 5,
  };
}

function plainNode(id: string, lat: number, lon: number): ALNSNode {
  return {
    id,
    latitude: lat,
    longitude: lon,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  };
}

function vehicle(id: string): ALNSVehicle {
  return { id, vehicleType: "fossil", capacityKg: 1000, capacityVolume: 10, rangeKm: null };
}

test("clean solution reports no violations and is unchanged", () => {
  const n1 = pdNode("a", 59.34, 18.07, 59.32, 18.05);
  const n2 = plainNode("b", 59.35, 18.08);
  const solution: ALNSSolution = {
    routes: [
      { vehicleId: "v1", nodes: [n1], totalWeight: 10, totalVolume: 0.1 },
      { vehicleId: "v2", nodes: [n2], totalWeight: 10, totalVolume: 0.1 },
    ],
    unassigned: [],
    cost: 0,
    costBreakdown: emptyBreakdown(),
  };

  const violations = enforcePdIntegrity(solution, buildPdReferenceMap([n1, n2]));
  assert.equal(violations.length, 0);
  assert.equal(solution.routes[0].nodes.length, 1);
  assert.equal(solution.routes[1].nodes.length, 1);
});

test("a P&D order duplicated onto two vehicles is treated as hard infeasibility and repaired", () => {
  const original = pdNode("order-1", 59.34, 18.07, 59.32, 18.05);
  const dup = { ...original };
  const solution: ALNSSolution = {
    routes: [
      { vehicleId: "v1", nodes: [original], totalWeight: 10, totalVolume: 0.1 },
      { vehicleId: "v2", nodes: [dup], totalWeight: 10, totalVolume: 0.1 },
    ],
    unassigned: [],
    cost: 0,
    costBreakdown: emptyBreakdown(),
  };

  const violations = enforcePdIntegrity(solution, buildPdReferenceMap([original]));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "duplicated_across_vehicles");

  // The order remains exactly once — pickup and delivery stay on ONE vehicle.
  const occurrences = solution.routes.flatMap(r => r.nodes).filter(n => n.id === "order-1");
  assert.equal(occurrences.length, 1);
  assert.equal(solution.routes[0].nodes.length, 1);
  assert.equal(solution.routes[1].nodes.length, 0);
  // Load totals corrected on the losing route.
  assert.equal(solution.routes[1].totalWeight, 0);
  assert.equal(Math.round(solution.routes[1].totalVolume * 10) / 10, 0);
  // Kept node still carries the embedded pickup leg.
  assert.equal(occurrences[0].pickupLat, 59.32);
  assert.equal(occurrences[0].pickupLon, 18.05);
});

test("a composite node that lost its pickup coordinates gets them re-attached", () => {
  const reference = pdNode("order-2", 59.36, 18.10, 59.31, 18.02);
  const corrupted: ALNSNode = { ...reference, pickupLat: undefined, pickupLon: undefined };
  const solution: ALNSSolution = {
    routes: [{ vehicleId: "v1", nodes: [corrupted], totalWeight: 10, totalVolume: 0.1 }],
    unassigned: [],
    cost: 0,
    costBreakdown: emptyBreakdown(),
  };

  const violations = enforcePdIntegrity(solution, buildPdReferenceMap([reference]));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "lost_pickup_coords");
  assert.equal(corrupted.pickupLat, 59.31);
  assert.equal(corrupted.pickupLon, 18.02);
});

test("node duplicated into unassigned is deduped", () => {
  const n = pdNode("order-3", 59.34, 18.07, 59.32, 18.05);
  const solution: ALNSSolution = {
    routes: [{ vehicleId: "v1", nodes: [n], totalWeight: 10, totalVolume: 0.1 }],
    unassigned: [{ ...n }],
    cost: 0,
    costBreakdown: emptyBreakdown(),
  };

  const violations = enforcePdIntegrity(solution);
  assert.equal(violations.length, 1);
  assert.equal(solution.unassigned.length, 0);
  assert.equal(solution.routes[0].nodes.length, 1);
});

test("ALNS never splits a pickup and its delivery across vehicles", async () => {
  // 8 P&D orders + 4 plain deliveries around Stockholm, 3 vehicles.
  const nodes: ALNSNode[] = [];
  for (let i = 0; i < 8; i++) {
    nodes.push(pdNode(
      `pd-${i}`,
      59.30 + i * 0.012, 18.02 + i * 0.015,   // delivery
      59.36 - i * 0.010, 18.12 - i * 0.012,   // pickup
    ));
  }
  for (let i = 0; i < 4; i++) {
    nodes.push(plainNode(`plain-${i}`, 59.33 + i * 0.008, 18.05 + i * 0.01));
  }
  const vehicles = [vehicle("v1"), vehicle("v2"), vehicle("v3")];

  const initial: ALNSSolution = {
    routes: vehicles.map(v => ({ vehicleId: v.id, nodes: [] as ALNSNode[], totalWeight: 0, totalVolume: 0 })),
    unassigned: [...nodes],
    cost: 0,
    costBreakdown: emptyBreakdown(),
  };

  const result = await runALNS(initial, vehicles, DEPOT.lat, DEPOT.lon, new Date(), {
    maxIterations: 300,
    timeLimitMs: 5000,
  });

  const assigned = result.routes.flatMap(r => r.nodes.filter(n => !n.isChargingStation));
  const allIds = [...assigned.map(n => n.id), ...result.unassigned.map(n => n.id)];

  // Every order appears exactly once across all vehicles + unassigned.
  assert.equal(new Set(allIds).size, allIds.length, "an order was assigned to more than one vehicle");
  assert.equal(allIds.length, nodes.length, "orders were lost or duplicated during optimization");

  // Every P&D order still carries its embedded pickup leg, so its pickup is
  // guaranteed to be serviced by the same vehicle, immediately before delivery.
  for (const n of [...assigned, ...result.unassigned]) {
    if (n.id.startsWith("pd-")) {
      assert.ok(n.pickupLat != null && n.pickupLon != null, `composite node ${n.id} lost its pickup leg`);
    }
  }
});
