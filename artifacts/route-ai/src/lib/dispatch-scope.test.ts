import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPlanOptions, ganttPopoutHref, mapPopoutHref, readDispatchScope, resolveDispatchScope, resolveUnplannedPlanScope, selectScopedRoutes, selectScopedUnassignedStops, sortScheduledRows, unambiguousDispatchPlan } from "./dispatch-scope.ts";

const routes = [
  { id: "a", planId: "one", status: "optimized", updatedAt: "2026-09-17", date: "2026-09-17" },
  { id: "b", planId: "two", status: "draft", updatedAt: "2026-09-17", date: "2026-09-17" },
  { id: "c", planId: "one", status: "completed", updatedAt: "2026-09-17", date: "2026-09-17" },
  { id: "legacy", planId: null, status: "completed", updatedAt: "2026-09-17", date: "2026-09-01" },
];
const stops = [
  { id: "assigned", routeId: "a", planningPlanId: "one" },
  { id: "own", routeId: null, planningPlanId: "one" },
  { id: "other", routeId: null, planningPlanId: "two" },
  { id: "unknown", routeId: null, planningPlanId: null },
];

test("no scope yields no rows and no unplanned pool (chooser, not global board)", () => {
  assert.deepEqual(selectScopedRoutes(routes, {}), []);
  assert.deepEqual(selectScopedRoutes(routes, { day: "2026-09-17" }), []);
  assert.deepEqual(selectScopedUnassignedStops(stops, {}, routes), []);
  assert.equal(resolveDispatchScope(routes, {}).status, "none");
});

test("same driver across projects and dates never mixes into one board", () => {
  const ajmel = [
    { id: "s4", planId: "p-sep", status: "optimized", updatedAt: "", date: "2026-09-04T00:00:00Z", name: "Ajmel" },
    { id: "s17", planId: "p-sep", status: "optimized", updatedAt: "", date: "2026-09-17T00:00:00Z", name: "Ajmel" },
    { id: "o29", planId: "p-oct", status: "optimized", updatedAt: "", date: "2026-10-29T00:00:00Z", name: "Ajmel" },
    { id: "o29b", planId: "p-oct", status: "optimized", updatedAt: "", date: "2026-10-29T00:00:00Z", name: "Ajmel" },
  ];
  // Multi-day plan requires a day.
  assert.deepEqual(resolveDispatchScope(ajmel, { planId: "p-sep" }), { status: "needsDay", day: null, days: ["2026-09-04", "2026-09-17"] });
  assert.deepEqual(selectScopedRoutes(ajmel, { planId: "p-sep" }), []);
  assert.deepEqual(selectScopedRoutes(ajmel, { planId: "p-sep", day: "2026-09-17" }).map(r => r.id), ["s17"]);
  // Single-day plan gets its day implicitly; same-named routes are not deduplicated.
  assert.equal(resolveDispatchScope(ajmel, { planId: "p-oct" }).day, "2026-10-29");
  assert.deepEqual(selectScopedRoutes(ajmel, { planId: "p-oct" }).map(r => r.id), ["o29", "o29b"]);
  // Plan + day intersect; another plan's day yields nothing.
  assert.deepEqual(selectScopedRoutes(ajmel, { planId: "p-oct", day: "2026-09-17" }), []);
  assert.deepEqual(selectScopedRoutes(ajmel, { routeId: "s4", day: "2026-09-17" }), []);
  assert.deepEqual(selectScopedRoutes(ajmel, { routeId: "s4" }).map(r => r.id), ["s4"]);
  const options = dispatchPlanOptions(ajmel);
  assert.deepEqual(options.map(o => o.planId), ["p-oct", "p-sep"]);
  assert.equal(options.length, 2);
});

test("only a single open plan is preselected", () => {
  assert.equal(unambiguousDispatchPlan(dispatchPlanOptions(routes)), null);
  assert.equal(unambiguousDispatchPlan(dispatchPlanOptions([routes[0], routes[3]])), "one");
});

test("popout URL carries only the selected scope, respecting the artifact base", () => {
  assert.equal(ganttPopoutHref("?view=live&planId=one&routeId=a&workflow=import", "/app/"), "/app/gantt-popout?planId=one&routeId=a");
  assert.equal(ganttPopoutHref("?view=traffic"), "/gantt-popout");
  assert.match(mapPopoutHref("?planId=one&day=2026-10-19"), /day=2026-10-19/);
  assert.deepEqual(readDispatchScope("?planId=one&routeId=a"), { planId: "one", routeId: "a" });
});

test("explicit plan preserves historical routes and excludes other plans", () => {
  assert.deepEqual(selectScopedRoutes(routes, { planId: "one", routeId: "a" }).map(r => r.id), ["a", "c"]);
  assert.deepEqual(selectScopedRoutes(routes, { planId: "missing" }), []);
  assert.deepEqual(selectScopedRoutes(routes, { routeId: "legacy" }).map(r => r.id), ["legacy"]);
});

test("dispatch order stays stable when routes are edited, with older dates distinguishable", () => {
  const rows = [
    { routeId: "new", driverName: "Anna", vehicleName: "Bil 1", routeDate: "2026-10-01" },
    { routeId: "other", driverName: "Bo", vehicleName: "Bil 2", routeDate: "2026-10-01" },
    { routeId: "old", driverName: "Anna", vehicleName: "Bil 1", routeDate: "2026-09-30" },
  ];
  assert.deepEqual(sortScheduledRows(rows).map(row => row.routeId), ["old", "new", "other"]);
  assert.deepEqual(sortScheduledRows([...rows].reverse()).map(row => row.routeId), ["old", "new", "other"]);
});

test("map scope survives encoded URLs without unrelated query state", () => {
  assert.equal(mapPopoutHref("?view=traffic&planId=one&routeId=a&workflow=import", "/app/"), "/app/map-popout?planId=one&routeId=a");
  assert.equal(mapPopoutHref("?view=traffic"), "/map-popout");
  const href = mapPopoutHref("?planId=plan%26one%2Ftwo");
  assert.equal(readDispatchScope(new URL(href, "https://example.test").search).planId, "plan&one/two");
});

test("unplanned row includes only explicit membership, never other or unknown plans", () => {
  assert.deepEqual(selectScopedUnassignedStops(stops, { planId: "one" }, routes).map(s => s.id), ["own"]);
  assert.deepEqual(selectScopedUnassignedStops(stops, { routeId: "legacy" }, routes), []);
  assert.deepEqual(selectScopedUnassignedStops(stops, { planId: "missing" }, routes), []);
  assert.deepEqual(selectScopedUnassignedStops(stops, { routeId: "a" }, routes).map(s => s.id), ["own"]);
  assert.deepEqual(selectScopedUnassignedStops(stops, { routeId: "missing" }, routes), []);
  assert.deepEqual(resolveUnplannedPlanScope({ routeId: "a" }, routes), { planId: "one", scoped: true });
  assert.deepEqual(resolveUnplannedPlanScope({}, routes), { planId: null, scoped: false });
});
