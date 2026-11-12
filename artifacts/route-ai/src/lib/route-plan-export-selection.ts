export type RoutePlanExportSelection =
  | { kind: "route"; id: string }
  | { kind: "plan"; id: string }
  | { kind: "date"; id: string };

interface ExportableRoute {
  id: string;
  planId: string;
  date: string;
}

export function routePlanSelectionStorageKey(organizationId: string): string {
  return `traivo:last-route-plan:${organizationId}`;
}

export function chooseRoutePlanExportSelection(
  routes: ExportableRoute[],
  highlightedRouteId: string | null,
  explicitPlanId: string | null,
): RoutePlanExportSelection | null {
  const selectedRoute = highlightedRouteId
    ? routes.find((route) => route.id === highlightedRouteId)
    : undefined;
  if (selectedRoute) return { kind: "route", id: selectedRoute.id };
  if (explicitPlanId) return { kind: "plan", id: explicitPlanId };
  const planIds = new Set(routes.map((route) => route.planId));
  if (planIds.size === 1) return { kind: "plan", id: [...planIds][0] };
  const dates = new Set(routes.map((route) =>
    new Date(route.date).toISOString().slice(0, 10)));
  if (dates.size === 1) return { kind: "date", id: [...dates][0] };
  return null;
}