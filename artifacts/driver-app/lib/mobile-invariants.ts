export interface GpsSessionOwner {
  userId: string;
  organizationId: string;
}

export interface GpsSessionIdentity extends GpsSessionOwner {
  routeId: string;
  status: "active" | "ended";
}

export function shouldInvalidateGpsForHttpStatus(status: number) {
  return status === 401 || status === 403 || status === 409;
}

export function canUseGpsSession(
  session: GpsSessionIdentity | null,
  owner: GpsSessionOwner | null,
  routeId: string | null | undefined,
) {
  return Boolean(
    session &&
    owner &&
    session.status !== "ended" &&
    session.routeId === routeId &&
    session.userId === owner.userId &&
    session.organizationId === owner.organizationId,
  );
}

export function offlineQueueKey(
  baseKey: string,
  owner: GpsSessionOwner | null,
) {
  if (!owner) throw new Error("Offline queue scope is unavailable");
  return `${baseKey}:${owner.userId}:${owner.organizationId}`;
}

export function shouldRecoverSyncLease(
  syncStatus: string | undefined,
  syncStartedAt: string | undefined,
  now: number,
  maxAgeMs: number,
) {
  if (syncStatus !== "syncing") return false;
  const started = syncStartedAt ? new Date(syncStartedAt).getTime() : Number.NaN;
  return !Number.isFinite(started) || now - started >= maxAgeMs;
}

export function gpsPermissionDecision(
  platform: "web" | "ios" | "android",
  foreground: "granted" | "denied" | "undetermined",
  background: "granted" | "denied" | "undetermined" = "granted",
) {
  if (platform === "web") return { allowed: true as const, reason: null };
  if (foreground !== "granted") return { allowed: false as const, reason: "foreground" };
  if (background !== "granted") return { allowed: false as const, reason: "background" };
  return { allowed: true as const, reason: null };
}

export function retainClientMessageId(clientMessageId: string) {
  if (!clientMessageId.trim()) throw new Error("clientMessageId is required");
  return clientMessageId;
}

/** Prevents an in-flight live-assistance response from updating a newly selected driver. */
export function isCurrentAssistanceScope(
  completedScopeKey: string,
  currentScopeKey: string | null,
) {
  return completedScopeKey === currentScopeKey;
}