import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileContinuousOptimizationStatus } from "./continuous-optimization-lifecycle.ts";

test("stale running status stays stopped after a confirmed stop", () => {
  const status = reconcileContinuousOptimizationStatus(
    { running: true, startedAt: 100, iteration: 8 },
    100,
  );

  assert.equal(status?.running, false);
});

test("an authoritative idle status remains stopped", () => {
  const status = reconcileContinuousOptimizationStatus(
    { running: false, startedAt: 100, iteration: 8 },
    100,
  );

  assert.equal(status?.running, false);
});

test("a newer run from another client is accepted", () => {
  const status = reconcileContinuousOptimizationStatus(
    { running: true, startedAt: 101, iteration: 1 },
    100,
  );

  assert.equal(status?.running, true);
  assert.equal(status?.startedAt, 101);
});