import { test } from "node:test";
import assert from "node:assert/strict";
import { manualCorrectionPosition, metricText } from "./planner-corrections.ts";

test("manual position requires explicit confirmation, finite coordinates and nonblank input", () => {
  assert.equal(manualCorrectionPosition("59.3", "18.1", false), null);
  for (const [lat, lon] of [["", "18"], ["91", "18"], ["59", "-181"], ["NaN", "18"], ["1e999", "18"]]) {
    assert.equal(manualCorrectionPosition(lat!, lon!, true), null);
  }
  assert.deepEqual(manualCorrectionPosition("59.3", "18.1", true),
    { latitude: 59.3, longitude: 18.1, confirmed: true });
});

test("unknown consequence is never presented as zero", () => {
  assert.equal(metricText(null, " min"), "Okänt");
  assert.equal(metricText(undefined, " min"), "Okänt");
  assert.equal(metricText(0, " min"), "0 min");
});
