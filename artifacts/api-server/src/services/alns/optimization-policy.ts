import type { ALNSConfig } from "./types";

export type OptimizationProfile = "small" | "compact" | "standard" | "custom";

export interface OptimizationPolicy {
  profile: OptimizationProfile;
  timeLimitMs: number;
  maxIterations: number;
  maxNoImprovementIterations?: number;
  minIterationsBeforeEarlyStop: number;
  localSearchTimeLimitMs: number;
  distanceMatrixTimeoutMs: number;
  weatherTimeoutMs: number;
}

export function resolveOptimizationPolicy(
  stopCount: number,
  requestedTimeBudgetMs?: number,
): OptimizationPolicy {
  if (requestedTimeBudgetMs != null) {
    const budget = Math.max(1_000, requestedTimeBudgetMs);
    return {
      profile: "custom",
      timeLimitMs: budget,
      maxIterations: 10_000,
      minIterationsBeforeEarlyStop: 0,
      localSearchTimeLimitMs: Math.min(5_000, Math.floor(budget * 0.2)),
      distanceMatrixTimeoutMs: Math.min(10_000, Math.max(1_000, Math.floor(budget * 0.5))),
      weatherTimeoutMs: Math.min(5_000, Math.max(250, Math.floor(budget * 0.1))),
    };
  }

  if (stopCount <= 10) {
    return {
      profile: "small",
      timeLimitMs: 3_500,
      maxIterations: 10_000,
      maxNoImprovementIterations: 600,
      minIterationsBeforeEarlyStop: 300,
      localSearchTimeLimitMs: 500,
      distanceMatrixTimeoutMs: 10_000,
      weatherTimeoutMs: 1_000,
    };
  }

  if (stopCount <= 20) {
    return {
      profile: "compact",
      timeLimitMs: 6_000,
      maxIterations: 10_000,
      maxNoImprovementIterations: 1_000,
      minIterationsBeforeEarlyStop: 500,
      localSearchTimeLimitMs: 750,
      distanceMatrixTimeoutMs: 10_000,
      weatherTimeoutMs: 1_250,
    };
  }

  return {
    profile: "standard",
    timeLimitMs: 30_000,
    maxIterations: 10_000,
    minIterationsBeforeEarlyStop: 0,
    localSearchTimeLimitMs: 5_000,
    distanceMatrixTimeoutMs: 10_000,
    weatherTimeoutMs: 5_000,
  };
}

export function policyToALNSConfig(
  policy: OptimizationPolicy,
): Pick<
  ALNSConfig,
  | "timeLimitMs"
  | "maxIterations"
  | "maxNoImprovementIterations"
  | "minIterationsBeforeEarlyStop"
  | "localSearchTimeLimitMs"
  | "distanceMatrixTimeoutMs"
> {
  return {
    timeLimitMs: policy.timeLimitMs,
    maxIterations: policy.maxIterations,
    maxNoImprovementIterations: policy.maxNoImprovementIterations,
    minIterationsBeforeEarlyStop: policy.minIterationsBeforeEarlyStop,
    localSearchTimeLimitMs: policy.localSearchTimeLimitMs,
    distanceMatrixTimeoutMs: policy.distanceMatrixTimeoutMs,
  };
}