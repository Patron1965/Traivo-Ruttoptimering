import { test } from "node:test";
import assert from "node:assert/strict";
import { timelineSelectionViewport } from "./timeline-selection-viewport.ts";

const viewport = { left: 100, top: 40, width: 800, height: 300 };
test("visible selection preserves manual pan", () => {
  assert.deepEqual(timelineSelectionViewport(viewport, { left: 400, top: 80, width: 30, height: 24 }, 260), { left: 100, top: 40 });
});
test("selection behind sticky driver labels is revealed", () => {
  assert.deepEqual(timelineSelectionViewport(viewport, { left: 300, top: 80, width: 30, height: 24 }, 260), { left: 28, top: 40 });
});
test("offscreen row and late stop are both revealed", () => {
  assert.deepEqual(timelineSelectionViewport(viewport, { left: 1200, top: 600, width: 30, height: 24 }, 260), { left: 442, top: 336 });
});
test("first row clamps scroll positions to zero", () => {
  assert.deepEqual(timelineSelectionViewport(viewport, { left: 260, top: 0, width: 24, height: 24 }, 260), { left: 0, top: 0 });
});
test("long blocks align their start instead of hiding the beginning", () => {
  assert.deepEqual(timelineSelectionViewport(viewport, { left: 600, top: 80, width: 900, height: 24 }, 260), { left: 328, top: 40 });
});
