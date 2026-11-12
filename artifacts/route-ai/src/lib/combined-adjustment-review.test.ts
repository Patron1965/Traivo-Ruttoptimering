import test from "node:test";
import assert from "node:assert/strict";
import { captureAdjustmentDraft, sameAdjustmentDraft, boundAdjustmentConfirmation } from "./combined-adjustment-review.ts";
const draft = () => ({ planId: "plan", depotLatitude: 59.3, depotLongitude: 18.1,
  routes: [{ routeId: "source", driverId: "driver1", planRevision: 7, stopIds: ["second", "first"] },
    { routeId: "target", driverId: "driver2", planRevision: 4, stopIds: ["third"] }] });
test("capture keeps complete combined membership/order and revisions without aliasing unsaved draft", () => {
  const input = draft(), captured = captureAdjustmentDraft(input);
  input.routes[0].stopIds.reverse();
  assert.deepEqual(captured.routes[0].stopIds, ["second", "first"]);
  assert.equal(Object.isFrozen(captured.routes[0].stopIds), true);
  assert.equal(sameAdjustmentDraft(captured, input), false);
});
test("confirmation binds exact whole reviewed draft, never a partial resource subset", () => {
  const captured = captureAdjustmentDraft(draft());
  const preview = { canApply: true, previewDigest: "whole-draft" } as any;
  assert.equal(boundAdjustmentConfirmation(captured, draft(), preview, false), null);
  const body = boundAdjustmentConfirmation(captured, draft(), preview, true)!;
  assert.deepEqual(body.routes, captured.routes);
  assert.equal(body.expectedPreviewDigest, "whole-draft");
  for (const edit of [
    (input: ReturnType<typeof draft>) => input.routes[0].stopIds.reverse(),
    (input: ReturnType<typeof draft>) => input.routes[0].planRevision++,
    (input: ReturnType<typeof draft>) => input.routes[0].driverId = "other",
    (input: ReturnType<typeof draft>) => input.routes[1].stopIds.push(input.routes[0].stopIds.pop()!),
  ]) {
    const changed = draft(); edit(changed);
    assert.equal(boundAdjustmentConfirmation(captured, changed, preview, true), null);
    assert.deepEqual(captured.routes[0].stopIds, ["second", "first"]);
  }
});
