import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PlanningDraftRequestError,
  updatePlanningDraftRequest,
} from "./planning-draft-request.ts";

test("a gateway response never retries a draft write after a concurrent revision", async (t) => {
  const sentRevisions: number[] = [];
  let currentRevision = 3;

  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { revision: number };
      sentRevisions.push(payload.revision);

      if (sentRevisions.length === 1) {
        assert.equal(payload.revision, currentRevision);
        currentRevision += 1;
        return new Response(JSON.stringify({ error: "Gateway unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }

      assert.fail(`unexpected retry against revision ${currentRevision}`);
    },
  );

  await assert.rejects(
    updatePlanningDraftRequest("draft-1", { revision: 3, state: { step: 2 } }),
    /Gateway unavailable/,
  );
  assert.equal(currentRevision, 4);
  assert.deepEqual(sentRevisions, [3]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("preserves structured draft size errors for actionable localization", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({
      error: "Draft state exceeds the 512 KiB limit",
      code: "DRAFT_STATE_TOO_LARGE",
      details: { limitBytes: 524288 },
    }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    }),
  );

  await assert.rejects(
    updatePlanningDraftRequest("draft-1", { revision: 3, state: {} }),
    (error: unknown) => {
      assert.ok(error instanceof PlanningDraftRequestError);
      assert.equal(error.status, 413);
      assert.equal(error.code, "DRAFT_STATE_TOO_LARGE");
      assert.deepEqual(error.details, { limitBytes: 524288 });
      return true;
    },
  );
});