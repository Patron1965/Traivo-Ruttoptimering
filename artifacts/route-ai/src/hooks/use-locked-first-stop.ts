import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import {
  invalidateRouteLockQueries,
  patchRouteLockCaches,
  type LockedFirstStopInput,
  RouteLockRequestError,
} from "@/lib/route-lock";
import type { Route } from "@workspace/api-client-react";

/**
 * Persists the route-owned first-stop lock. This intentionally does not
 * optimistically move a stop: the server may recalculate the complete
 * schedule and its returned Route is the only authoritative result.
 */
export function useLockedFirstStop() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;

  return useMutation<Route, RouteLockRequestError, LockedFirstStopInput>({
    mutationKey: ["route-locked-first-stop"],
    retry: false,
    mutationFn: async ({ routeId, stopId, planRevision }) => {
      const response = await fetch(`/api/routes/${routeId}/locked-first-stop`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopId, planRevision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new RouteLockRequestError(response.status, data);
      }
      return data as Route;
    },
    onSuccess: async (savedRoute) => {
      patchRouteLockCaches(queryClient, savedRoute, organizationId);
      await invalidateRouteLockQueries(
        queryClient,
        savedRoute.id,
        organizationId,
        savedRoute.planId,
      );
    },
    onError: (_error, variables) => {
      // A revision conflict or a backend validation error means this view is
      // stale. Refresh, but never replay the write automatically.
      void invalidateRouteLockQueries(
        queryClient,
        variables.routeId,
        organizationId,
      );
    },
  });
}