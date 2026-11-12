import assert from "node:assert/strict";
import test from "node:test";
import {
  isLiveRouteRemoval,
  capRouteIds,
  createRouteDeletionSnapshot,
  routeDeletionSnapshotChanged,
  selectionFromAggregateCheckbox,
  selectedRouteIdsForGroups,
  setVisibleRouteSelection,
  type RouteSelection,
} from "./route-selection.ts";

test("sent and accepted unstarted routes need no extra live acknowledgement", () => {
  assert.equal(isLiveRouteRemoval({ status: "optimized", handoffStatus: "sent" }), false);
  assert.equal(isLiveRouteRemoval({ status: "optimized", handoffStatus: "accepted" }), false);
  assert.equal(isLiveRouteRemoval({ status: "in_progress", handoffStatus: "accepted" }), true);
});

const initialGroups = [
  { key: "plan:morning", routeIds: ["run-1", "run-2"] },
  { key: "plan:evening", routeIds: ["run-3"] },
];

test("plan selection resolves current group membership after route changes", () => {
  const selection: RouteSelection = { kind: "plan", key: "plan:morning" };

  assert.deepEqual(
    selectedRouteIdsForGroups(selection, initialGroups, new Set(["plan:morning"])),
    ["run-1", "run-2"],
  );
  assert.deepEqual(
    selectedRouteIdsForGroups(
      selection,
      [{ key: "plan:morning", routeIds: ["run-1", "run-4"] }],
      new Set(["plan:morning"]),
    ),
    ["run-1", "run-4"],
  );
});

test("route selection is one run and disappears when its group is filtered", () => {
  const selection: RouteSelection = { kind: "route", id: "run-2" };

  assert.deepEqual(
    selectedRouteIdsForGroups(selection, initialGroups, new Set(["plan:morning"])),
    ["run-2"],
  );
  assert.deepEqual(
    selectedRouteIdsForGroups(selection, initialGroups, new Set(["plan:evening"])),
    [],
  );
});

test("visible deletion selection is capped and reports omitted routes", () => {
  const result = setVisibleRouteSelection(
    new Set<string>(),
    ["run-1", "run-2", "run-3"],
    true,
    2,
  );
  assert.deepEqual([...result.selection], ["run-1", "run-2"]);
  assert.equal(result.omittedCount, 1);
  assert.deepEqual(capRouteIds(["run-1", "run-1", "run-2"], 2), {
    routeIds: ["run-1", "run-2"],
    omittedCount: 0,
  });
});

test("aggregate checkbox state maps checked true to select and false to clear", () => {
  assert.equal(selectionFromAggregateCheckbox(true), true);
  assert.equal(selectionFromAggregateCheckbox(false), false);
  assert.equal(selectionFromAggregateCheckbox("indeterminate"), false);
});

test("deletion confirmation snapshot rejects missing, changed, or ineligible routes", () => {
  const routes = [
    { id: "run-1", name: "Morning", planId: "plan-1", planRevision: 4, status: "optimized" },
    { id: "run-2", name: "Evening", planId: "plan-1", planRevision: 4, status: "optimized" },
  ];
  const snapshot = createRouteDeletionSnapshot(routes, ["run-1", "run-2"]);
  assert.ok(snapshot);
  assert.deepEqual(snapshot?.map((item) => item.routeId), ["run-1", "run-2"]);
  assert.equal(routeDeletionSnapshotChanged(snapshot!, routes), false);
  assert.equal(
    routeDeletionSnapshotChanged(snapshot!, routes.map((route) => (
      route.id === "run-2" ? { ...route, planRevision: 5 } : route
    ))),
    true,
  );
  assert.equal(
    routeDeletionSnapshotChanged(snapshot!, routes.map((route) => (
      route.id === "run-1" ? { ...route, status: "cancelled" } : route
    ))),
    true,
  );
  assert.equal(createRouteDeletionSnapshot(routes, ["missing"]), null);
});