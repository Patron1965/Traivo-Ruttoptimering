/**
 * Turns errors from fetch, React Query and the generated API client into
 * user-facing copy without leaking arbitrary response bodies or implementation
 * details. The translator is deliberately supplied by the caller so this
 * utility can be used from hooks, contexts and tests without coupling those
 * layers to React.
 */

export type ErrorTranslator = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export interface LocalizeErrorOptions {
  /**
   * A component-specific translation to use when the error has no known
   * reason/status. It is intentionally only a fallback: known business
   * reasons and HTTP statuses always win.
   */
  fallbackKey?: string;
  /** A literal fallback for callers which do not have a catalog key yet. */
  fallback?: string;
  /** Use when the caller has status information separate from the error. */
  status?: number;
}

/**
 * Marks copy authored by the UI as already localized. Callers should only
 * construct this for messages that came from their own translation catalog or
 * a deliberately user-facing local validation path, never for server text.
 */
export class TrustedLocalizedError extends Error {
  readonly isTrustedLocalizedError = true;

  constructor(message: string) {
    super(message);
    this.name = "TrustedLocalizedError";
  }
}

type ErrorRecord = Record<string, unknown>;

function asRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === "object" ? value as ErrorRecord : null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

/** Extracts an HTTP status from ApiError, a native response-shaped error, or a body. */
export function getErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const data = asRecord(record?.data) ?? asRecord(record?.body);
  const status = record?.status ?? record?.statusCode ?? response?.status ?? data?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

function collectCandidates(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 3 || value == null) return output;
  const direct = nonEmptyString(value);
  if (direct) {
    output.push(direct);
    return output;
  }

  const record = asRecord(value);
  if (!record) return output;

  for (const key of ["code", "reason", "message", "error", "detail", "title"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      output.push(candidate.trim());
    }
  }
  for (const key of ["data", "body", "response"]) {
    if (record[key] && typeof record[key] === "object") {
      collectCandidates(record[key], output, depth + 1);
    }
  }
  return output;
}

/** An unsent route has no recipient yet; this is not a revision conflict. */
export function isStopMessageAwaitingDispatch(error: unknown): boolean {
  return getErrorStatus(error) === 409
    && collectCandidates(error).includes("The stop has no dispatched driver");
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

/** Checks a structured API error without exposing its response prose. */
export function hasErrorCode(error: unknown, expectedCode: string): boolean {
  const expected = normalize(expectedCode);
  return collectCandidates(error).some((candidate) => normalize(candidate) === expected);
}

type MessageRule = {
  pattern: RegExp;
  key: string;
};

const ROUTE_DELETE_CONFLICT_REASON_KEYS: Record<string, string> = {
  route_status: "routes.deleteConflictReasons.routeStatus",
  handoff: "routes.deleteConflictReasons.handoff",
  stop_status: "routes.deleteConflictReasons.stopStatus",
  execution_history: "routes.deleteConflictReasons.executionHistory",
  approved_route: "routes.deleteConflictReasons.approvedRoute",
  approved_membership: "routes.deleteConflictReasons.approvedMembership",
  partial_plan: "routes.deleteConflictReasons.partialPlan",
};

function routeDeleteConflictReasons(error: unknown): {
  isConflict: boolean;
  reasonKeys: string[];
} {
  const errorRecord = asRecord(error);
  const response = asRecord(errorRecord?.response);
  const data = asRecord(errorRecord?.data) ?? asRecord(errorRecord?.body);
  const roots = [errorRecord, data, response, asRecord(response?.data)].filter(
    (value): value is ErrorRecord => !!value,
  );
  const isConflict = roots.some((root) => root.code === "ROUTE_DELETE_CONFLICT");
  const reasons = roots.flatMap((root) => {
    const details = asRecord(root.details);
    const conflicts = details?.conflicts;
    if (!Array.isArray(conflicts)) return [];
    return conflicts.flatMap((conflict) => {
      const reason = asRecord(conflict)?.reason;
      return typeof reason === "string" ? [reason] : [];
    });
  });
  return {
    isConflict: isConflict || reasons.some((reason) => reason in ROUTE_DELETE_CONFLICT_REASON_KEYS),
    reasonKeys: Array.from(new Set(
      reasons
        .map((reason) => ROUTE_DELETE_CONFLICT_REASON_KEYS[reason])
        .filter((key): key is string => !!key),
    )),
  };
}

/*
 * These are deliberately business reasons, not a translation of arbitrary
 * server prose. Keep this list in sync with the stable reason codes/messages
 * used by the route-planning API.
 */
const BUSINESS_REASON_RULES: MessageRule[] = [
  { pattern: /^Chaufförens startplats kunde inte verifieras$/i, key: "drivers.startAddressNotVerified" },
  { pattern: /^Chaufförens slutplats kunde inte verifieras$/i, key: "drivers.endAddressNotVerified" },
  { pattern: /^Vehicle is already assigned to driver /i, key: "drivers.vehicleAlreadyAssigned" },
  { pattern: /^Only pending stops can be deleted\. No stops were deleted\.$/i, key: "common.errorReasons.stopDeleteStatus" },
  { pattern: /^Deletion would reorder active or terminal stops\. No stops were deleted\.$/i, key: "common.errorReasons.stopDeleteSequence" },
  { pattern: /\bcapacity(?: is)? exceeded\b|\bcapacity needs checking\b|\boverload(?:ed)?\b/i, key: "common.errorReasons.capacity" },
  { pattern: /\bworking hours?(?: may be)? exceeded\b|\bwork(?:ing)? hours?\b.*\bexceed/i, key: "common.errorReasons.workingHours" },
  { pattern: /\bvehicle range\b.*\bexceed|\brange(?: may be)? exceeded\b/i, key: "common.errorReasons.range" },
  { pattern: /\broute has no vehicle\b|\bno vehicle\b/i, key: "common.errorReasons.noVehicle" },
  { pattern: /\btime window has passed\b|\btime window\b.*\bpassed\b/i, key: "common.errorReasons.timeWindow" },
  { pattern: /\bqualified field service\b|\bfield service\b.*\brequir/i, key: "common.errorReasons.fieldService" },
  { pattern: /\bno space in planned routes\b|\bno room in planned routes\b/i, key: "common.errorReasons.noRouteSpace" },
  { pattern: /\bstop does not fit\b|\bassignment conflict\b|\bconflict(?:ed)? with route\b/i, key: "common.errorReasons.assignmentConflict" },
  { pattern: /\bactive or planned route\b|\bvehicle is used by\b/i, key: "common.errorReasons.vehicleInUse" },
  { pattern: /\bmissing required skill\b|\bdriver missing\b.*\bskill\b/i, key: "common.errorReasons.missingSkill" },
  { pattern: /\bmissing required certification\b|\bdriver missing\b.*\bcertif/i, key: "common.errorReasons.missingCertification" },
  { pattern: /\bexpired certification\b|\bcertification expired\b/i, key: "common.errorReasons.expiredCertification" },
  { pattern: /\bmissing required equipment\b|\bvehicle missing\b.*\bequipment\b/i, key: "common.errorReasons.missingEquipment" },
  { pattern: /\bincompatible role\b|\bno active technician\b/i, key: "common.errorReasons.incompatibleRole" },
];

const CODE_TO_KEY: Record<string, string> = {
  stale_resource_snapshot: "dispatch.approvalInputsChanged",
  stale_plan_revision: "dispatch.approvalRevisionChanged",
  invalid_recipient: "dispatch.approvalRecipientChanged",
  route_not_in_plan: "dispatch.approvalRevisionChanged",
  capacity_exceeded: "common.errorReasons.capacity",
  working_hours_exceeded: "common.errorReasons.workingHours",
  range_exceeded: "common.errorReasons.range",
  no_vehicle: "common.errorReasons.noVehicle",
  time_window_passed: "common.errorReasons.timeWindow",
  field_service_required: "common.errorReasons.fieldService",
  no_route_space: "common.errorReasons.noRouteSpace",
  assignment_conflict: "common.errorReasons.assignmentConflict",
  vehicle_in_use: "common.errorReasons.vehicleInUse",
  missing_skill: "common.errorReasons.missingSkill",
  missing_certification: "common.errorReasons.missingCertification",
  expired_certification: "common.errorReasons.expiredCertification",
  missing_equipment: "common.errorReasons.missingEquipment",
  incompatible_role: "common.errorReasons.incompatibleRole",
  missing_vehicle: "common.errorReasons.missingVehicle",
  inactive_vehicle: "common.errorReasons.inactiveVehicle",
  missing_driver: "common.errorReasons.missingDriver",
  missing_stops: "common.errorReasons.missingStops",
  invalid_coordinates: "common.errorReasons.invalidCoordinates",
  review_required: "common.errorReasons.reviewRequired",
  locked_first_stop_conflict: "common.errorReasons.lockedFirstStopConflict",
  dispatch_revision_conflict: "common.errorConflict",
  dispatch_driver_unresolved: "common.errorReasons.missingDriver",
  dispatch_planning_evidence_missing: "common.errorReasons.reviewRequired",
  dispatch_pickup_coordinates_required: "common.errorReasons.invalidCoordinates",
  draft_state_too_large: "import.draftStateTooLarge",
  draft_body_too_large: "import.requestTooLarge",
  body_too_large: "import.requestTooLarge",
  vehicle_already_planned: "import.vehicleAlreadyPlanned",
  draft_import_incomplete: "import.planStopsNotReady",
  invalid_request: "common.errorBadRequest",
  route_not_found: "common.errorNotFound",
  route_not_active: "dispatch.driverSmsNotDispatched",
  handoff_missing: "dispatch.driverSmsNotDispatched",
  handoff_stale: "dispatch.driverSmsStaleVersion",
  recipient_mismatch: "dispatch.driverSmsSentToAnotherDriver",
  recipient_unavailable: "dispatch.driverUnavailable",
  resend_rate_limited: "dispatch.driverSmsRateLimited",
  internal_error: "common.errorServer",
};

const KNOWN_MESSAGE_RULES: MessageRule[] = [
  { pattern: /^The stop has no dispatched driver$/i, key: "stopMessages.awaitingDispatch" },
  { pattern: /^(?:unauthorized|authentication required|login required|session expired)$/i, key: "common.errorUnauthorized" },
  { pattern: /^(?:forbidden|access denied|permission denied)$/i, key: "common.errorForbidden" },
  { pattern: /^(?:not found|route not found|stop not found|organization not found|logo not found)$/i, key: "common.errorNotFound" },
  { pattern: /^(?:bad request|invalid input|validation failed)$/i, key: "common.errorBadRequest" },
  { pattern: /^(?:conflict|request conflict)$/i, key: "common.errorConflict" },
  { pattern: /^(?:failed to fetch|network error|network request failed|load failed|the network connection was lost)$/i, key: "common.errorNetwork" },
  { pattern: /^(?:request timed out|timeout|the operation timed out)$/i, key: "common.errorTimeout" },
  { pattern: /^inloggningen misslyckades$/i, key: "auth.signInFailed" },
  { pattern: /^(?:request failed|failed)$/i, key: "common.errorRequestFailed" },
  { pattern: /^(?:invalid|expired) (?:password )?reset link$|^the reset link is invalid or has expired$/i, key: "auth.resetExpired" },
  { pattern: /^återställningslänken är ogiltig eller har gått ut\.?$/i, key: "auth.resetExpired" },
];

function translate(
  t: ErrorTranslator,
  key: string,
  fallback: string,
  options: Record<string, unknown> = {},
): string {
  const value = t(key, { defaultValue: fallback, ...options });
  return typeof value === "string" && value.trim() ? value : fallback;
}

function statusKey(status: number | undefined): string | undefined {
  if (status === 401) return "common.errorUnauthorized";
  if (status === 403) return "common.errorForbidden";
  if (status === 404) return "common.errorNotFound";
  if (status === 408 || status === 504) return "common.errorTimeout";
  if (status === 409) return "common.errorConflict";
  if (status === 400 || status === 422) return "common.errorBadRequest";
  if (status != null && status >= 500) return "common.errorServer";
  return undefined;
}

function isNetworkError(candidates: string[]): boolean {
  return candidates.some((candidate) => /failed to fetch|network error|network request failed|load failed|connection was lost/i.test(candidate));
}

/**
 * Localize an unknown caught value at the UI boundary.
 *
 * Public interface for callers:
 *   localizeError(error, t, { fallbackKey: "stops.bulkDeleteError" })
 *   localizeError(new TrustedLocalizedError(t("import.parseFailed")), t)
 *
 * The function only returns raw text for a small set of known, already
 * localized Swedish auth/branding details, or an explicitly wrapped
 * TrustedLocalizedError. Unknown response text is replaced by a safe catalog
 * message.
 */
export function localizeError(
  error: unknown,
  t: ErrorTranslator,
  options: LocalizeErrorOptions = {},
): string {
  if (error instanceof TrustedLocalizedError && error.message.trim()) {
    return error.message;
  }
  const candidates = collectCandidates(error);
  const normalizedCandidates = candidates.map(normalize);
  const status = options.status ?? getErrorStatus(error);
  // This endpoint explicitly identifies authored planning validation messages,
  // not arbitrary exception/provider prose. Preserve the actionable stop or
  // revision explanation rather than replacing every HTTP 400 with "failed".
  const record = asRecord(error);
  const body = asRecord(record?.data) ?? asRecord(record?.body) ?? record;
  if (body?.code === "IMPORT_PLAN_REVIEW_FAILED") {
    const explanation = nonEmptyString(body.error);
    if (explanation) return explanation;
  }

  // Stable machine-readable reason codes should win over prose.
  for (const candidate of normalizedCandidates) {
    const codeKey = CODE_TO_KEY[candidate.replace(/ /g, "_")];
    if (codeKey) return translate(t, codeKey, candidate);
  }

  const routeDeleteConflict = routeDeleteConflictReasons(error);
  if (routeDeleteConflict.isConflict) {
    if (routeDeleteConflict.reasonKeys.length === 1) {
      return translate(
        t,
        routeDeleteConflict.reasonKeys[0],
        "This route cannot be deleted for a safety reason.",
      );
    }
    if (routeDeleteConflict.reasonKeys.length > 1) {
      const reasons = routeDeleteConflict.reasonKeys.map((key) => translate(
        t,
        key,
        "This route cannot be deleted for a safety reason.",
      ));
      return translate(
        t,
        "routes.deleteConflictSummary",
        "Some selected routes cannot be deleted: {{reasons}}",
        { reasons: reasons.join(" · ") },
      );
    }
    return translate(
      t,
      options.fallbackKey ?? "routes.bulkDeleteError",
      options.fallback ?? "Could not delete the selected routes. No routes were deleted.",
    );
  }

  for (const candidate of candidates) {
    const businessRule = BUSINESS_REASON_RULES.find((rule) => rule.pattern.test(candidate));
    if (businessRule) return translate(t, businessRule.key, candidate);
  }

  for (const candidate of candidates) {
    const knownRule = KNOWN_MESSAGE_RULES.find((rule) => rule.pattern.test(candidate));
    if (knownRule) return translate(t, knownRule.key, candidate);
  }

  // These two messages carry actionable, intentionally user-facing Swedish
  // guidance from branding/auth and should not be replaced by a generic error.
  const localizedSwedish = candidates.find((candidate) => (
    /^din inloggning är inte längre giltig\./i.test(candidate)
    || /^du behöver vara administratör för att ändra kundanpassningen\./i.test(candidate)
  ));
  if (localizedSwedish) return localizedSwedish;

  if (isNetworkError(candidates)) {
    return translate(t, "common.errorNetwork", "Network connection failed. Check your connection and try again.");
  }

  const httpKey = statusKey(status);
  if (httpKey) {
    const fallback = status === 401
      ? "Your session has expired. Sign in again to continue."
      : status === 403
        ? "You do not have permission to do that."
        : status === 404
          ? "The requested item could not be found."
          : status === 409
            ? "The request conflicts with a newer change. Refresh and try again."
            : status != null && status >= 500
              ? "The service is temporarily unavailable. Try again later."
              : "The request could not be completed. Check the information and try again.";
    return translate(t, httpKey, fallback);
  }

  if (options.fallbackKey) {
    return translate(t, options.fallbackKey, options.fallback ?? "The request could not be completed.");
  }

  return translate(t, "common.errorUnknown", options.fallback ?? "Something went wrong. Try again.");
}
