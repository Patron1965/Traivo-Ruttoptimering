export interface DispatchRouteIntent {
  planId?: string | null;
  routeId?: string | null;
}

/**
 * Build the canonical link used by route-plan list actions.  Keeping the
 * intent in the URL makes the dispatch view reloadable and avoids relying on
 * the map's local selection state.
 */
export function trafficDispatchHref(intent: DispatchRouteIntent): string {
  const params = new URLSearchParams({ view: "traffic" });
  if (intent.planId) params.set("planId", intent.planId);
  if (intent.routeId) params.set("routeId", intent.routeId);
  return `/dispatch?${params.toString()}`;
}

/**
 * "All plans" is a real scope change.  Preserve display mode/workflow query
 * state, but never leave a stale plan or route highlight behind.
 */
export function clearDispatchScope(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("planId");
  params.delete("routeId");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function routeMatchesPlan(
  route: { id: string; planId?: string | null },
  planId: string | null,
): boolean {
  return Boolean(planId) && route.planId === planId;
}