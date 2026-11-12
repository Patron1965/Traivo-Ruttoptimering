import { test } from "node:test";
import assert from "node:assert/strict";
import { liveMapPoint, liveRouteFocusPoints } from "./live-map-focus.ts";

test("vehicle focus preserves valid coordinates including zero", () => {
  assert.deepEqual(liveMapPoint({ latitude: 0, longitude: 0 }), [[0, 0]]);
  assert.deepEqual(liveMapPoint({ latitude: 59.3, longitude: 18.1 }), [[59.3, 18.1]]);
});

test("invalid and missing positions never enter map bounds", () => {
  for (const position of [
    {}, { latitude: null, longitude: 18 }, { latitude: 59, longitude: NaN },
    { latitude: Infinity, longitude: 18 }, { latitude: 91, longitude: 18 },
    { latitude: 59, longitude: -181 },
  ]) assert.deepEqual(liveMapPoint(position), []);
});

test("route focus includes only its own known stops and frozen depots", () => {
  assert.deepEqual(liveRouteFocusPoints({
    stopsList: [{ latitude: 59.3, longitude: 18.1 }, { latitude: null, longitude: null }],
    depotSnapshot: {
      start: { latitude: 59.4, longitude: 18.2 },
      end: { latitude: 59.5, longitude: 18.3 },
    },
  }), [[59.3, 18.1], [59.4, 18.2], [59.5, 18.3]]);
});

test("empty or missing routes never invent a demo depot", () => {
  assert.deepEqual(liveRouteFocusPoints(), []);
  assert.deepEqual(liveRouteFocusPoints({ stopsList: [] }), []);
});
