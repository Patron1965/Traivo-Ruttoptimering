import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import {
  invalidateRouteLockQueries,
  patchRouteLockCaches,
  RouteLockRequestError,
} from "@/lib/route-lock";
import type { PlanningLocksRequest } from "@/lib/planning-locks";
import type { Route } from "@workspace/api-client-react";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/";

export interface PlanningLocksMutationInput {
  routeId: string;
  body: PlanningLocksRequest;
}

/** PUT /api/routes/:id/planning-locks. Never retried; errors refresh the view. */
export function usePlanningLocks() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;

  return useMutation<Route, RouteLockRequestError, PlanningLocksMutationInput>({
    mutationKey: ["route-planning-locks"],
    retry: false,
    mutationFn: async ({ routeId, body }) => {
      const response = await fetch(`${API_BASE}api/routes/${encodeURIComponent(routeId)}/planning-locks`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new RouteLockRequestError(response.status, data);
      return data as Route;
    },
    onSuccess: async (savedRoute) => {
      patchRouteLockCaches(queryClient, savedRoute, organizationId);
      await invalidateRouteLockQueries(queryClient, savedRoute.id, organizationId, savedRoute.planId);
    },
    onError: (error, variables) => {
      if (error.status === 401) return;
      void invalidateRouteLockQueries(queryClient, variables.routeId, organizationId);
    },
  });
}
