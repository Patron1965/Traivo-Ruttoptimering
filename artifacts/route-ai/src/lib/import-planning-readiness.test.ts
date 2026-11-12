import assert from "node:assert/strict";
import test from "node:test";
import { getInitialPlanReadiness } from "./import-planning-readiness.ts";

test("allows a coherent large persisted import without a size-based block", () => {
  const stopIds = Array.from({ length: 228 }, (_, index) => `stop-${index}`);
  const stops = stopIds.map((id) => ({ id, archivedAt: null }));
  assert.deepEqual(getInitialPlanReadiness(stopIds, stops), {
    ready: true,
    reason: "ready",
  });
});

test("gates planning when persisted IDs and records do not match", () => {
  assert.equal(
    getInitialPlanReadiness(["stop-1", "stop-2"], [{ id: "stop-1" }]).reason,
    "missing_records",
  );
  assert.equal(
    getInitialPlanReadiness(["stop-1", "stop-1"], [{ id: "stop-1" }]).reason,
    "duplicate_ids",
  );
});