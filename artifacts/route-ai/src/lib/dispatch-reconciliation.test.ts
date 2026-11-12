import assert from "node:assert/strict";
import test from "node:test";
import {
  getRoutesRequiringDispatch,
  hasCurrentHandoff,
  matchesPlanRevision,
  type DispatchRouteSnapshot,
} from "./dispatch-reconciliation.ts";

function route(overrides: Partial<DispatchRouteSnapshot> = {}): DispatchRouteSnapshot {
  return {
    id: "route-1",
    planRevision: 3,
    handoffStatus: "pending",
    handoffVersion: null,
    handoffDriverId: null,
    ...overrides,
  };
}

test("only a current non-pending handoff with a recipient is reusable", () => {
  assert.equal(hasCurrentHandoff(route({
    handoffStatus: "sent",
    handoffVersion: 3,
    handoffDriverId: "driver-1",
  }), 3), true);
  assert.equal(hasCurrentHandoff(route({
    handoffStatus: "sent",
    handoffVersion: 2,
    handoffDriverId: "driver-1",
  }), 3), false);
  assert.equal(hasCurrentHandoff(route({
    handoffStatus: "pending",
    handoffVersion: 3,
    handoffDriverId: "driver-1",
  }), 3), false);
  assert.equal(hasCurrentHandoff(route({
    handoffStatus: "sent",
    handoffVersion: 3,
    handoffDriverId: null,
  }), 3), false);
});

test("reconciliation retries only routes unresolved after a partial send", () => {
  const planned = [
    route({ id: "route-1" }),
    route({ id: "route-2" }),
  ];
  const afterFirstAttempt = new Map<string, DispatchRouteSnapshot>([
    ["route-1", route({
      id: "route-1",
      handoffStatus: "sent",
      handoffVersion: 3,
      handoffDriverId: "driver-1",
    })],
    ["route-2", route({ id: "route-2" })],
  ]);

  assert.deepEqual(
    getRoutesRequiringDispatch(planned, afterFirstAttempt).map((route) => route.id),
    ["route-2"],
  );
});

test("a changed fetched revision is never silently treated as current", () => {
  assert.equal(matchesPlanRevision(route({ planRevision: 4 }), 3), false);
  assert.equal(hasCurrentHandoff(route({
    planRevision: 4,
    handoffStatus: "sent",
    handoffVersion: 4,
    handoffDriverId: "driver-1",
  }), 4), true);
});