/**
 * Pilot matrix preserves the existing tested CAPACITY and WORKING_HOURS
 * confirmations. Numeric planning capacity is not a newly invented legal
 * safety limit. Hard eligibility/closures remain independently enforced.
 * Unknown/new codes default hard; force is never a blanket bypass.
 */
export function planningConflictSeverity(code: string): "hard" | "authorized_soft" {
  return code === "WORKING_HOURS" || code === "CAPACITY" ? "authorized_soft" : "hard";
}

export function hasBlockingPlanningConflicts(
  conflicts: readonly string[],
  authorizedConfirmation: boolean,
  hardUnavailable = false,
): boolean {
  return hardUnavailable || conflicts.some((code) =>
    planningConflictSeverity(code) === "hard" || !authorizedConfirmation);
}
