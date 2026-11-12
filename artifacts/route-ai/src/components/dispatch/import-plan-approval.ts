import type {
  ImportRoutePlanApprovalResult,
  ImportRoutePlanApprovalSummary,
  Route,
} from "@workspace/api-client-react";
import type { ImportAssignedRoute } from "@/components/import/types";

export type ImportApprovalMatchState =
  | "noEligibleRoutes"
  | "notProtected"
  | "stale"
  | "missingDriver"
  | "awaitingApproval"
  | "exact";

export interface ImportApprovalMapping {
  allPlanRoutes: Route[];
  eligiblePlanRoutes: Route[];
  expectedRoutes: Array<{
    routeId: string;
    planRevision: number;
    driverId: string;
  }>;
  assignedRoutes: ImportAssignedRoute[];
  state: ImportApprovalMatchState;
  exact: boolean;
  canApprove: boolean;
}

export type ImportApprovalActionState =
  | "readOnly"
  | "awaitingApproval"
  | "exact"
  | "blocked";

/**
 * Keep role authorization separate from server approval state. A read-only
 * viewer can inspect an exact or awaiting plan, but must never receive a
 * mutation action.
 */
export function getImportApprovalActionState(
  state: ImportApprovalMatchState,
  canWrite: boolean,
): ImportApprovalActionState {
  if (!canWrite) return "readOnly";
  if (state === "exact") return "exact";
  if (state === "awaitingApproval") return "awaitingApproval";
  return "blocked";
}

export type ExactApprovalMatcher = (
  result: {
    protected: boolean;
    routes: Array<{
      routeId: string;
      planRevision: number;
      driverId: string | null;
      approval: { approved: boolean };
    }>;
  },
  expected: Array<{
    routeId: string;
    planRevision: number;
    driverId: string;
  }>,
) => boolean;

const DISPATCHABLE_ROUTE_STATUSES = new Set<Route["status"]>([
  "optimized",
  "in_progress",
]);

function hasCurrentRouteTuples(
  approvalRoutes: ImportRoutePlanApprovalSummary[],
  planId: string,
  liveRoutes: Route[],
): boolean {
  if (approvalRoutes.length !== liveRoutes.length) return false;
  const liveById = new Map(liveRoutes.map((route) => [route.id, route]));
  const approvalIds = new Set<string>();
  const everyApprovalRouteMatches = approvalRoutes.every((approvalRoute) => {
    if (approvalIds.has(approvalRoute.routeId)) return false;
    approvalIds.add(approvalRoute.routeId);
    const liveRoute = liveById.get(approvalRoute.routeId);
    return Boolean(
      liveRoute
      && approvalRoute.planId === planId
      && approvalRoute.planRevision === liveRoute.planRevision
      && approvalRoute.driverId,
    );
  });
  return everyApprovalRouteMatches && liveRoutes.every((route) => approvalIds.has(route.id));
}

/**
 * Joins the server's live approval tuples with live route rows. The driver
 * recipient always comes from the approval response; this function never
 * derives or falls back to a vehicle's current driver.
 */
export function mapImportApprovalRoutes(
  planId: string,
  liveRoutes: readonly Route[],
  approval: ImportRoutePlanApprovalResult | null | undefined,
  hasExactApprovedRouteSet: ExactApprovalMatcher,
): ImportApprovalMapping {
  const allPlanRoutes = liveRoutes.filter(
    (route) => route.planId === planId && route.status !== "cancelled",
  );
  const eligiblePlanRoutes = allPlanRoutes.filter((route) =>
    DISPATCHABLE_ROUTE_STATUSES.has(route.status),
  );
  const base = {
    allPlanRoutes,
    eligiblePlanRoutes,
    expectedRoutes: [],
    assignedRoutes: [],
    exact: false,
    canApprove: false,
  } satisfies Omit<ImportApprovalMapping, "state">;

  if (
    eligiblePlanRoutes.length === 0
    || eligiblePlanRoutes.some((route) => !route.vehicleId)
  ) {
    return { ...base, state: "noEligibleRoutes" };
  }
  if (!approval?.protected) {
    return { ...base, state: "notProtected" };
  }
  if (approval.planId !== planId) {
    return { ...base, state: "stale" };
  }

  const approvalRoutes = approval.routes;
  const approvalById = new Map(approvalRoutes.map((route) => [route.routeId, route]));
  const expectedRoutes: ImportApprovalMapping["expectedRoutes"] = [];
  for (const liveRoute of eligiblePlanRoutes) {
    const approvalRoute = approvalById.get(liveRoute.id);
    if (!approvalRoute?.driverId) {
      return { ...base, state: "missingDriver" };
    }
    expectedRoutes.push({
      routeId: liveRoute.id,
      planRevision: liveRoute.planRevision,
      driverId: approvalRoute.driverId,
    });
  }

  const exact = hasExactApprovedRouteSet(approval, expectedRoutes);
  const tuplesMatch = hasCurrentRouteTuples(
    approvalRoutes,
    planId,
    eligiblePlanRoutes,
  );
  if (!tuplesMatch) {
    return {
      ...base,
      expectedRoutes,
      exact: false,
      state: "stale",
    };
  }
  if (exact) {
    const assignedRoutes = eligiblePlanRoutes.map((liveRoute) => {
      const approvalRoute = approvalById.get(liveRoute.id)!;
      return {
        routeId: liveRoute.id,
        planId: liveRoute.planId,
        name: liveRoute.name,
        vehicleId: liveRoute.vehicleId!,
        driverId: approvalRoute.driverId!,
        stopCount: liveRoute.totalStops,
        totalDistanceKm: liveRoute.totalDistanceKm ?? 0,
        totalDurationMin: liveRoute.totalDurationMin ?? 0,
        planRevision: liveRoute.planRevision,
        status: "optimized" as const,
        depotSnapshot: liveRoute.depotSnapshot,
        workdayTimeline: liveRoute.workdayTimeline,
        workdaySummary: liveRoute.workdaySummary ?? undefined,
      };
    });
    return {
      ...base,
      expectedRoutes,
      assignedRoutes,
      exact: true,
      state: "exact",
    };
  }

  const canApprove = eligiblePlanRoutes.every((route) => route.status === "optimized" || (
    route.status === "in_progress" && route.handoffVersion != null
    && route.handoffDriverId != null && route.planRevision >= route.handoffVersion
    && route.dispatchSnapshotVersion === route.handoffVersion
  ));
  return {
    ...base,
    expectedRoutes,
    exact: false,
    canApprove,
    state: canApprove ? "awaitingApproval" : "stale",
  };
}