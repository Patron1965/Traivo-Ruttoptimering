import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAddressCandidates, isCustomerDraftEligible } from "./customer-planning";

test("reads explicit candidates from generated ApiError data, not Axios response.data", () => {
  const candidates = [{ id: "verified-candidate", displayName: "Test" }];
  assert.deepEqual(customerAddressCandidates({
    status: 422,
    data: { code: "ADDRESS_VERIFICATION_REQUIRED", details: { candidates } },
  }), candidates);
  assert.equal(customerAddressCandidates({
    status: 422, data: { code: "INVALID_TIME_WINDOW" },
  }), null);
});

test("a draft selected for a different day is no longer eligible", () => {
  const draft = { startAt: "2026-10-25T00:00:00.000Z", planId: null };
  assert.equal(isCustomerDraftEligible(draft, "2026-10-25"), true);
  assert.equal(isCustomerDraftEligible(draft, "2026-10-26"), false);
  assert.equal(isCustomerDraftEligible({ ...draft, planId: "optimized" }, "2026-10-25"), false);
});