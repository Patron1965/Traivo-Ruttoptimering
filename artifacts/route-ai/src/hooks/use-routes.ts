import { useQueryClient } from "@tanstack/react-query";
import {
  useListRoutes as useGeneratedListRoutes,
  useGetRouteStops as useGeneratedGetRouteStops,
  useOptimizeRoutes as useGeneratedOptimizeRoutes,
  useDeleteRoute as useGeneratedDeleteRoute,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useRoutes() {
  return useGeneratedListRoutes({ organizationId: ORG_ID });
}

export function useRouteStops(routeId: string) {
  return useGeneratedGetRouteStops(routeId, {
    query: { enabled: !!routeId },
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
