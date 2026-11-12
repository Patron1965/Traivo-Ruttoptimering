import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRouteMetrics,
  dispatchHref,
  distinctDriverSummary,
  filterGroupsByDay,
  formatMinutes,
  groupStatus,
  parseRoutesListFilters,
  parseRoutesListViewState,
  projectOpenTarget,
  routeMetrics,
  routeOpenHref,
  routesListStorageKey,
  serializeRoutesListFilters,
  sortGroupsByLatestDay,
} from "./route-project-table.ts";

const summary = { shiftMin: 480, nonReturnDrivingMin: 100, returnMin: 20, serviceMin: 200, totalMin: 360 };

test("route metrics read actual per-route fields only", () => {
  const m = routeMetrics({ id: "a", status: "draft", totalStops: 12, totalDistanceKm: 41.3, workdaySummary: summary });
  assert.equal(m.stops, 12);
  assert.equal(m.workMin, 360);
  assert.equal(m.travelMin, 120);
  assert.equal(m.serviceMin, 200);
  assert.equal(m.utilization, 0.75);
});

test("missing or invalid values stay unknown", () => {
  const m = routeMetrics({ id: "a", status: "draft", totalStops: Number.NaN, totalDistanceKm: null, workdaySummary: null });
  assert.equal(m.stops, null);
  assert.equal(m.distanceKm, null);
  assert.equal(m.workMin, null);
  assert.equal(m.utilization, null);
  assert.equal(formatMinutes(null), "–");
});

test("parent totals are unknown if any child value is unknown", () => {
  const agg = aggregateRouteMetrics([
    { id: "a", status: "draft", totalStops: 3, workdaySummary: summary },
    { id: "b", status: "draft", totalStops: 4, workdaySummary: null },
  ]);
  assert.equal(agg.stops, 7);
  assert.equal(agg.workMin, null);
  assert.equal(agg.utilization, null);
  const both = aggregateRouteMetrics([
    { id: "a", status: "draft", totalStops: 3, workdaySummary: summary },
    { id: "b", status: "draft", totalStops: 4, workdaySummary: summary },
  ]);
  assert.equal(both.workMin, 720);
  assert.equal(both.utilization, 0.75);
});

test("day filter keeps group identity and drops other days", () => {
  const groups = [
    { key: "plan:1", routes: [{ id: "a", date: "2025-03-03T00:00:00Z" }, { id: "b", date: "2025-03-04" }] },
    { key: "plan:2", routes: [{ id: "c", date: "2025-03-05" }] },
  ];
  const out = filterGroupsByDay(groups, "2025-03-04");
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "plan:1");
  assert.deepEqual(out[0].routes.map((r) => r.id), ["b"]);
  assert.equal(filterGroupsByDay(groups, null).length, 2);
  assert.deepEqual(sortGroupsByLatestDay(groups).map((g) => g.key), ["plan:2", "plan:1"]);
});

test("same-named projects remain separate rows", () => {
  const groups = [
    { key: "plan:x", name: "Tisdag", routes: [{ id: "a", date: "2025-03-04" }] },
    { key: "plan:y", name: "Tisdag", routes: [{ id: "b", date: "2025-03-04" }] },
  ];
  assert.equal(filterGroupsByDay(groups, "2025-03-04").length, 2);
});

test("multi-day project requires a day choice; route opens with actual id and day", () => {
  const routes = [
    { id: "r1", planId: "p", status: "draft", date: "2025-03-03" },
    { id: "r2", planId: "p", status: "draft", date: "2025-03-04" },
  ];
  const target = projectOpenTarget("p", routes);
  assert.equal(target.kind, "chooseDay");
  if (target.kind === "chooseDay") assert.equal(target.options[1].href, "/dispatch?view=traffic&planId=p&day=2025-03-04");
  const single = projectOpenTarget("p", routes.slice(0, 1));
  assert.deepEqual(single, { kind: "single", href: "/dispatch?view=traffic&planId=p&day=2025-03-03", day: "2025-03-03" });
  assert.equal(routeOpenHref(routes[1]), "/dispatch?view=traffic&routeId=r2&day=2025-03-04");
  assert.ok(!routeOpenHref(routes[1]).includes("planId"));
  assert.equal(routeOpenHref(routes[1], "/routes?status=all"), "/dispatch?view=traffic&routeId=r2&day=2025-03-04&returnTo=%2Froutes%3Fstatus%3Dall");
  assert.equal(routeOpenHref(routes[1], "https://evil.example/routes"), "/dispatch?view=traffic&routeId=r2&day=2025-03-04");
  assert.equal(projectOpenTarget(null, [{ id: "l1", status: "draft", date: "2025-03-01" }]).kind, "single");
  assert.equal(dispatchHref({ day: "bad" }), "/dispatch?view=traffic");
});

test("list filters are validated and round-trip", () => {
  assert.deepEqual(parseRoutesListFilters("?status=evil&date=2025-02-30&q=abc"), { q: "abc", status: "active", date: null });
  const filters = { q: "Solna", status: "all" as const, date: "2025-03-04" };
  assert.deepEqual(parseRoutesListFilters(serializeRoutesListFilters(filters)), filters);
  assert.equal(serializeRoutesListFilters({ q: "", status: "active", date: null }), "");
});

test("view state parsing is defensive and storage is scoped", () => {
  assert.deepEqual(parseRoutesListViewState("not json"), { expanded: [], scrollTop: 0, columns: [] });
  const parsed = parseRoutesListViewState(JSON.stringify({ expanded: ["plan:1", "javascript:x", 4], scrollTop: -3, columns: ["distance", "evil"] }));
  assert.deepEqual(parsed, { expanded: ["plan:1"], scrollTop: 0, columns: ["distance"] });
  assert.equal(routesListStorageKey(null, "u"), null);
  assert.notEqual(routesListStorageKey("org1", "u"), routesListStorageKey("org2", "u"));
});

test("driver and status summaries", () => {
  assert.deepEqual(distinctDriverSummary(["d1", "d1", null, "d2"]), { count: 2, missing: 1 });
  assert.equal(groupStatus([{ status: "draft" }, { status: "draft" }]), "draft");
  assert.equal(groupStatus([{ status: "draft" }, { status: "completed" }]), "mixed");
});

test("child route link scopes Dispatch to exactly that route", async () => {
  const { readDispatchScope, selectScopedRoutes } = await import("./dispatch-scope.ts");
  const all = [
    { id: "r1", planId: "p", status: "draft", updatedAt: "", date: "2025-03-04" },
    { id: "r2", planId: "p", status: "draft", updatedAt: "", date: "2025-03-04" },
  ];
  const href = routeOpenHref({ id: "r2", planId: "p", status: "draft", date: "2025-03-04" });
  const scoped = selectScopedRoutes(all, readDispatchScope(new URL(href, "https://x.test").search));
  assert.deepEqual(scoped.map((r) => r.id), ["r2"]);
  const parent = projectOpenTarget("p", all);
  assert.equal(parent.kind, "single");
  if (parent.kind === "single") {
    assert.deepEqual(selectScopedRoutes(all, readDispatchScope(new URL(parent.href, "https://x.test").search)).map((r) => r.id), ["r1", "r2"]);
  }
});
