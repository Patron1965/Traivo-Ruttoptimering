import assert from "node:assert/strict";
import { test } from "node:test";
import { routePlanningSettingsMatchCurrent } from "./route-plan-approval-service";
import { effectivePlanningPolicy, withOrganizationPlanningPolicy } from "./planning-policy";
import { evaluateRouteWorkday } from "./route-workday";
import type { ALNSVehicle } from "./alns/types";

test("approval accepts stricter plan limits but invalidates newly disallowed allowances", () => {
  const route = {
    optimizationPlanningSnapshot: {
      version: 1 as const,
      objective: "balanced" as const,
      travelReservePercent: 0,
      stopReserveMin: 0,
      stopPriorities: {},
      excludedPairValues: [],
      depotOverride: null,
      vehicleSelectionMode: "use_all_selected_pairs" as const,
      maxDriverOvertimeMin: 10,
      allowLateStopsMin: 5,
    },
  };
  assert.equal(routePlanningSettingsMatchCurrent(route, {
    maxDriverOvertimeMin: 10,
    allowLateStopsMin: 5,
  }), true);
  assert.equal(routePlanningSettingsMatchCurrent(route, {
    maxDriverOvertimeMin: 11,
    allowLateStopsMin: 5,
  }), true);
  assert.equal(routePlanningSettingsMatchCurrent(route, {
    maxDriverOvertimeMin: 10,
    allowLateStopsMin: 6,
  }), true);
  assert.equal(routePlanningSettingsMatchCurrent(route, {
    maxDriverOvertimeMin: 9,
    allowLateStopsMin: 5,
  }), false);
  assert.equal(routePlanningSettingsMatchCurrent(route, {
    maxDriverOvertimeMin: 10,
    allowLateStopsMin: 4,
  }), false);
});

test("explicit zero survives organization 15/5 defaults, fresh evaluation and approval", () => {
  const organization = { maxDriverOvertimeMin: 15, allowLateStopsMin: 5 };
  const plan = { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 };
  const effective = effectivePlanningPolicy(organization, plan);
  assert.deepEqual(effective, plan);
  assert.deepEqual(effectivePlanningPolicy(organization, undefined), organization);
  assert.deepEqual(effectivePlanningPolicy(organization, organization), organization);
  assert.deepEqual(effectivePlanningPolicy(organization, { maxDriverOvertimeMin: 0 }),
    { maxDriverOvertimeMin: 0, allowLateStopsMin: 5 });
  assert.deepEqual(effectivePlanningPolicy(organization, { maxDriverOvertimeMin: 30 }),
    organization);
  assert.equal(routePlanningSettingsMatchCurrent({
    optimizationPlanningSnapshot: {
      version: 1, objective: "balanced", travelReservePercent: 0, stopReserveMin: 0,
      stopPriorities: {}, excludedPairValues: [], depotOverride: null,
      vehicleSelectionMode: "use_all_selected_pairs", ...plan,
    },
  }, organization), true);
  const base: ALNSVehicle = {
    id: "synthetic", vehicleType: "fossil", capacityKg: 100, capacityVolume: 10, rangeKm: null,
  };
  const stop = {
    id: "visit", latitude: 59.33, longitude: 18.07, serviceDurationMin: 481,
    timeWindowStart: null, timeWindowEnd: null, weightKg: 0, volumeM3: 0,
  };
  const date = new Date("2026-01-01T07:00:00Z");
  const result = evaluateRouteWorkday([stop], withOrganizationPlanningPolicy(base, effective),
    59.33, 18.07, date);
  assert.equal(result.feasible, false);
  assert.equal(result.summary.allowedOvertimeMin, 0);
  assert.equal(result.summary.overtimeMin, 1);
  assert.equal(evaluateRouteWorkday([stop], withOrganizationPlanningPolicy(base, organization),
    59.33, 18.07, date).feasible, true);
});