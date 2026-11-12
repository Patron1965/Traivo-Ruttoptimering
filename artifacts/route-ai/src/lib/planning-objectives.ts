import type { PlanningInputs } from "@workspace/api-client-react";

/** Keep existing choices and defaults; this profile is explicitly opt-in. */
export const ROUTE_PLANNING_OBJECTIVES = [
  "balanced",
  "shortest",
  "geographic",
  "areas_worktime",
] as const;

export type RoutePlanningObjective = (typeof ROUTE_PLANNING_OBJECTIVES)[number];

export const PLANNING_OBJECTIVES = [
  ...ROUTE_PLANNING_OBJECTIVES,
  "minimize_vehicles",
] as const;

const OBJECTIVE_TRANSLATION_SUFFIX: Record<PlanningInputs["objective"], string> = {
  balanced: "Balanced",
  shortest: "Shortest",
  geographic: "Geographic",
  areas_worktime: "AreasWorktime",
  minimize_vehicles: "MinimizeVehicles",
};

export function objectiveTranslationSuffix(objective: PlanningInputs["objective"]): string {
  return OBJECTIVE_TRANSLATION_SUFFIX[objective];
}
