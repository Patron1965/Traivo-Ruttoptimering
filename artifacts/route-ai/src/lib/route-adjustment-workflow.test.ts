import assert from "node:assert/strict";
import test from "node:test";
import {
  routeAdjustmentAction,
  runRouteAdjustment,
} from "./route-adjustment-workflow.ts";

test("a clean persisted reoptimization opens review without previewing or saving again", async () => {
  const action = routeAdjustmentAction({
    hasValidatedResult: false,
    hasPersistedPlan: true,
    isDirty: false,
    planningInputsMatch: true,
    sharedInstructionsMatch: true,
  });
  assert.equal(action, "open");
  let saves = 0;
  const saved = [{ routeId: "route", planRevision: 8 }];
  const outcome = await runRouteAdjustment({
    action,
    validatedResult: saved,
    adjust: async () => { saves++; return saved; },
    open: async result => { assert.equal(result, saved); },
  });
  assert.equal(outcome.kind, "opened");
  assert.equal(saves, 0);
  assert.equal(routeAdjustmentAction({
    hasValidatedResult: false, hasPersistedPlan: true, isDirty: true,
    planningInputsMatch: true, sharedInstructionsMatch: true,
  }), "adjust");
  assert.equal(routeAdjustmentAction({
    hasValidatedResult: true, hasPersistedPlan: true, isDirty: false,
    planningInputsMatch: false, sharedInstructionsMatch: true,
  }), "blocked");
});

test("an adjustment failure is distinct from a planner-open failure", async () => {
  assert.equal(
    routeAdjustmentAction({
      hasValidatedResult: false,
      isDirty: true,
      planningInputsMatch: true,
      sharedInstructionsMatch: true,
    }),
    "adjust",
  );
  assert.equal(
    routeAdjustmentAction({
      hasValidatedResult: true,
      isDirty: false,
      planningInputsMatch: true,
      sharedInstructionsMatch: true,
    }),
    "open",
  );
  let openCalls = 0;
  const adjustmentFailure = await runRouteAdjustment({
    action: "adjust" as const,
    adjust: async () => {
      throw new Error("adjustment failed");
    },
    open: async () => {
      openCalls += 1;
    },
  });
  assert.equal(adjustmentFailure.kind, "adjustment-failed");
  assert.equal(openCalls, 0);

  let adjustCalls = 0;
  openCalls = 0;
  const navigationFailure = await runRouteAdjustment({
    action: "adjust" as const,
    adjust: async () => {
      adjustCalls += 1;
      return "authoritative";
    },
    open: async () => {
      openCalls += 1;
      throw new Error("navigation failed");
    },
  });
  assert.equal(navigationFailure.kind, "open-failed");
  assert.equal(adjustCalls, 1);
  assert.equal(openCalls, 1);

  const retry = await runRouteAdjustment({
    action: "open" as const,
    validatedResult: "authoritative",
    adjust: async () => {
      throw new Error("must not replay adjustment");
    },
    open: async () => undefined,
  });
  assert.deepEqual(retry, { kind: "opened", result: "authoritative" });
});

test("pending protected inputs block both POST and navigation", async () => {
  assert.equal(
    routeAdjustmentAction({
      hasValidatedResult: false,
      isDirty: true,
      planningInputsMatch: false,
      sharedInstructionsMatch: true,
    }),
    "blocked",
  );
  assert.equal(
    routeAdjustmentAction({
      hasValidatedResult: true,
      isDirty: false,
      planningInputsMatch: true,
      sharedInstructionsMatch: false,
    }),
    "blocked",
  );
  let adjustCalls = 0;
  let openCalls = 0;
  const result = await runRouteAdjustment({
    action: "blocked" as const,
    adjust: async () => {
      adjustCalls += 1;
      return "never";
    },
    open: async () => {
      openCalls += 1;
    },
  });
  assert.deepEqual(result, { kind: "blocked" });
  assert.equal(adjustCalls, 0);
  assert.equal(openCalls, 0);
});
