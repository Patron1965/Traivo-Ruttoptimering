/**
 * The overlap explanation is server evidence, not a client-side diagnosis.
 * The current API contract is intentionally read literally. Older persisted
 * reason/message-only rows remain visible as historical text, but cannot be
 * promoted to a confirmed explanation without the versioned status/scope.
 */
export type OverlapExplanationStatus = "verified" | "unknown" | "incomplete";

export interface NormalizedRouteOverlapExplanation {
  status: OverlapExplanationStatus;
  reasonCode: string | null;
  serverMessage: string | null;
  affectedVehicleIds: string[];
  affectedStopIds: string[];
  analyzedPairCount: number | null;
}

function idsFromScope(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
}

const KNOWN_REASON_CODES = new Set([
  "TIME_WINDOW",
  "CAPACITY",
  "SKILL",
  "WORKING_HOURS",
  "EV_RANGE",
]);

/**
 * Normalize server evidence without inventing a reason when the server could
 * not verify one. `null` is returned only when there is no explanation at all.
 */
export function normalizeRouteOverlapExplanation(
  explanation: unknown,
): NormalizedRouteOverlapExplanation | null {
  if (!explanation || typeof explanation !== "object") return null;
  const value = explanation as Record<string, unknown>;
  const candidateServerMessage =
    typeof value.message === "string" && value.message.trim()
      ? value.message
      : null;
  const scope =
    value.scope && typeof value.scope === "object"
      ? (value.scope as Record<string, unknown>)
      : null;
  const hasCurrentContract =
    (value.status === "confirmed" ||
      value.status === "unknown" ||
      value.status === "incomplete") &&
    typeof value.analyzedPairCount === "number" &&
    Number.isFinite(value.analyzedPairCount) &&
    scope !== null;
  const reasonCode =
    hasCurrentContract &&
    typeof value.reasonCode === "string" &&
    KNOWN_REASON_CODES.has(value.reasonCode)
      ? value.reasonCode
      : null;
  const affectedVehicleIds = idsFromScope(scope?.vehicleIds);
  const affectedStopIds = idsFromScope(scope?.stopIds);
  const analyzedPairCount =
    hasCurrentContract &&
    typeof value.analyzedPairCount === "number" &&
    Number.isFinite(value.analyzedPairCount)
      ? value.analyzedPairCount
      : null;

  // Current causal server text is only trusted alongside the versioned
  // status/scope contract. Historical rows may retain a reason/message shape,
  // but their old message must not be presented as current evidence.
  const serverMessage = hasCurrentContract ? candidateServerMessage : null;
  if (!hasCurrentContract && !candidateServerMessage) {
    return null;
  }
  if (hasCurrentContract && !serverMessage) {
    return null;
  }

  // Reason/message-only historical rows are retained as text, but are
  // intentionally downgraded: the current contract is what proves scope and
  // the bounded analysis status.
  const currentStatus: OverlapExplanationStatus =
    value.status === "confirmed" && reasonCode
      ? "verified"
      : value.status === "incomplete"
        ? "incomplete"
        : "unknown";
  return {
    status: hasCurrentContract ? currentStatus : "unknown",
    reasonCode,
    serverMessage,
    affectedVehicleIds,
    affectedStopIds,
    analyzedPairCount,
  };
}

export function routeOverlapReasonKey(
  reasonCode: string | null,
): string | null {
  if (!reasonCode) return null;
  switch (reasonCode) {
    case "TIME_WINDOW":
      return "import.overlapReasonTimeWindow";
    case "CAPACITY":
      return "import.overlapReasonCapacity";
    case "SKILL":
      return "import.overlapReasonSkill";
    case "WORKING_HOURS":
      return "import.overlapReasonWorkingHours";
    case "EV_RANGE":
      return "import.overlapReasonEvRange";
    default:
      return null;
  }
}
