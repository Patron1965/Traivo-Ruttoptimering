import test from "node:test";
import assert from "node:assert/strict";
import {
  groupRoutesByPlan,
  isTerminalRouteStatus,
  routePlanGroupKey,
} from "./route-plan-groups.ts";

function route(
  id: string,
  planId: string | null,
  status: string,
  totalStops = 1,
  vehicleId: string | null = null,
) {
  return { id, planId, status, totalStops, vehicleId };
}

test("groups only by planId and keeps mixed-status children together", () => {
  const groups = groupRoutesByPlan([
    route("active", "plan-a", "in_progress", 4, "vehicle-a"),
    route("cancelled", "plan-a", "cancelled", 3, "vehicle-b"),
    route("same-day-other-plan", "plan-b", "completed", 2, "vehicle-c"),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].routes.map((item) => item.id), ["active", "cancelled"]);
  assert.equal(groups[0].totalStops, 7);
  assert.equal(groups[0].vehicleCount, 2);
  assert.equal(groups[0].missingVehicleCount, 0);
  assert.equal(groups[0].hasNonTerminalRoute, true);
  assert.equal(groups[1].hasNonTerminalRoute, false);
});

test("isolates every route without a plan identity", () => {
  const first = route("legacy-a", null, "completed");
  const second = route("legacy-b", null, "completed");

  const groups = groupRoutesByPlan([first, second]);

  assert.equal(groups.length, 2);
  assert.notEqual(routePlanGroupKey(first), routePlanGroupKey(second));
  assert.equal(groups[0].fallbackId, "legacy-a");
  assert.equal(groups[1].fallbackId, "legacy-b");
});

test("counts unique vehicles separately from child route rows and missing vehicles", () => {
  const groups = groupRoutesByPlan([
    { ...route("first-run", "plan-a", "optimized"), vehicleId: "vehicle-a" },
    { ...route("second-run", "plan-a", "completed"), vehicleId: "vehicle-a" },
    { ...route("missing-run", "plan-a", "draft"), vehicleId: null },
  ]);

  assert.equal(groups[0].routes.length, 3);
  assert.equal(groups[0].vehicleCount, 1);
  assert.equal(groups[0].missingVehicleCount, 1);
});

test("terminal status classification does not turn cancelled into completed", () => {
  assert.equal(isTerminalRouteStatus("completed"), true);
  assert.equal(isTerminalRouteStatus("cancelled"), true);
  assert.equal(isTerminalRouteStatus("in_progress"), false);
});
