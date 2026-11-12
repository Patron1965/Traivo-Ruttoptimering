import test from "node:test";
import assert from "node:assert/strict";
import { attemptDirectDispatchMove, type DirectMoveSnapshot } from "./direct-dispatch-move.ts";

const snapshot: DirectMoveSnapshot = {
  stopIds: ["b", "a"], routeId: "target", targetIndex: 2, force: false,
  routeRevisions: [{ routeId: "target", planRevision: 7 }, { routeId: "source", planRevision: 4 }],
};
const digest = "a".repeat(64);
const safe = { canMove: true, conflicts: [], previewDigest: digest };

test("disabled and unauthorized roles open review without any requests", async () => {
  for (const flags of [{ enabled: false, canEdit: true }, { enabled: true, canEdit: false }]) {
    const result = await attemptDirectDispatchMove({
      ...flags, snapshot, isCurrent: () => true,
      preview: async () => assert.fail("no preview"), commit: async () => assert.fail("no commit"),
    });
    assert.equal(result, "review");
  }
});

test("validated preview commits once with exact ordered snapshot and digest", async () => {
  let commits = 0;
  const result = await attemptDirectDispatchMove({
    enabled: true, canEdit: true, snapshot, isCurrent: () => true,
    preview: async payload => { assert.deepEqual(payload, snapshot); return safe; },
    commit: async (payload, expectedDigest) => {
      commits++;
      assert.strictEqual(payload, snapshot);
      assert.equal(payload.force, false);
      assert.equal(expectedDigest, digest);
      return { conflicts: [] };
    },
  });
  assert.equal(result, "saved");
  assert.equal(commits, 1);
});

test("conflicts and malformed previews fail closed", async () => {
  for (const response of [{ ...safe, conflicts: ["CAPACITY"] }, { ...safe, canMove: false },
    { ...safe, previewDigest: "" }, { ...safe, conflicts: undefined }, null]) {
    assert.equal(await attemptDirectDispatchMove({
      enabled: true, canEdit: true, snapshot, isCurrent: () => true,
      preview: async () => response, commit: async () => assert.fail("no commit"),
    }), "review");
  }
});

test("stale, auth and network errors never retry either phase", async () => {
  for (const status of [401, 403, 409, 500]) {
    for (const phase of ["preview", "commit"]) {
      let previews = 0; let commits = 0;
      assert.equal(await attemptDirectDispatchMove({
        enabled: true, canEdit: true, snapshot, isCurrent: () => true,
        preview: async () => { previews++; if (phase === "preview") throw { status }; return safe; },
        commit: async () => { commits++; throw { status }; },
      }), "review");
      assert.equal(previews, 1);
      assert.equal(commits, phase === "commit" ? 1 : 0);
    }
  }
});

test("identity, scope or role change while preview is pending cancels commit", async () => {
  let current = true;
  assert.equal(await attemptDirectDispatchMove({
    enabled: true, canEdit: true, snapshot, isCurrent: () => current,
    preview: async () => { current = false; return safe; },
    commit: async () => assert.fail("scope changed"),
  }), "cancelled");
});

test("commit conflict requires review and refresh failure remains a saved move", async () => {
  for (const [result, expected] of [
    [{ conflicts: [], status: 409 }, "review"],
    [{ conflicts: [], refreshFailed: true }, "saved-refresh-failed"],
  ] as const) {
    assert.equal(await attemptDirectDispatchMove({
      enabled: true, canEdit: true, snapshot, isCurrent: () => true,
      preview: async () => safe, commit: async () => ({ ...result, conflicts: [] }),
    }), expected);
  }
});
