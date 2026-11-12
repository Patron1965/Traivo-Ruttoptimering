/**
 * Pure helpers for persistent planner locks (docs/planner-lock-api.md).
 * No React, no fetch: safe for node:test.
 */

export type PlanningLockRole = "admin" | "dispatcher" | string;

export interface PlanningLockRoute {
  id: string;
  planRevision: number;
  status?: string | null;
  optimizationFrozen?: boolean | null;
  vehicleId?: string | null;
  driverId?: string | null;
}

export interface PlanningLockStop {
  id: string;
  status?: string | null;
  routeId?: string | null;
  archivedAt?: string | null;
  lockedVehicleId?: string | null;
  lockedDriverId?: string | null;
  lockedServiceStartAt?: string | null;
}

export interface ResourcePair {
  vehicleId: string;
  driverId: string;
}

export interface PlanningLocksRequest {
  planRevision: number;
  frozen?: boolean;
  stopId?: string;
  resourcePair?: ResourcePair | null;
  serviceStartAt?: string | null;
}

export type LockEvidenceKind = "frozen" | "resource" | "time";

const STOCKHOLM = "Europe/Stockholm";

export function canWritePlanningLocks(roles: { hasRole: (...r: string[]) => boolean }): boolean {
  return roles.hasRole("admin", "dispatcher");
}

/** True when the ISO instant has an explicit offset and exact minute precision. */
export function isExactMinuteInstant(value: string | null | undefined): value is string {
  if (!value) return false;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms % 60_000 === 0;
}

/**
 * Normalises an authoritative server service-start (Date or ISO) to an ISO
 * instant. Returns null if unknown or not on an exact minute; the browser
 * never rounds, because tolerance is zero.
 */
export function authoritativeServiceStartIso(
  value: Date | string | null | undefined,
  evidenceAuthoritative: boolean,
): string | null {
  if (!evidenceAuthoritative || value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms) || ms % 60_000 !== 0) return null;
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

export function formatStockholm(iso: string | null | undefined): string {
  if (!iso) return "okänd tid";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "okänd tid";
  return d.toLocaleString("sv-SE", {
    timeZone: STOCKHOLM,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export type RouteFreezeBlock = "role" | "missing_revision" | null;

export function routeFreezeBlock(route: PlanningLockRoute, canWrite: boolean): RouteFreezeBlock {
  if (!canWrite) return "role";
  if (!Number.isInteger(route.planRevision)) return "missing_revision";
  return null;
}

export type StopLockBlock =
  | "role"
  | "frozen"
  | "not_pending"
  | "not_on_route"
  | "archived"
  | "missing_revision"
  | null;

export function stopLockBlock(
  route: PlanningLockRoute,
  stop: PlanningLockStop,
  canWrite: boolean,
): StopLockBlock {
  if (!canWrite) return "role";
  if (route.optimizationFrozen) return "frozen";
  if (!Number.isInteger(route.planRevision)) return "missing_revision";
  if (stop.routeId != null && stop.routeId !== route.id) return "not_on_route";
  if (stop.archivedAt) return "archived";
  if (stop.status !== "pending") return "not_pending";
  return null;
}

export const BLOCK_REASON_SV: Record<Exclude<StopLockBlock | RouteFreezeBlock, null>, string> = {
  role: "Endast administratör eller trafikledare kan ändra lås.",
  frozen: "Rutten är fryst. Lås upp rutten först för att ändra stopplås.",
  not_pending: "Endast väntande stopp kan låsas.",
  not_on_route: "Stoppet tillhör inte den här rutten.",
  archived: "Arkiverade stopp kan inte låsas.",
  missing_revision: "Ruttens planversion saknas. Ladda om vyn.",
};

export function currentPair(route: PlanningLockRoute): ResourcePair | null {
  return route.vehicleId && route.driverId
    ? { vehicleId: route.vehicleId, driverId: route.driverId }
    : null;
}

export function hasResourceLock(stop: PlanningLockStop): boolean {
  return Boolean(stop.lockedVehicleId && stop.lockedDriverId);
}

export function buildFreezeRequest(route: PlanningLockRoute, frozen: boolean): PlanningLocksRequest {
  return { planRevision: route.planRevision, frozen };
}

export function buildResourceLockRequest(
  route: PlanningLockRoute,
  stopId: string,
  lock: boolean,
): PlanningLocksRequest {
  if (!lock) return { planRevision: route.planRevision, stopId, resourcePair: null };
  const pair = currentPair(route);
  if (!pair) throw new Error("Rutten saknar fordon–förare-par.");
  return { planRevision: route.planRevision, stopId, resourcePair: pair };
}

export function buildTimeLockRequest(
  route: PlanningLockRoute,
  stopId: string,
  serviceStartAt: string | null,
): PlanningLocksRequest {
  if (serviceStartAt !== null && !isExactMinuteInstant(serviceStartAt)) {
    throw new Error("Servicestart måste vara en exakt minut med tidszon.");
  }
  return { planRevision: route.planRevision, stopId, serviceStartAt };
}

export function lockEvidence(
  route: Pick<PlanningLockRoute, "optimizationFrozen"> | null | undefined,
  stop: PlanningLockStop | null | undefined,
): LockEvidenceKind[] {
  const out: LockEvidenceKind[] = [];
  if (route?.optimizationFrozen) out.push("frozen");
  if (stop && hasResourceLock(stop)) out.push("resource");
  if (stop?.lockedServiceStartAt) out.push("time");
  return out;
}

/** Swedish guidance for a failed write. 401/409 are never retried. */
export function planningLockErrorGuidance(status: number, message?: string): string {
  if (status === 401) return "Din session har gått ut. Logga in igen; ändringen sparades inte.";
  if (status === 403) return "Du saknar behörighet att ändra lås.";
  if (status === 409) {
    return `Planen har ändrats eller låset avvisades${message ? ` (${message})` : ""}. Vyn har laddats om; kontrollera och försök igen manuellt.`;
  }
  return message || "Låset kunde inte sparas.";
}
