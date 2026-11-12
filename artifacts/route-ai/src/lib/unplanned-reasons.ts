type StopWithPlanningEvidence = {
  unplannedReason?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  timeWindowEnd?: Date | string | null;
};

export type UnplannedReasonEvidence =
  | { kind: "stored"; value: string }
  | { kind: "invalid_coordinates" }
  | { kind: "expired_time_window" }
  | { kind: "missing" };

/**
 * Returns only persisted planning evidence or a directly observable data
 * problem. In particular, capacity/working-hours/skill explanations must not
 * be inferred in the browser when the optimizer did not provide one.
 */
export function getUnplannedReasonEvidence(
  stop: StopWithPlanningEvidence,
  now: Date = new Date(),
): UnplannedReasonEvidence {
  const storedReason = stop.unplannedReason;
  if (typeof storedReason === "string" && storedReason.trim()) {
    return { kind: "stored", value: storedReason.trim() };
  }
  if (
    !stop.address?.trim() ||
    typeof stop.latitude !== "number" ||
    !Number.isFinite(stop.latitude) ||
    typeof stop.longitude !== "number" ||
    !Number.isFinite(stop.longitude)
  ) {
    return { kind: "invalid_coordinates" };
  }
  if (stop.timeWindowEnd) {
    const end = new Date(stop.timeWindowEnd);
    if (Number.isFinite(end.getTime()) && end.getTime() < now.getTime()) {
      return { kind: "expired_time_window" };
    }
  }
  return { kind: "missing" };
}