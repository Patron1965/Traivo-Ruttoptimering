export function isHistoricalRoute(route: { status: string }): boolean {
  return route.status === "completed" || route.status === "cancelled";
}

export function selectMapRoutes<T extends { status: string }>(routes: T[], history: boolean): T[] {
  return routes.filter(route => isHistoricalRoute(route) === history);
}

export function selectLiveRouteItems<T extends { routeId?: string | null }>(
  items: T[], routes: { id: string; status: string }[],
): T[] {
  const liveIds = new Set(selectMapRoutes(routes, false).map(route => route.id));
  return items.filter(item => !!item.routeId && liveIds.has(item.routeId));
}