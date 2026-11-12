/**
 * Pure scope/step logic for the three-step route planner workspace.
 * Scope uses only real stop fields: planningPlanId (project), planningDate
 * (day) and the postcode in the address (area). Nothing is invented.
 */
export type PlannerStep = 1 | 2 | 3;

/** Explicit bucket for stops lacking a project or day; never merged silently. */
export const NO_VALUE = "__none__";

export interface ScopeStop {
  id: string;
  routeId?: string | null;
  planningPlanId?: string | null;
  planningDate?: string | null;
  address: string;
  notes?: string | null;
  contactName?: string | null;
  customerName?: string | null;
  customerSiteName?: string | null;
  externalRef?: string | null;
}

export interface PlannerScope {
  project: string | null;
  date: string | null;
  area: string | null;
  search: string;
}

export interface ScopeOption { value: string; count: number }

export const stopProjectKey = (stop: ScopeStop) => stop.planningPlanId || NO_VALUE;
export const stopDateKey = (stop: ScopeStop) => stop.planningDate?.slice(0, 10) || NO_VALUE;
export function stopAreaKey(stop: ScopeStop): string {
  const match = stop.address?.match(/\b(\d{3})\s?\d{2}\b/);
  return match ? `${match[1]}xx` : NO_VALUE;
}

function countBy(stops: readonly ScopeStop[], key: (s: ScopeStop) => string): ScopeOption[] {
  const counts = new Map<string, number>();
  for (const stop of stops) counts.set(key(stop), (counts.get(key(stop)) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => (a.value === NO_VALUE ? 1 : b.value === NO_VALUE ? -1 : a.value.localeCompare(b.value)));
}

export interface ResolvedScope {
  project: string | null;
  date: string | null;
  /** Which choice the dispatcher still has to make before jobs are listed. */
  needs: "project" | "date" | null;
  projects: ScopeOption[];
  dates: ScopeOption[];
  areas: ScopeOption[];
}

/**
 * A project/day is only implied when exactly one exists. With several, the
 * dispatcher must choose: jobs from different projects or days never mix.
 */
export function resolveScope(stops: readonly ScopeStop[], scope: PlannerScope): ResolvedScope {
  const projects = countBy(stops, stopProjectKey);
  const project = scope.project && projects.some((o) => o.value === scope.project)
    ? scope.project
    : projects.length === 1 ? projects[0].value : null;
  const inProject = project ? stops.filter((s) => stopProjectKey(s) === project) : [];
  const dates = countBy(inProject, stopDateKey);
  const date = !project ? null
    : scope.date && dates.some((o) => o.value === scope.date) ? scope.date
      : dates.length === 1 ? dates[0].value : null;
  const inDay = date ? inProject.filter((s) => stopDateKey(s) === date) : [];
  return {
    project, date,
    needs: projects.length === 0 ? null : !project ? "project" : !date ? "date" : null,
    projects, dates, areas: countBy(inDay, stopAreaKey),
  };
}

export function stopsInScope<T extends ScopeStop>(stops: readonly T[], resolved: Pick<ResolvedScope, "project" | "date">): T[] {
  if (!resolved.project || !resolved.date) return [];
  return stops.filter((s) => stopProjectKey(s) === resolved.project && stopDateKey(s) === resolved.date);
}

/** Area and search narrow the visible list only; they never drop selections. */
export function filterVisibleStops<T extends ScopeStop>(stops: readonly T[], area: string | null, search: string): T[] {
  const q = search.trim().toLowerCase();
  return stops.filter((s) => {
    if (area && stopAreaKey(s) !== area) return false;
    if (!q) return true;
    return [s.address, s.notes, s.contactName, s.customerName, s.customerSiteName, s.externalRef]
      .some((v) => v?.toLowerCase().includes(q));
  });
}

/** Keeps only ids that are still allowed; reports how many were dropped. */
export function pruneSelection(selected: ReadonlySet<string>, allowed: ReadonlySet<string>): { next: Set<string>; removed: number } {
  const next = new Set([...selected].filter((id) => allowed.has(id)));
  return { next, removed: selected.size - next.size };
}

export interface StepGateInput { selectedStops: number; selectedVehicles: number; hasRoutes: boolean }

export function stepAvailability(input: StepGateInput): Record<PlannerStep, { enabled: boolean; reason: string | null }> {
  const sourceReady = input.selectedStops > 0 && input.selectedVehicles > 0;
  return {
    1: { enabled: true, reason: null },
    2: {
      enabled: sourceReady || input.hasRoutes,
      reason: sourceReady || input.hasRoutes ? null
        : input.selectedStops === 0 ? "Välj minst ett jobb" : "Välj minst ett fordon",
    },
    3: { enabled: input.hasRoutes, reason: input.hasRoutes ? null : "Optimera rutter först" },
  };
}

/** Stable signature of what a route proposal was built from. */
export function sourceSignature(project: string | null, date: string | null, stopIds: Iterable<string>, vehicleIds: Iterable<string>): string {
  return JSON.stringify([project, date, [...stopIds].sort(), [...vehicleIds].sort()]);
}

export function dispatchScopeHref(planId: string, day: string | null): string {
  const params = new URLSearchParams({ view: "traffic", planId });
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) params.set("day", day);
  return `/dispatch?${params.toString()}`;
}

function minutesOfDay(value: string): number | null {
  const hhmm = value.match(/^(\d{2}):(\d{2})/);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes();
}

/** Late = server-planned service start after the end of the time window. */
export function isLateForWindow(windowEnd: string | null | undefined, serviceStartAt: string | null | undefined): boolean {
  if (!windowEnd || !serviceStartAt) return false;
  if (!/^\d{2}:\d{2}/.test(windowEnd)) {
    const end = new Date(windowEnd).getTime();
    const start = new Date(serviceStartAt).getTime();
    return Number.isFinite(end) && Number.isFinite(start) && start > end;
  }
  const end = minutesOfDay(windowEnd);
  const start = minutesOfDay(serviceStartAt);
  return end !== null && start !== null && start > end;
}

export function formatClock(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 5);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

export function formatTimeWindow(start?: string | null, end?: string | null): string | null {
  const a = formatClock(start);
  const b = formatClock(end);
  if (!a && !b) return null;
  return `${a ?? "–"}–${b ?? "–"}`;
}

/**
 * The server dates the routes (and starts its clock) from `date`. Only a
 * real YYYY-MM-DD scope day is sent; otherwise null, and the UI must say
 * that the server falls back to today.
 */
export function optimizationDateFor(day: string | null): string | null {
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00Z` : null;
}

export type LocalCheck = "issues" | "clear" | "unknown";

/**
 * Local checks only cover overtime, time windows (when the server timeline
 * exists) and unplanned jobs. Missing timeline data is "unknown", never clear.
 */
export function localCheckState(input: { issues: number; routesMissingTimeline: number }): LocalCheck {
  if (input.issues > 0) return "issues";
  return input.routesMissingTimeline > 0 ? "unknown" : "clear";
}

/** Displayed plan differs from the filter header when its day/project differ. */
export function displayedPlanMismatch(
  displayed: { day: string | null; project: string | null },
  filter: { date: string | null; project: string | null },
): boolean {
  const dayDiffers = Boolean(displayed.day && filter.date && displayed.day !== filter.date);
  const projectDiffers = Boolean(displayed.project && filter.project && displayed.project !== filter.project);
  return dayDiffers || projectDiffers || (!filter.date && Boolean(displayed.day));
}
