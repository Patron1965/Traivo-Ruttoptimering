import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseGpsSession,
  gpsPermissionDecision,
  isCurrentAssistanceScope,
  offlineQueueKey,
  retainClientMessageId,
  shouldInvalidateGpsForHttpStatus,
  shouldRecoverSyncLease,
} from "./mobile-invariants.ts";

test("invalid GPS responses require OS collection shutdown", () => {
  assert.equal(shouldInvalidateGpsForHttpStatus(401), true);
  assert.equal(shouldInvalidateGpsForHttpStatus(403), true);
  assert.equal(shouldInvalidateGpsForHttpStatus(409), true);
  assert.equal(shouldInvalidateGpsForHttpStatus(400), false);
});

test("GPS session is bound to route, user, and organization", () => {
  const session = {
    routeId: "route-a",
    userId: "driver-a",
    organizationId: "org-a",
    status: "active",
  };
  assert.equal(canUseGpsSession(session, { userId: "driver-a", organizationId: "org-a" }, "route-a"), true);
  assert.equal(canUseGpsSession(session, { userId: "driver-b", organizationId: "org-a" }, "route-a"), false);
  assert.equal(canUseGpsSession(session, { userId: "driver-a", organizationId: "org-b" }, "route-a"), false);
  assert.equal(canUseGpsSession(session, { userId: "driver-a", organizationId: "org-a" }, "route-b"), false);
});

test("offline queue namespace fails closed and separates users", () => {
  assert.equal(offlineQueueKey("pod", { userId: "a", organizationId: "org" }), "pod:a:org");
  assert.notEqual(
    offlineQueueKey("pod", { userId: "a", organizationId: "org" }),
    offlineQueueKey("pod", { userId: "b", organizationId: "org" }),
  );
  assert.throws(() => offlineQueueKey("pod", null), /scope is unavailable/);
});

test("interrupted syncing items recover only after their lease expires", () => {
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  assert.equal(shouldRecoverSyncLease("syncing", "2026-01-01T00:09:59.000Z", now, 120_000), false);
  assert.equal(shouldRecoverSyncLease("syncing", "2026-01-01T00:07:00.000Z", now, 120_000), true);
  assert.equal(shouldRecoverSyncLease("pending", undefined, now, 120_000), false);
});

test("permission lifecycle requires foreground and background native grants", () => {
  assert.deepEqual(gpsPermissionDecision("web", "denied"), { allowed: true, reason: null });
  assert.deepEqual(gpsPermissionDecision("ios", "denied"), { allowed: false, reason: "foreground" });
  assert.deepEqual(gpsPermissionDecision("android", "granted", "denied"), { allowed: false, reason: "background" });
  assert.deepEqual(gpsPermissionDecision("android", "granted", "granted"), { allowed: true, reason: null });
});

test("message retries reuse the exact client id", () => {
  const id = "message-123";
  assert.equal(retainClientMessageId(id), id);
  assert.throws(() => retainClientMessageId("  "), /required/);
});

test("live-assistance results cannot bleed across driver or route switches", () => {
  const first = "driver-a:route-a";
  assert.equal(isCurrentAssistanceScope(first, first), true);
  assert.equal(isCurrentAssistanceScope(first, "driver-b:route-b"), false);
  assert.equal(isCurrentAssistanceScope(first, "driver-a:route-b"), false);
  assert.equal(isCurrentAssistanceScope(first, null), false);
});