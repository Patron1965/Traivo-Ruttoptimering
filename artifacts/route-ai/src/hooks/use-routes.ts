import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  useListRoutes as useGeneratedListRoutes,
  useGetRouteStops as useGeneratedGetRouteStops,
  useOptimizeRoutes as useGeneratedOptimizeRoutes,
  useCreateRoute as useGeneratedCreateRoute,
  useDeleteRoute as useGeneratedDeleteRoute,
  useUpdateRoute as useGeneratedUpdateRoute,
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

export function useOptimizeRoutes() {
  const queryClient = useQueryClient();
  return useGeneratedOptimizeRoutes({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      },
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
