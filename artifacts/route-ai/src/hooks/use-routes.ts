import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import {
  useListRoutes as useGeneratedListRoutes,
  useGetRouteStops as useGeneratedGetRouteStops,
  useCreateRoute as useGeneratedCreateRoute,
  useDeleteRoute as useGeneratedDeleteRoute,
  useUpdateRoute as useGeneratedUpdateRoute,
  type OptimizeResponse,
} from "@workspace/api-client-react";
import type { Route } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useRoutes() {
  return useGeneratedListRoutes({ organizationId: ORG_ID });
}

export function useRoute(routeId: string) {
  return useQuery<Route>({
    queryKey: ["/api/routes", routeId],
    queryFn: async () => {
      const res = await fetch(`/api/routes/${routeId}?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Route not found");
      return res.json();
    },
    enabled: !!routeId,
  });
}

export function useUpdateRoute() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateRoute({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      },
    },
  });
}

export function useRouteStops(routeId: string) {
  return useGeneratedGetRouteStops(routeId, {
    query: { enabled: !!routeId, queryKey: ["/api/routes", routeId, "stops"] },
  });
}

export interface OptimizationWeights {
  distanceWeight: number;
  co2Weight: number;
  etaPrecisionWeight: number;
  driverHappinessWeight?: number;
}

interface OptimizeParams {
  organizationId: string;
  vehicleIds: string[];
  stopIds: string[];
  depotLatitude: number;
  depotLongitude: number;
  optimizationWeights?: OptimizationWeights;
  timeBudgetMs?: number;
}

export interface OptimizationJobStatus {
  jobId: string;
  status: "running" | "complete" | "error";
  progress: {
    totalClusters: number;
    completedClusters: number;
    phase: "clustering" | "optimizing" | "merging" | "complete";
    elapsedMs: number;
  } | null;
  stopCount: number;
  vehicleCount: number;
  result?: OptimizeResponse;
  error?: string;
  elapsedMs: number;
}

let activeJobProgress: OptimizationJobStatus["progress"] | null = null;

export function getActiveJobProgress() {
  return activeJobProgress;
}

export function useOptimizeRoutes() {
  const queryClient = useQueryClient();
  return useMutation<OptimizeResponse, Error, { data: OptimizeParams }>({
    mutationKey: ["optimizeRoutes"],
    mutationFn: async ({ data }) => {
      activeJobProgress = null;
      const isLarge = data.stopIds.length > 100;
      const timeBudget = isLarge ? Math.max(data.timeBudgetMs ?? 30000, 60000) : (data.timeBudgetMs ?? 30000);

      const res = await fetch("/api/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, async: isLarge, timeBudgetMs: timeBudget }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Optimization failed" }));
        throw new Error(err.error || "Optimization failed");
      }
      const json = await res.json();

      if (json.jobId) {
        return await pollJobUntilComplete(json.jobId);
      }

      return json;
    },
    onSuccess: () => {
      activeJobProgress = null;
      queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
    onError: () => {
      activeJobProgress = null;
    },
  });
}

async function pollJobUntilComplete(jobId: string): Promise<OptimizeResponse> {
  const maxWait = 150000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await fetch(`/api/optimize/status/${jobId}`);
    if (!res.ok) throw new Error("Failed to check optimization status");
    const status: OptimizationJobStatus = await res.json();

    activeJobProgress = status.progress;

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
  return useQuery<OptimizationJobStatus>({
    queryKey: ["/api/optimize/status", jobId],
    queryFn: async () => {
      const res = await fetch(`/api/optimize/status/${jobId}`);
      if (!res.ok) throw new Error("Job not found");
      return res.json();
    },
    enabled: !!jobId,
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
      },
    },
  });
}

export function useDeleteRoute() {
  const queryClient = useQueryClient();
  return useGeneratedDeleteRoute({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
      }
    }
  })
}
