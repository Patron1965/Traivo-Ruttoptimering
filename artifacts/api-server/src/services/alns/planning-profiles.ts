import type { OptimizationWeights } from "./types";

export type PlanningProfile = "balanced" | "shortest" | "geographic" | "areas_worktime" | "minimize_vehicles";

/** Resource occupancy is deliberately absent: it belongs to the caller's resource selection. */
export function planningProfileWeights(profile: PlanningProfile): OptimizationWeights {
  const common = { searchProfile: profile, workloadBalanceWeight: 0, distanceWeight: 0,
    co2Weight: 0, etaPrecisionWeight: 0, driverHappinessWeight: 0, geographicCohesionWeight: 0 };
  switch (profile) {
    case "shortest": return { ...common, distanceWeight: 1 };
    case "geographic": return { ...common, distanceWeight: .25, co2Weight: .1,
      etaPrecisionWeight: .1, driverHappinessWeight: .05, geographicCohesionWeight: .5 };
    case "areas_worktime": return { ...common, objectivePriority: "areas_worktime",
      workloadBalanceWeight: 1, geographicCohesionWeight: 1 };
    case "minimize_vehicles": return { ...common, distanceWeight: .5, co2Weight: .2,
      etaPrecisionWeight: .15, driverHappinessWeight: .15 };
    default: return { ...common, workloadBalanceWeight: 1, distanceWeight: .35,
      co2Weight: .15, etaPrecisionWeight: .15, driverHappinessWeight: .35 };
  }
}

/** Computational road seeds are not territorial constraints or objective penalties. */
export function usesRoadSeed(profile?: PlanningProfile): boolean {
  return profile != null && profile !== "areas_worktime";
}
