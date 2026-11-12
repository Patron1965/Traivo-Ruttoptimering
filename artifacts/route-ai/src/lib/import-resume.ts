export type ImportApprovalResumeRoute = {
  routeId: string;
  planId: string;
  planRevision: number;
  status: string;
  vehicleId: string | null;
  driverId: string | null;
  approval: {
    approved: boolean;
    approvedAt: string | null;
    approvedByUserId: string | null;
  };
};

export type ImportApprovalResumeState = {
  planId: string;
  protected: true;
  routes: ImportApprovalResumeRoute[];
};

export type HydratedImportRoute = {
  routeId: string;
  planId: string;
  planRevision: number;
  vehicleId: string | null;
  driverId: string;
  handoffStatus?: string | null;
  handoffDriverId?: string | null;
  handoffVersion?: number | null;
  name?: string | null;
  totalDistanceKm: number;
  totalDurationMin: number;
  stopCount: number;
  depotSnapshot?: unknown;
  approval: ImportApprovalResumeRoute["approval"];
  status: string;
};

/**
 * Build the local route projection only from one fresh approval response and
 * the matching fresh route reads.  Keeping this pure prevents a failed read
 * from accidentally reusing the draft's stale assignedRoutes snapshot.
 */
export function buildHydratedImportRoutes(
  approval: ImportApprovalResumeState,
  routes: readonly { summary: ImportApprovalResumeRoute; route: Record<string, unknown> }[],
): HydratedImportRoute[] {
  if (routes.length !== approval.routes.length) {
    throw new Error("IMPORT_ROUTE_HYDRATION_INCOMPLETE");
  }
  return routes.map(({ summary, route }) => {
    if (!summary.driverId) {
      throw new Error(`IMPORT_ROUTE_DRIVER_MISSING:${summary.routeId}`);
    }
    return {
      routeId: summary.routeId,
      planId: summary.planId,
      planRevision: summary.planRevision,
      vehicleId: summary.vehicleId ?? (typeof route.vehicleId === "string" ? route.vehicleId : null),
      driverId: summary.driverId,
      handoffStatus: typeof route.handoffStatus === "string" ? route.handoffStatus : null,
      handoffDriverId: typeof route.handoffDriverId === "string" ? route.handoffDriverId : null,
      handoffVersion: typeof route.handoffVersion === "number" ? route.handoffVersion : null,
      name: typeof route.name === "string" ? route.name : null,
      totalDistanceKm: typeof route.totalDistanceKm === "number" ? route.totalDistanceKm : 0,
      totalDurationMin: typeof route.totalDurationMin === "number" ? route.totalDurationMin : 0,
      stopCount: typeof route.totalStops === "number" ? route.totalStops : 0,
      depotSnapshot: route.depotSnapshot ?? null,
      approval: summary.approval,
      status: typeof route.status === "string" ? route.status : summary.status,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Approval state is scoped to the planning draft's plan.  In particular, an
 * empty route array is valid for a protected plan when every imported stop
 * was left unplanned; it is not a missing-plan response.
 */
export function isImportApprovalResumeState(
  value: unknown,
  expectedPlanId: string,
): value is ImportApprovalResumeState {
  if (!isRecord(value)) return false;
  if (value.planId !== expectedPlanId || value.protected !== true || !Array.isArray(value.routes)) {
    return false;
  }

  return value.routes.every((route) => {
    if (!isRecord(route)) return false;
    if (
      typeof route.routeId !== "string"
      || route.planId !== expectedPlanId
      || typeof route.planRevision !== "number"
      || typeof route.status !== "string"
      || (route.vehicleId !== null && typeof route.vehicleId !== "string")
      || (route.driverId !== null && typeof route.driverId !== "string")
      || !isRecord(route.approval)
      || typeof route.approval.approved !== "boolean"
      || (route.approval.approvedAt !== null && typeof route.approval.approvedAt !== "string")
      || (
        route.approval.approvedByUserId !== null
        && typeof route.approval.approvedByUserId !== "string"
      )
    ) {
      return false;
    }
    return true;
  });
}