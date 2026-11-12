export interface ContinuousOptimizationLifecycleStatus {
  running: boolean;
  startedAt?: number | null;
}

/**
 * Poll responses can be older than a stop confirmation because an earlier
 * request may still be in flight. Keep that run stopped, while accepting a
 * later run started by another client.
 */
export function reconcileContinuousOptimizationStatus<
  T extends ContinuousOptimizationLifecycleStatus,
>(
  status: T | undefined,
  stoppedRunStartedAt: number | null,
): T | undefined {
  if (
    !status ||
    !status.running ||
    stoppedRunStartedAt == null ||
    status.startedAt == null ||
    status.startedAt > stoppedRunStartedAt
  ) {
    return status;
  }
  return { ...status, running: false };
}