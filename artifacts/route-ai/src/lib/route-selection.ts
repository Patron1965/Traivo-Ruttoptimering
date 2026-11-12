export type RouteSelection =
  | { kind: "plan"; key: string }
  | { kind: "route"; id: string };

export interface RouteSelectionGroup {
  key: string;
  routeIds: string[];
}

export const MAX_BULK_ROUTE_DELETE = 500;

export type AggregateCheckboxState = boolean | "indeterminate";

/**
 * Radix emits a boolean when an aggregate checkbox is toggled. Treat only an
 * explicit true value as a request to select; an indeterminate value is never
 * allowed to trigger a destructive selection.
 */
export function selectionFromAggregateCheckbox(
  checked: AggregateCheckboxState,
): boolean {
  return checked === true;
}

/**
 * A route can only be selected for deletion when it is still a plan that has
 * not started. The API remains authoritative (for example, it also checks
 * the status of the route's stops), but keeping blocked runs out of the
 * selection makes the destructive action understandable in the UI.
 */
export function isRouteDeletionEligible(status: string): boolean {
  return status === "draft" || status === "optimized" || status === "in_progress";
}

export function capRouteIds(
  routeIds: readonly string[],
  limit = MAX_BULK_ROUTE_DELETE,
): { routeIds: string[]; omittedCount: number } {
  const uniqueIds = Array.from(new Set(routeIds));
  return {
    routeIds: uniqueIds.slice(0, limit),
    omittedCount: Math.max(0, uniqueIds.length - limit),
  };
}

/**
 * Toggle a visible set of checkboxes without ever selecting more than the
 * server's atomic bulk-delete limit.
 */
export function setVisibleRouteSelection(
  current: ReadonlySet<string>,
  visibleRouteIds: readonly string[],
  selected: boolean,
  limit = MAX_BULK_ROUTE_DELETE,
): { selection: Set<string>; omittedCount: number } {
  const next = new Set(current);
  if (!selected) {
    visibleRouteIds.forEach((id) => next.delete(id));
    return { selection: next, omittedCount: 0 };
  }

  const remainingIds = visibleRouteIds.filter((id) => !next.has(id));
  const availableSlots = Math.max(0, limit - next.size);
  const idsToAdd = remainingIds.slice(0, availableSlots);
  idsToAdd.forEach((id) => next.add(id));
  return {
    selection: next,
    omittedCount: remainingIds.length - idsToAdd.length,
  };
}

export interface RouteDeletionSnapshotItem {
  routeId: string;
  name: string;
  planId: string | null;
  planRevision: number;
  status: string;
  handoffStatus: string | null;
}

export interface RouteDeletionSnapshotRoute {
  id: string;
  name: string;
  planId?: string | null;
  planRevision: number;
  status: string;
  handoffStatus?: string | null;
}

/**
 * Capture the exact route identities shown in the confirmation dialog. The
 * snapshot is intentionally immutable from the caller's perspective; the
 * server still performs the final authorization and validation.
 */
export function createRouteDeletionSnapshot(
  routes: readonly RouteDeletionSnapshotRoute[],
  routeIds: readonly string[],
): RouteDeletionSnapshotItem[] | null {
  const byId = new Map(routes.map((route) => [route.id, route]));
  const selected = Array.from(new Set(routeIds)).map((routeId) => {
    const route = byId.get(routeId);
    if (!route || !isRouteDeletionEligible(route.status)) return null;
    return {
      routeId: route.id,
      name: route.name,
      planId: route.planId ?? null,
      planRevision: route.planRevision,
      status: route.status,
      handoffStatus: route.handoffStatus ?? null,
    };
  });
  return selected.every((item): item is RouteDeletionSnapshotItem => item !== null)
    ? selected
    : null;
}

/**
 * A route may disappear, move to another plan revision, be renamed, or become
 * ineligible while a confirmation dialog is open. In all of those cases the
 * caller must close the dialog and require a fresh confirmation instead of
 * silently shrinking or changing the request.
 */
export function routeDeletionSnapshotChanged(
  snapshot: readonly RouteDeletionSnapshotItem[],
  routes: readonly RouteDeletionSnapshotRoute[],
): boolean {
  const currentById = new Map(routes.map((route) => [route.id, route]));
  if (snapshot.length === 0) return true;
  return snapshot.some((item) => {
    const current = currentById.get(item.routeId);
    return !current
      || !isRouteDeletionEligible(current.status)
      || current.name !== item.name
      || (current.planId ?? null) !== item.planId
      || current.planRevision !== item.planRevision
      || (current.handoffStatus ?? null) !== item.handoffStatus;
  });
}

export function isLiveRouteRemoval(route: {
  status: string;
  handoffStatus?: string | null;
}): boolean {
  // Being sent/opened/accepted is not the same as starting the journey.
  return route.status === "in_progress";
}

/**
 * Resolve the current membership of a selection. A plan selection is always
 * read from the current group, so newly added or removed runs are reflected
 * without rewriting selection state.
 */
export function selectedRouteIdsForGroups(
  selection: RouteSelection | null,
  groups: RouteSelectionGroup[],
  visibleGroupKeys?: ReadonlySet<string>,
): string[] {
  if (!selection) return [];

  if (selection.kind === "plan") {
    if (visibleGroupKeys && !visibleGroupKeys.has(selection.key)) return [];
    return groups.find((group) => group.key === selection.key)?.routeIds ?? [];
  }

  const group = groups.find((candidate) => candidate.routeIds.includes(selection.id));
  if (!group || (visibleGroupKeys && !visibleGroupKeys.has(group.key))) return [];
  return [selection.id];
}