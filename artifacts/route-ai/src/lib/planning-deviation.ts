/** UI eligibility only. The canonical server policy must still authorize every write. */
export function canConfirmPlanningDeviation(codes: readonly string[]): boolean {
  return codes.length > 0 && codes.every(code => code === "CAPACITY" || code === "WORKING_HOURS");
}
