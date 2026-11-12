import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRouteOverlapExplanation,
  routeOverlapReasonKey,
} from "./route-overlap-explanation.ts";

test("keeps confirmed server evidence and bounded scope", () => {
  const result = normalizeRouteOverlapExplanation({
    status: "confirmed",
    reasonCode: "CAPACITY",
    message: "Serverns verifierade förklaring",
    analyzedPairCount: 2,
    scope: {
      vehicleIds: ["vehicle-a", "vehicle-b"],
      stopIds: ["stop-a", "stop-b"],
    },
  });

  assert.equal(result?.status, "verified");
  assert.equal(result?.reasonCode, "CAPACITY");
  assert.deepEqual(result?.affectedVehicleIds, ["vehicle-a", "vehicle-b"]);
  assert.deepEqual(result?.affectedStopIds, ["stop-a", "stop-b"]);
  assert.equal(result?.analyzedPairCount, 2);
  assert.equal(routeOverlapReasonKey(result?.reasonCode ?? null), "import.overlapReasonCapacity");
});

test("does not turn an incomplete analysis into a confirmed constraint", () => {
  const result = normalizeRouteOverlapExplanation({
    status: "incomplete",
    reasonCode: "CAPACITY",
    message: "Analysen avbröts",
    analyzedPairCount: 250,
    scope: {
      vehicleIds: ["vehicle-a", "vehicle-b"],
      stopIds: ["stop-a", "stop-b"],
    },
  });

  assert.equal(result?.status, "incomplete");
  assert.equal(result?.reasonCode, "CAPACITY");
});

test("preserves an explicit no-blocker explanation", () => {
  const result = normalizeRouteOverlapExplanation({
    status: "unknown",
    message: "Ingen blockerande orsak kunde verifieras.",
    analyzedPairCount: 1,
    scope: {
      vehicleIds: ["vehicle-a"],
      stopIds: ["stop-a"],
    },
  });

  assert.equal(result?.status, "unknown");
  assert.equal(result?.reasonCode, null);
  assert.equal(result?.serverMessage, "Ingen blockerande orsak kunde verifieras.");
});

test("does not promote a historical reason/message-only row to verified evidence", () => {
  const result = normalizeRouteOverlapExplanation({
    reasonCode: "CAPACITY",
    message: "Äldre förklaring",
  });

  assert.equal(result?.status, "unknown");
  assert.equal(result?.reasonCode, null);
  assert.equal(result?.serverMessage, null);
  assert.equal(result?.analyzedPairCount, null);
  assert.deepEqual(result?.affectedStopIds, []);
});

test("does not promote an unrecognized confirmed reason", () => {
  const result = normalizeRouteOverlapExplanation({
    status: "confirmed",
    reasonCode: "UNKNOWN_REASON",
    message: "Servermeddelande",
    analyzedPairCount: 1,
    scope: { vehicleIds: ["vehicle-a"], stopIds: ["stop-a"] },
  });

  assert.equal(result?.status, "unknown");
  assert.equal(result?.reasonCode, null);
});

test("reads the versioned scope from the server contract", () => {
  const result = normalizeRouteOverlapExplanation({
    status: "confirmed",
    reasonCode: "TIME_WINDOW",
    message: "Tidsfönster",
    analyzedPairCount: 4,
    scope: {
      vehicleIds: ["vehicle-a", "vehicle-b"],
      stopIds: ["stop-a", "stop-b"],
    },
  });

  assert.equal(result?.status, "verified");
  assert.deepEqual(result?.affectedVehicleIds, ["vehicle-a", "vehicle-b"]);
  assert.deepEqual(result?.affectedStopIds, ["stop-a", "stop-b"]);
  assert.equal(result?.analyzedPairCount, 4);
});

test("returns null for an empty payload", () => {
  assert.equal(normalizeRouteOverlapExplanation({}), null);
});