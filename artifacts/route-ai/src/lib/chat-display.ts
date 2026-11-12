/**
 * Pure helpers for the planner chat (route + stop threads). Kept free of React
 * so the truthfulness rules (sender labels, delivery states, read receipts)
 * can be regression-tested with node:test.
 */

export type ChatScope = "route" | "stop";

/** Truthful delivery states. "read" only exists for stop messages with an actual receipt. */
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

/** Real name when known, otherwise the role. Never a raw id. */
export function senderLabel(input: { own: boolean; name?: string | null; role?: string | null }): string {
  if (input.own) return "Du";
  if (input.name && !isOpaqueIdentifier(input.name)) return input.name.trim();
  return roleLabel(input.role);
}

const STOCKHOLM = "Europe/Stockholm";

function stockholmDayKey(date: Date): string {
  return date.toLocaleDateString("sv-SE", { timeZone: STOCKHOLM });
}

/** Swedish time (Europe/Stockholm). Same-day messages show only HH:MM. */
export function formatChatTime(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = date.toLocaleTimeString("sv-SE", { timeZone: STOCKHOLM, hour: "2-digit", minute: "2-digit" });
  if (stockholmDayKey(date) === stockholmDayKey(now)) return time;
  const day = date.toLocaleDateString("sv-SE", { timeZone: STOCKHOLM, day: "numeric", month: "short" });
  return `${day} ${time}`;
}

export interface ReadReceipt { userId: string; readAt: string }

/** Only an actual receipt by someone other than the sender counts as "Läst". */
export function readByCounterpart(receipts: ReadReceipt[] | null | undefined, ownUserId: string): boolean {
  return Boolean(receipts?.some((r) => r.userId && r.userId !== ownUserId && r.readAt));
}

/** Delivery state for an own message already stored on the server. */
export function serverDeliveryState(scope: ChatScope, receipts: ReadReceipt[] | null | undefined, ownUserId: string): DeliveryState {
  if (scope === "stop" && readByCounterpart(receipts, ownUserId)) return "read";
  return "saved";
}

export interface PendingChatMessage {
  /** "route:<id>" or "stop:<id>" — pending evidence is never shown in another scope. */
  scopeKey: string;
  clientMessageId: string;
  body: string;
  createdAt: string;
  status: "sending" | "saved" | "failed";
  error?: string;
}

export function scopeKeyFor(scope: ChatScope, id: string): string {
  return `${scope}:${id}`;
}

/**
 * Pending items for the visible scope that the server list does not contain yet.
 * Items for other scopes stay in state (not discarded) but are not rendered here.
 */
export function visiblePending(
  pending: PendingChatMessage[],
  scopeKey: string,
  serverClientIds: Iterable<string | null | undefined>,
): PendingChatMessage[] {
  const ids = new Set<string>();
  for (const id of serverClientIds) if (id) ids.add(id);
  return pending.filter((p) => p.scopeKey === scopeKey && !ids.has(p.clientMessageId));
}

/** Drops pending entries confirmed by the server for that scope (keeps all others). */
export function prunePending(
  pending: PendingChatMessage[],
  scopeKey: string,
  serverClientIds: Iterable<string | null | undefined>,
): PendingChatMessage[] {
  const ids = new Set<string>();
  for (const id of serverClientIds) if (id) ids.add(id);
  const next = pending.filter((p) => p.scopeKey !== scopeKey || !ids.has(p.clientMessageId));
  return next.length === pending.length ? pending : next;
}

export function upsertPending(pending: PendingChatMessage[], item: PendingChatMessage): PendingChatMessage[] {
  return [...pending.filter((p) => p.clientMessageId !== item.clientMessageId), item];
}

export function patchPending(
  pending: PendingChatMessage[],
  clientMessageId: string,
  patch: Partial<PendingChatMessage>,
): PendingChatMessage[] {
  return pending.map((p) => (p.clientMessageId === clientMessageId ? { ...p, ...patch } : p));
}

/**
 * Incoming stop messages to mark read. A thread that is mounted but not visible
 * (e.g. "Hela rutten" tab active) must never send read receipts.
 */
export function unreadIdsToMark(
  messages: Array<{ id: string; senderUserId: string; readAt?: string | null; readReceipts?: ReadReceipt[] }>,
  viewerId: string,
  alreadyMarked: Set<string>,
  visible: boolean,
): string[] {
  if (!visible) return [];
  return messages
    .filter((m) => m.senderUserId !== viewerId && !m.readAt
      && !m.readReceipts?.some((r) => r.userId === viewerId) && !alreadyMarked.has(m.id))
    .map((m) => m.id);
}

/** Show a human route name, never a raw id. */
export function routeDisplayName(name: string | null | undefined): string | undefined {
  return name && !isOpaqueIdentifier(name) ? name.trim() : undefined;
}
