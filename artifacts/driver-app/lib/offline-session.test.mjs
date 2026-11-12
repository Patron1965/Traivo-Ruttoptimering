import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineSession, readOfflineSession, sameOfflineAssignment, MAX_OFFLINE_MS } from "./offline-session.ts";

const now = Date.parse("2026-10-14T06:00:00Z");
const user = { id: "synthetic-a", name: "Synthetic A", email: "a@example.invalid", role: "driver", organizationId: "synthetic-org-a", driverProfileId: "driver-a" };
const driver = { id: "driver-a", name: "Synthetic A", organizationId: user.organizationId, vehicleId: "vehicle-a", phone: null, email: null };
const session = { idleTimeoutMin: 60, absoluteTimeoutHours: 24, absoluteExpiresAt: new Date(now + 24 * 3600_000).toISOString() };
const snapshot = () => createOfflineSession("synthetic-token-a", user, driver, session, now);

test("airplane-mode cold start restores only a previously verified token and driver", () => {
  const saved = snapshot();
  assert.deepEqual(readOfflineSession(JSON.stringify(saved), "synthetic-token-a", now + 30 * 60_000), saved);
  assert.equal(readOfflineSession(JSON.stringify(saved), "synthetic-token-b", now), null);
  assert.equal(readOfflineSession(null, "synthetic-token-a", now), null);
  assert.equal(readOfflineSession("{broken", "synthetic-token-a", now), null);
});

test("local access expires at the earliest idle, absolute or 12-hour boundary", () => {
  assert.equal(snapshot().expiresAt, now + 3600_000);
  assert.equal(readOfflineSession(JSON.stringify(snapshot()), "synthetic-token-a", now + 3600_000), null);
  const shorter = createOfflineSession("t", user, driver, { ...session, absoluteExpiresAt: new Date(now + 10_000).toISOString() }, now);
  assert.equal(shorter.expiresAt, now + 10_000);
  const long = createOfflineSession("t", user, driver, { ...session, idleTimeoutMin: 24 * 60 }, now);
  assert.equal(long.expiresAt, now + MAX_OFFLINE_MS);
  assert.equal(createOfflineSession("t", user, driver, { ...session, absoluteExpiresAt: "invalid" }, now), null);
  assert.equal(createOfflineSession("t", user, driver, { ...session, idleTimeoutMin: 0 }, now), null);
  assert.equal(readOfflineSession(JSON.stringify(snapshot()), "synthetic-token-a", now - 1), null);
});

test("administrators, unassigned drivers and mismatched tenants have no offline grant", () => {
  assert.equal(createOfflineSession("t", { ...user, role: "admin" }, driver, session, now), null);
  assert.equal(createOfflineSession("t", user, null, session, now), null);
  assert.equal(createOfflineSession("t", user, { ...driver, vehicleId: null }, session, now), null);
  assert.equal(createOfflineSession("t", user, { ...driver, organizationId: "other" }, session, now), null);
  assert.equal(createOfflineSession("t", user, { ...driver, id: "other" }, session, now), null);
});

test("reconnection requires the exact account, company, role and assignment", () => {
  const previous = snapshot();
  assert.equal(sameOfflineAssignment(previous, user, driver), true);
  assert.equal(sameOfflineAssignment(previous, { ...user, id: "synthetic-b" }, driver), false);
  assert.equal(sameOfflineAssignment(previous, { ...user, organizationId: "org-b" }, driver), false);
  assert.equal(sameOfflineAssignment(previous, { ...user, role: "admin" }, driver), false);
  assert.equal(sameOfflineAssignment(previous, user, { ...driver, id: "driver-b" }), false);
  assert.equal(sameOfflineAssignment(previous, user, { ...driver, vehicleId: "vehicle-b" }), false);
  assert.equal(sameOfflineAssignment(previous, user, null), false);
});

test("malformed or extended grants fail closed", () => {
  const saved = snapshot();
  for (const value of [
    { ...saved, version: 2 },
    { ...saved, expiresAt: now + MAX_OFFLINE_MS + 1 },
    { ...saved, verifiedAt: null },
    { ...saved, user: { ...user, role: "admin" } },
    { ...saved, driver: { ...driver, organizationId: "org-b" } },
  ]) assert.equal(readOfflineSession(JSON.stringify(value), "synthetic-token-a", now), null);
});
