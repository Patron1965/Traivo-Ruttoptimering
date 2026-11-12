export type LegacyQueueType =
  | "status"
  | "proof"
  | "serviceReport"
  | "exception"
  | "routeMessage";

export type LegacyQuarantineState = "unresolved" | "reclaimed" | "denied";

export interface LegacyQueueSource {
  queueType: LegacyQueueType;
  sourceKey: string;
  items: unknown[];
}

export interface LegacyQuarantineItem {
  quarantineId: string;
  queueType: LegacyQueueType | "unknown";
  sourceKey: string;
  sourceIndex: number;
  item: Record<string, unknown> | null;
  rawError?: string;
  stopId?: string;
  routeId?: string;
  clientEventId?: string;
  clientMessageId?: string;
  planVersion?: number;
  timestamp?: number;
  state: LegacyQuarantineState;
  reason?: string;
  firstSeenAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function collectLegacyQueueItems(
  sources: LegacyQueueSource[],
  firstSeenAt = new Date().toISOString(),
): LegacyQuarantineItem[] {
  const records: LegacyQuarantineItem[] = [];
  for (const source of sources) {
    source.items.forEach((raw, sourceIndex) => {
      const item = asRecord(raw);
      const itemId = item ? stringValue(item.id) : undefined;
      const quarantineId = `${source.queueType}:${itemId ?? `${source.sourceKey}:${sourceIndex}`}`;
      records.push({
        quarantineId,
        queueType: source.queueType,
        sourceKey: source.sourceKey,
        sourceIndex,
        item,
        rawError: item ? undefined : "Legacy queue entry is not an object.",
        stopId: item ? stringValue(item.stopId) : undefined,
        routeId: item ? stringValue(item.routeId) : undefined,
        clientEventId: item ? stringValue(item.clientEventId) : undefined,
        clientMessageId: item ? stringValue(item.clientMessageId) : undefined,
        planVersion: item ? numberValue(item.planVersion) : undefined,
        timestamp: item ? numberValue(item.timestamp) : undefined,
        state: "unresolved",
        firstSeenAt,
      });
    });
  }
  return records;
}

/**
 * Recovery exports intentionally contain identifiers and replay metadata only.
 * They never include auth tokens, comments, message bodies, reports, or media.
 */
export function safeLegacyRecoveryMetadata(item: LegacyQuarantineItem) {
  return {
    quarantineId: item.quarantineId,
    queueType: item.queueType,
    sourceKey: item.sourceKey,
    sourceIndex: item.sourceIndex,
    stopId: item.stopId ?? null,
    routeId: item.routeId ?? null,
    clientEventId: item.clientEventId ?? null,
    clientMessageId: item.clientMessageId ?? null,
    planVersion: item.planVersion ?? null,
    timestamp: item.timestamp ?? null,
    state: item.state,
    reason: item.reason ?? null,
  };
}