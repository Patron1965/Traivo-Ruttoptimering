import assert from "node:assert/strict";
import test from "node:test";
import {
  getProgressElapsedMs,
  isCompleteProgressPayload,
  isProgressRecordForRun,
  isFreshProgressRecord,
  missingProgressStatus,
  isDefinitivePlanRejection,
  shouldSurfacePollAbort,
  type ProgressTimeRecord,
} from "./import-route-plan-progress-state.ts";

function record(overrides: Partial<ProgressTimeRecord> = {}): ProgressTimeRecord {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:10.000Z",
    serverNow: "2026-01-01T00:00:12.000Z",
    elapsedMs: 12_000,
    ...overrides,
  };
}

test("progress is fresh inside the heartbeat freshness window", () => {
  assert.equal(isFreshProgressRecord(record()), true);
  assert.equal(
    isFreshProgressRecord(
      record({
        updatedAt: "2026-01-01T00:00:00.000Z",
        serverNow: "2026-01-01T00:00:21.000Z",
      }),
    ),
    false,
  );
});

test("elapsed time is server anchored and never inferred from an invalid clock", () => {
  assert.equal(
    getProgressElapsedMs(
      record({
        elapsedMs: Number.NaN,
        startedAt: "2026-01-01T00:00:00.000Z",
        serverNow: "2026-01-01T00:00:17.500Z",
      }),
    ),
    17_500,
  );
  assert.equal(
    getProgressElapsedMs(
      record({ elapsedMs: Number.NaN, startedAt: "not-a-date" }),
    ),
    null,
  );
});

test("active timeout reconnects but cleanup aborts stay silent", () => {
  assert.equal(shouldSurfacePollAbort("AbortError", true), true);
  assert.equal(shouldSurfacePollAbort("AbortError", false), false);
  assert.equal(shouldSurfacePollAbort("TypeError", false), true);
});

test("a newly submitted run can register before a missing record is called a delay", () => {
  assert.equal(missingProgressStatus(false, 1000, 1000), "starting");
  assert.equal(missingProgressStatus(false, 1000, 20_999), "starting");
  assert.equal(missingProgressStatus(false, 1000, 21_000), "reconnecting");
});

test("missing known or restored runs do not get a startup grace period", () => {
  assert.equal(missingProgressStatus(true, 1000, 1001), "reconnecting");
  assert.equal(missingProgressStatus(false, null, 1001), "reconnecting");
  assert.equal(missingProgressStatus(false, 1001, 1000), "reconnecting");
});

test("completion requires the current identity and a result envelope", () => {
  assert.equal(isProgressRecordForRun("run-1", "run-1"), true);
  assert.equal(isProgressRecordForRun("run-1", "run-2"), false);
  assert.equal(isCompleteProgressPayload("complete", { planId: "plan-1" }), true);
  assert.equal(isCompleteProgressPayload("complete", null), false);
  assert.equal(isCompleteProgressPayload("running", { planId: "plan-1" }), false);
});

test("explicit road-data rejection ends waiting, but gateway failures remain recoverable", () => {
  assert.equal(isDefinitivePlanRejection(503, "ROAD_DATA_UNAVAILABLE"), true);
  assert.equal(isDefinitivePlanRejection(503, "IMPORT_ROUTE_PLAN_FAILED"), false);
  assert.equal(isDefinitivePlanRejection(502, "ROAD_DATA_UNAVAILABLE"), false);
  assert.equal(isDefinitivePlanRejection(null, "ROAD_DATA_UNAVAILABLE"), false);
  assert.equal(isDefinitivePlanRejection(409, "PLAN_CONFLICT"), true);
  assert.equal(isDefinitivePlanRejection(408, "TIMEOUT"), false);
  assert.equal(isDefinitivePlanRejection(429, "RATE_LIMITED"), false);
});
