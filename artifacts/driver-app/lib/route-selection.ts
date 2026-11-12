interface SelectableRoute {
  id: string;
  organizationId: string;
  handoffDriverId: string | null;
  status: string;
}

export function eligibleRoutes<T extends SelectableRoute>(
  routes: T[],
  identity: { organizationId: string; driverId?: string; isAdmin: boolean } | null,
): T[] {
  if (!identity) return [];
  return routes.filter((route) =>
    route.organizationId === identity.organizationId &&
    (identity.isAdmin || (route.handoffDriverId === identity.driverId &&
      (route.status === "in_progress" || route.status === "optimized"))),
  );
}

export function resolveSelectedRoute<T extends { id: string }>(routes: T[], selectedId: string | null): T | null {
  return routes.find((route) => route.id === selectedId) ?? routes[0] ?? null;
}