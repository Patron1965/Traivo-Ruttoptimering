import assert from "node:assert/strict";
import test from "node:test";
import { chooseRoutePlanExportSelection } from "./route-plan-export-selection";

test("preserves an all-unassigned plan when no route exists", () => {
  const planId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    chooseRoutePlanExportSelection([], null, planId),
    { kind: "plan", id: planId },
  );
});

test("global scope ignores a stale persisted plan when no plan URL is explicit", () => {
  assert.equal(
    chooseRoutePlanExportSelection([], null, null),
    null,
  );
});