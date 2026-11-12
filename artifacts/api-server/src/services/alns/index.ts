export type {
  EnvironmentContext,
  ALNSNode,
  ALNSVehicle,
  ALNSDriverConstraints,
  ALNSRoute,
  ALNSSolution,
  CostBreakdown,
  OptimizationWeights,
  RouteEvaluation,
  OperatorStats,
  ALNSConfig,
  ALNSRunStats,
  ClusteredALNSRunStats,
  ALNSStopReason,
  ClusterStopReason,
  OptimizationStopReason,
  OptimizationRunStats,
  ALNSResult,
  OptimizationPerformance,
  ClusteredOptimizationProgress,
} from "./types";

export { DEFAULT_WEIGHTS, DEFAULT_CONFIG, DEFAULT_ENV_CTX, CHARGING_STATIONS } from "./types";
export { getDistanceCache, haversineDistance, estimateCo2, cachedDistance } from "./distance-cache";
export { evaluateRoute, computeSolutionCost, computeGeographicCohesionCost, evaluateRouteCost, compareSolutionScores, compareSolutions } from "./cost";
export {
  OptimizerPlanningLockConflict, assertLockedJobsRetained,
  assertPlanningLockResult, assertFrozenRouteFeasible,
} from "./planning-locks";
export {
  explainGeographicRouteOverlap,
  explainGeographicRouteOverlapAsync,
  type RouteOverlapExplanation,
  type RouteOverlapReasonCode,
} from "./route-overlap-explanations";
export {
  runALNS,
  buildInitialSolutionFromCW,
  buildInitialSolutionFromCWAsync,
  optimizeWithALNS,
  reoptimizeAffectedRoutes,
} from "./runner";
export { chargingStationInsertion } from "./operators/repair";
export {
  resolveOptimizationPolicy,
  policyToALNSConfig,
  type OptimizationPolicy,
  type OptimizationProfile,
} from "./optimization-policy";
