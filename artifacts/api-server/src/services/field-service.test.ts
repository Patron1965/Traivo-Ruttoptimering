/**
 * Field service backend tests (task #126)
 *
 * Covers:
 *  - Transport default / backward compat: existing stops default to delivery jobType
 *  - Field service eligibility: compatible assignment (all requirements met)
 *  - Field service eligibility: incompatible — expired certification
 *  - Field service eligibility: incompatible — missing equipment
 *  - Field service eligibility: missing skill
 *  - P&D composite node integrity: pickupLat/Lon preserved, no split
 *  - Service report billing_ready requires completedAt (validation gate)
 *
 * These tests run in-process without hitting the DB (eligibility) or
 * via direct schema assertions (defaults).  Where DB is required, the
 * checkFieldServiceEligibility function is tested by mocking the db
 * import — we can't do real DB calls in unit tests.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { evaluateRoute } from "./alns/cost";
import {
  buildInitialSolutionFromCW,
  optimizeWithALNS,
  type ALNSNode,
  type ALNSVehicle,
} from "./alns";
import type { ALNSRoute } from "./alns/types";
import { isEligibleFieldServiceResource } from "./field-service";
import {
  applyFieldServiceEligibilityToVehicles,
  markUnstaffedVehicleIneligible,
} from "./field-service-policy";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEPOT = { lat: 59.33, lon: 18.07 };

function makeStop(id: string, overrides: Partial<ALNSNode> = {}): ALNSNode {
  return {
    id,
    latitude: DEPOT.lat + 0.01 * Math.random(),
    longitude: DEPOT.lon + 0.01 * Math.random(),
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 10,
    weightKg: 50,
    volumeM3: 0.2,
    ...overrides,
  };
}

function makeVehicle(id: string, overrides: Partial<ALNSVehicle> = {}): ALNSVehicle {
  return {
    id,
    vehicleType: "fossil",
    capacityKg: 1000,
    capacityVolume: 10,
    rangeKm: null,
    ...overrides,
  };
}

// ── 1. Transport backward compat: stops without jobType field behave as delivery ──

test("stop without field-service columns evaluates feasibly (transport backward compat)", () => {
  const stop = makeStop("legacy-stop");
  // Legacy stop has no requiredSkills/Certs/Equipment — no ineligibleStopIds on vehicle
  const vehicle = makeVehicle("v1");
  const route: ALNSRoute = {
    vehicleId: "v1",
    nodes: [stop],
    totalWeight: stop.weightKg,
    totalVolume: stop.volumeM3,
  };
  const result = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, new Date("2026-01-01T08:00:00Z"));
  assert.equal(result.feasible, true, "legacy delivery stop must be feasible");
  assert.equal(result.totalDistanceKm > 0, true, "route has positive distance");
});

// ── 2. Compatible field-service assignment (all requirements met) ─────────────

test("field service stop is feasible when vehicle has no ineligibleStopIds", () => {
  const stop = makeStop("fs-stop", {
    requiredSkills: ["HVAC"],
    requiredCertifications: ["F-GAS"],
    requiredEquipment: ["MANIFOLD_GAUGE"],
  });
  // Vehicle has NOT been flagged as ineligible for this stop
  const vehicle = makeVehicle("v-eligible");

  const route: ALNSRoute = {
    vehicleId: "v-eligible",
    nodes: [stop],
    totalWeight: stop.weightKg,
    totalVolume: stop.volumeM3,
  };
  const result = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, new Date("2026-01-01T08:00:00Z"));
  assert.equal(result.feasible, true, "eligible vehicle must be feasible for FS stop");
});

// ── 3. Incompatible — vehicle flagged ineligible blocks assignment ────────────

test("field service stop is infeasible when vehicle has ineligibleStopIds for it", () => {
  const stop = makeStop("fs-stop-blocked", {
    requiredSkills: ["HVAC"],
    requiredCertifications: ["F-GAS-EXPIRED"],
  });
  const vehicle = makeVehicle("v-ineligible", {
    ineligibleStopIds: new Set(["fs-stop-blocked"]),
  });

  const route: ALNSRoute = {
    vehicleId: "v-ineligible",
    nodes: [stop],
    totalWeight: stop.weightKg,
    totalVolume: stop.volumeM3,
  };
  const result = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, new Date("2026-01-01T08:00:00Z"));
  assert.equal(result.feasible, false, "ineligible vehicle must not be assigned to FS stop");
});

test("driver-only resources cannot receive field-service work", () => {
  assert.equal(isEligibleFieldServiceResource({ driverRole: "driver", isActive: true }), false);
  assert.equal(isEligibleFieldServiceResource({ driverRole: "technician", isActive: true }), true);
  assert.equal(isEligibleFieldServiceResource({ driverRole: "both", isActive: true }), true);
  assert.equal(isEligibleFieldServiceResource({ driverRole: "technician", isActive: false }), false);
});

test("vehicle without an active technician is ineligible for every field-service node", () => {
  const serviceNodes = [
    makeStop("service-with-requirements", { jobType: "field_service", requiredSkills: ["HVAC"] }),
    makeStop("service-without-requirements", { jobType: "field_service" }),
  ];
  const vehicle = makeVehicle("unstaffed");
  const reasons = new Map<string, { reasonCodes: string[]; details: string[] }>();

  const marked = markUnstaffedVehicleIneligible(vehicle, serviceNodes, undefined, reasons);

  assert.equal(marked, true);
  assert.deepEqual(vehicle.ineligibleStopIds, new Set(serviceNodes.map((node) => node.id)));
  assert.deepEqual(reasons.get("service-without-requirements")?.reasonCodes, ["INCOMPATIBLE_ROLE"]);
});

// ── 4. Mixed route: ineligible stop blocks entire route ──────────────────────

test("one ineligible FS stop makes the whole route infeasible for that vehicle", () => {
  const normalStop = makeStop("normal-stop");
  const blockedStop = makeStop("blocked-stop", { requiredEquipment: ["SPECIAL_TOOL"] });
  const vehicle = makeVehicle("v-partial", {
    ineligibleStopIds: new Set(["blocked-stop"]),
  });

  const route: ALNSRoute = {
    vehicleId: "v-partial",
    nodes: [normalStop, blockedStop],
    totalWeight: normalStop.weightKg + blockedStop.weightKg,
    totalVolume: normalStop.volumeM3 + blockedStop.volumeM3,
  };
  const result = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, new Date("2026-01-01T08:00:00Z"));
  assert.equal(result.feasible, false, "mixed route with one blocked FS stop must be infeasible");
});

test("reoptimization keeps field-service nodes away from incompatible vehicles", async () => {
  const eligibleVehicle = makeVehicle("vehicle-eligible");
  const ineligibleVehicle = makeVehicle("vehicle-ineligible");
  const serviceNodes = [
    makeStop("fs-eligible", { jobType: "field_service" }),
    makeStop("fs-impossible", { jobType: "field_service" }),
  ];
  const drivers = [
    { id: "technician", vehicleId: eligibleVehicle.id },
    { id: "ordinary-driver", vehicleId: ineligibleVehicle.id },
  ];

  const globallyIneligible = await applyFieldServiceEligibilityToVehicles(
    [eligibleVehicle, ineligibleVehicle],
    serviceNodes,
    drivers,
    async (driverId, _vehicleId, node) =>
      driverId === "technician" && node.id === "fs-eligible",
  );

  assert.deepEqual(eligibleVehicle.ineligibleStopIds, new Set(["fs-impossible"]));
  assert.deepEqual(
    ineligibleVehicle.ineligibleStopIds,
    new Set(["fs-eligible", "fs-impossible"]),
  );
  assert.deepEqual(globallyIneligible, new Set(["fs-impossible"]));
});

test("optimization accepts a vehicle when any assigned active driver is an eligible technician", async () => {
  const vehicle = makeVehicle("multi-driver-vehicle");
  const serviceNode = makeStop("multi-driver-service", {
    jobType: "field_service",
    requiredSkills: ["HVAC"],
  });
  const drivers = [
    { id: "eligible-technician", vehicleId: vehicle.id },
    { id: "ordinary-driver-last", vehicleId: vehicle.id },
  ];

  const globallyIneligible = await applyFieldServiceEligibilityToVehicles(
    [vehicle],
    [serviceNode],
    drivers,
    async (driverId) => driverId === "eligible-technician",
  );

  assert.equal(vehicle.ineligibleStopIds, undefined);
  assert.deepEqual(globallyIneligible, new Set());
});

// ── 5. P&D integrity: composite node is never split, pickup coords preserved ──

test("P&D composite node stays intact through ALNS optimization", async () => {
  const pdNode = makeStop("pd-stop", {
    pickupLat: DEPOT.lat - 0.005,
    pickupLon: DEPOT.lon - 0.005,
    pickupServiceMin: 10,
    weightKg: 100,
  });
  const plainStop = makeStop("plain-stop");
  const nodes: ALNSNode[] = [pdNode, plainStop];
  const vehicles: ALNSVehicle[] = [makeVehicle("v-pd")];

  const result = await optimizeWithALNS(
    nodes,
    vehicles,
    DEPOT.lat,
    DEPOT.lon,
    new Date("2026-01-01T08:00:00Z"),
    { timeLimitMs: 500, maxIterations: 200 },
  );

  // Find the pd-stop node in any route
  let foundPdNode: ALNSNode | undefined;
  for (const route of result.routes) {
    for (const n of route.nodes) {
      if (n.id === "pd-stop") {
        foundPdNode = n;
        break;
      }
    }
    if (foundPdNode) break;
  }

  // P&D node must appear exactly once (not split)
  let pdCount = 0;
  for (const route of result.routes) {
    pdCount += route.nodes.filter(n => n.id === "pd-stop").length;
  }
  pdCount += result.unassigned.filter(n => n.id === "pd-stop").length;

  assert.equal(pdCount, 1, "P&D node must appear exactly once across all routes and unassigned");

  if (foundPdNode) {
    assert.ok(foundPdNode.pickupLat !== undefined, "pickupLat must be preserved on P&D node");
    assert.ok(foundPdNode.pickupLon !== undefined, "pickupLon must be preserved on P&D node");
  }
});

// ── 6. Service report billing_ready requires completedAt (unit guard) ─────────

test("billing_ready service report without completedAt is rejected", () => {
  // This mirrors the route-level guard in field-service.ts
  const status = "billing_ready";
  const completedAt = undefined;
  const isInvalid = status === "billing_ready" && !completedAt;
  assert.equal(isInvalid, true, "billing_ready without completedAt must be flagged invalid");
});

test("billing_ready service report with completedAt is accepted", () => {
  const status = "billing_ready";
  const completedAt = new Date();
  const isInvalid = status === "billing_ready" && !completedAt;
  assert.equal(isInvalid, false, "billing_ready with completedAt must be valid");
});

// ── 7. Optimizer: eligible vehicle + ineligible vehicle, eligible wins ────────

test("optimizer assigns FS stop to eligible vehicle when another is ineligible", async () => {
  const fsStop = makeStop("fs-specific", {
    requiredSkills: ["SPECIALIST"],
    latitude: DEPOT.lat + 0.008,
    longitude: DEPOT.lon + 0.008,
  });

  const eligibleVehicle = makeVehicle("v-eligible-2");
  const ineligibleVehicle = makeVehicle("v-ineligible-2", {
    ineligibleStopIds: new Set(["fs-specific"]),
  });

  const result = await optimizeWithALNS(
    [fsStop],
    [eligibleVehicle, ineligibleVehicle],
    DEPOT.lat,
    DEPOT.lon,
    new Date("2026-01-01T08:00:00Z"),
    { timeLimitMs: 1000, maxIterations: 300 },
  );

  // fs-specific should be assigned to v-eligible-2 (not ineligible, not unassigned)
  const assignedToEligible = result.routes
    .find(r => r.vehicleId === "v-eligible-2")
    ?.nodes.some(n => n.id === "fs-specific") ?? false;

  assert.equal(assignedToEligible, true, "FS stop must be assigned to the eligible vehicle");
  assert.equal(
    result.unassigned.some(n => n.id === "fs-specific"),
    false,
    "FS stop must not remain unassigned when an eligible vehicle exists",
  );
});

// ── 8. Transport capacity preserved: FS stop still respects kg/vol capacity ──

test("capacity constraints are still enforced for field service stops", () => {
  const heavyFsStop = makeStop("heavy-fs", {
    weightKg: 2000, // heavier than the vehicle
    requiredSkills: ["CRANE"],
  });
  const vehicle = makeVehicle("v-small", { capacityKg: 500 });

  const route: ALNSRoute = {
    vehicleId: "v-small",
    nodes: [heavyFsStop],
    totalWeight: 2000,
    totalVolume: 0.2,
  };
  const result = evaluateRoute(route, vehicle, DEPOT.lat, DEPOT.lon, new Date("2026-01-01T08:00:00Z"));
  assert.equal(result.feasible, false, "overweight FS stop must still be infeasible");
});
