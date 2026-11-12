import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Route, Stop } from "@workspace/api-client-react";
import { getGetImportRoutePlanApprovalQueryKey } from "@workspace/api-client-react";
import { createDispatchMoveError } from "@/lib/dispatch-move-auth";
import { TrustedLocalizedError } from "@/lib/localize-error";
import { isTerminalRouteStatus } from "@/lib/route-plan-groups";

export function useDispatchMove(
  activeRoutes: Route[],
  allStops: Stop[] | undefined,
) {
  const queryClient = useQueryClient();

  return useCallback(
    async (
      stopIds: string[],
      routeId: string | null,
      targetIndex: number,
      force = false,
      expectedPreviewDigest?: string,
      optimizeTargetRoute = false,
    ) => {
      const affectedRouteIds = new Set<string>();
      if (routeId) affectedRouteIds.add(routeId);
      for (const stopId of stopIds) {
        const sourceRouteId = allStops?.find((stop) => stop.id === stopId)?.routeId;
        if (sourceRouteId) affectedRouteIds.add(sourceRouteId);
      }
      const routeRevisions = [...affectedRouteIds].map((affectedRouteId) => {
        const route = activeRoutes.find((candidate) => candidate.id === affectedRouteId);
        if (!route) {
          throw new TrustedLocalizedError("Ruttens aktuella version kunde inte hittas. Ladda om och försök igen.");
        }
        if (isTerminalRouteStatus(route.status)) {
          throw new TrustedLocalizedError("Avslutade rutter kan endast visas och kan inte ändras.");
        }
        return { routeId: route.id, planRevision: route.planRevision };
      });
      const response = await fetch("/api/stops/dispatch-move", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopIds, routeId, targetIndex, force, routeRevisions, expectedPreviewDigest, optimizeTargetRoute }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409) {
        return {
          conflicts: Array.isArray(body.conflicts) ? body.conflicts as string[] : [],
          error: typeof body.error === "string" ? body.error : undefined,
          code: typeof body.code === "string" ? body.code : undefined,
          details: body.details,
          status: response.status,
        };
      }
      if (!response.ok) {
        throw createDispatchMoveError(
          response.status,
          typeof body.error === "string" ? body.error : "Could not move stops",
        );
      }
      const refreshResults = await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        ...[...new Set(activeRoutes
          .filter(route => affectedRouteIds.has(route.id))
          .map(route => route.planId)
          .filter((id): id is string => Boolean(id)))]
          .map(planId => queryClient.invalidateQueries({
            queryKey: getGetImportRoutePlanApprovalQueryKey(planId),
          })),
      ]);
      // The write is already committed. A failed refetch must not invite a
      // second move or be presented as a rejected save.
      return {
        conflicts: [] as string[],
        refreshFailed: refreshResults.some(result => result.status === "rejected"),
      };
    },
    [activeRoutes, allStops, queryClient],
  );
}