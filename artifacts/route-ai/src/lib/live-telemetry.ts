/**
 * Pure helpers for the read-only live traffic views. Only real, measured
 * telemetry is shown as a vehicle position: planned markers (isRealGps not
 * true or missing measuredAt) are never presented as where a vehicle is.
 */
export const LIVE_STALE_AFTER_MS = 2 * 60 * 1000;

export type TelemetryLike = {
  routeId?: string | null;
  isRealGps?: boolean;
  measuredAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type LiveVehicleStatus = "live" | "stale" | "no-position";

function validCoordinate(lat: unknown, lng: unknown): boolean {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

export function measuredTime(position: TelemetryLike): number | null {
  if (!position.measuredAt) return null;
  const time = Date.parse(position.measuredAt);
  return Number.isFinite(time) ? time : null;
}

/** True only for an actual received fix with a measurement time and valid coordinates. */
export function isActualTelemetry(position: TelemetryLike): boolean {
  return position.isRealGps === true && measuredTime(position) !== null
    && validCoordinate(position.latitude, position.longitude);
}

export function actualTelemetryOnly<T extends TelemetryLike>(positions: readonly T[]): T[] {
  return positions.filter(isActualTelemetry);
}

export function telemetryStatus(position: TelemetryLike | undefined, now: number, staleAfterMs = LIVE_STALE_AFTER_MS): LiveVehicleStatus {
  if (!position || !isActualTelemetry(position)) return "no-position";
  const time = measuredTime(position)!;
  return now - time > staleAfterMs ? "stale" : "live";
}

/** Latest actual fix per route. Planned markers are ignored. */
export function latestActualByRoute<T extends TelemetryLike>(positions: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const position of actualTelemetryOnly(positions)) {
    if (!position.routeId) continue;
    const existing = map.get(position.routeId);
    if (!existing || measuredTime(position)! > measuredTime(existing)!) map.set(position.routeId, position);
  }
  return map;
}

const DISPATCHED_HANDOFF = new Set(["sent", "received", "opened", "accepted"]);

/** Routes that are dispatched to a driver or already being driven. */
export function isDispatchedOrDriving(route: { status: string; handoffStatus?: string | null }): boolean {
  if (route.status === "completed" || route.status === "cancelled") return false;
  return route.status === "in_progress" || DISPATCHED_HANDOFF.has(route.handoffStatus ?? "");
}

export function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s sedan`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min sedan`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min sedan`;
}

export type TrafficLayout = "split" | "map" | "timeline";

export function readTrafficLayout(value: string | null | undefined): TrafficLayout {
  return value === "map" || value === "timeline" ? value : "split";
}

export const LIVE_MAP_POPOUT_HREF = "/map-popout?live=1";
