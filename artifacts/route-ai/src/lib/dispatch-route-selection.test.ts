import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileDriverRoutes, routeHighlight, selectDriverRoute, singleDriverRoute } from "./dispatch-route-selection.ts";

test("ordinary row click selects only that route, including when already selected", () => {
  const current = new Set(["a", "c"]);
  assert.deepEqual([...selectDriverRoute(current, "b", false)], ["b"]);
  assert.deepEqual([...selectDriverRoute(current, "a", false)], ["a"]);
  assert.deepEqual([...current], ["a", "c"]);
});

test("Shift adds non-adjacent rows and toggles them off without changing other rows", () => {
  let current = selectDriverRoute(new Set(), "a", true);
  current = selectDriverRoute(current, "c", true);
  current = selectDriverRoute(current, "f", true);
  assert.deepEqual([...current], ["a", "c", "f"]);
  assert.equal(singleDriverRoute(current), null);
  current = selectDriverRoute(current, "c", true);
  assert.deepEqual([...current], ["a", "f"]);
  current = selectDriverRoute(current, "a", true);
  assert.equal(singleDriverRoute(current), "f");
  current = selectDriverRoute(current, "f", true);
  assert.equal(current.size, 0);
  assert.equal(singleDriverRoute(current), null);
});

test("only current scope rows survive reconciliation; matching driver names never merge routes", () => {
  const result = reconcileDriverRoutes(new Set(["same-driver-route-a", "same-driver-route-b", "other-plan"]),
    new Set(["same-driver-route-a", "same-driver-route-b"]));
  assert.deepEqual([...result], ["same-driver-route-a", "same-driver-route-b"]);
  assert.equal(reconcileDriverRoutes(result, new Set()).size, 0);
});

test("every selected map/timeline route is highlighted and no selected route is dimmed", () => {
  const selected = new Set(["a", "f"]);
  assert.deepEqual(routeHighlight("a", selected), { isHighlighted: true, isDimmed: false });
  assert.deepEqual(routeHighlight("f", selected), { isHighlighted: true, isDimmed: false });
  assert.deepEqual(routeHighlight("b", selected), { isHighlighted: false, isDimmed: true });
  assert.deepEqual(routeHighlight("b", selected, true), { isHighlighted: false, isDimmed: false });
});

test("clearing drivers is neutral on the map and independent of selected stops", () => {
  const stops = new Set(["stop-a", "stop-b"]);
  const drivers = new Set<string>();
  assert.equal(singleDriverRoute(drivers), null);
  assert.deepEqual(routeHighlight("a", drivers), { isHighlighted: false, isDimmed: false });
  assert.deepEqual([...stops], ["stop-a", "stop-b"]);
});
