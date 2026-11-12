import assert from "node:assert/strict";
import test from "node:test";
import { projectImportDraftState, supplementalDraftStopIds } from "./import-draft-state.ts";

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
test("polygon project stops hydrate from authoritative stop reads after reload", () => {
  const state = { source: "manual", selectedStopIds: ["map-1", "map-2"],
    dispatchSourceStopIds: ["map-1", "map-2", "map-1"],
    resourceSelection: { pairValues: ["vehicle|driver"] } };
  const reloaded = projectImportDraftState(state, { hasAuthoritativeImportedResult: false });
  assert.deepEqual(supplementalDraftStopIds(reloaded), ["map-1", "map-2"]);
  assert.deepEqual(reloaded.resourceSelection.pairValues, ["vehicle|driver"]);
});

test("reload retains additive append and customer visit membership independently of original source counts", () => {
  const state = { appendedStopIds: ["new-1", "new-2"], customerVisitStopIds: ["visit-1", "new-1"], importedStopIds: ["old"] };
  const reloaded = JSON.parse(JSON.stringify(projectImportDraftState(state, { hasAuthoritativeImportedResult: true, serverPlanId: "plan" })));
  assert.deepEqual(supplementalDraftStopIds(reloaded), ["visit-1", "new-1", "new-2"]);
  assert.deepEqual(reloaded.importedStopIds, ["old"]);
});

test("compacts imported plan route snapshots below the draft state limit", () => {
  const sourceValues = ["Order 371", "2026-09-17", "Some customer"];
  const pickupCoordinates = { latitude: 59.33, longitude: 18.06 };
  const state = {
    parsedData: {
      headers: ["reference", "date", "pickup_latitude", "pickup_longitude"],
      rows: [{ sourceValues, pickupCoordinates }],
    },
    mappedRows: [{ _sourceValues: sourceValues, pickupLatitude: 59.33, pickupLongitude: 18.06 }],
    importedStopIds: Array.from({ length: 228 }, (_, index) => `stop-${index}`),
    unplannedStopIds: Array.from({ length: 143 }, (_, index) => `stop-${index}`),
    savedStops: Array.from({ length: 228 }, (_, index) => ({ id: `stop-${index}`, address: `Stop ${index}` })),
    assignedRoutes: [{
      routeId: "route-1",
      geometry: "x".repeat(700_000),
      workdayTimeline: Array.from({ length: 228 }, (_, index) => ({ stopId: `stop-${index}` })),
    }],
  };
  assert.ok(jsonBytes(state) > 512 * 1024);

  const compacted = projectImportDraftState(state, {
    hasAuthoritativeImportedResult: true,
    serverPlanId: "plan-1",
  });
  assert.ok(jsonBytes(compacted) < 512 * 1024);
  assert.equal("assignedRoutes" in compacted, false);
  assert.equal("savedStops" in compacted, false);
  assert.deepEqual(compacted.parsedData.rows[0].sourceValues, sourceValues);
  assert.deepEqual(compacted.mappedRows[0]._sourceValues, sourceValues);
  assert.deepEqual(compacted.mappedRows[0].pickupLatitude, pickupCoordinates.latitude);
  assert.deepEqual(compacted.unplannedStopIds.length, 143);
});

test("keeps legacy manual draft projections without authoritative evidence", () => {
  const state = {
    source: "manual",
    selectedStopIds: ["manual-stop-1"],
    savedStops: [{ id: "manual-stop-1", address: "Legacy stop" }],
    assignedRoutes: [{ routeId: "local-route", stopIds: ["manual-stop-1"] }],
  };
  assert.deepEqual(
    projectImportDraftState(state, {
      hasAuthoritativeImportedResult: false,
      serverPlanId: null,
    }),
    state,
  );
});