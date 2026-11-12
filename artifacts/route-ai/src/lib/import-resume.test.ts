import assert from "node:assert/strict";
import test from "node:test";
import { isImportApprovalResumeState } from "./import-resume.ts";

const planId = "11111111-1111-4111-8111-111111111111";

test("accepts a protected plan with no routes for all-unplanned resume", () => {
  assert.equal(
    isImportApprovalResumeState(
      { planId, protected: true, routes: [] },
      planId,
    ),
    true,
  );
});

test("rejects approval state from another plan or an unprotected response", () => {
  assert.equal(
    isImportApprovalResumeState(
      { planId, protected: false, routes: [] },
      planId,
    ),
    false,
  );
  assert.equal(
    isImportApprovalResumeState(
      { planId: "22222222-2222-4222-8222-222222222222", protected: true, routes: [] },
      planId,
    ),
    false,
  );
});

test("rejects malformed route collections while preserving route identity checks", () => {
  assert.equal(
    isImportApprovalResumeState(
      { planId, protected: true, routes: {} },
      planId,
    ),
    false,
  );
  assert.equal(
    isImportApprovalResumeState(
      {
        planId,
        protected: true,
        routes: [{
          routeId: "33333333-3333-4333-8333-333333333333",
          planId: "22222222-2222-4222-8222-222222222222",
          planRevision: 1,
          status: "optimized",
          vehicleId: null,
          driverId: null,
          approval: {
            approved: false,
            approvedAt: null,
            approvedByUserId: null,
          },
        }],
      },
      planId,
    ),
    false,
  );
});