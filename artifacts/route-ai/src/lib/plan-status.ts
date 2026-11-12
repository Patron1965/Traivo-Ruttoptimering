/**
 * Canonical plan lifecycle state used by the planner, dispatch board and the
 * import flow.  The input deliberately only contains server-owned fields.  A
 * click/transition in one screen must never be used as evidence that a plan
 * changed state.
 */

export type PlanLifecycleStatus =
  | "draft"
  | "calculated"
  | "needs_review"
  | "approval_checking"
  | "ready_for_approval"
  | "dispatch_ready"
  | "partially_approved"
  | "approved"
  | "partially_sent"
  | "sent"
  | "partially_received"
  | "received"
  | "partially_accepted"
  | "accepted"
  | "rejected";

export type PlanNextAction =
  | "build"
  | "review"
  | "approve"
  | "send"
  | "follow_up"
  | "resolve_rejection"
  | "live";

export type PlanApprovalAvailability = "checking" | "not_protected" | "protected";

export interface PlanStatusRoute {
  id?: string | null;
  routeId?: string | null;
  status?: string | null;
  planRevision?: number | null;
  manualReviewRequired?: boolean | null;
  manualReviewedAt?: string | null;
  handoffStatus?: string | null;
  handoffVersion?: number | null;
  handoffDriverId?: string | null;
  driverId?: string | null;
  vehicleId?: string | null;
  driverName?: string | null;
  vehicleName?: string | null;
  totalStops?: number | null;
  date?: string | null;
}

export interface PlanApprovalState {
  protected?: boolean;
  routes?: Array<{
    routeId?: string;
    planRevision?: number;
    driverId?: string | null;
    driverName?: string | null;
    vehicleId?: string | null;
    vehicleName?: string | null;
    approval?: { approved?: boolean };
  }>;
}

export function getCurrentApprovalResources(
  routes: readonly PlanStatusRoute[],
  approval?: PlanApprovalState | null,
): NonNullable<PlanApprovalState["routes"]> | null {
  if (!approval?.routes || approval.routes.length !== routes.length) {
    return null;
  }
  const current = routes.every((route, index) => {
    const routeId = route.id ?? route.routeId;
    const candidate = routeId
      ? approval.routes?.find((approvalRoute) => approvalRoute.routeId === routeId)
      : approval.routes?.[index];
    return Boolean(
      candidate
      && candidate.planRevision === route.planRevision,
    );
  });
  return current ? approval.routes : null;
}

export type PlanBlocker = {
  type: "unplannedStops" | "missingVehicle" | "missingDriver" | "manualReview";
  count?: number;
};

export interface PlanStatusInput {
  routes: readonly PlanStatusRoute[];
  approval?: PlanApprovalState | null;
  approvalAvailability?: PlanApprovalAvailability;
  unplannedCount?: number;
}

export interface PlanStatusResult {
  status: PlanLifecycleStatus;
  stage: number;
  nextAction: PlanNextAction;
  routeCount: number;
  approvedCount: number;
  sentCount: number;
  receivedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  blockers: PlanBlocker[];
}

export function deriveNoServerPlanStatus(unplannedCount = 0): PlanStatusResult {
  return {
    status: "draft",
    stage: 0,
    nextAction: "build",
    routeCount: 0,
    approvedCount: 0,
    sentCount: 0,
    receivedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    blockers: unplannedCount > 0
      ? [{ type: "unplannedStops", count: unplannedCount }]
      : [],
  };
}

const HANDOFF_LEVEL: Record<string, number> = {
  sent: 1,
  received: 2,
  opened: 3,
  accepted: 4,
};

function currentHandoffLevel(route: PlanStatusRoute): number {
  if (!hasCurrentHandoff(route)) {
    return 0;
  }
  return HANDOFF_LEVEL[route.handoffStatus ?? ""] ?? 0;
}

function hasCurrentHandoff(route: PlanStatusRoute): boolean {
  return Boolean(
    route.handoffStatus
      && route.handoffStatus !== "pending"
      && (
        route.handoffVersion == null
        || route.planRevision == null
        || route.handoffVersion === route.planRevision
      ),
  );
}

function isApproved(
  route: PlanStatusRoute,
  index: number,
  approval: PlanApprovalState | null | undefined,
): boolean {
  const routeId = route.id ?? route.routeId;
  const approvalRoute = routeId
    ? approval?.routes?.find((candidate) => candidate.routeId === routeId)
    : undefined;
  // Approval responses are authoritative only when protected and complete.
  // When an id is not available on a lightweight route summary, preserve the
  // positional relationship supplied by the API.
  const positional = approval?.routes?.[index];
  const currentApproval = routeId ? approvalRoute : positional;
  return Boolean(
    approval?.protected
      && currentApproval?.approval?.approved
      && currentApproval.planRevision === route.planRevision
      && (currentApproval.driverId == null
        || route.driverId == null
        || currentApproval.driverId === route.driverId),
  );
}

/**
 * Derive the current lifecycle from the latest server payload.
 *
 * The function intentionally does not accept a "last action" or optimistic
 * flag.  This makes it safe to use after a refresh, a second browser tab, or
 * a failed mutation response.
 */
export function derivePlanStatus({
  routes,
  approval,
  approvalAvailability = approval?.protected ? "protected" : "not_protected",
  unplannedCount = 0,
}: PlanStatusInput): PlanStatusResult {
  const routeCount = routes.length;
  if (routeCount === 0) {
    return {
      status: "draft",
      stage: 0,
      nextAction: "build",
      routeCount: 0,
      approvedCount: 0,
      sentCount: 0,
      receivedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      blockers: unplannedCount > 0 ? [{ type: "unplannedStops", count: unplannedCount }] : [],
    };
  }

  const approvedCount = routes.reduce(
    (count, route, index) => count + (isApproved(route, index, approval) ? 1 : 0),
    0,
  );
  const sentCount = routes.filter((route) => currentHandoffLevel(route) >= 1).length;
  const receivedCount = routes.filter((route) => currentHandoffLevel(route) >= 2).length;
  const acceptedCount = routes.filter((route) => currentHandoffLevel(route) === 4).length;
  const rejectedCount = routes.filter(
    (route) => route.handoffStatus === "rejected" && hasCurrentHandoff(route),
  ).length;
  const reviewedCount = routes.filter(
    (route, index) => !route.manualReviewRequired || Boolean(route.manualReviewedAt) || isApproved(route, index, approval),
  ).length;
  const hasDraft = routes.some((route) => route.status === "draft");
  const hasCalculated = routes.some((route) =>
    route.status === "optimized" || route.status === "in_progress" || route.status === "completed",
  ) || routes.every((route) => !route.status);
  const hasCurrentApprovalMapping = Boolean(
    approval?.protected
      && approval.routes?.length === routeCount
      && routes.every((route, index) => {
        const routeId = route.id ?? route.routeId;
        const candidate = routeId
          ? approval.routes?.find((approvalRoute) => approvalRoute.routeId === routeId)
          : approval.routes?.[index];
        return Boolean(
          candidate
            && candidate.planRevision === route.planRevision,
        );
      }),
  );
  const blockers: PlanBlocker[] = [
    ...(unplannedCount > 0 ? [{ type: "unplannedStops" as const, count: unplannedCount }] : []),
    ...(routes.some((route) => !route.vehicleId) ? [{ type: "missingVehicle" as const }] : []),
    ...(routes.some((route) =>
      Object.prototype.hasOwnProperty.call(route, "driverId")
      && !route.driverId
      && !route.handoffDriverId,
    )
      ? [{ type: "missingDriver" as const }]
      : []),
    ...(routes.some((route, index) => route.manualReviewRequired && !route.manualReviewedAt && !isApproved(route, index, approval))
      ? [{ type: "manualReview" as const }]
      : []),
  ];

  let status: PlanLifecycleStatus;
  let nextAction: PlanNextAction;
  if (rejectedCount > 0) {
    status = "rejected";
    nextAction = "resolve_rejection";
  } else if (acceptedCount === routeCount) {
    status = "accepted";
    nextAction = "live";
  } else if (acceptedCount > 0) {
    status = "partially_accepted";
    nextAction = "follow_up";
  } else if (receivedCount === routeCount) {
    status = "received";
    nextAction = "follow_up";
  } else if (receivedCount > 0) {
    status = "partially_received";
    nextAction = "follow_up";
  } else if (sentCount === routeCount) {
    status = "sent";
    nextAction = "follow_up";
  } else if (sentCount > 0) {
    status = "partially_sent";
    nextAction = "follow_up";
  } else if (approvedCount === routeCount) {
    status = "approved";
    nextAction = "send";
  } else if (approvedCount > 0) {
    status = "partially_approved";
    nextAction = "approve";
  } else if (reviewedCount < routeCount || blockers.length > (unplannedCount > 0 ? 1 : 0)) {
    status = "needs_review";
    nextAction = "review";
  } else if (hasDraft || !hasCalculated) {
    status = "draft";
    nextAction = "build";
  } else if (approvalAvailability === "checking"
    || (approvalAvailability === "protected" && !hasCurrentApprovalMapping)) {
    status = "approval_checking";
    nextAction = "follow_up";
  } else if (approvalAvailability === "protected" && hasCurrentApprovalMapping) {
    status = "ready_for_approval";
    nextAction = "approve";
  } else {
    status = "dispatch_ready";
    nextAction = "send";
  }

  const stage =
    sentCount > 0
      ? 5
      : status === "approved" || status === "partially_approved"
        ? 4
        : status === "ready_for_approval" || status === "dispatch_ready"
          ? 4
          : status === "approval_checking" || status === "needs_review"
          ? 3
          : status === "draft"
            ? 0
            : 1;

  return {
    status,
    stage,
    nextAction,
    routeCount,
    approvedCount,
    sentCount,
    receivedCount,
    acceptedCount,
    rejectedCount,
    blockers,
  };
}
