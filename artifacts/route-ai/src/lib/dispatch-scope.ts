export interface DispatchScope {
  planId?: string | null;
  routeId?: string | null;
  day?: string | null;
}

export function readDispatchScope(search: string): DispatchScope {
  const params = new URLSearchParams(search);
  const day = params.get("day");
  return { planId: params.get("planId"), routeId: params.get("routeId"),
    ...(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? { day } : {}) };
}

const routeDay = (route: { date?: string | null }) => route.date?.slice(0, 10) ?? null;

/** Distinct working days of the routes, ascending. */
export function scopeDays(routes: ReadonlyArray<{ date?: string | null }>): string[] {
  return [...new Set(routes.map(routeDay).filter((d): d is string => Boolean(d)))].sort();
}

export type DispatchScopeStatus = "none" | "needsDay" | "ready";

/**
 * The single effective scope every dispatch surface consumes. Without an
 * explicit plan or route there is no board (chooser instead). A plan spanning
 * several days requires an explicit day; a single-day plan gets it implicitly.
 */
export function resolveDispatchScope<T extends { id: string; planId?: string | null; date?: string | null }>(
  routes: ReadonlyArray<T>, scope: DispatchScope,
): { status: DispatchScopeStatus; day: string | null; days: string[] } {
  if (!scope.planId && !scope.routeId) return { status: "none", day: null, days: [] };
  const members = routes.filter((route) =>
    (!scope.planId || route.planId === scope.planId) && (!scope.routeId || scope.planId || route.id === scope.routeId));
  const days = scopeDays(members);
  if (scope.day) return { status: "ready", day: scope.day, days };
  if (days.length <= 1) return { status: "ready", day: days[0] ?? null, days };
  return { status: "needsDay", day: null, days };
}

export function selectScopedRoutes<T extends {
  id: string; planId?: string | null; status: string; updatedAt: string; date?: string | null;
}>(routes: T[], scope: DispatchScope): T[] {
  const resolved = resolveDispatchScope(routes, scope);
  if (resolved.status !== "ready") return [];
  return routes.filter((route) => {
    const member = scope.planId ? route.planId === scope.planId : route.id === scope.routeId;
    return member && (!resolved.day || routeDay(route) === resolved.day);
  }).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id));
}

export interface DispatchPlanOption { planId: string; label: string; days: string[]; routeCount: number; terminal: boolean }

/** One option per actual planId; same-named plans are never merged. */
export function dispatchPlanOptions<T extends {
  id: string; planId?: string | null; status: string; date?: string | null; name?: string | null; customerReference?: string | null;
}>(routes: ReadonlyArray<T>): DispatchPlanOption[] {
  const groups = new Map<string, T[]>();
  for (const route of routes) if (route.planId) groups.set(route.planId, [...(groups.get(route.planId) ?? []), route]);
  return [...groups].map(([planId, members]) => ({
    planId,
    label: members[0].customerReference || members[0].name || `Plan ${planId.slice(0, 8)}`,
    days: scopeDays(members), routeCount: members.length,
    terminal: members.every((r) => ["completed", "cancelled"].includes(r.status)),
  })).sort((a, b) => (b.days.at(-1) ?? "").localeCompare(a.days.at(-1) ?? "") || a.planId.localeCompare(b.planId));
}

/** Only an unambiguous situation may be preselected: exactly one open plan. */
export function unambiguousDispatchPlan(options: ReadonlyArray<DispatchPlanOption>): string | null {
  const open = options.filter((o) => !o.terminal);
  return open.length === 1 ? open[0].planId : null;
}

/** Prefer today's uniquely identifiable outgoing plan, never an arbitrary draft. */
export function unambiguousLivePlan(routes: ReadonlyArray<{
  planId?: string | null; date?: string | null; status: string;
  handoffVersion?: number | null; handoffDriverId?: string | null;
}>, today: string): string | null {
  const current = routes.filter((route) =>
    route.date?.slice(0, 10) === today &&
    route.status !== "completed" && route.status !== "cancelled" &&
    route.handoffVersion != null && !!route.handoffDriverId && !!route.planId);
  const plans = [...new Set(current.map((route) => route.planId!))];
  return plans.length === 1 ? plans[0] : null;
}

/** Route edits must not reorder the dispatcher's driver/vehicle rows. */
export function sortScheduledRows<T extends {
  routeId: string; driverName: string; vehicleName: string; routeDate?: string | null;
}>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.driverName.localeCompare(b.driverName, "sv") ||
    a.vehicleName.localeCompare(b.vehicleName, "sv") ||
    (a.routeDate ?? "").localeCompare(b.routeDate ?? "") ||
    a.routeId.localeCompare(b.routeId));
}

// The unplanned pool belongs to the plan the dispatcher is working in. An
// explicit plan wins; otherwise the selected route decides through its own
// recorded plan membership. A route without a plan has no unplanned pool, and
// membership is never guessed from date or proximity.
export function resolveUnplannedPlanScope(
  scope: DispatchScope,
  routes: ReadonlyArray<{ id: string; planId?: string | null }> = [],
): { planId: string | null; scoped: boolean } {
  if (scope.planId) return { planId: scope.planId, scoped: true };
  if (scope.routeId) {
    const route = routes.find((candidate) => candidate.id === scope.routeId);
    return { planId: route?.planId ?? null, scoped: true };
  }
  return { planId: null, scoped: false };
}

export function selectScopedUnassignedStops<T extends {
  routeId?: string | null; planningPlanId?: string | null;
}>(
  stops: T[],
  scope: DispatchScope,
  routes: ReadonlyArray<{ id: string; planId?: string | null }> = [],
): T[] {
  const { planId, scoped } = resolveUnplannedPlanScope(scope, routes);
  // Without an explicit scope there is no board, so no unplanned pool either.
  return stops.filter((stop) => !stop.routeId && scoped && Boolean(planId) && stop.planningPlanId === planId);
}

export function ganttPopoutHref(search: string, baseUrl = "/"): string {
  return dispatchPopoutHref("gantt-popout", search, baseUrl);
}

export function mapPopoutHref(search: string, baseUrl = "/"): string {
  return dispatchPopoutHref("map-popout", search, baseUrl);
}

function dispatchPopoutHref(page: string, search: string, baseUrl: string): string {
  const scope = readDispatchScope(search);
  const params = new URLSearchParams();
  if (scope.planId) params.set("planId", scope.planId);
  if (scope.routeId) params.set("routeId", scope.routeId);
  if (scope.day) params.set("day", scope.day);
  return `${baseUrl.replace(/\/$/, "")}/${page}${params.size ? `?${params}` : ""}`;
}
