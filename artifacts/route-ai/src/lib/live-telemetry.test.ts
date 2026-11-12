import assert from "node:assert/strict";
import test from "node:test";
import {
  actualTelemetryOnly, isDispatchedOrDriving, latestActualByRoute, readTrafficLayout, telemetryStatus, formatAge,
} from "./live-telemetry.ts";

const now = Date.parse("2025-03-01T10:00:00Z");
const real = (routeId: string, at: string, extra = {}) => ({ routeId, isRealGps: true, measuredAt: at, latitude: 59.3, longitude: 18.0, ...extra });

test("planned markers are never treated as positions", () => {
  assert.equal(telemetryStatus({ routeId: "r", isRealGps: false, measuredAt: null, latitude: 59, longitude: 18 }, now), "no-position");
  assert.equal(telemetryStatus({ routeId: "r", latitude: 59, longitude: 18 }, now), "no-position");
  assert.equal(telemetryStatus(undefined, now), "no-position");
  assert.equal(actualTelemetryOnly([{ routeId: "r", isRealGps: true, measuredAt: null, latitude: 1, longitude: 1 }]).length, 0);
});

test("invalid coordinates are no position", () => {
  assert.equal(telemetryStatus(real("r", "2025-03-01T09:59:30Z", { latitude: 0, longitude: 0 }), now), "no-position");
  assert.equal(telemetryStatus(real("r", "2025-03-01T09:59:30Z", { latitude: 200 }), now), "no-position");
});

test("fresh and stale classification", () => {
  assert.equal(telemetryStatus(real("r", "2025-03-01T09:59:30Z"), now), "live");
  assert.equal(telemetryStatus(real("r", "2025-03-01T09:50:00Z"), now), "stale");
});

test("latest actual fix per route", () => {
  const map = latestActualByRoute([
    real("a", "2025-03-01T09:50:00Z"), real("a", "2025-03-01T09:55:00Z"),
    { routeId: "a", isRealGps: false, measuredAt: "2025-03-01T09:59:00Z", latitude: 1, longitude: 1 },
  ]);
  assert.equal(map.get("a")?.measuredAt, "2025-03-01T09:55:00Z");
});

test("dispatched or driving routes", () => {
  assert.equal(isDispatchedOrDriving({ status: "in_progress" }), true);
  assert.equal(isDispatchedOrDriving({ status: "optimized", handoffStatus: "accepted" }), true);
  assert.equal(isDispatchedOrDriving({ status: "optimized", handoffStatus: "pending" }), false);
  assert.equal(isDispatchedOrDriving({ status: "completed", handoffStatus: "accepted" }), false);
});

test("layout and age", () => {
  assert.equal(readTrafficLayout("map"), "map");
  assert.equal(readTrafficLayout("x"), "split");
  assert.equal(formatAge(90_000), "1 min sedan");
});
