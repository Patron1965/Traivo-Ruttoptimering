import assert from "node:assert/strict";
import test from "node:test";
import type { Stop } from "./api";
import { getNextPendingStop } from "./next-stop.ts";

function stop(overrides: Partial<Stop>): Stop {
  return {
    id: "stop",
    routeId: "route",
    address: "Testgatan 1",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    sequenceOrder: 1,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: null,
    notes: null,
    contactName: null,
    contactEmail: null,
    completedAt: null,
    pickupAddress: null,
    pickupLatitude: null,
    pickupLongitude: null,
    ...overrides,
  };
}

test("keeps an invalid-coordinate pending stop as the next stop", () => {
  const invalidFirst = stop({
    id: "first",
    sequenceOrder: 1,
    latitude: null,
    longitude: null,
    navigationVerified: false,
  });
  const verifiedLater = stop({
    id: "second",
    sequenceOrder: 2,
    latitude: 59.3293,
    longitude: 18.0686,
    navigationVerified: true,
  });

  assert.equal(
    getNextPendingStop([verifiedLater, invalidFirst])?.id,
    invalidFirst.id,
  );
});

test("ignores completed stops before the next pending stop", () => {
  const completed = stop({ id: "completed", sequenceOrder: 1, status: "completed" });
  const pending = stop({ id: "pending", sequenceOrder: 2 });

  assert.equal(getNextPendingStop([pending, completed])?.id, pending.id);
});