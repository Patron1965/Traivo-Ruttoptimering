import assert from "node:assert/strict";
import test from "node:test";
import { hasValidRouteGeometry } from "./route-geometry.ts";

test("accepts a decoded road line with two in-range points", () => {
  assert.equal(hasValidRouteGeometry([[59.3, 18.0], [59.4, 18.1]]), true);
});

test("rejects short, non-finite, and out-of-range decoded lines", () => {
  assert.equal(hasValidRouteGeometry([[59.4, 18.1]]), false);
  assert.equal(hasValidRouteGeometry([[59.4, 18.1], [Number.NaN, 18.2]]), false);
  assert.equal(hasValidRouteGeometry([[91, 18.1], [59.4, 18.2]]), false);
  assert.equal(hasValidRouteGeometry([[59.4, 181], [59.5, 18.2]]), false);
});