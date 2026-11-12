import test from "node:test";
import assert from "node:assert/strict";
import { positionFreshness } from "./position-freshness.ts";

const now = Date.parse("2026-10-19T12:00:00Z");
test("no sample or impossible timestamp never implies live GPS", () => {
  for (const value of [undefined, null, "", "invalid", "2026-10-19T13:00:00Z"]) {
    assert.equal(positionFreshness(value, now).status, "missing");
  }
});
test("telemetry ages without another network response", () => {
  const sample = "2026-10-19T11:59:00Z";
  assert.equal(positionFreshness(sample, now).status, "current");
  assert.equal(positionFreshness(sample, now + 120_000).status, "stale");
});
