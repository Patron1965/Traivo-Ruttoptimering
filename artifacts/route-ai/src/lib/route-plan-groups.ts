export interface RoutePlanGroupable {
  id: string;
  planId?: string | null;
  status: string;
  vehicleId?: string | null;
  totalStops?: number | null;
  date?: string | null;
}

export interface RoutePlanGroup<Route extends RoutePlanGroupable> {
  /**
   * A plan id is the only value that joins two route runs.  Legacy routes get
   * an id-specific key so that missing plan ids can never join one another.
   */
  key: string;
  planId: string | null;
  fallbackId: string;
  routes: Route[];
  totalStops: number;
  vehicleCount: number;
  missingVehicleCount: number;
  hasNonTerminalRoute: boolean;
}

export const TERMINAL_ROUTE_STATUSES = new Set(["completed", "cancelled"]);

export function isTerminalRouteStatus(status: string): boolean {
  return TERMINAL_ROUTE_STATUSES.has(status);
}

export function routePlanGroupKey(route: RoutePlanGroupable): string {
  const planId = typeof route.planId === "string" ? route.planId.trim() : "";
  return planId ? `plan:${planId}` : `legacy:${route.id}`;
}

/**
 * Build the read model before applying the active/history filter.  This is
 * important for plans that contain both live and terminal route runs: they
 * stay together and the selected tab controls which plans are shown, not
 * which children are removed.
 */
export function groupRoutesByPlan<Route extends RoutePlanGroupable>(
  routes: Route[],
): RoutePlanGroup<Route>[] {
  const groups = new Map<string, RoutePlanGroup<Route>>();

  routes.forEach((route) => {
    const planId = typeof route.planId === "string" && route.planId.trim()
      ? route.planId.trim()
      : null;
    const key = routePlanGroupKey(route);
    const existing = groups.get(key);

    if (existing) {
      existing.routes.push(route);
      existing.totalStops += Number.isFinite(route.totalStops)
        ? route.totalStops ?? 0
        : 0;
      existing.hasNonTerminalRoute ||= !isTerminalRouteStatus(route.status);
      return;
    }

    groups.set(key, {
      key,
      planId,
      fallbackId: planId ?? route.id,
      routes: [route],
      totalStops: Number.isFinite(route.totalStops) ? route.totalStops ?? 0 : 0,
      vehicleCount: route.vehicleId ? 1 : 0,
      missingVehicleCount: route.vehicleId ? 0 : 1,
      hasNonTerminalRoute: !isTerminalRouteStatus(route.status),
    });
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    vehicleCount: new Set(
      group.routes
        .map((route) => route.vehicleId)
        .filter((vehicleId): vehicleId is string => !!vehicleId),
    ).size,
    missingVehicleCount: group.routes.filter((route) => !route.vehicleId).length,
  }));
}
