import assert from "node:assert/strict";
import test from "node:test";
import { applyDriverRoutingProfile } from "./driver-routing-profile";
import { evaluateRoute } from "./alns/cost";
import { evaluateRouteWorkday } from "./route-workday";
import type { ALNSDriverConstraints, ALNSRoute, ALNSVehicle } from "./alns/types";

test("driver profile limits vehicle capacity and carries routing endpoints and tempo", () => {
  const result = applyDriverRoutingProfile(
    {
      id: "vehicle-1",
      vehicleType: "fossil",
      capacityKg: 2_000,
      capacityVolume: 20,
      rangeKm: null,
    },
    {
      capacityKg: 900,
      capacityVolume: 8,
      startLatitude: 59.33,
      startLongitude: 18.06,
      endLatitude: 59.35,
      endLongitude: 18.09,
      tempo: "slow",
    },
  );

  assert.equal(result.capacityKg, 900);
  assert.equal(result.capacityVolume, 8);
  assert.equal(result.startLatitude, 59.33);
  assert.equal(result.endLongitude, 18.09);
  assert.equal(result.tempoMultiplier, 1.15);
});

test("driver cannot raise the physical vehicle capacity", () => {
  const result = applyDriverRoutingProfile(
    {
      id: "vehicle-1",
      vehicleType: "fossil",
      capacityKg: 1_000,
      capacityVolume: 10,
      rangeKm: null,
    },
    {
      capacityKg: 5_000,
      capacityVolume: 50,
      startLatitude: null,
      startLongitude: null,
      endLatitude: null,
      endLongitude: null,
      tempo: "fast",
    },
  );

  assert.equal(result.capacityKg, 1_000);
  assert.equal(result.capacityVolume, 10);
  assert.equal(result.tempoMultiplier, 0.9);
});

const baseVehicle: ALNSVehicle = {
  id: "vehicle-1",
  vehicleType: "fossil",
  capacityKg: 1_000,
  capacityVolume: 10,
  rangeKm: null,
};

const baseConstraints: ALNSDriverConstraints = {
  vehicleId: "vehicle-1",
  driverName: "Test",
  preferredStartTime: "11:45",
  preferredEndTime: "16:00",
  maxDrivingHoursPerDay: 8,
  avoidNightDriving: false,
  breakFrequencyMinutes: 120,
  preferredBreakDurationMin: 15,
  breakStartTime: "12:00",
  breakEndTime: "12:30",
};

test("a service interval crossing the mandatory break waits for contiguous service", () => {
  const route: ALNSRoute = {
    vehicleId: "vehicle-1",
    nodes: [{
      id: "stop-1",
      latitude: 59.3293,
      longitude: 18.0686,
      timeWindowStart: null,
      timeWindowEnd: null,
      serviceDurationMin: 60,
      weightKg: 1,
      volumeM3: 1,
    }],
    totalWeight: 1,
    totalVolume: 1,
  };
  const start = new Date("2026-01-01T08:00:00Z");
  const result = evaluateRoute(route, baseVehicle, 59.3293, 18.0686, start, baseConstraints);
  const workday = evaluateRouteWorkday(
    route.nodes,
    baseVehicle,
    59.3293,
    18.0686,
    start,
    baseConstraints,
  );

  assert.equal(result.feasible, true);
  assert.equal(result.endTime.toISOString(), "2026-01-01T12:30:00.000Z");
  assert.equal(workday.summary.serviceMin, 60);
  assert.equal(workday.summary.breakMin, 30);
  assert.equal(workday.summary.waitingMin, 15);
  assert.equal(workday.events.filter(event => event.type === "service").length, 1);
});

test("driver work end is a hard feasibility limit", () => {
  const route: ALNSRoute = {
    vehicleId: "vehicle-1",
    nodes: [{
      id: "stop-1",
      latitude: 59.3293,
      longitude: 18.0686,
      timeWindowStart: null,
      timeWindowEnd: null,
      serviceDurationMin: 90,
      weightKg: 1,
      volumeM3: 1,
    }],
    totalWeight: 1,
    totalVolume: 1,
  };
  const constraints = {
    ...baseConstraints,
    preferredStartTime: "15:00",
    breakStartTime: null,
    breakEndTime: null,
  };
  const result = evaluateRoute(route, baseVehicle, 59.3293, 18.0686, new Date(), constraints);
  assert.equal(result.feasible, false);
});