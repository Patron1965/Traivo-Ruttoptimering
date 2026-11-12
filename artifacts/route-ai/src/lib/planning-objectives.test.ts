import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreateImportRoutePlanBody,
  GetRouteResponse,
  OptimizeRoutesBody,
  ReoptimizeImportRoutePlanPlanningInputsBody,
  UpdatePlanningDraftBody,
} from "../../../../lib/api-zod/src/generated/api.ts";
import {
  PLANNING_OBJECTIVES,
  ROUTE_PLANNING_OBJECTIVES,
  objectiveTranslationSuffix,
} from "./planning-objectives.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const inputs = {
  version: 1,
  objective: "areas_worktime",
  travelReservePercent: 0,
  stopReserveMin: 0,
  stopPriorities: {},
  excludedPairValues: [],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs",
};

test("all objective editors share the opt-in choice and retain existing choices", () => {
  assert.deepEqual(ROUTE_PLANNING_OBJECTIVES, [
    "balanced", "shortest", "geographic", "areas_worktime",
  ]);
  assert.deepEqual(PLANNING_OBJECTIVES, [...ROUTE_PLANNING_OBJECTIVES, "minimize_vehicles"]);
  for (const path of ["../components/import/Step6Vehicles.tsx", "../components/import/Step7Adjust.tsx"]) {
    assert.match(read(path), /PLANNING_OBJECTIVES\.map/);
  }
  const planner = read("../pages/Planner.tsx");
  assert.match(read("../components/planner/OptimizerSettings.tsx"), /ROUTE_PLANNING_OBJECTIVES\.map/);
  assert.match(planner, /objective: optimizationProfile/);
  assert.match(planner, /persistedEvidence\?\.effectiveObjective === "areas_worktime"/);
  assert.match(planner, /useState<OptimizationProfile>\("balanced"\)/);
  assert.match(read("../pages/Import.tsx"), /optimizationProfile: "geographic"/);
  assert.match(
    read("../components/routes/RouteReoptimizationMenu.tsx"),
    /areas-worktime-repartition-guidance/,
  );
});

test("localized objective labels resolve without leaking underscore enum keys", () => {
  assert.equal(objectiveTranslationSuffix("areas_worktime"), "AreasWorktime");
  for (const language of ["sv", "en"]) {
    const locale = JSON.parse(read(`../i18n/locales/${language}.json`));
    for (const objective of PLANNING_OBJECTIVES) {
      const suffix = objectiveTranslationSuffix(objective);
      assert.ok(locale.import[`optimization${suffix}`]);
      assert.ok(locale.import[`optimization${suffix}Description`]);
    }
    const label = language === "sv"
      ? "Sammanhållna områden och arbetstid"
      : "Cohesive areas and working time";
    assert.equal(locale.import.optimizationAreasWorktime, label);
    assert.equal(locale.planner.optimizationProfileAreasWorktime, label);
    assert.ok(locale.planner.optimizationProfileAreasWorktimeDescription);
    assert.ok(locale.import.optimizationAreasWorktimeScopeGuidance);
  }
  for (const driver of [
    "../pages/DriverView.tsx",
    "../../../driver-app/app/(tabs)/index.tsx",
  ]) {
    assert.match(read(driver), /areas_worktime:.*"Sammanhållna områden och arbetstid"/);
    assert.match(read(driver), /summary\?\.objective \?\? snapshot\?\.objective/);
  }
});

test("draft, import, review recalculation and Planner requests preserve the objective", () => {
  assert.deepEqual(
    UpdatePlanningDraftBody.shape.state.parse({ planningInputs: inputs }),
    { planningInputs: inputs },
  );
  for (const schema of [
    CreateImportRoutePlanBody.shape.planningInputs,
    ReoptimizeImportRoutePlanPlanningInputsBody.shape.planningInputs,
    OptimizeRoutesBody.shape.planningInputs,
  ]) {
    assert.equal(schema.parse(inputs)?.objective, "areas_worktime");
    assert.equal(schema.safeParse({ ...inputs, objective: "unknown" }).success, false);
    for (const objective of PLANNING_OBJECTIVES) {
      assert.equal(schema.parse({ ...inputs, objective })?.objective, objective);
    }
  }
});

test("saved route snapshots and evidence retain the lexicographic objective selector", () => {
  assert.equal(
    GetRouteResponse.shape.optimizationPlanningSnapshot.parse(inputs)?.objective,
    "areas_worktime",
  );
  const weights = {
    objectivePriority: "areas_worktime",
    distanceWeight: 0,
    co2Weight: 0,
    etaPrecisionWeight: 0,
    driverHappinessWeight: 0,
    geographicCohesionWeight: 1,
  };
  const summary = GetRouteResponse.shape.planningSummary.parse({
    complete: true,
    objective: "areas_worktime",
    travelReservePercent: 0,
    stopReserveMin: 0,
    mandatoryUnplannedStopIds: [],
    selectedPairValues: [],
    usedPairValues: [],
    unusedPairValues: [],
    unplanned: [],
    optimizationEvidence: {
      source: "planningInputs",
      requestedObjective: "areas_worktime",
      effectiveObjective: "areas_worktime",
      requestedWeights: weights,
      effectiveWeights: weights,
      vehicleDistributionMode: "balance",
      vehicleSelectionMode: "use_all_selected_pairs",
    },
  });
  assert.equal(summary?.objective, "areas_worktime");
  assert.equal(summary?.optimizationEvidence?.requestedObjective, "areas_worktime");
  assert.equal(summary?.optimizationEvidence?.effectiveObjective, "areas_worktime");
  assert.equal(summary?.optimizationEvidence?.requestedWeights?.objectivePriority, "areas_worktime");
  assert.equal(summary?.optimizationEvidence?.effectiveWeights?.objectivePriority, "areas_worktime");
});
