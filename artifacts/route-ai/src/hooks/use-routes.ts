import { useQueryClient, useQuery, useQueries, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import {
  useListRoutes as useGeneratedListRoutes,
  useCreateRoute as useGeneratedCreateRoute,
  useUpdateRoute as useGeneratedUpdateRoute,
  useDispatchRoute as useGeneratedDispatchRoute,
  useAdjustAssignedRoutes as useGeneratedAdjustAssignedRoutes,
  type OptimizeResponse,
  type PlanningInputs,
} from "@workspace/api-client-react";
import type { Route, Stop, RouteDeletionResult, RouteDeletionSelection } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { invalidateRouteQueries } from "@/lib/route-query-cache";

export function useRoutes() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedListRoutes({ organizationId: organizationId! }, {
    query: {
      queryKey: ["/api/routes", organizationId],
      enabled: !!organizationId,
      // Surface a failed refresh immediately while retaining cached routes.
      // The visible retry action and periodic refresh handle recovery.
      retry: false,
      refetchInterval: 15000,
      refetchOnWindowFocus: true,
    },
  });
}

export function useRoute(routeId: string) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useQuery<Route>({
    queryKey: ["/api/routes", organizationId, routeId],
    queryFn: async () => {
      const res = await fetch(`/api/routes/${routeId}?organizationId=${organizationId}`);
      if (!res.ok) throw new Error("Route not found");
      return res.json();
    },
    enabled: !!routeId && !!organizationId,
  });
}

export function useUpdateRoute() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateRoute({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useAdjustAssignedRoutes() {
  const queryClient = useQueryClient();
  return useGeneratedAdjustAssignedRoutes({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useRouteStops(routeId: string) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useQuery<Stop[]>({
    queryKey: ["/api/routes", organizationId, routeId, "stops"],
    queryFn: async () => {
      const res = await fetch(`/api/routes/${routeId}/stops?organizationId=${organizationId}`);
      if (!res.ok) throw new Error("Failed to load route stops");
      return res.json();
    },
    enabled: !!routeId && !!organizationId,
  });
}

export interface RouteIncident {
  id: string;
  routeId: string;
  category: "traffic" | "vehicle_issue" | "accident" | "customer_unavailable" | "access_problem" | "weather" | "safety" | "other";
  comment: string;
  attachmentUrl: string | null;
  createdAt: string;
}
export interface OptimizationWeights {
  distanceWeight: number;
  co2Weight: number;
  etaPrecisionWeight: number;
  driverHappinessWeight?: number;
  geographicCohesionWeight?: number;
}

interface OptimizeParams {
  organizationId: string;
  vehicleIds: string[];
  stopIds: string[];
  depotLatitude: number;
  depotLongitude: number;
  optimizationWeights?: OptimizationWeights;
  timeBudgetMs?: number;
  vehicleDistributionMode?: "minimize" | "balance";
  planningInputs?: PlanningInputs;
  /** Route day; accepted by POST /api/optimize (ExtendedOptimizeBody.date). */
  date?: string;
}

export interface OptimizationJobStatus {
  jobId: string;
  status: "running" | "complete" | "error";
  progress: {
    totalClusters: number;
    completedClusters: number;
    phase: "preparing" | "distance_matrix" | "clustering" | "optimizing" | "merging" | "complete";
    elapsedMs: number;
    iterations: number;
    improvements: number;
    stopReason: OptimizationStopReason | null;
    clusterStopReasons: Record<string, number>;
  } | null;
  stopCount: number;
  vehicleCount: number;
  result?: OptimizeResponse & {
    optimizationTiming?: OptimizationTiming;
  };
  error: string | null;
  elapsedMs: number;
}

export type OptimizationStopReason =
  | "time_limit"
  | "max_iterations"
  | "no_improvement"
  | "no_nodes"
  | "no_vehicles"
  | "mixed";

interface OptimizationTiming {
  inputLoadMs: number;
  weatherMs: number;
  distanceMatrixMs: number;
  clusteringMs: number;
  alnsSearchMs: number;
  mergingMs: number;
  persistenceMs: number;
  totalMs: number;
  iterations: number;
  improvements: number;
  stopReason: OptimizationStopReason;
  totalClusters: number;
  optimizedClusters: number;
  clusterStopReasons?: Record<string, number>;
}

export function useOptimizeRoutes() {
  const queryClient = useQueryClient();
  const [jobStatus, setJobStatus] = useState<OptimizationJobStatus | null>(null);
  const mutation = useMutation<OptimizeResponse, Error, { data: OptimizeParams }>({
    mutationKey: ["optimizeRoutes"],
    mutationFn: async ({ data }) => {
      setJobStatus(null);
      const isLarge = data.stopIds.length > 100;
      const timeBudget = isLarge
        ? Math.max(data.timeBudgetMs ?? 30_000, 60_000)
        : data.timeBudgetMs;
      const requestData = {
        ...data,
        async: isLarge,
        ...(timeBudget != null ? { timeBudgetMs: timeBudget } : {}),
      };

      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(requestData),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Optimization failed" }));
        throw new Error(err.error || "Optimization failed");
      }
      const json = await res.json();

      if (json.jobId) {
        return await pollJobUntilComplete(json.jobId, setJobStatus);
      }

      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      void invalidateRouteQueries(queryClient);
    },
  });
  return { ...mutation, jobStatus };
}

async function pollJobUntilComplete(
  jobId: string,
  onStatus: (status: OptimizationJobStatus) => void,
): Promise<OptimizeResponse> {
  const maxWait = 150000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`/api/optimize/status/${jobId}`, { credentials: "include" });
    if (!res.ok) throw new Error("Failed to check optimization status");
    const status: OptimizationJobStatus = await res.json();

    onStatus(status);

    if (status.status === "complete" && status.result) {
      return status.result;
    }
    if (status.status === "error") {
      throw new Error(status.error || "Optimization failed");
    }
  }
  throw new Error("Optimization timed out");
}

export function useOptimizationJobStatus(jobId: string | null) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useQuery<OptimizationJobStatus>({
    queryKey: ["/api/optimize/status", organizationId, jobId],
    queryFn: async () => {
      const res = await fetch(`/api/optimize/status/${jobId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Job not found");
      return res.json();
    },
    enabled: !!organizationId && !!jobId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === "complete" || data?.status === "error") return false;
      return 1500;
    },
  });
}

export function useCreateRoute() {
  const queryClient = useQueryClient();
  return useGeneratedCreateRoute({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useDeleteRoute() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useMutation({
    mutationFn: async ({ id, confirmLiveRouteRemoval }: {
      id: string;
      confirmLiveRouteRemoval: boolean;
    }) => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const res = await fetch(`/api/routes/${id}?organizationId=${organizationId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirmLiveRouteRemoval }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Object.assign(new Error(err.error || "Failed to delete route"), {
          status: res.status,
          code: err.code,
          data: err,
        });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] }),
        queryClient.invalidateQueries({ queryKey: ["planning-drafts", organizationId] }),
      ]);
      void invalidateRouteQueries(queryClient);
    },
  });
}

export type BulkDeleteRoutesResponse = RouteDeletionResult;

/**
 * Delete routes in one server transaction. Do not replace this with a loop of
 * single-route mutations: the API validates the complete set before making
 * any changes, so a conflict cannot leave a partial deletion behind.
 */
export function useBulkDeleteRoutes() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;

  return useMutation<BulkDeleteRoutesResponse, Error, RouteDeletionSelection>({
    mutationFn: async ({ routeIds, confirmLiveRouteRemoval }) => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      if (routeIds.length === 0) throw new Error("At least one route is required");
      if (routeIds.length > 500) throw new Error("A maximum of 500 routes can be deleted at once");

      const res = await fetch("/api/routes/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ routeIds, confirmLiveRouteRemoval }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Object.assign(new Error(err.error || "Failed to delete routes"), {
          status: res.status,
          code: err.code,
          data: err,
        });
      }
      const payload = await res.json() as Partial<BulkDeleteRoutesResponse>;
      const removedRouteIds = [
        ...(payload.deletedRouteIds ?? []),
        ...(payload.archivedRouteIds ?? []),
      ];
      if (!Array.isArray(payload.deletedRouteIds)
        || !Array.isArray(payload.archivedRouteIds)
        || (payload.deletedCount ?? 0) + (payload.archivedCount ?? 0) !== routeIds.length
        || removedRouteIds.length !== routeIds.length
        || new Set(removedRouteIds).size !== routeIds.length
        || removedRouteIds.some((id) => !routeIds.includes(id))) {
        throw new Error("Unexpected route deletion response; refresh the route list before trying again");
      }
      return payload as BulkDeleteRoutesResponse;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] }),
        queryClient.invalidateQueries({ queryKey: ["planning-drafts", organizationId] }),
      ]);
      void invalidateRouteQueries(queryClient);
    },
  });
}

export function useDispatchRoute() {
  const queryClient = useQueryClient();
  return useGeneratedDispatchRoute({
    mutation: {
      onSuccess: (_result, variables) => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

/** Poll incident feeds for the routes currently displayed in Dispatch. */
export function useRouteIncidents(routeIds: string[]) {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useQueries({
    queries: routeIds.map((routeId) => ({
      queryKey: ["/api/routes", organizationId, routeId, "incidents"],
      queryFn: async (): Promise<RouteIncident[]> => {
        const res = await fetch(
          `/api/routes/${routeId}/incidents?organizationId=${encodeURIComponent(organizationId!)}`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error("Failed to load route incidents");
        return res.json();
      },
      enabled: !!organizationId && !!routeId,
      refetchInterval: 15000,
      refetchOnWindowFocus: true,
    })),
  });
}
