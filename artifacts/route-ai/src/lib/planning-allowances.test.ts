import assert from "node:assert/strict";
import test from "node:test";
import { effectivePlanningAllowances, savedPlanningAllowances, planningAllowanceText, planningAllowancesKnown } from "./planning-allowances.ts";

test("shows actual inherited 15/5 limits without changing inputs or defaults", () => {
  const inputs = Object.freeze({});
  const defaults = Object.freeze({ maxDriverOvertimeMin: 15, allowLateStopsMin: 5 });
  const effective = effectivePlanningAllowances(inputs, defaults);
  assert.deepEqual(effective, defaults);
  assert.equal(planningAllowanceText(effective),
    "Tillåten övertid per förare: 15 min. Tillåten försening vid stopp: 5 min.");
  assert.deepEqual(inputs, {});
  assert.equal(planningAllowancesKnown(effective), true);
});

test("explicit zero overrides organization allowances and is visibly no exceptions", () => {
  const result = effectivePlanningAllowances(
    { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 },
    { maxDriverOvertimeMin: 15, allowLateStopsMin: 5 },
  );
  assert.deepEqual(result, { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 });
  assert.equal(planningAllowanceText(result).match(/inga undantag/g)?.length, 2);
});

test("each field inherits independently and unknown limits are never presented as zero", () => {
  const result = effectivePlanningAllowances({ maxDriverOvertimeMin: 0 }, { allowLateStopsMin: 5 });
  assert.deepEqual(result, { maxDriverOvertimeMin: 0, allowLateStopsMin: 5 });
  const unknown = effectivePlanningAllowances();
  assert.equal(planningAllowancesKnown(unknown), false);
  assert.match(planningAllowanceText(unknown), /inte tillgängligt/);
  assert.doesNotMatch(planningAllowanceText(unknown), /inga undantag/);
  assert.equal(planningAllowancesKnown({ maxDriverOvertimeMin: -1, allowLateStopsMin: 5 }), false);
});

test("requested allowances are capped by each current organization ceiling", () => {
  const requested = Object.freeze({ maxDriverOvertimeMin: 30, allowLateStopsMin: 10 });
  const ceiling = Object.freeze({ maxDriverOvertimeMin: 15, allowLateStopsMin: 5 });
  assert.deepEqual(effectivePlanningAllowances(requested, ceiling), {
    maxDriverOvertimeMin: 15, allowLateStopsMin: 5,
  });
  assert.deepEqual(requested, { maxDriverOvertimeMin: 30, allowLateStopsMin: 10 });
  assert.deepEqual(effectivePlanningAllowances(
    { maxDriverOvertimeMin: 5, allowLateStopsMin: 10 }, ceiling,
  ), { maxDriverOvertimeMin: 5, allowLateStopsMin: 5 });
  assert.deepEqual(effectivePlanningAllowances(requested,
    { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 },
  ), { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 });
});

test("unknown organization ceiling prevents claiming positive effective limits, but explicit zero remains safe", () => {
  const unknown = effectivePlanningAllowances({ maxDriverOvertimeMin: 30, allowLateStopsMin: 5 });
  assert.equal(planningAllowancesKnown(unknown), false);
  assert.deepEqual(unknown, { maxDriverOvertimeMin: undefined, allowLateStopsMin: undefined });
  assert.equal(planningAllowancesKnown(effectivePlanningAllowances({
    maxDriverOvertimeMin: 0, allowLateStopsMin: 0,
  })), true);
  assert.deepEqual(effectivePlanningAllowances(
    { maxDriverOvertimeMin: 0, allowLateStopsMin: 5 }, { maxDriverOvertimeMin: 15 },
  ), { maxDriverOvertimeMin: 0, allowLateStopsMin: undefined });
});

test("historical snapshot remains 15/5 when current company limits tighten to 0/0", () => {
  const saved = Object.freeze({ maxDriverOvertimeMin: 15, allowLateStopsMin: 5 });
  assert.deepEqual(savedPlanningAllowances(saved), saved);
  assert.deepEqual(effectivePlanningAllowances(saved,
    { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 },
  ), { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 });
  assert.match(planningAllowanceText(savedPlanningAllowances(saved)), /15 min/);
  assert.equal(planningAllowancesKnown(savedPlanningAllowances()), false);
});
