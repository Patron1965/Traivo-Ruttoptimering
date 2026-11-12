import { test } from "node:test";
import assert from "node:assert/strict";
import {
  policyToALNSConfig,
  resolveOptimizationPolicy,
} from "./alns/optimization-policy";

test("nine-stop jobs receive the small adaptive profile", () => {
  const policy = resolveOptimizationPolicy(9);

  assert.equal(policy.profile, "small");
  assert.equal(policy.timeLimitMs, 3_500);
  assert.equal(policy.maxNoImprovementIterations, 600);
  assert.ok(policy.localSearchTimeLimitMs < 1_000);
  assert.equal(policy.distanceMatrixTimeoutMs, 10_000);
  assert.ok(policy.weatherTimeoutMs <= 1_000);
});

test("an explicit time budget remains authoritative", () => {
  const policy = resolveOptimizationPolicy(9, 30_000);
  const config = policyToALNSConfig(policy);

  assert.equal(policy.profile, "custom");
  assert.equal(config.timeLimitMs, 30_000);
  assert.equal(config.maxNoImprovementIterations, undefined);
  assert.equal(config.localSearchTimeLimitMs, 5_000);
});

test("larger jobs keep the standard search budget", () => {
  const policy = resolveOptimizationPolicy(40);

  assert.equal(policy.profile, "standard");
  assert.equal(policy.timeLimitMs, 30_000);
  assert.equal(policy.maxNoImprovementIterations, undefined);
});