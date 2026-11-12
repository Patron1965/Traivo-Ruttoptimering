export const STOP_LIFECYCLE_LOCKED_CODE = "STOP_LIFECYCLE_LOCKED" as const;

export type LockedStopErrorDetails = {
  stopId: string;
  routeId: string | null;
  sequenceOrder: number | null;
  status: string;
  address: string;
};

type LockedStopErrorPayload = {
  code: typeof STOP_LIFECYCLE_LOCKED_CODE;
  details: LockedStopErrorDetails;
};

const STATUS_LABELS: Record<"en" | "sv", Record<string, string>> = {
  en: {
    pending: "pending",
    in_progress: "in progress",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
  },
  sv: {
    pending: "väntar",
    in_progress: "pågår",
    completed: "slutfört",
    failed: "misslyckat",
    skipped: "överhoppat",
  },
};

const STATUS_ALIASES: Record<string, string> = {
  pending: "pending",
  waiting: "pending",
  queued: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  "in progress": "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  failed: "failed",
  error: "failed",
  skipped: "skipped",
  skip: "skipped",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLockedStopDetails(value: unknown): value is LockedStopErrorDetails {
  if (!isRecord(value)) return false;
  return (
    typeof value.stopId === "string"
    && (typeof value.routeId === "string" || value.routeId === null)
    && (typeof value.sequenceOrder === "number" || value.sequenceOrder === null)
    && typeof value.status === "string"
    && typeof value.address === "string"
  );
}

export function isLockedStopError(value: unknown): value is LockedStopErrorPayload {
  return (
    isRecord(value)
    && value.code === STOP_LIFECYCLE_LOCKED_CODE
    && isLockedStopDetails(value.details)
  );
}

function statusLabel(status: string, language: "sv" | "en"): string {
  const normalized = status.trim().toLowerCase();
  const alias = STATUS_ALIASES[normalized];
  return alias
    ? STATUS_LABELS[language][alias]
    : language === "sv" ? "okänd status" : "unknown status";
}

/**
 * Returns a localized, actionable explanation only for the structured
 * lifecycle-lock response. Other dispatch errors must keep their existing
 * generic handling.
 */
export function formatLockedStopError(
  value: unknown,
  language: string,
): string | null {
  if (!isLockedStopError(value)) return null;

  const locale = language.toLowerCase().startsWith("sv") ? "sv" : "en";
  const { details } = value;
  const address = details.address.trim();
  const label = address || details.stopId;
  const position = details.sequenceOrder == null
    ? locale === "sv" ? "utan positionsnummer" : "no position number"
    : String(details.sequenceOrder);
  const status = statusLabel(details.status, locale);

  if (locale === "sv") {
    return `Det låsta stoppet "${label}" (position ${position}, status ${status}) kan inte flyttas. Flytten skulle ändra det här stoppets rutt eller position. Endast väntande stopp kan flyttas utan att förskjuta låsta stopp.`;
  }
  return `The locked stop "${label}" (position ${position}, status ${status}) cannot be moved. This move would change this stop's route or position. Only pending stops can be moved without shifting locked stops.`;
}