import type { Driver, ImportRoutePlanApprovalResult, Route } from "@workspace/api-client-react";

/**
 * Route's optimization resource snapshot is not exposed by the Route API.
 * Protected plans therefore need matching approval-summary evidence, whose
 * driver resolution uses that immutable snapshot (even before approval).
 * For other routes only an explicit handoff proves the mutation recipient;
 * a currently linked vehicle driver cannot prove a hidden snapshot's identity.
 */
export function dispatchRouteDriverNames(
  routes: readonly Route[],
  drivers: readonly Driver[],
  evidence?: ImportRoutePlanApprovalResult,
): Map<string, string> {
  return new Map(routes.flatMap(route => {
    if (!route.vehicleId) return [];
    let driverId = route.handoffDriverId;
    if (route.draftId != null) {
      const summary = evidence?.protected && evidence.planId === route.planId
        ? evidence.routes.find(item => item.routeId === route.id
          && item.planId === route.planId && item.draftId === route.draftId
          && item.planRevision === route.planRevision && item.vehicleId === route.vehicleId)
        : undefined;
      driverId = summary?.driverId;
    }
    if (!driverId) return [];
    const driver = drivers.find(item => item.id === driverId && item.isActive
      && item.vehicleId === route.vehicleId && item.organizationId === route.organizationId);
    return driver ? [[route.id, driver.name] as const] : [];
  }));
}
