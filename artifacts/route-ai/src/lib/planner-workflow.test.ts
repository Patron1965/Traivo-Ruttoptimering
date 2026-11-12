import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_VALUE, dispatchScopeHref, filterVisibleStops, isLateForWindow, pruneSelection,
  resolveScope, sourceSignature, stepAvailability, stopAreaKey, stopsInScope,
} from "./planner-workflow.ts";

const stops = [
  { id: "a", planningPlanId: "p1", planningDate: "2026-09-17", address: "Sveavägen 1, 113 50 Stockholm", customerName: "Karolinska" },
  { id: "b", planningPlanId: "p1", planningDate: "2026-09-17", address: "Ringvägen 4, 118 60 Stockholm" },
  { id: "c", planningPlanId: "p1", planningDate: "2026-09-18", address: "Ringvägen 9, 118 60 Stockholm" },
  { id: "d", planningPlanId: "p2", planningDate: "2026-09-17", address: "Okänd" },
  { id: "e", planningPlanId: null, planningDate: null, address: "Gatan 2" },
];
const empty = { project: null, date: null, area: null, search: "" };

test("several projects require an explicit choice and list nothing", () => {
  const r = resolveScope(stops, empty);
  assert.equal(r.needs, "project");
  assert.deepEqual(stopsInScope(stops, r), []);
  assert.deepEqual(r.projects.map((o) => o.value), ["p1", "p2", NO_VALUE]);
});

test("a project with several days requires a day; days never mix", () => {
  const r = resolveScope(stops, { ...empty, project: "p1" });
  assert.equal(r.needs, "date");
  const day = resolveScope(stops, { ...empty, project: "p1", date: "2026-09-17" });
  assert.equal(day.needs, null);
  assert.deepEqual(stopsInScope(stops, day).map((s) => s.id), ["a", "b"]);
  assert.deepEqual(day.areas.map((o) => o.value), ["113xx", "118xx"]);
});

test("a single project and day is implied", () => {
  const r = resolveScope([stops[0], stops[1]], empty);
  assert.equal(r.project, "p1");
  assert.equal(r.date, "2026-09-17");
});

test("a stale choice falls back to requiring a choice", () => {
  assert.equal(resolveScope(stops, { ...empty, project: "gone" }).needs, "project");
});

test("area and search filter without touching scope", () => {
  assert.deepEqual(filterVisibleStops(stops.slice(0, 2), "118xx", "").map((s) => s.id), ["b"]);
  assert.deepEqual(filterVisibleStops(stops.slice(0, 2), null, "karol").map((s) => s.id), ["a"]);
  assert.equal(stopAreaKey(stops[3]), NO_VALUE);
});

test("pruning reports removed selections", () => {
  const { next, removed } = pruneSelection(new Set(["a", "c"]), new Set(["a", "b"]));
  assert.deepEqual([...next], ["a"]);
  assert.equal(removed, 1);
});

test("steps gate on selection and routes", () => {
  assert.equal(stepAvailability({ selectedStops: 0, selectedVehicles: 1, hasRoutes: false })[2].enabled, false);
  assert.equal(stepAvailability({ selectedStops: 2, selectedVehicles: 1, hasRoutes: false })[2].enabled, true);
  assert.equal(stepAvailability({ selectedStops: 2, selectedVehicles: 1, hasRoutes: false })[3].enabled, false);
  assert.equal(stepAvailability({ selectedStops: 0, selectedVehicles: 0, hasRoutes: true })[3].enabled, true);
});

test("source signature is order independent", () => {
  assert.equal(sourceSignature("p", "d", ["b", "a"], ["v"]), sourceSignature("p", "d", ["a", "b"], ["v"]));
  assert.notEqual(sourceSignature("p", "d", ["a"], ["v"]), sourceSignature("p", "e", ["a"], ["v"]));
});

test("dispatch link is scoped to plan and valid day", () => {
  assert.equal(dispatchScopeHref("p1", "2026-09-17"), "/dispatch?view=traffic&planId=p1&day=2026-09-17");
  assert.equal(dispatchScopeHref("p1", NO_VALUE), "/dispatch?view=traffic&planId=p1");
});

test("late detection for clock and ISO windows", () => {
  assert.equal(isLateForWindow("2026-09-17T10:00:00.000Z", "2026-09-17T10:30:00.000Z"), true);
  assert.equal(isLateForWindow("2026-09-17T10:00:00.000Z", "2026-09-17T09:30:00.000Z"), false);
  assert.equal(isLateForWindow(null, "2026-09-17T09:30:00.000Z"), false);
});

import { displayedPlanMismatch, localCheckState, optimizationDateFor } from "./planner-workflow.ts";

test("optimization date is the scoped day, never an implicit other day", () => {
  assert.equal(optimizationDateFor("2026-09-17"), "2026-09-17T00:00:00Z");
  assert.equal(optimizationDateFor(NO_VALUE), null);
  assert.equal(optimizationDateFor(null), null);
});

test("local checks never report clear when timeline data is missing", () => {
  assert.equal(localCheckState({ issues: 0, routesMissingTimeline: 1 }), "unknown");
  assert.equal(localCheckState({ issues: 0, routesMissingTimeline: 0 }), "clear");
  assert.equal(localCheckState({ issues: 2, routesMissingTimeline: 1 }), "issues");
});

test("displayed plan mismatch against filter header", () => {
  assert.equal(displayedPlanMismatch({ day: "2026-09-17", project: "p" }, { date: "2026-09-17", project: "p" }), false);
  assert.equal(displayedPlanMismatch({ day: "2026-09-17", project: "p" }, { date: "2026-09-18", project: "p" }), true);
  assert.equal(displayedPlanMismatch({ day: "2026-09-17", project: null }, { date: null, project: null }), true);
});
