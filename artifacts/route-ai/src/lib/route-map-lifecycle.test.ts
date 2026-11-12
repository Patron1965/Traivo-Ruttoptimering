import assert from "node:assert/strict";
import test from "node:test";
import { canCommitRouteGeometry } from "./route-map-lifecycle.ts";

test("late geometry from a previous selection cannot commit", () => {
  assert.equal(
    canCommitRouteGeometry({ requestKey: "route-a:old" }, "route-a:new"),
    false,
  );
  assert.equal(
    canCommitRouteGeometry(undefined, "route-a:old"),
    false,
  );
});

test("geometry for the current request can commit", () => {
  assert.equal(
    canCommitRouteGeometry({ requestKey: "route-a:new" }, "route-a:new"),
    true,
  );
});