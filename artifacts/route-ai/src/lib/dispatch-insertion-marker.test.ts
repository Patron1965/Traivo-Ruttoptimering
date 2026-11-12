import { test } from "node:test";
import assert from "node:assert/strict";
import { describeInsertion, insertionLabelSide } from "./dispatch-insertion-marker.ts";

const stops = (...orders: number[]) => orders.map((sequenceOrder) => ({ sequenceOrder }));

test("empty route", () => {
  assert.deepEqual(describeInsertion(0, []), { placement: "empty", beforeOrder: null });
});
test("first uses actual anchor sequenceOrder, not ordinal", () => {
  assert.deepEqual(describeInsertion(0, stops(4, 8, 12)), { placement: "first", beforeOrder: 4 });
});
test("middle labels the real next visible stop after filtering/removal", () => {
  // Visual index 2 of remaining [3, 8, 12] must say before 12, never 'between 3 and 4'.
  assert.deepEqual(describeInsertion(2, stops(3, 8, 12)), { placement: "middle", beforeOrder: 12 });
});
test("end is canonical route end with no ordinal claim", () => {
  assert.deepEqual(describeInsertion(3, stops(3, 8, 12)), { placement: "last", beforeOrder: null });
  assert.equal(describeInsertion(99, stops(1)).placement, "last");
  assert.equal(describeInsertion(Number.NaN, stops(1)).placement, "last");
  assert.equal(describeInsertion(-2, stops(5, 6)).beforeOrder, 5);
});
test("missing sequenceOrder yields null anchor", () => {
  assert.equal(describeInsertion(0, [{}]).beforeOrder, null);
});
test("label flips near right edge only when room on left", () => {
  assert.equal(insertionLabelSide(10, 1000), "right");
  assert.equal(insertionLabelSide(950, 1000), "left");
  assert.equal(insertionLabelSide(60, 120), "right");
});
