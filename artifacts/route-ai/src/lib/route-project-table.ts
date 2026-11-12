/**
 * Pure helpers for the compact "Projekt och rutter" table.
 *
 * Rules:
 * - A project row is exactly one route-plan group (grouped by planId). Groups
 *   are never merged by name.
 * - Metrics are read only from per-route fields. A parent total is the sum of
 *   its visible children and becomes unknown (null) as soon as one child value
 *   is unknown; plan-level totals are never presented as route totals.
 */

export const ROUTE_STATUS_FILTERS = ["all", "active", "drafts", "completed"] as const;
export type RouteListStatusFilter = (typeof ROUTE_STATUS_FILTERS)[number];

export const OPTIONAL_ROUTE_COLUMNS = ["distance", "travel", "service", "utilization", "environment"] as const;
export type OptionalRouteColumn = (typeof OPTIONAL_ROUTE_COLUMNS)[number];

export interface MetricWorkdaySummary {
  shiftMin?: number | null;
  nonReturnDrivingMin?: number | null;
  returnMin?: number | null;
  serviceMin?: number | null;
  totalMin?: number | null;
}

export interface MetricRoute {
  id: string;
  planId?: string | null;
  status: string;
  date?: string | null;
  totalStops?: number | null;
  totalDistanceKm?: number | null;
  workdaySummary?: MetricWorkdaySummary | null;
}

export interface RouteMetrics {
  stops: number | null;
  distanceKm: number | null;
  workMin: number | null;
  travelMin: number | null;
  serviceMin: number | null;
  shiftMin: number | null;
  /** 0..n ratio of work time to shift time. */
  utilization: number | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function known(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isValidDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function routeDay(route: { date?: string | null }): string | null {
  const day = route.date?.slice(0, 10) ?? null;
  return day && isValidDay(day) ? day : null;
}

export function routeMetrics(route: MetricRoute): RouteMetrics {
  const summary = route.workdaySummary ?? null;
  const workMin = summary && known(summary.totalMin) ? summary.totalMin : null;
  const shiftMin = summary && known(summary.shiftMin) && summary.shiftMin > 0 ? summary.shiftMin : null;
  const travelMin = summary && known(summary.nonReturnDrivingMin) && known(summary.returnMin)
    ? summary.nonReturnDrivingMin + summary.returnMin
    : null;
  return {
    stops: known(route.totalStops) ? route.totalStops : null,
    distanceKm: known(route.totalDistanceKm) ? route.totalDistanceKm : null,
    workMin,
    travelMin,
    serviceMin: summary && known(summary.serviceMin) ? summary.serviceMin : null,
    shiftMin,
    utilization: workMin !== null && shiftMin !== null ? workMin / shiftMin : null,
  };
}

/** Sum only when every value is known; an empty list is unknown. */
export function sumKnown(values: ReadonlyArray<number | null>): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

export function aggregateRouteMetrics(routes: ReadonlyArray<MetricRoute>): RouteMetrics {
  const metrics = routes.map(routeMetrics);
  const workMin = sumKnown(metrics.map((m) => m.workMin));
  const shiftMin = sumKnown(metrics.map((m) => m.shiftMin));
  return {
    stops: sumKnown(metrics.map((m) => m.stops)),
    distanceKm: sumKnown(metrics.map((m) => m.distanceKm)),
    workMin,
    travelMin: sumKnown(metrics.map((m) => m.travelMin)),
    serviceMin: sumKnown(metrics.map((m) => m.serviceMin)),
    shiftMin,
    utilization: workMin !== null && shiftMin !== null && shiftMin > 0 ? workMin / shiftMin : null,
  };
}

export const UNKNOWN = "–";

export function formatMinutes(value: number | null): string {
  if (value === null) return UNKNOWN;
  const total = Math.round(value);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function formatKm(value: number | null, locale = "sv-SE"): string {
  if (value === null) return UNKNOWN;
  return `${value.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return UNKNOWN;
  return `${Math.round(value * 100)} %`;
}

export function formatCount(value: number | null): string {
  return value === null ? UNKNOWN : String(value);
}

export function groupDays(routes: ReadonlyArray<{ date?: string | null }>): string[] {
  return [...new Set(routes.map(routeDay).filter((d): d is string => d !== null))].sort();
}

/** Keep only children on the chosen day; drop groups that become empty. */
export function filterGroupsByDay<R extends { date?: string | null }, G extends { routes: R[] }>(
  groups: ReadonlyArray<G>,
  day: string | null,
): G[] {
  if (!day) return [...groups];
  return groups.flatMap((group) => {
    const routes = group.routes.filter((route) => routeDay(route) === day);
    return routes.length > 0 ? [{ ...group, routes }] : [];
  });
}

/** Newest first; within the same day keep a stable key order. */
export function sortGroupsByLatestDay<R extends { date?: string | null }, G extends { key: string; routes: R[] }>(
  groups: ReadonlyArray<G>,
): G[] {
  return [...groups].sort((a, b) => {
    const da = groupDays(a.routes).at(-1) ?? "";
    const db = groupDays(b.routes).at(-1) ?? "";
    return db.localeCompare(da) || a.key.localeCompare(b.key);
  });
}

export function distinctDriverSummary(driverIds: ReadonlyArray<string | null | undefined>): {
  count: number;
  missing: number;
} {
  const ids = new Set<string>();
  let missing = 0;
  for (const id of driverIds) {
    if (id) ids.add(id);
    else missing += 1;
  }
  return { count: ids.size, missing };
}

export function groupStatus(routes: ReadonlyArray<{ status: string }>): string | "mixed" | null {
  const statuses = new Set(routes.map((route) => route.status));
  if (statuses.size === 0) return null;
  return statuses.size === 1 ? [...statuses][0] : "mixed";
}

// ---------------------------------------------------------------- navigation

export interface DispatchIntent { planId?: string | null; routeId?: string | null; day?: string | null; returnTo?: string | null }

/** returnTo must be the local /routes list; anything else is dropped. */
function safeReturnTo(value: string | null | undefined): string | null {
  return value && (value === "/routes" || value.startsWith("/routes?")) && !value.includes("\\") ? value : null;
}

export function dispatchHref(intent: DispatchIntent): string {
  const params = new URLSearchParams({ view: "traffic" });
  if (intent.planId) params.set("planId", intent.planId);
  if (intent.routeId) params.set("routeId", intent.routeId);
  if (intent.day && isValidDay(intent.day)) params.set("day", intent.day);
  const returnTo = safeReturnTo(intent.returnTo);
  if (returnTo) params.set("returnTo", returnTo);
  return `/dispatch?${params.toString()}`;
}

/**
 * Dispatch gives planId precedence over routeId, so a child link carries ONLY
 * the actual routeId plus its day; adding planId would open the whole plan.
 */
export function routeOpenHref(route: MetricRoute, returnTo?: string | null): string {
  return dispatchHref({ routeId: route.id, day: routeDay(route), returnTo });
}

export type ProjectOpenTarget =
  | { kind: "single"; href: string; day: string | null }
  | { kind: "chooseDay"; options: Array<{ day: string; href: string }> };

/**
 * A project spanning several days needs an explicit day choice. A legacy group
 * without planId is always a single route and opens that route id.
 */
export function projectOpenTarget(planId: string | null, routes: ReadonlyArray<MetricRoute>, returnTo?: string | null): ProjectOpenTarget {
  const days = groupDays(routes);
  if (!planId) {
    const route = routes[0];
    return { kind: "single", href: route ? routeOpenHref(route, returnTo) : dispatchHref({ returnTo }), day: days[0] ?? null };
  }
  if (days.length > 1) {
    return { kind: "chooseDay", options: days.map((day) => ({ day, href: dispatchHref({ planId, day, returnTo }) })) };
  }
  return { kind: "single", href: dispatchHref({ planId, day: days[0] ?? null, returnTo }), day: days[0] ?? null };
}

// ---------------------------------------------------------------- list state

export interface RoutesListFilters {
  q: string;
  status: RouteListStatusFilter;
  date: string | null;
}

export const DEFAULT_ROUTES_LIST_FILTERS: RoutesListFilters = { q: "", status: "active", date: null };

export function parseRoutesListFilters(search: string): RoutesListFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const status = params.get("status");
  const date = params.get("date");
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    status: (ROUTE_STATUS_FILTERS as readonly string[]).includes(status ?? "")
      ? (status as RouteListStatusFilter)
      : DEFAULT_ROUTES_LIST_FILTERS.status,
    date: isValidDay(date) ? date : null,
  };
}

export function serializeRoutesListFilters(filters: RoutesListFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status !== DEFAULT_ROUTES_LIST_FILTERS.status) params.set("status", filters.status);
  if (filters.date && isValidDay(filters.date)) params.set("date", filters.date);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function routesListStorageKey(organizationId: string | null | undefined, userId: string | null | undefined): string | null {
  if (!organizationId || !userId) return null;
  return `routes-list:v1:${organizationId}:${userId}`;
}

export interface RoutesListViewState {
  expanded: string[];
  scrollTop: number;
  columns: OptionalRouteColumn[];
}

export const EMPTY_VIEW_STATE: RoutesListViewState = { expanded: [], scrollTop: 0, columns: [] };

/** Parse untrusted stored JSON. Unknown keys/columns are dropped. */
export function parseRoutesListViewState(raw: string | null): RoutesListViewState {
  if (!raw) return { ...EMPTY_VIEW_STATE };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const expanded = Array.isArray(value.expanded)
      ? value.expanded.filter((k): k is string => typeof k === "string" && /^(plan|legacy):[^\s]{1,200}$/.test(k)).slice(0, 500)
      : [];
    const scrollTop = typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0
      ? Math.min(value.scrollTop, 1_000_000)
      : 0;
    const columns = Array.isArray(value.columns)
      ? OPTIONAL_ROUTE_COLUMNS.filter((c) => (value.columns as unknown[]).includes(c))
      : [];
    return { expanded, scrollTop, columns };
  } catch {
    return { ...EMPTY_VIEW_STATE };
  }
}
