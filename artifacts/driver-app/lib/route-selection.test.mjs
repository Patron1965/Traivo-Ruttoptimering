import assert from "node:assert/strict";
import test from "node:test";
import { eligibleRoutes, resolveSelectedRoute } from "./route-selection.ts";

const identity = { organizationId: "org-a", driverId: "driver-a", isAdmin: false };
const route = (id, overrides = {}) => ({
  id, organizationId: "org-a", handoffDriverId: "driver-a", status: "optimized", ...overrides,
});
const a = route("a");
const b = route("b");

test("two routes share a stable selected identity across reorder and refetch", () => {
  let selected = resolveSelectedRoute([a, b], null);
  assert.equal(selected.id, "a");
  selected = resolveSelectedRoute([a, b], "b");
  assert.equal(selected.id, "b");
  assert.equal(resolveSelectedRoute([{ ...b }, { ...a }], selected.id).id, "b");
  assert.equal(resolveSelectedRoute([a, b], "a").id, "a");
});

test("selected route removed, completed or reassigned falls back only to eligible routes", () => {
  for (const routes of [
    [a],
    [a, route("b", { status: "completed" })],
    [a, route("b", { handoffDriverId: "driver-b" })],
    [a, route("b", { organizationId: "org-b" })],
  ]) {
    assert.equal(resolveSelectedRoute(eligibleRoutes(routes, identity), "b").id, "a");
  }
  assert.equal(resolveSelectedRoute([], "b"), null);
});

test("logout, foreign driver and foreign organization never expose previous selection", () => {
  assert.deepEqual(eligibleRoutes([a, b], null), []);
  assert.deepEqual(eligibleRoutes([a, b], { ...identity, driverId: "driver-b" }), []);
  assert.deepEqual(eligibleRoutes([a, b], { ...identity, organizationId: "org-b" }), []);
  assert.equal(resolveSelectedRoute(eligibleRoutes([a, b], null), "b"), null);
});

test("administrator keeps organizational overview including completed routes", () => {
  const completed = route("completed", { handoffDriverId: "other", status: "completed" });
  const foreign = route("foreign", { organizationId: "org-b" });
  assert.deepEqual(eligibleRoutes([a, completed, foreign], { ...identity, isAdmin: true }), [a, completed]);
});

test("both administrators see the tenant's routes without a personal driver profile", () => {
  const otherDriver = route("other-driver", { handoffDriverId: "driver-b", status: "in_progress" });
  const foreign = route("foreign", { organizationId: "org-b" });
  for (const userId of ["planner-admin", "owner-admin"]) {
    assert.deepEqual(eligibleRoutes([a, otherDriver, foreign], {
      userId, organizationId: "org-a", isAdmin: true,
    }), [a, otherDriver]);
  }
});

test("explicit assistance remains restricted to the selected driver", () => {
  const otherDriver = route("other-driver", { handoffDriverId: "driver-b" });
  assert.deepEqual(eligibleRoutes([a, otherDriver], {
    organizationId: "org-a", driverId: "driver-b", isAdmin: false,
  }), [otherDriver]);
});