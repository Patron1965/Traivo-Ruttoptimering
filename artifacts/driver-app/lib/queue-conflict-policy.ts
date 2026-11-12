/** No retry may rewrite an event ID, timestamp, owner or plan version. */
export function queueFailureStatus(status: number | undefined, category: string): "failed" | "conflict" {
  if (category === "unauthorized" || status === 401) return "failed";
  if (category === "conflict" || (status !== undefined && status >= 400 && status < 500 && ![408, 429].includes(status))) return "conflict";
  return "failed";
}

export interface QueueReference {
  id: string;
  queueType: string;
  stopId?: string;
  syncStatus?: string;
}

export function conflictStopItems<T extends QueueReference>(items: T[], conflict: QueueReference): T[] {
  if (!conflict.stopId) return [];
  return items.filter(item => item.stopId === conflict.stopId && item.syncStatus !== "synced");
}

export function queueReferenceKey(item: QueueReference): string {
  return `${item.queueType}:${item.id}`;
}

export function assertConflictSelection(current: QueueReference[], selected: QueueReference[]) {
  const conflict = selected.find(item => item.syncStatus === "conflict");
  if (!conflict?.stopId || selected.some(item => item.stopId !== conflict.stopId)) throw new Error("OFFLINE_QUEUE_ERROR");
  const actual = conflictStopItems(current, conflict);
  const expected = new Map(selected.map(item => [queueReferenceKey(item), item.syncStatus]));
  if (actual.length !== expected.size || !actual.some(item => item.syncStatus === "conflict") ||
      actual.some(item => item.syncStatus === "syncing" || expected.get(queueReferenceKey(item)) !== item.syncStatus)) {
    throw new Error("OFFLINE_QUEUE_ERROR");
  }
}
