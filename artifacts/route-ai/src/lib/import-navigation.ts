/**
 * A retained draft can remember that it was on the review step even when the
 * server never created a plan. In that case the only valid recovery target is
 * resource selection, not a plan-status/review surface.
 */
export function resolveImportResumeStep(
  requestedStep: number,
  serverPlanId: string | null | undefined,
  persistedStopsReady: boolean,
): number {
  if (!serverPlanId && requestedStep > 5 && persistedStopsReady) return 5;
  return requestedStep;
}