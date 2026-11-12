export type ProgressTimeRecord = {
  startedAt: string;
  updatedAt: string;
  serverNow: string;
  elapsedMs: number;
};

export function isProgressRecordForRun(
  recordProgressId: string,
  activeProgressId: string,
): boolean {
  return recordProgressId === activeProgressId;
}

export function isCompleteProgressPayload(
  status: "running" | "complete" | "error",
  result: unknown,
): boolean {
  return status === "complete" && result != null;
}

export function shouldSurfacePollAbort(
  errorName: string | undefined,
  timedOut: boolean,
): boolean {
  return timedOut || errorName !== "AbortError";
}

const FRESHNESS_WINDOW_MS = 20_000;

export function isDefinitivePlanRejection(status: number | null, code: string): boolean {
  // Only this application-owned 503 guarantees no planning write occurred.
  // A generic gateway/timeout/503 remains ambiguous and must never be replayed.
  return (status === 503 && code === "ROAD_DATA_UNAVAILABLE") ||
    (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429);
}

export function missingProgressStatus(
  recordVisible: boolean,
  submittedAt: number | null,
  now: number,
): "starting" | "reconnecting" {
  // A just-submitted request may not have registered its status row yet.
  // This grace applies only to a 404, never to a timeout or an old heartbeat.
  return !recordVisible && submittedAt !== null &&
    now >= submittedAt && now - submittedAt < FRESHNESS_WINDOW_MS
    ? "starting"
    : "reconnecting";
}

export function isFreshProgressRecord(record: ProgressTimeRecord): boolean {
  const updatedAt = Date.parse(record.updatedAt);
  const serverNow = Date.parse(record.serverNow);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(serverNow)) return false;
  return serverNow - updatedAt <= FRESHNESS_WINDOW_MS;
}

export function getProgressElapsedMs(record: ProgressTimeRecord): number | null {
  if (Number.isFinite(record.elapsedMs)) return Math.max(0, record.elapsedMs);
  const startedAt = Date.parse(record.startedAt);
  const serverNow = Date.parse(record.serverNow);
  if (!Number.isFinite(startedAt) || !Number.isFinite(serverNow)) return null;
  return Math.max(0, serverNow - startedAt);
}
