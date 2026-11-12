// Pure helpers for the customer portal. No imports so node tests can run directly.

export type PortalStatus =
  | "scheduled" | "started" | "on_the_way" | "completed" | "failed"
  | "skipped" | "cancelled" | "paused" | "unavailable";

export type StatusTone = "calm" | "moving" | "done" | "problem" | "muted";

const STATUS: Record<PortalStatus, { label: string; sentence: string; tone: StatusTone }> = {
  scheduled: { label: "Planerad", sentence: "Leveransen är planerad.", tone: "calm" },
  started: { label: "Rutten har startat", sentence: "Föraren har påbörjat dagens rutt.", tone: "moving" },
  on_the_way: { label: "På väg", sentence: "Föraren är på väg till dig.", tone: "moving" },
  completed: { label: "Levererad", sentence: "Leveransen är genomförd.", tone: "done" },
  failed: { label: "Kunde inte levereras", sentence: "Leveransen kunde inte genomföras.", tone: "problem" },
  skipped: { label: "Hoppades över", sentence: "Leveransen hoppades över vid det här tillfället.", tone: "problem" },
  cancelled: { label: "Avbokad", sentence: "Leveransen är avbokad.", tone: "muted" },
  paused: { label: "Pausad", sentence: "Leveransen är tillfälligt pausad.", tone: "muted" },
  unavailable: { label: "Status saknas", sentence: "Status kan inte visas just nu.", tone: "muted" },
};

export function portalStatus(status: string) {
  return STATUS[status as PortalStatus] ?? STATUS.unavailable;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "skipped", "cancelled"]);

/** Only highlight the current stage; do not invent a timestamped event history. */
export function portalDeliveryStage(status: string): number | null {
  if (status === "scheduled" || status === "started") return 0;
  if (status === "on_the_way") return 1;
  if (status === "completed") return 2;
  return null;
}

const TRACKING: Record<string, string> = {
  live: "Fordonets position visas på kartan.",
  stale: "Fordonets position är inte längre aktuell och visas inte.",
  waiting: "Väntar på att fordonet ska börja köra mot dig.",
  inactive: "Fordonets position visas inte just nu.",
  completed: "Leveransen är avslutad. Ingen position visas.",
  unavailable: "Fordonets position är inte tillgänglig.",
  offline: "Du är offline. Ingen position visas.",
  missing: "Fordonets position saknas just nu.",
  not_next: "Föraren har andra leveranser före din. Positionen visas när det är din tur.",
};
export function trackingText(state: string) {
  return TRACKING[state] ?? TRACKING.unavailable;
}

const TZ = "Europe/Stockholm";

/** Formats a date-only (YYYY-MM-DD) or ISO value as a Swedish date. */
export function formatPortalDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(dateOnly ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long", timeZone: dateOnly ? "UTC" : TZ }).format(ms);
}

export function formatPortalTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const clock = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (clock) return `${clock[1]}:${clock[2]}`;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(ms);
}

export function formatPortalDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(ms);
}

export function formatWindow(start: string | null | undefined, end: string | null | undefined): string | null {
  const a = formatPortalTime(start), b = formatPortalTime(end);
  if (a && b) return `${a}–${b}`;
  if (a) return `från ${a}`;
  if (b) return `senast ${b}`;
  return null;
}

/** Reads `#token=...` from a URL fragment. Returns null for anything else. */
export function tokenFromFragment(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get("token");
  return token && /^[A-Za-z0-9_\-.~]{32,128}$/.test(token) ? token : null;
}

export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/[^\d+]/g, "");
  const normalized = digits.startsWith("+") ? "+" + digits.slice(1).replace(/\+/g, "") : digits.replace(/\+/g, "");
  return normalized.replace("+", "").length >= 5 ? `tel:${normalized}` : null;
}

export function isPortalAuthStatus(status: number | undefined) {
  return status === 401 || status === 403;
}

export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < 12) return "Lösenordet behöver minst 12 tecken.";
  if (password.length > 256) return "Lösenordet får vara högst 256 tecken.";
  if (password !== confirm) return "Lösenorden matchar inte.";
  return null;
}
