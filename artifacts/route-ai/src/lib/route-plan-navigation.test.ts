import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDispatchScope,
  routeMatchesPlan,
  trafficDispatchHref,
} from "./route-plan-navigation.ts";

test("traffic links preserve plan and route intent", () => {
  assert.equal(
    trafficDispatchHref({ planId: "plan 1", routeId: "route/2" }),
    "/dispatch?view=traffic&planId=plan+1&routeId=route%2F2",
  );
});

test("all-plans scope clears both URL selections without dropping view mode", () => {
  assert.equal(
    clearDispatchScope("?view=traffic&mode=plan&planId=plan-1&routeId=route-2"),
    "?view=traffic&mode=plan",
  );
});

test("route intent cannot match a route from another plan", () => {
  assert.equal(routeMatchesPlan({ id: "route-1", planId: "plan-1" }, "plan-1"), true);
  assert.equal(routeMatchesPlan({ id: "route-1", planId: "plan-2" }, "plan-1"), false);
  assert.equal(routeMatchesPlan({ id: "route-1", planId: null }, "plan-1"), false);
});