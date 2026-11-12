import assert from "node:assert/strict";
import test from "node:test";
import { unplannedStopDiagnosticPresentation } from "./unplanned-stop-diagnostic.ts";

test("known per-stop diagnostic codes select their source and recommendation", () => {
  for (const code of [
    "FIELD_SERVICE_INELIGIBLE",
    "CAPACITY_EXCEEDED",
    "RANGE_EXCEEDED",
    "TIME_WINDOW_UNREACHABLE",
    "LATE_TOLERANCE_EXCEEDED",
    "OVERTIME_ALLOWANCE_EXCEEDED",
    "BREAK_WINDOW_CONFLICT",
    "STOP_AVAILABILITY_CONFLICT",
  ]) {
    const presentation = unplannedStopDiagnosticPresentation(code);
    assert.equal(presentation.exact, true, `${code} should be exact`);
    assert.ok(presentation.sourceLabelKey.startsWith("import.unplannedDiagnostic"));
    assert.ok(presentation.recommendationKey.startsWith("import.unplannedRecommendation"));
  }
});

test("missing and ambiguous legacy diagnostics use explicitly generic guidance", () => {
  for (const code of [
    undefined,
    null,
    "WORKING_TIME_OR_TIME_WINDOW_EXCEEDED",
    "ROUTE_COMBINATION_FAILED",
    "FUTURE_CODE",
  ]) {
    const presentation = unplannedStopDiagnosticPresentation(code);
    assert.deepEqual(presentation, {
      exact: false,
      sourceLabelKey: "import.unplannedDiagnosticFallbackLabel",
      recommendationKey: "import.unplannedRecommendationFallback",
    });
  }
});