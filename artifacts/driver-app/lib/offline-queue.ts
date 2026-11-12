import AsyncStorage from "./durable-storage";
import { PutServiceReportPayload } from "./api";
import {
  migrateLegacyExecutionQueues,
  type LegacyPlanVersionResolver,
  type LegacyQueuedMutation,
  type LegacyQueuedProof,
  type LegacyQueuedServiceReport,
} from "./offline-queue-migration";
import { offlineQueueKey, shouldRecoverSyncLease } from "./mobile-invariants";
import type { StopReport } from "./stop-report";
import { assertConflictSelection, queueReferenceKey } from "./queue-conflict-policy";
import { sameOfflineQueueOwner } from "./message-display";
export { sameOfflineQueueOwner };
import {
  collectLegacyQueueItems,
  type LegacyQuarantineItem,
  type LegacyQueueSource,
  type LegacyQueueType,
} from "./offline-quarantine";

const QUEUE_KEY = "routeai_offline_queue";
const CACHE_KEY = "routeai_cache";
const POD_QUEUE_KEY = "routeai_pod_queue";
const SR_QUEUE_KEY = "routeai_sr_queue";
const EXCEPTION_QUEUE_KEY = "routeai_exception_queue";
const MESSAGE_QUEUE_KEY = "routeai_message_queue";
const STOP_REPORT_QUEUE_KEY = "routeai_stop_report_queue";
const CONFLICT_ARCHIVE_KEY = "routeai_conflict_archive_v1";
const queueTypesByKey: Record<string, string> = {
  [QUEUE_KEY]: "status", [POD_QUEUE_KEY]: "proof", [SR_QUEUE_KEY]: "serviceReport",
  [EXCEPTION_QUEUE_KEY]: "exception", [MESSAGE_QUEUE_KEY]: "routeMessage",
  [STOP_REPORT_QUEUE_KEY]: "stopReport",
};
const LEGACY_QUARANTINE_KEY = "routeai_legacy_queue_quarantine_v1";
const LEGACY_QUEUE_SOURCES: Array<{ queueType: LegacyQueueType; sourceKey: string }> = [
  { queueType: "status", sourceKey: QUEUE_KEY },
  { queueType: "proof", sourceKey: POD_QUEUE_KEY },
  { queueType: "serviceReport", sourceKey: SR_QUEUE_KEY },
  { queueType: "exception", sourceKey: EXCEPTION_QUEUE_KEY },
  { queueType: "routeMessage", sourceKey: MESSAGE_QUEUE_KEY },
];

export interface OfflineQueueScope {
  userId: string;
  organizationId: string;
}

let currentScope: OfflineQueueScope | null = null;
let syncLeases = 0;
let resolveSyncIdle: (() => void) | null = null;
let scopeChangePending = false;
let offlineCacheExpiresAt: number | null = null;
let queueMaintenance: Promise<void> | null = null;

export function setOfflineCacheExpiry(expiresAt: number | null) {
  offlineCacheExpiresAt = expiresAt;
}

export function setOfflineQueueScope(scope: OfflineQueueScope | null) {
  if (!scope) offlineCacheExpiresAt = null;
  currentScope = scope;
  scopeChangePending = false;
  if (syncLeases === 0) {
    resolveSyncIdle?.();
    resolveSyncIdle = null;
  }
}

export function getOfflineQueueScope(): OfflineQueueScope | null {
  return currentScope;
}

export async function pauseOfflineQueueForScopeChange() {
  scopeChangePending = true;
  if (syncLeases > 0) {
    await new Promise<void>((resolve) => {
      resolveSyncIdle = resolve;
    });
  }
}

export async function acquireOfflineSyncLease() {
  while (queueMaintenance) await queueMaintenance;
  while (scopeChangePending) {
    await new Promise<void>((resolve) => {
      const previous = resolveSyncIdle;
      resolveSyncIdle = () => {
        previous?.();
        resolve();
      };
    });
  }
  syncLeases += 1;
  return () => {
    syncLeases = Math.max(0, syncLeases - 1);
    if (syncLeases === 0) {
      resolveSyncIdle?.();
      resolveSyncIdle = null;
    }
  };
}

function scopedKey(baseKey: string): string {
  if (offlineCacheExpiresAt !== null && Date.now() >= offlineCacheExpiresAt) {
    throw new Error("Offline access expired; reconnect to verify the session.");
  }
  if (!currentScope) {
    throw new Error("Offline queue scope is unavailable; authenticate before reading or writing queued data.");
  }
  return offlineQueueKey(baseKey, currentScope);
}

export type OfflineItemStatus = "pending" | "syncing" | "synced" | "conflict" | "failed";

export type QueuedStopReport = StopReport & {
  timestamp: number;
  syncStatus: OfflineItemStatus;
  attempts?: number;
  lastError?: string;
  syncedAt?: string;
  syncStartedAt?: string;
};

export const getStopReportQueue = () => readQueue<QueuedStopReport>(STOP_REPORT_QUEUE_KEY);

export async function readReportDraft<T>(identity: string): Promise<T | null> {
  const key = scopedKey(`routeai_report_draft_${identity}`);
  const raw = await AsyncStorage.getItem(key);
  if (key !== scopedKey(`routeai_report_draft_${identity}`)) throw new Error("OFFLINE_QUEUE_ERROR");
  return raw ? JSON.parse(raw) as T : null;
}

export async function writeReportDraft(identity: string, value: unknown, owner = getOfflineQueueScope()) {
  const key = scopedKey(`routeai_report_draft_${identity}`);
  if (!owner || key !== offlineQueueKey(`routeai_report_draft_${identity}`, owner)) throw new Error("OFFLINE_QUEUE_ERROR");
  await AsyncStorage.setItem(key, JSON.stringify(value));
  if (key !== scopedKey(`routeai_report_draft_${identity}`)) throw new Error("OFFLINE_QUEUE_ERROR");
}

export async function clearReportDraft(identity: string) {
  await AsyncStorage.removeItem(scopedKey(`routeai_report_draft_${identity}`));
}

let reportWrite: Promise<unknown> = Promise.resolve();
export async function enqueueStopReport(report: StopReport): Promise<void> {
  const key = scopedKey(STOP_REPORT_QUEUE_KEY);
  const run = reportWrite.catch(() => {}).then(async () => {
    if (key !== scopedKey(STOP_REPORT_QUEUE_KEY)) throw new Error("OFFLINE_QUEUE_ERROR");
    const queue = await getStopReportQueue();
    if (key !== scopedKey(STOP_REPORT_QUEUE_KEY)) throw new Error("OFFLINE_QUEUE_ERROR");
    if (!queue.some((item) => item.id === report.id)) {
      queue.push({ ...report, timestamp: Date.parse(report.occurredAt), syncStatus: "pending", attempts: 0 });
      // A single durable write contains all media plus its dependent outcome.
      await AsyncStorage.setItem(key, JSON.stringify(queue));
    }
  });
  reportWrite = run;
  await run;
}

export interface QueuedMutation {
  id: string;
  type: "updateStopStatus";
  stopId: string;
  routeId?: string;
  status: string;
  timestamp: number;
  planVersion: number;
  skipReason?: string;
  comment?: string;
  actualDurationMin?: number;
  syncStatus?: OfflineItemStatus;
  lastError?: string;
  attempts?: number;
  syncedAt?: string;
  syncStartedAt?: string;
}

export interface QueuedProof {
  id: string;
  stopId: string;
  proofType: "photo" | "signature" | "barcode";
  proofStage: "pickup" | "delivery";
  data: string;
  notes?: string;
  timestamp: number;
  clientEventId: string;
  planVersion: number;
  occurredAt: string;
  syncStatus?: OfflineItemStatus;
  lastError?: string;
  attempts?: number;
  syncedAt?: string;
  syncStartedAt?: string;
}

export interface QueuedServiceReport {
  id: string;
  stopId: string;
  report: PutServiceReportPayload;
  proofs?: { type: "photo" | "signature"; data: string; notes?: string; clientEventId: string; planVersion: number; occurredAt: string }[];
  timestamp: number;
  syncStatus?: OfflineItemStatus;
  lastError?: string;
  attempts?: number;
  syncedAt?: string;
  syncStartedAt?: string;
}

export interface QueuedException {
  id: string;
  stopId: string;
  category: string;
  comment: string;
  photoData: string;
  proofStage: "pickup" | "delivery";
  clientEventId: string;
  planVersion: number;
  occurredAt: string;
  timestamp: number;
  syncStatus?: OfflineItemStatus;
  lastError?: string;
  attempts?: number;
  syncedAt?: string;
  syncStartedAt?: string;
}

export interface QueuedRouteMessage {
  id: string;
  routeId: string;
  stopId?: string;
  body: string;
  clientMessageId: string;
  timestamp: number;
  occurredAt: string;
  syncStatus?: OfflineItemStatus;
  lastError?: string;
  attempts?: number;
  syncedAt?: string;
  syncStartedAt?: string;
}

export async function enqueueStopStatusUpdate(
  stopId: string,
  status: string,
  planVersion = 0,
  details: { routeId?: string; skipReason?: string; comment?: string; actualDurationMin?: number } = {},
): Promise<void> {
  const queue = await getQueue();
  const entry: QueuedMutation = {
    id: `${stopId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "updateStopStatus",
    stopId,
    status,
    timestamp: Date.now(),
    planVersion,
    ...details,
    syncStatus: "pending",
    attempts: 0,
  };
  queue.push(entry);
  await AsyncStorage.setItem(scopedKey(QUEUE_KEY), JSON.stringify(queue));
}

export type OrderedExecutionItem =
  | ({ queueType: "stopReport" } & QueuedStopReport)
  | ({ queueType: "status" } & QueuedMutation)
  | ({ queueType: "proof" } & QueuedProof)
  | ({ queueType: "exception" } & QueuedException);

async function readQueue<T>(baseKey: string): Promise<T[]> {
  try {
    const key = scopedKey(baseKey);
    const raw = await AsyncStorage.getItem(key);
    if (key !== scopedKey(baseKey)) throw new Error("OFFLINE_QUEUE_ERROR");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Offline queue data is invalid for ${baseKey}; refusing to discard queued media.`);
    }
    if (!queueTypesByKey[baseKey]) return parsed;
    const archive = await getConflictArchive();
    if (key !== scopedKey(baseKey)) throw new Error("OFFLINE_QUEUE_ERROR");
    const archived = new Set(archive.map(entry => queueReferenceKey(entry.item)));
    return parsed.filter(item => !archived.has(`${queueTypesByKey[baseKey]}:${item.id}`));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Offline queue data is unreadable for ${baseKey}; refusing to discard queued media.`);
    }
    throw error;
  }
}

async function readLegacyQuarantine(): Promise<LegacyQuarantineItem[]> {
  const raw = await AsyncStorage.getItem(LEGACY_QUARANTINE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Legacy offline queue quarantine is unreadable; refusing to discard old media.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Legacy offline queue quarantine is invalid; refusing to discard old media.");
  }
  return parsed as LegacyQuarantineItem[];
}

export async function scanLegacyOfflineQueues(): Promise<LegacyQuarantineItem[]> {
  const [quarantine, ...sources] = await Promise.all([
    readLegacyQuarantine(),
    ...LEGACY_QUEUE_SOURCES.map(async (source) => ({
      ...source,
      raw: await AsyncStorage.getItem(source.sourceKey),
    })),
  ]);
  const detected: LegacyQuarantineItem[] = [];
  for (const source of sources) {
    if (!source.raw) continue;
    try {
      const parsed = JSON.parse(source.raw);
      if (!Array.isArray(parsed)) {
        detected.push({
          quarantineId: `malformed:${source.sourceKey}`,
          queueType: "unknown",
          sourceKey: source.sourceKey,
          sourceIndex: -1,
          item: null,
          rawError: "Legacy queue value was not an array.",
          state: "unresolved",
          firstSeenAt: new Date().toISOString(),
        });
        continue;
      }
      detected.push(...collectLegacyQueueItems([{
        queueType: source.queueType,
        sourceKey: source.sourceKey,
        items: parsed,
      }]));
    } catch {
      detected.push({
        quarantineId: `malformed:${source.sourceKey}`,
        queueType: "unknown",
        sourceKey: source.sourceKey,
        sourceIndex: -1,
        item: null,
        rawError: "Legacy queue value could not be parsed.",
        state: "unresolved",
        firstSeenAt: new Date().toISOString(),
      });
    }
  }
  const byId = new Map(quarantine.map((item) => [item.quarantineId, item]));
  let changed = false;
  for (const item of detected) {
    if (!byId.has(item.quarantineId)) {
      byId.set(item.quarantineId, item);
      changed = true;
    }
  }
  const merged = [...byId.values()];
  if (changed) {
    await AsyncStorage.setItem(LEGACY_QUARANTINE_KEY, JSON.stringify(merged));
  }
  return merged;
}

export async function markLegacyQuarantineItem(
  quarantineId: string,
  state: "reclaimed" | "denied",
  reason?: string,
) {
  const items = await readLegacyQuarantine();
  const next = items.map((item) =>
    item.quarantineId === quarantineId
      ? { ...item, state, ...(reason ? { reason } : {}) }
      : item,
  );
  await AsyncStorage.setItem(LEGACY_QUARANTINE_KEY, JSON.stringify(next));
  return next.find((item) => item.quarantineId === quarantineId) ?? null;
}

async function appendReclaimedQueueItem(baseKey: string, item: Record<string, unknown>) {
  const queue = await readQueue<Record<string, unknown>>(baseKey);
  if (!item.id || !queue.some((candidate) => candidate.id === item.id)) {
    queue.push({
      ...item,
      syncStatus: "pending",
      attempts: 0,
      syncedAt: undefined,
      syncStartedAt: undefined,
    });
    await AsyncStorage.setItem(scopedKey(baseKey), JSON.stringify(queue));
  }
}

export async function reclaimLegacyQueueItem(quarantineId: string) {
  scopedKey(QUEUE_KEY);
  const items = await readLegacyQuarantine();
  const record = items.find((item) => item.quarantineId === quarantineId);
  if (!record) throw new Error("Legacy queue item was not found.");
  if (record.state !== "unresolved") throw new Error("Legacy queue item has already been reviewed.");
  if (!record.item || record.queueType === "unknown") {
    throw new Error(record.rawError ?? "Legacy queue item is invalid.");
  }
  const item = record.item;
  if (!item.id) throw new Error("Legacy queue item has no stable id.");
  if (!record.stopId || item.stopId !== record.stopId) {
    throw new Error("Legacy item is not linked to an authorized stop.");
  }
  if (item.syncStatus === "synced") throw new Error("This legacy item was already marked synced and will not be replayed.");
  if (["status", "proof", "exception"].includes(record.queueType) && !Number.isInteger(item.planVersion)) {
    throw new Error("Legacy item has no accepted planVersion; it cannot be rebased or replayed.");
  }
  if (record.queueType === "status") {
    await appendReclaimedQueueItem(QUEUE_KEY, item);
  } else if (record.queueType === "proof") {
    if (typeof item.clientEventId !== "string") throw new Error("Legacy proof has no clientEventId.");
    await appendReclaimedQueueItem(POD_QUEUE_KEY, item);
  } else if (record.queueType === "serviceReport") {
    const proofs = Array.isArray(item.proofs) ? item.proofs : [];
    if (proofs.some((proof) => !proof || typeof proof !== "object" || typeof (proof as Record<string, unknown>).clientEventId !== "string")) {
      throw new Error("Legacy service media has no stable clientEventId.");
    }
    await appendReclaimedQueueItem(SR_QUEUE_KEY, item);
  } else if (record.queueType === "exception") {
    if (typeof item.clientEventId !== "string" || typeof item.photoData !== "string" || !item.photoData) {
      throw new Error("Legacy exception is missing its required photo or clientEventId.");
    }
    await appendReclaimedQueueItem(EXCEPTION_QUEUE_KEY, item);
  } else if (record.queueType === "routeMessage") {
    if (typeof item.stopId !== "string" || typeof item.clientMessageId !== "string") {
      throw new Error("Only stop-linked legacy messages with a stable clientMessageId can be reclaimed.");
    }
    await appendReclaimedQueueItem(MESSAGE_QUEUE_KEY, item);
  } else {
    throw new Error("This legacy queue type cannot be reclaimed.");
  }
  await markLegacyQuarantineItem(quarantineId, "reclaimed");
  return record;
}

export async function migrateOfflineQueues(
  resolveCurrentPlanVersion: LegacyPlanVersionResolver,
): Promise<void> {
  const [statuses, proofs, serviceReports] = await Promise.all([
    readQueue<LegacyQueuedMutation>(QUEUE_KEY),
    readQueue<LegacyQueuedProof>(POD_QUEUE_KEY),
    readQueue<LegacyQueuedServiceReport>(SR_QUEUE_KEY),
  ]);
  const migrated = await migrateLegacyExecutionQueues(
    { statuses, proofs, serviceReports },
    resolveCurrentPlanVersion,
  );
  await Promise.all([
    AsyncStorage.setItem(scopedKey(QUEUE_KEY), JSON.stringify(migrated.statuses)),
    AsyncStorage.setItem(scopedKey(POD_QUEUE_KEY), JSON.stringify(migrated.proofs)),
    AsyncStorage.setItem(scopedKey(SR_QUEUE_KEY), JSON.stringify(migrated.serviceReports)),
  ]);
}

export async function getOrderedExecutionQueue(): Promise<OrderedExecutionItem[]> {
  const [statuses, proofs] = await Promise.all([getQueue(), getProofQueue()]);
  return [
    ...(await getStopReportQueue())
      .filter(item => item.syncStatus !== "synced")
      .map(item => ({ ...item, queueType: "stopReport" as const })),
    ...statuses
      .filter((item) => item.syncStatus !== "synced")
      .map((item) => ({ ...item, queueType: "status" as const })),
    ...proofs
      .filter((item) => item.syncStatus !== "synced")
      .map((item) => ({ ...item, queueType: "proof" as const })),
    ...(await getExceptionQueue())
      .filter((item) => item.syncStatus !== "synced")
      .map((item) => ({ ...item, queueType: "exception" as const })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

export async function getQueue(): Promise<QueuedMutation[]> {
  return readQueue<QueuedMutation>(QUEUE_KEY);
}

export async function removeFromQueue(id: string): Promise<void> {
  await markQueueItemStatus("status", id, "synced");
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(scopedKey(QUEUE_KEY));
}

export async function enqueueProof(proof: Omit<QueuedProof, "id" | "timestamp" | "clientEventId" | "occurredAt"> & {
  clientEventId?: string;
  occurredAt?: string;
}): Promise<void> {
  const queue = await getProofQueue();
  const entry: QueuedProof = {
    ...proof,
    id: `${proof.stopId}_${proof.proofType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    clientEventId: proof.clientEventId ?? `${proof.stopId}_proof_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: proof.occurredAt ?? new Date().toISOString(),
    syncStatus: "pending",
    attempts: 0,
  };
  queue.push(entry);
  await AsyncStorage.setItem(scopedKey(POD_QUEUE_KEY), JSON.stringify(queue));
}

export async function getProofQueue(): Promise<QueuedProof[]> {
  return readQueue<QueuedProof>(POD_QUEUE_KEY);
}

export async function removeProofFromQueue(id: string): Promise<void> {
  await markQueueItemStatus("proof", id, "synced");
}

export async function enqueueServiceReport(
  stopId: string,
  report: PutServiceReportPayload,
  proofs?: { type: "photo" | "signature"; data: string; notes?: string; clientEventId: string; planVersion: number; occurredAt: string }[]
): Promise<void> {
  const queue = await getServiceReportQueue();
  const existingIndex = queue.findIndex((q) => q.stopId === stopId);
  const entry: QueuedServiceReport = {
    id: `${stopId}_report_${Date.now()}`,
    stopId,
    report,
    proofs,
    timestamp: Date.now(),
    syncStatus: "pending",
    attempts: 0,
  };
  if (existingIndex >= 0) {
    queue[existingIndex] = entry;
  } else {
    queue.push(entry);
  }
  await AsyncStorage.setItem(scopedKey(SR_QUEUE_KEY), JSON.stringify(queue));
}

export async function getServiceReportQueue(): Promise<QueuedServiceReport[]> {
  return readQueue<QueuedServiceReport>(SR_QUEUE_KEY);
}

export async function removeServiceReportFromQueue(id: string): Promise<void> {
  await markQueueItemStatus("serviceReport", id, "synced");
}

export async function updateQueuedServiceReport(
  id: string,
  report: PutServiceReportPayload,
  proofs: QueuedServiceReport["proofs"],
): Promise<void> {
  const queue = await getServiceReportQueue();
  const next = queue.map((item) =>
    item.id === id ? { ...item, report, proofs } : item,
  );
  await AsyncStorage.setItem(scopedKey(SR_QUEUE_KEY), JSON.stringify(next));
}

export async function enqueueException(
  item: Omit<QueuedException, "id" | "timestamp" | "syncStatus" | "attempts"> & {
    id?: string;
  },
) {
  const queue = await getExceptionQueue();
  const entry: QueuedException = {
    ...item,
    id: item.id ?? `${item.stopId}_exception_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    syncStatus: "pending",
    attempts: 0,
  };
  queue.push(entry);
  await AsyncStorage.setItem(scopedKey(EXCEPTION_QUEUE_KEY), JSON.stringify(queue));
}

export async function getExceptionQueue(): Promise<QueuedException[]> {
  return readQueue<QueuedException>(EXCEPTION_QUEUE_KEY);
}

export async function removeExceptionFromQueue(id: string) {
  await markQueueItemStatus("exception", id, "synced");
}

export async function enqueueRouteMessage(
  message: Omit<QueuedRouteMessage, "id" | "timestamp" | "syncStatus" | "attempts"> & { id?: string },
  expectedOwner?: OfflineQueueScope | null,
) {
  // Capture the storage key (and so the owner) before any await; re-check before writing so a
  // send started by one actor can never land in another actor's queue.
  if (expectedOwner !== undefined && !sameOfflineQueueOwner(expectedOwner, currentScope)) {
    throw new Error("OFFLINE_QUEUE_OWNER_CHANGED");
  }
  const key = scopedKey(MESSAGE_QUEUE_KEY);
  const raw = await AsyncStorage.getItem(key);
  if (key !== scopedKey(MESSAGE_QUEUE_KEY)
    || (expectedOwner !== undefined && !sameOfflineQueueOwner(expectedOwner, currentScope))) {
    throw new Error("OFFLINE_QUEUE_OWNER_CHANGED");
  }
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(parsed)) throw new Error("Offline queue data is invalid; refusing to overwrite queued messages.");
  const queue = parsed as QueuedRouteMessage[];
  if (queue.some((item) => item.clientMessageId === message.clientMessageId)) return;
  const entry: QueuedRouteMessage = {
    ...message,
    id: message.id ?? `${message.routeId}_message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    syncStatus: "pending",
    attempts: 0,
  };
  queue.push(entry);
  await AsyncStorage.setItem(key, JSON.stringify(queue));
}

export async function getRouteMessageQueue(): Promise<QueuedRouteMessage[]> {
  return readQueue<QueuedRouteMessage>(MESSAGE_QUEUE_KEY);
}

export async function removeRouteMessageFromQueue(id: string) {
  await markQueueItemStatus("routeMessage", id, "synced");
}

export type OfflineQueueItem =
  | ({ queueType: "stopReport" } & QueuedStopReport)
  | ({ queueType: "status" } & QueuedMutation)
  | ({ queueType: "proof" } & QueuedProof)
  | ({ queueType: "serviceReport" } & QueuedServiceReport)
  | ({ queueType: "exception" } & QueuedException)
  | ({ queueType: "routeMessage" } & QueuedRouteMessage);

export type ArchivedQueueItem = { archivedAt: string; reason: "user_review"; item: OfflineQueueItem };

export const getConflictArchive = () => readQueue<ArchivedQueueItem>(CONFLICT_ARCHIVE_KEY);

// Local resolution is exclusive with sync and account changes. It never sends
// work, rebases revisions or labels unacknowledged reports as synced.
async function withQueueMaintenance<T>(owner: OfflineQueueScope, action: () => Promise<T>): Promise<T> {
  if (queueMaintenance || scopeChangePending || syncLeases > 0 ||
      owner.userId !== currentScope?.userId || owner.organizationId !== currentScope?.organizationId) {
    throw new Error("OFFLINE_QUEUE_ERROR");
  }
  let finish!: () => void;
  queueMaintenance = new Promise<void>(resolve => { finish = resolve; });
  syncLeases += 1;
  try {
    return await action();
  } finally {
    syncLeases -= 1;
    queueMaintenance = null;
    finish();
    if (syncLeases === 0) {
      resolveSyncIdle?.();
      resolveSyncIdle = null;
    }
  }
}

export async function archiveStopConflicts(selected: OfflineQueueItem[], owner: OfflineQueueScope): Promise<void> {
  return archiveQueueSelection(selected, owner, false);
}

export async function archivePendingQueue(selected: OfflineQueueItem[], owner: OfflineQueueScope): Promise<void> {
  return archiveQueueSelection(selected, owner, true);
}

async function archiveQueueSelection(selected: OfflineQueueItem[], owner: OfflineQueueScope, allPending: boolean): Promise<void> {
  await withQueueMaintenance(owner, async () => {
    const key = scopedKey(CONFLICT_ARCHIVE_KEY);
    const current = await getOfflineQueueItems();
    if (allPending) {
      const pending = current.filter(item => item.syncStatus !== "synced");
      const reviewed = new Map(selected.map(item => [queueReferenceKey(item), JSON.stringify(item)]));
      if (!pending.length || pending.length !== reviewed.size ||
          pending.some(item => item.syncStatus === "syncing" || reviewed.get(queueReferenceKey(item)) !== JSON.stringify(item))) {
        throw new Error("OFFLINE_QUEUE_ERROR");
      }
    } else {
      assertConflictSelection(current, selected);
    }
    const selectedKeys = new Set(selected.map(queueReferenceKey));
    const archive = await getConflictArchive();
    const archivedAt = new Date().toISOString();
    // One durable write both retains original media/events and removes exactly
    // these items from replay. Failed storage writes leave the queue blocked.
    await AsyncStorage.setItem(key, JSON.stringify([
      ...archive,
      ...current.filter(item => selectedKeys.has(queueReferenceKey(item)))
        .map(item => ({ item, archivedAt, reason: "user_review" as const })),
    ]));
  });
}

export async function retryQueueConflict(selected: OfflineQueueItem, owner: OfflineQueueScope): Promise<void> {
  await withQueueMaintenance(owner, async () => {
    const item = (await getOfflineQueueItems()).find(item => queueReferenceKey(item) === queueReferenceKey(selected));
    if (!item || item.syncStatus !== "conflict") throw new Error("OFFLINE_QUEUE_ERROR");
    await markQueueItemStatus(item.queueType, item.id, "pending");
  });
}

export async function getOfflineQueueItems(): Promise<OfflineQueueItem[]> {
  const [statuses, proofs, reports, exceptions, messages, stopReports] = await Promise.all([
    getQueue(),
    getProofQueue(),
    getServiceReportQueue(),
    getExceptionQueue(),
    getRouteMessageQueue(),
    getStopReportQueue(),
  ]);
  return [
    ...stopReports.map((item) => ({ ...item, queueType: "stopReport" as const })),
    ...statuses.map((item) => ({ ...item, queueType: "status" as const })),
    ...proofs.map((item) => ({ ...item, queueType: "proof" as const })),
    ...reports.map((item) => ({ ...item, queueType: "serviceReport" as const })),
    ...exceptions.map((item) => ({ ...item, queueType: "exception" as const })),
    ...messages.map((item) => ({ ...item, queueType: "routeMessage" as const })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

export async function markQueueItemStatus(
  queueType: "status" | "proof" | "serviceReport" | "exception" | "routeMessage" | "stopReport",
  id: string,
  status: OfflineItemStatus,
  lastError?: string,
) {
  if (queueType === "stopReport") {
    const key = scopedKey(STOP_REPORT_QUEUE_KEY);
    const run = reportWrite.catch(() => {}).then(async () => {
      if (key !== scopedKey(STOP_REPORT_QUEUE_KEY)) throw new Error("OFFLINE_QUEUE_ERROR");
      const queue = await getStopReportQueue();
      if (key !== scopedKey(STOP_REPORT_QUEUE_KEY)) throw new Error("OFFLINE_QUEUE_ERROR");
      await AsyncStorage.setItem(key, JSON.stringify(queue.map(item => item.id !== id ? item : ({
        ...item, syncStatus: status,
        lastError: status === "synced" ? undefined : lastError,
        syncStartedAt: status === "syncing" ? new Date().toISOString() : undefined,
        syncedAt: status === "synced" ? new Date().toISOString() : item.syncedAt,
        attempts: status === "syncing" ? (item.attempts ?? 0) + 1 : item.attempts,
        // Acknowledged evidence is in private object storage; reclaim local quota.
        proofs: status === "synced" ? [] : item.proofs,
      }))));
    });
    reportWrite = run;
    await run;
    return;
  }
  const key =
    queueType === "status"
      ? QUEUE_KEY
      : queueType === "proof"
        ? POD_QUEUE_KEY
        : queueType === "serviceReport"
          ? SR_QUEUE_KEY
          : queueType === "exception"
            ? EXCEPTION_QUEUE_KEY
            : MESSAGE_QUEUE_KEY;
  const queue = await readQueue<Record<string, unknown>>(key);
  const next = queue.map((item) =>
    item.id === id
      ? {
          ...item,
          syncStatus: status,
          ...(lastError ? { lastError } : {}),
          ...(status === "synced"
            ? { syncedAt: new Date().toISOString(), syncStartedAt: undefined, lastError: undefined }
            : {}),
          ...(status === "syncing"
            ? { attempts: Number(item.attempts ?? 0) + 1, syncStartedAt: new Date().toISOString() }
            : {}),
        }
      : item,
  );
  await AsyncStorage.setItem(scopedKey(key), JSON.stringify(next));
}

export async function recoverStuckSyncingItems(maxAgeMs = 2 * 60 * 1000) {
  const now = Date.now();
  const items = await getOfflineQueueItems();
  for (const item of items) {
    if (item.syncStatus !== "syncing") continue;
    if (shouldRecoverSyncLease(item.syncStatus, item.syncStartedAt, now, maxAgeMs)) {
      await markQueueItemStatus(item.queueType, item.id, "pending", "generic");
    }
  }
}

export async function setCachedData(key: string, data: unknown): Promise<void> {
  try {
    const storageKey = scopedKey(CACHE_KEY);
    const raw = await AsyncStorage.getItem(storageKey);
    const cache = raw ? JSON.parse(raw) : {};
    cache[key] = { data, timestamp: Date.now() };
    if (storageKey !== scopedKey(CACHE_KEY)) return;
    await AsyncStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {}
}

export async function getCachedData<T>(key: string, maxAgeMs = 10 * 60 * 1000): Promise<T | null> {
  try {
    const storageKey = scopedKey(CACHE_KEY);
    const raw = await AsyncStorage.getItem(storageKey);
    if (storageKey !== scopedKey(CACHE_KEY)) return null;
    if (!raw) return null;
    const cache = JSON.parse(raw);
    const entry = cache[key];
    if (!entry) return null;
    const now = Date.now();
    if (offlineCacheExpiresAt !== null) {
      if (now >= offlineCacheExpiresAt || entry.timestamp > now) return null;
    } else if (now - entry.timestamp > maxAgeMs) return null;
    return entry.data as T;
  } catch {
    return null;
  }
}

export async function removeCachedData(prefixes: string[]): Promise<void> {
  try {
    const storageKey = scopedKey(CACHE_KEY);
    const raw = await AsyncStorage.getItem(storageKey);
    if (!raw) return;
    const cache = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(cache)) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) delete cache[key];
    }
    await AsyncStorage.setItem(storageKey, JSON.stringify(cache));
  } catch {}
}
