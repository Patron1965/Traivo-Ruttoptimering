import assert from "node:assert/strict";
import test from "node:test";
import { REPORT_FAILURE_REASONS, restoreReportFailureReason, needsReportFailureReason } from "./report-failure-reason.ts";

test("failed reports require an explicit recognized reason", () => {
  for (const value of [undefined, null, "", "unknown", {}, 1]) {
    assert.equal(needsReportFailureReason("failed", value), true);
  }
  for (const reason of REPORT_FAILURE_REASONS) {
    assert.equal(needsReportFailureReason("failed", reason), false);
  }
  assert.equal(needsReportFailureReason("completed", ""), false);
});

test("drafts preserve explicit choices but do not promote legacy exception defaults", () => {
  const legacy = { exceptionCategory: "customer_unavailable" };
  assert.equal(restoreReportFailureReason((legacy as Record<string, unknown>).reportFailureReason), "");
  for (const reportFailureReason of REPORT_FAILURE_REASONS) {
    const draft = JSON.parse(JSON.stringify({ reportFailureReason }));
    assert.equal(restoreReportFailureReason(draft.reportFailureReason), reportFailureReason);
  }
});
