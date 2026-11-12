import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritativeServiceStartIso,
  buildFreezeRequest,
  buildResourceLockRequest,
  buildTimeLockRequest,
  isExactMinuteInstant,
  lockEvidence,
  planningLockErrorGuidance,
  stopLockBlock,
} from "./planning-locks.ts";

const route = { id: "r1", planRevision: 7, vehicleId: "v1", driverId: "d1", optimizationFrozen: false };
const stop = { id: "s1", status: "pending", routeId: "r1" };

test("exact minute instants", () => {
  assert.equal(isExactMinuteInstant("2025-03-01T08:15:00Z"), true);
  assert.equal(isExactMinuteInstant("2025-03-01T08:15:00+01:00"), true);
  assert.equal(isExactMinuteInstant("2025-03-01T08:15:30Z"), false);
  assert.equal(isExactMinuteInstant("2025-03-01T08:15:00"), false);
  assert.equal(isExactMinuteInstant(null), false);
});

test("authoritative service start never rounds or guesses", () => {
  assert.equal(authoritativeServiceStartIso("2025-03-01T08:15:00.000Z", true), "2025-03-01T08:15:00Z");
  assert.equal(authoritativeServiceStartIso("2025-03-01T08:15:12Z", true), null);
  assert.equal(authoritativeServiceStartIso("2025-03-01T08:15:00Z", false), null);
  assert.equal(authoritativeServiceStartIso(undefined, true), null);
});

test("request builders use current revision", () => {
  assert.deepEqual(buildFreezeRequest(route, true), { planRevision: 7, frozen: true });
  assert.deepEqual(buildResourceLockRequest(route, "s1", true), {
    planRevision: 7, stopId: "s1", resourcePair: { vehicleId: "v1", driverId: "d1" },
  });
  assert.deepEqual(buildResourceLockRequest(route, "s1", false), { planRevision: 7, stopId: "s1", resourcePair: null });
  assert.throws(() => buildResourceLockRequest({ ...route, driverId: null }, "s1", true));
  assert.throws(() => buildTimeLockRequest(route, "s1", "2025-03-01T08:15:01Z"));
  assert.deepEqual(buildTimeLockRequest(route, "s1", null), { planRevision: 7, stopId: "s1", serviceStartAt: null });
});

test("stop lock eligibility", () => {
  assert.equal(stopLockBlock(route, stop, true), null);
  assert.equal(stopLockBlock(route, stop, false), "role");
  assert.equal(stopLockBlock({ ...route, optimizationFrozen: true }, stop, true), "frozen");
  assert.equal(stopLockBlock(route, { ...stop, status: "completed" }, true), "not_pending");
  assert.equal(stopLockBlock(route, { ...stop, routeId: "r2" }, true), "not_on_route");
});

test("evidence and guidance", () => {
  assert.deepEqual(lockEvidence({ optimizationFrozen: true }, {
    id: "s1", lockedVehicleId: "v", lockedDriverId: "d", lockedServiceStartAt: "2025-03-01T08:15:00Z",
  }), ["frozen", "resource", "time"]);
  assert.deepEqual(lockEvidence(null, null), []);
  assert.match(planningLockErrorGuidance(409), /manuellt/);
  assert.match(planningLockErrorGuidance(401), /Logga in/);
});
