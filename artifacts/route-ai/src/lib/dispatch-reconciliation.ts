export type DispatchRouteSnapshot = {
  id: string;
  planRevision: number;
  handoffStatus?: string | null;
  handoffVersion?: number | null;
  handoffDriverId?: string | null;
};

const CURRENT_HANDOFF_STATUSES = new Set(["sent", "received", "opened", "accepted", "rejected"]);

export function matchesPlanRevision(
  actual: Pick<DispatchRouteSnapshot, "planRevision">,
  expectedRevision: number,
): boolean {
  return actual.planRevision === expectedRevision;
}

/**
 * A handoff is reusable only when the server reports a recipient and the
 * handoff belongs to the exact route revision being dispatched. Pending,
 * recipient-less, and stale handoffs must go through preflight again.
 */
export function hasCurrentHandoff(
  route: DispatchRouteSnapshot,
  planRevision = route.planRevision,
): boolean {
  return Boolean(
    route.handoffStatus
      && CURRENT_HANDOFF_STATUSES.has(route.handoffStatus)
      && route.handoffDriverId
      && (route.handoffVersion ?? route.planRevision) === planRevision,
  );
}

/**
 * Reconcile a planned route set against freshly fetched route snapshots before
 * dispatch. This keeps retries idempotent after a partial send: routes that
 * acquired a current handoff are skipped, while unresolved routes remain.
 */
export function getRoutesRequiringDispatch(
  routes: readonly DispatchRouteSnapshot[],
  snapshots: ReadonlyMap<string, DispatchRouteSnapshot>,
): DispatchRouteSnapshot[] {
  return routes.filter((route) => {
    const current = snapshots.get(route.id);
    return !current || !hasCurrentHandoff(current, route.planRevision);
  });
}