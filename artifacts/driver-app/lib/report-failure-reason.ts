export const REPORT_FAILURE_REASONS = ["customer_unavailable", "access_problem", "vehicle_issue", "other"] as const;
export type ReportFailureReason = typeof REPORT_FAILURE_REASONS[number];

export function restoreReportFailureReason(value: unknown): ReportFailureReason | "" {
  return typeof value === "string" && REPORT_FAILURE_REASONS.some(reason => reason === value)
    ? value as ReportFailureReason : "";
}

export function needsReportFailureReason(outcome: string, reason: unknown): boolean {
  return outcome === "failed" && !restoreReportFailureReason(reason);
}
