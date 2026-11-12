import test from "node:test";
import assert from "node:assert/strict";
import { canConfirmPlanningDeviation } from "./planning-deviation.ts";

test("only known soft deviations can offer confirmation", () => {
  assert.equal(canConfirmPlanningDeviation(["WORKING_HOURS", "CAPACITY"]), true);
  for (const codes of [[], ["TIME_WINDOW"], ["WORKING_HOURS", "SKILLS"], ["UNKNOWN"], ["PLANNING_LOCK_CONFLICT"]]) {
    assert.equal(canConfirmPlanningDeviation(codes), false);
  }
});
