const STOP_STATUS_TRANSLATION_KEYS: Record<string, string> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
  canceled: "cancelled",
  delivered: "delivered",
};

export function getStopStatusTranslationKey(status: unknown): string {
  if (typeof status !== "string") return "unknown";

  return STOP_STATUS_TRANSLATION_KEYS[status.trim().toLowerCase()] ?? "unknown";
}