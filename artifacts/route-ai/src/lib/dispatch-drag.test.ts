import assert from "node:assert/strict";
import test from "node:test";
import {
  activateDispatchDrag,
  cancelDispatchDrag,
  createDispatchDragSession,
  firstDispatchTouchPoint,
  handoffDispatchDrag,
  hasDispatchDragActivationDistance,
} from "./dispatch-drag.ts";

test("each drop preserves the review selection after drag cleanup, including the second move", () => {
  let selection = new Set<string>();
  let session: ReturnType<typeof createDispatchDragSession> | null = null;
  for (const id of ["first-stop", "second-stop"]) {
    session = createDispatchDragSession([id], "source", { clientX: 0, clientY: 0 });
    handoffDispatchDrag(
      () => { session = cancelDispatchDrag(session); selection = new Set(); },
      () => { selection = new Set([id]); },
    );
    assert.equal(session, null);
    assert.deepEqual([...selection], [id]);
  }
});

test("keeps a click and sub-threshold jitter pending without activating a drag", () => {
  const session = createDispatchDragSession(
    ["selected-stop", "grouped-stop"],
    "route-a",
    { clientX: 100, clientY: 100 },
  );

  assert.equal(hasDispatchDragActivationDistance(session, { clientX: 100, clientY: 100 }), false);
  assert.equal(hasDispatchDragActivationDistance(session, { clientX: 103, clientY: 103 }), false);
  assert.equal(activateDispatchDrag(session, { clientX: 103, clientY: 103 }).active, false);
});

test("activates exactly at the threshold and preserves grouped selection", () => {
  const session = createDispatchDragSession(
    ["selected-stop", "grouped-stop"],
    "route-a",
    { clientX: 100, clientY: 100 },
  );
  const activated = activateDispatchDrag(session, { clientX: 103, clientY: 104 });

  assert.equal(activated.active, true);
  assert.deepEqual(activated.stopIds, ["selected-stop", "grouped-stop"]);
  assert.equal(activated.sourceRouteId, "route-a");
});

test("uses changed touches for native touch-end and cleans up cancellation by dropping the session", () => {
  const touchPoint = firstDispatchTouchPoint([], [{ clientX: 240, clientY: 320 }]);
  assert.deepEqual(touchPoint, { clientX: 240, clientY: 320 });

  const session = createDispatchDragSession(["stop"], "unplanned", {
    clientX: 240,
    clientY: 320,
  });
  assert.equal(activateDispatchDrag(session, { clientX: 241, clientY: 321 }).active, false);
  assert.equal(cancelDispatchDrag(session), null);
});