import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  activeOriginalPairs,
  normalizePlanningInputs,
  optimizationEvidenceForConfig,
  planningWeights,
  unknownOptimizationEvidence,
  verifiedDepotOverrideSnapshot,
} from "./import-route-workflow";

const inputs = (overrides: Record<string, unknown> = {}) =>
  normalizePlanningInputs({
    version: 1,
    objective: "balanced",
    travelReservePercent: 0,
    stopReserveMin: 0,
    stopPriorities: {},
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs",
    ...overrides,
  });

test("area and worktime objective survives normalization without changing legacy scoring", () => {
  const planning = inputs({ objective: "areas_worktime" });
  assert.equal(planning.objective, "areas_worktime");
  assert.deepEqual(planningWeights(planning), {
    searchProfile: "areas_worktime",
    objectivePriority: "areas_worktime",
    workloadBalanceWeight: 1,
    distanceWeight: 0,
    co2Weight: 0,
    etaPrecisionWeight: 0,
    driverHappinessWeight: 0,
    geographicCohesionWeight: 1,
  });
  assert.equal(planningWeights(inputs()).objectivePriority, undefined);
  assert.equal(planningWeights(inputs({ objective: "geographic" })).geographicCohesionWeight, 0.5);
  assert.equal(planningWeights(inputs({ objective: "geographic" })).workloadBalanceWeight, 0);
  assert.equal(planningWeights(inputs({ objective: "shortest" })).workloadBalanceWeight, 0);
  assert.equal(planningWeights(inputs()).workloadBalanceWeight, 1);
  const evidence = optimizationEvidenceForConfig({
    source: "planningInputs", planningInputs: planning,
    requestedWeights: planningWeights(planning),
    effectiveWeights: planningWeights(planning) as any,
    vehicleDistributionMode: "balance",
  });
  assert.equal(evidence.effectiveObjective, "areas_worktime");
  assert.equal(evidence.requestedWeights?.objectivePriority, "areas_worktime");
  assert.equal(evidence.effectiveWeights?.objectivePriority, "areas_worktime");
});

test("normalization never changes resource selection to match an objective", () => {
  for (const objective of ["balanced", "shortest", "geographic", "areas_worktime", "minimize_vehicles"] as const) {
    for (const vehicleSelectionMode of ["use_all_selected_pairs", "minimize_vehicles"] as const) {
      assert.equal(inputs({ objective, vehicleSelectionMode }).vehicleSelectionMode, vehicleSelectionMode);
    }
  }
});

test("resource exclusion is applied against the original selection so a later edit can re-add it", () => {
  const first = `${randomUUID()}:${randomUUID()}`;
  const second = `${randomUUID()}:${randomUUID()}`;
  assert.deepEqual(
    activeOriginalPairs(
      [first, second],
      inputs({ excludedPairValues: [first] }),
    ),
    [second].map((value) => {
      const [vehicleId, driverId] = value.split(":");
      return { vehicleId, driverId };
    }),
  );
  assert.equal(activeOriginalPairs([first, second], inputs()).length, 2);
});

test("a route-scoped override can only reuse an immutable verified route depot snapshot", () => {
  const sourceRouteId = randomUUID();
  const sourceSnapshot = {
    start: {
      address: "Verified source",
      latitude: 59.4,
      longitude: 18.1,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      verification: null,
    },
    end: {
      address: "Verified end",
      latitude: 59.41,
      longitude: 18.11,
      verifiedAt: "2026-01-01T00:00:00.000Z",
      verification: null,
    },
  };
  const resolved = verifiedDepotOverrideSnapshot(
    inputs({
      depotOverride: {
        scope: "plan",
        verifiedDepotId: `route:${sourceRouteId}`,
      },
    }).depotOverride,
    undefined,
    [{ id: sourceRouteId, depotSnapshot: sourceSnapshot } as any],
  );
  assert.deepEqual(resolved, sourceSnapshot);
  assert.equal(
    verifiedDepotOverrideSnapshot(
      inputs({
        depotOverride: {
          scope: "plan",
          verifiedDepotId: `route:${randomUUID()}`,
        },
      }).depotOverride,
      undefined,
      [{ id: sourceRouteId, depotSnapshot: sourceSnapshot } as any],
    ),
    undefined,
  );
});

test("explicit planning inputs own the effective weights even when legacy weights disagree", () => {
  const geographic = inputs({ objective: "geographic" });
  const evidence = optimizationEvidenceForConfig({
    source: "planningInputs",
    planningInputs: geographic,
    requestedWeights: planningWeights(geographic),
    effectiveWeights: planningWeights(geographic) as any,
    vehicleDistributionMode: "balance",
  });
  assert.equal(evidence.source, "planningInputs");
  assert.equal(evidence.requestedObjective, "geographic");
  assert.equal(evidence.effectiveObjective, "geographic");
  assert.equal(evidence.effectiveWeights?.geographicCohesionWeight, 0.5);
  // Old saved evidence has no workload field; the explicit geographic
  // objective must still avoid accidental time balancing on recomputation.
  const oldWeights = { ...planningWeights(geographic) };
  delete oldWeights.workloadBalanceWeight;
  const restored = optimizationEvidenceForConfig({
    source: "planningInputs",
    planningInputs: geographic,
    requestedWeights: oldWeights,
    effectiveWeights: oldWeights as any,
    vehicleDistributionMode: "balance",
  });
  assert.equal(restored.effectiveWeights?.workloadBalanceWeight, 0);
  assert.equal(evidence.vehicleSelectionMode, "use_all_selected_pairs");
});

test("legacy evidence retains custom weights and vehicle mode without inventing a profile", () => {
  const evidence = optimizationEvidenceForConfig({
    source: "legacy",
    planningInputs: inputs(),
    requestedWeights: {
      distanceWeight: 0.8,
      geographicCohesionWeight: 0.2,
    },
    effectiveWeights: {
      distanceWeight: 0.8,
      geographicCohesionWeight: 0.2,
    } as any,
    vehicleDistributionMode: "minimize",
  });
  assert.equal(evidence.source, "legacy");
  assert.equal(evidence.requestedObjective, null);
  assert.equal(evidence.effectiveObjective, null);
  assert.equal(evidence.effectiveWeights?.distanceWeight, 0.8);
  assert.equal(evidence.vehicleSelectionMode, "minimize_vehicles");
});

test("unknown evidence is explicit and cannot be inferred from a planning snapshot", () => {
  assert.deepEqual(unknownOptimizationEvidence(), {
    source: "unknown",
    requestedObjective: null,
    effectiveObjective: null,
    requestedWeights: null,
    effectiveWeights: null,
    vehicleDistributionMode: null,
    vehicleSelectionMode: null,
  });
});
