export type PersistedPlanningStop = {
  id?: unknown;
  archivedAt?: unknown;
};

export type PlanningReadiness = {
  ready: boolean;
  reason: "ready" | "missing_ids" | "duplicate_ids" | "missing_records" | "archived_record";
};

/**
 * A plan request must be tied to the exact persisted stop records it claims to
 * plan. This is intentionally an identity/readiness check, not a size limit:
 * large, valid imports are handled the same as small imports.
 */
export function getInitialPlanReadiness(
  stopIds: readonly string[],
  stops: readonly PersistedPlanningStop[] | undefined,
): PlanningReadiness {
  if (stopIds.length === 0 || stopIds.some((id) => typeof id !== "string" || id.length === 0)) {
    return { ready: false, reason: "missing_ids" };
  }
  if (new Set(stopIds).size !== stopIds.length) {
    return { ready: false, reason: "duplicate_ids" };
  }
  if (!stops || stops.length !== stopIds.length) {
    return { ready: false, reason: "missing_records" };
  }
  const recordsById = new Map(
    stops
      .filter((stop): stop is PersistedPlanningStop & { id: string } => typeof stop.id === "string")
      .map((stop) => [stop.id, stop]),
  );
  if (recordsById.size !== stopIds.length || stopIds.some((id) => !recordsById.has(id))) {
    return { ready: false, reason: "missing_records" };
  }
  if (stopIds.some((id) => recordsById.get(id)?.archivedAt != null)) {
    return { ready: false, reason: "archived_record" };
  }
  return { ready: true, reason: "ready" };
}