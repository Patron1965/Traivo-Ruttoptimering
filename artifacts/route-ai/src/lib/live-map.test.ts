import test from "node:test";
import assert from "node:assert/strict";
import { selectMapRoutes, selectLiveRouteItems } from "./live-map.ts";

const routes = ["draft", "planned", "dispatched", "in_progress", "completed", "cancelled"].map(status => ({ id: status, status }));
test("live mode excludes terminal routes; history requires an explicit choice", () => {
  assert.deepEqual(selectMapRoutes(routes, false).map(r => r.id), ["draft", "planned", "dispatched", "in_progress"]);
  assert.deepEqual(selectMapRoutes(routes, true).map(r => r.id), ["completed", "cancelled"]);
  assert.deepEqual(selectMapRoutes([], false), []);
});
test("live positions and activity cannot leak terminal, unknown or unassigned routes", () => {
  const items = [...routes.map(r => ({ routeId: r.id })), { routeId: "unknown" }, { routeId: null }];
  assert.deepEqual(selectLiveRouteItems(items, routes).map(r => r.routeId), ["draft", "planned", "dispatched", "in_progress"]);
  assert.deepEqual(selectLiveRouteItems(items, []), []);
});
test("a completed route immediately disappears from live items", () => {
  assert.equal(selectLiveRouteItems([{ routeId: "x" }], [{ id: "x", status: "in_progress" }]).length, 1);
  assert.equal(selectLiveRouteItems([{ routeId: "x" }], [{ id: "x", status: "completed" }]).length, 0);
});