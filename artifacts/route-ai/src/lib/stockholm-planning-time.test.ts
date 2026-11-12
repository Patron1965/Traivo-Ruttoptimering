import test from "node:test";
import assert from "node:assert/strict";
import { stockholmPlanningMinuteToIso } from "./stockholm-planning-time.ts";
test("Stockholm planning input uses seasonal UTC offset", () => {
  assert.equal(stockholmPlanningMinuteToIso("2026-01-19T08:00"), "2026-01-19T07:00:00.000Z");
  assert.equal(stockholmPlanningMinuteToIso("2026-07-19T08:00"), "2026-07-19T06:00:00.000Z");
});
test("invalid, nonexistent and ambiguous local minutes are rejected", () => {
  for (const input of ["2026-03-29T02:30", "2026-10-25T02:30", "2026-02-30T08:00", "", "2026-12-01T24:00"]) {
    assert.equal(stockholmPlanningMinuteToIso(input), null);
  }
});
