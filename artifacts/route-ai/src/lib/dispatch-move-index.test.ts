import assert from "node:assert/strict";
import test from "node:test";
import { canonicalInsertionIndex } from "./dispatch-move-index.ts";

test("anchors before hidden stops when a filtered timeline omits blocks", () => {
  assert.equal(
    canonicalInsertionIndex({
      canonicalStopIds: ["before", "hidden-before", "visible-after", "hidden-after"],
      draggedStopIds: [],
      anchorStopId: "visible-after",
    }),
    2,
  );
});

test("inserts at canonical end when the pointer is after the visible blocks", () => {
  assert.equal(
    canonicalInsertionIndex({
      canonicalStopIds: ["hidden-before", "visible", "hidden-after"],
      draggedStopIds: [],
      anchorStopId: null,
    }),
    3,
  );
});

test("same-route group moves remove dragged stops before finding the anchor", () => {
  assert.equal(
    canonicalInsertionIndex({
      canonicalStopIds: ["a", "drag-1", "hidden", "drag-2", "anchor", "tail"],
      draggedStopIds: ["drag-1", "drag-2"],
      anchorStopId: "anchor",
    }),
    2,
  );
  assert.equal(
    canonicalInsertionIndex({
      canonicalStopIds: ["a", "drag-1", "hidden", "drag-2", "anchor", "tail"],
      draggedStopIds: ["drag-1", "drag-2"],
      anchorStopId: null,
    }),
    4,
  );
});
