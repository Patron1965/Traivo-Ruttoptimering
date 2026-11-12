import assert from "node:assert/strict";
import test from "node:test";
import { previewCurrentRoute, routePreviewFailure } from "./reoptimization-preview.ts";

test("each preview attempt reads a fresh revision instead of reusing stale UI props", async () => {
  let revision = 4;
  const revisions: number[] = [];
  const read = async (id: string) => ({ id, planRevision: ++revision });
  const preview = async (route: { id: string; planRevision: number }) => {
    revisions.push(route.planRevision);
    return { planRevision: route.planRevision };
  };
  const first = await previewCurrentRoute("route", read, preview);
  const second = await previewCurrentRoute("route", read, preview);
  assert.deepEqual(revisions, [5, 6]);
  assert.equal(first.result.planRevision, first.route.planRevision);
  assert.equal(second.result.planRevision, 6);
});

test("failed refresh never starts optimization; conflict is not automatically retried", async () => {
  let calls = 0;
  await assert.rejects(previewCurrentRoute("route", async () => {
    throw new Error("offline");
  }, async () => { calls++; }));
  assert.equal(calls, 0);
  await assert.rejects(previewCurrentRoute("route",
    async id => ({ id, planRevision: 1 }),
    async () => { calls++; throw new Error("conflict"); }));
  assert.equal(calls, 1);
});

test("missing planning evidence and missing resource are not described as a stale plan", () => {
  const missing = routePreviewFailure({ status: 409, data: {
    error: "Rutten saknar sparat depå- eller reservunderlag och kan inte planeras om säkert.",
  } });
  assert.match(missing!, /saknar sparat planeringsunderlag/);
  const resource = routePreviewFailure({ status: 409, data: {
    error: "Rutten saknar ett aktivt bil–chaufförspar.",
  } });
  assert.match(resource!, /aktiv resurs/);
  assert.equal(routePreviewFailure({ status: 409, data: { error: "private database internals" } }), undefined);
});
