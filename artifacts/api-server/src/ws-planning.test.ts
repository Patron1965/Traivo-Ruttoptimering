import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePlanningInputs,
  refreshedPlanningSummary,
} from "./services/import-route-workflow";
import { disruptionNodeForPlanning } from "./ws";

test("disruption reoptimization carries immutable planning reserves and stop metadata into ALNS nodes", () => {
  const stop: Parameters<typeof disruptionNodeForPlanning>[0] = {
    id: "stop-1",
    jobType: "pickup_delivery",
    latitude: 59.34,
    longitude: 18.08,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 25,
    weightKg: 12,
    volumeM3: 0.4,
    priority: 1,
    pickupAddress: "Pickup depot",
    pickupLatitude: 59.35,
    pickupLongitude: 18.09,
    requiredSkills: ["HVAC"],
    requiredCertifications: ["CERT-A"],
    requiredEquipment: ["LIFT"],
  };
  const planningInputs = normalizePlanningInputs({
    version: 1,
    objective: "balanced",
    travelReservePercent: 20,
    stopReserveMin: 20,
    stopPriorities: { "stop-1": 2 },
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs",
  });

  const node = disruptionNodeForPlanning(stop, planningInputs);

  assert.equal(node.jobType, "pickup_delivery");
  assert.equal(node.stopReserveMin, 20);
  assert.equal(node.travelReservePercent, 20);
  assert.equal(node.planningPriority, 2);
  assert.equal(node.pickupLat, 59.35);
  assert.equal(node.pickupLon, 18.09);
  assert.equal(node.pickupServiceMin, 25);
  assert.deepEqual(node.requiredSkills, ["HVAC"]);
  assert.deepEqual(node.requiredCertifications, ["CERT-A"]);
  assert.deepEqual(node.requiredEquipment, ["LIFT"]);
});

test("disruption reoptimization replaces stale route unplanned summary evidence", () => {
  const planningInputs = normalizePlanningInputs({
    version: 1,
    objective: "balanced",
    travelReservePercent: 20,
    stopReserveMin: 20,
    stopPriorities: { "stop-2": 2 },
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs",
  });
  const staleSummary = {
    complete: false,
    objective: "balanced",
    travelReservePercent: 0,
    stopReserveMin: 0,
    mandatoryUnplannedStopIds: ["stop-1"],
    selectedPairValues: ["vehicle:driver"],
    usedPairValues: ["vehicle:driver"],
    unusedPairValues: [],
    unplanned: [{
      stopId: "stop-1",
      priority: 2 as const,
      reason: "Stale reason",
    }],
  };
  const summary = refreshedPlanningSummary(
    staleSummary,
    planningInputs,
    [{
      id: "stop-2",
      latitude: 59.34,
      longitude: 18.08,
      timeWindowStart: null,
      timeWindowEnd: null,
      serviceDurationMin: 10,
      weightKg: 0,
      volumeM3: 0,
      planningPriority: 2,
    }],
    new Map([["stop-2", "Concrete capacity reason"]]),
  );

  assert.equal(summary.complete, false);
  assert.deepEqual(summary.mandatoryUnplannedStopIds, ["stop-2"]);
  assert.deepEqual(summary.unplanned, [{
    stopId: "stop-2",
    priority: 2,
    reason: "Concrete capacity reason",
  }]);
  assert.deepEqual(summary.selectedPairValues, ["vehicle:driver"]);

  const cleared = refreshedPlanningSummary(
    summary,
    planningInputs,
    [],
    new Map(),
  );
  assert.equal(cleared.complete, true);
  assert.deepEqual(cleared.mandatoryUnplannedStopIds, []);
  assert.deepEqual(cleared.unplanned, []);
});