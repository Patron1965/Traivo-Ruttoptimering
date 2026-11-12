import assert from "node:assert/strict";
import { test } from "node:test";
import { unambiguousLivePlan } from "./dispatch-scope.ts";

test("live entry prefers today's outgoing version zero over unshipped drafts", () => {
  const live = { planId: "live", date: "2026-11-10", status: "in_progress", handoffVersion: 0, handoffDriverId: "driver" };
  assert.equal(unambiguousLivePlan([live, { ...live, planId: "draft", handoffVersion: null }], "2026-11-10"), "live");
  assert.equal(unambiguousLivePlan([live, { ...live, planId: "other" }], "2026-11-10"), null);
  assert.equal(unambiguousLivePlan([{ ...live, status: "completed" }], "2026-11-10"), null);
  assert.equal(unambiguousLivePlan([live], "2026-11-11"), null);
});
