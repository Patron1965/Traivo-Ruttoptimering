import assert from "node:assert/strict";
import { test } from "node:test";
import { optimizationPlanningInputsWithPolicy, optimizationStartTimeForRequest } from "./optimize";
import { DEFAULT_PLANNING_INPUTS } from "../services/import-route-workflow";
import { effectivePlanningPolicy, withOrganizationPlanningPolicy } from "../services/planning-policy";
import { evaluateRouteWorkday } from "../services/route-workday";

test("optimization clock uses the requested route date instead of wall clock", () => {
  const fallback = new Date("2030-01-01T12:00:00.000Z");
  const requested = optimizationStartTimeForRequest("2026-09-13T00:00:00.000Z", fallback);
  assert.equal(requested.toISOString(), "2026-09-13T00:00:00.000Z");
  assert.equal(optimizationStartTimeForRequest(undefined, fallback), fallback);
});

test("optimization request distinguishes missing allowance fields from explicit zero", () => {
  const organization = { maxDriverOvertimeMin: 15, allowLateStopsMin: 5 };
  const { maxDriverOvertimeMin, allowLateStopsMin, ...legacy } = DEFAULT_PLANNING_INPUTS;
  for (const value of [undefined, null, legacy]) {
    const normalized = optimizationPlanningInputsWithPolicy(value, organization);
    assert.equal(normalized.maxDriverOvertimeMin, 15);
    assert.equal(normalized.allowLateStopsMin, 5);
  }
  for (const plan of [
    { ...legacy, maxDriverOvertimeMin: 0 },
    { ...legacy, maxDriverOvertimeMin: 0, allowLateStopsMin: 0 },
  ]) {
    const normalized = optimizationPlanningInputsWithPolicy(plan, organization);
    assert.equal(normalized.maxDriverOvertimeMin, 0);
    assert.equal(normalized.allowLateStopsMin, "allowLateStopsMin" in plan ? 0 : 5);
    assert.deepEqual(optimizationPlanningInputsWithPolicy(JSON.parse(JSON.stringify(normalized)), organization),
      normalized, "effective persisted snapshot must survive reoptimization");
  }
  const strictDefaults = optimizationPlanningInputsWithPolicy(undefined, {});
  assert.equal(strictDefaults.maxDriverOvertimeMin, 0);
  assert.equal(strictDefaults.allowLateStopsMin, 0);
  assert.ok(Object.hasOwn(strictDefaults, "maxDriverOvertimeMin"));
});

test("optimization request policy matches canonical vehicle and persisted workday evidence", () => {
  const organization = { maxDriverOvertimeMin: 15, allowLateStopsMin: 5 };
  for (const allowance of [0, 15]) {
    const snapshot = optimizationPlanningInputsWithPolicy({
      ...DEFAULT_PLANNING_INPUTS, maxDriverOvertimeMin: allowance,
    }, organization);
    const vehicle = withOrganizationPlanningPolicy({
      id: "synthetic", vehicleType: "fossil" as const, capacityKg: 100, capacityVolume: 10, rangeKm: null,
    }, effectivePlanningPolicy(organization, snapshot));
    const workday = evaluateRouteWorkday([{
      id: "synthetic-visit", latitude: 59.33, longitude: 18.07, serviceDurationMin: 481,
      timeWindowStart: null, timeWindowEnd: null, weightKg: 0, volumeM3: 0,
    }], vehicle, 59.33, 18.07, new Date("2026-01-01T07:00:00Z"));
    assert.equal(workday.summary.allowedOvertimeMin, snapshot.maxDriverOvertimeMin);
    assert.equal(workday.summary.allowLateStopsMin, snapshot.allowLateStopsMin);
    assert.equal(workday.feasible, allowance === 15);
  }
});