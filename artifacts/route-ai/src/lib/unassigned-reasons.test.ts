import assert from "node:assert/strict";
import test from "node:test";
import { getUnassignedReasonPresentation } from "./unassigned-reasons.ts";

test("keeps the localized capacity code label primary and details supporting", () => {
  const presentation = getUnassignedReasonPresentation(
    "CAPACITY",
    "Vehicle capacity is insufficient",
    "The selected vehicle has 10 kg less capacity than required.",
    "No specific assignment constraint was established by the optimizer",
  );

  assert.equal(presentation.code, "CAPACITY");
  assert.equal(presentation.label, "Vehicle capacity is insufficient");
  assert.equal(presentation.detail, "The selected vehicle has 10 kg less capacity than required.");
});

test("keeps localized time-window and working-hours labels when diagnostics include details", () => {
  const timeWindow = getUnassignedReasonPresentation(
    "TIME_WINDOW",
    "Stop cannot be served within its time window",
    "The latest feasible arrival is after the customer window.",
    "No specific assignment constraint was established by the optimizer",
  );
  const workingHours = getUnassignedReasonPresentation(
    "WORKING_HOURS",
    "Route cannot fit within working hours",
    "The route would exceed the driver's shift end.",
    "No specific assignment constraint was established by the optimizer",
  );

  assert.equal(timeWindow.label, "Stop cannot be served within its time window");
  assert.equal(timeWindow.detail, "The latest feasible arrival is after the customer window.");
  assert.equal(workingHours.label, "Route cannot fit within working hours");
  assert.equal(workingHours.detail, "The route would exceed the driver's shift end.");
});

test("uses a constraint-not-established label for generic empty diagnostics", () => {
  const presentation = getUnassignedReasonPresentation(
    "UNASSIGNED",
    "No specific assignment constraint was established by the optimizer",
    "",
    "No specific assignment constraint was established by the optimizer",
  );

  assert.equal(
    presentation.label,
    "No specific assignment constraint was established by the optimizer",
  );
  assert.equal(presentation.detail, null);
  assert.doesNotMatch(presentation.label, /recalculat/i);
});