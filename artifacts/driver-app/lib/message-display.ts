/**
 * Pure helpers for the driver chat screen. No React Native imports so the
 * rules can be tested with node:test.
 */
export type DeliveryState = "sending" | "saved" | "queued" | "failed" | "read";

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  sending: "Skickar",
  saved: "Sparat i systemet",
  queued: "Väntar på anslutning",
  failed: "Kunde inte skickas – försök igen",
  read: "Läst",
};

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueIdentifier(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return !v || UUID_LIKE.test(v) || /^(user|usr|driver)[_-][0-9a-z_-]{6,}$/i.test(v);
}

export function roleLabel(role: string | null | undefined): string {
  if (role === "driver") return "Chaufför";
  if (role === "dispatcher" || role === "admin" || role === "owner" || role === "planner") return "Trafikledning";
  return "Okänd avsändare";
}

export function senderLabel(input: { own: boolean; name?: string | null; role?: string | null }): string {
  if (input.own) return "Du";
  if (input.name && !isOpaqueIdentifier(input.name)) return input.name.trim();
  return roleLabel(input.role);
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/** Stockholm wall-clock parts; falls back to CET/CEST rules if Intl time zones are unavailable. */
function stockholmParts(date: Date): { y: number; m: number; d: number; h: number; min: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Stockholm", year: "numeric", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const out = { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
    if (Object.values(out).every((v) => Number.isFinite(v))) return out;
  } catch {
    // fall through
  }
  const y = date.getUTCFullYear();
  const lastSunday = (month: number) => {
    const d = new Date(Date.UTC(y, month + 1, 0, 1));
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  };
  const dst = date.getTime() >= lastSunday(2) && date.getTime() < lastSunday(9);
  const local = new Date(date.getTime() + (dst ? 2 : 1) * 3_600_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), h: local.getUTCHours(), min: local.getUTCMinutes() };
}

export function formatChatTime(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const p = stockholmParts(date);
  const n = stockholmParts(now);
  const time = `${pad(p.h)}:${pad(p.min)}`;
  if (p.y === n.y && p.m === n.m && p.d === n.d) return time;
  return `${p.d} ${MONTHS[p.m - 1]} ${time}`;
}

export function readByCounterpart(receipts: Array<{ userId: string; readAt: string }> | null | undefined, ownUserId: string): boolean {
  return Boolean(receipts?.some((r) => r.userId && r.userId !== ownUserId && r.readAt));
}

/** Route messages have no read receipts: never "read". */
export function serverDeliveryState(isStop: boolean, receipts: Array<{ userId: string; readAt: string }> | null | undefined, ownUserId: string): DeliveryState {
  return isStop && readByCounterpart(receipts, ownUserId) ? "read" : "saved";
}

/** Isolates drafts, pending sends and cache by actor + route + stop. */
export function messageScopeKey(actorId: string | null | undefined, routeId: string, stopId: string | null | undefined): string {
  return `${actorId ?? "anon"}|${routeId}|${stopId ?? "route"}`;
}

/**
 * Only real connection failures go to the durable offline queue. Authorization,
 * validation, conflict and session errors must surface to the driver instead.
 */
export function shouldQueueSendFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 0 || status === 502 || status === 503 || status === 504;
  const message = error instanceof Error ? error.message : "";
  return /NETWORK_ERROR|Network request failed|Failed to fetch/i.test(message);
}

export interface LocalPending {
  scopeKey: string;
  clientMessageId: string;
  body: string;
  createdAt: string;
  status: "sending" | "failed";
  error?: string;
}

export function pendingForScope(pending: LocalPending[], scopeKey: string, serverClientIds: Iterable<string | null | undefined>): LocalPending[] {
  const ids = new Set<string>();
  for (const id of serverClientIds) if (id) ids.add(id);
  return pending.filter((p) => p.scopeKey === scopeKey && !ids.has(p.clientMessageId));
}

export interface QueuedLike {
  routeId: string;
  stopId?: string;
  clientMessageId: string;
  syncStatus?: string;
}

/** Durable queue items for exactly this route+stop scope, minus those the server already has. */
export function queuedForScope<T extends QueuedLike>(queue: T[], routeId: string, stopId: string | null | undefined, serverClientIds: Iterable<string | null | undefined>): T[] {
  const ids = new Set<string>();
  for (const id of serverClientIds) if (id) ids.add(id);
  return queue.filter((q) => q.routeId === routeId && (q.stopId ?? null) === (stopId ?? null) && !ids.has(q.clientMessageId));
}

export function queuedDeliveryState(syncStatus: string | undefined): DeliveryState {
  if (syncStatus === "failed" || syncStatus === "conflict") return "failed";
  if (syncStatus === "synced") return "saved";
  return "queued";
}

/** Same durable-queue owner (user + organization). Null never matches. */
export function sameOfflineQueueOwner(
  a: { userId: string; organizationId: string } | null | undefined,
  b: { userId: string; organizationId: string } | null | undefined,
): boolean {
  return !!a && !!b && a.userId === b.userId && a.organizationId === b.organizationId;
}
