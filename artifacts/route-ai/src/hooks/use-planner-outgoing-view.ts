import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Route, Stop } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { LiveViewBackoff, LIVE_VIEW_POLL_MS } from "@/lib/live-view-backoff";
import {
  parsePlannerOutgoingView, PlannerOutgoingViewError, PLANNER_OUTGOING_SCOPE_LIMIT,
  type PlannerOutgoingRouteResources,
} from "@/lib/planner-outgoing-view";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
const EMPTY_ROUTES: Route[] = [];
const EMPTY_STOPS: Stop[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_RESOURCES: Record<string, PlannerOutgoingRouteResources> = {};
const liveBackoff = new LiveViewBackoff();

/**
 * Pass only the currently selected plan/day route scope. In live mode ALL
 * consumers (map, gantt, route/stop detail) must use these arrays together.
 */
export function usePlannerOutgoingView(workingRoutes: readonly Route[], workingStops: readonly Stop[], live: boolean) {
  const { user, isLoading: authLoading } = useAuth();
  const organizationId = user?.organizationId;
  const actorKey = JSON.stringify([organizationId, user?.id, user?.role]);
  const planRoutes = useMemo(() => workingRoutes.length ? [...workingRoutes] : EMPTY_ROUTES, [workingRoutes]);
  const planStops = useMemo(() => workingStops.length ? [...workingStops] : EMPTY_STOPS, [workingStops]);
  const routeIds = [...new Set(workingRoutes.map((route) => route.id))].sort();
  const scopeKey = routeIds.join(",");
  const identities = workingRoutes.map((route) => [
    route.id, route.handoffVersion, route.dispatchSnapshotVersion, route.handoffDriverId, route.handoffStatus,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const guardError = useMemo(() => {
    if (!live || authLoading) return null;
    if (!organizationId) return new PlannerOutgoingViewError("Logga in och välj en organisation för livevyn.", 401);
    if (user?.role !== "admin" && user?.role !== "dispatcher") {
      return new PlannerOutgoingViewError("Livevyn innehåller utskickade kontaktuppgifter och kräver administratör eller trafikledare.", 403);
    }
    if (routeIds.length > PLANNER_OUTGOING_SCOPE_LIMIT) {
      return new PlannerOutgoingViewError(`Avgränsa livevyn till högst ${PLANNER_OUTGOING_SCOPE_LIMIT} rutter. Ingen delmängd visas.`, 400);
    }
    if (workingRoutes.some((route) => route.organizationId !== organizationId)) {
      return new PlannerOutgoingViewError("Rutturvalet tillhör inte den aktiva organisationen. Läs in urvalet igen.", 409);
    }
    return null;
  }, [live, authLoading, organizationId, user?.role, scopeKey, workingRoutes]);
  const query = useQuery({
    // Existing route/stop realtime invalidation reaches this route-prefixed key.
    // Actor/role also isolate same-org logout/login and permission transitions.
    queryKey: ["/api/routes", organizationId, "outgoing-view", user?.id, user?.role, scopeKey, identities],
    enabled: live && !authLoading && !guardError && !!organizationId && routeIds.length > 0,
    retry: false,
    placeholderData: () => undefined,
    staleTime: LIVE_VIEW_POLL_MS,
    refetchInterval: live ? () => Math.max(LIVE_VIEW_POLL_MS, liveBackoff.remaining(actorKey)) : false,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => {
      // Focus events and realtime invalidations also obey the server's cooldown.
      liveBackoff.assertReady(actorKey);
      const response = await fetch(`${API_BASE}/routes/outgoing-view?${new URLSearchParams({ routeIds: scopeKey })}`, {
        credentials: "include", cache: "no-store", signal,
      });
      if (response.status === 429) {
        throw liveBackoff.pause(actorKey, response.headers.get("Retry-After"));
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = body && typeof body === "object" ? body as Record<string, unknown> : {};
        throw new PlannerOutgoingViewError(
          typeof error.error === "string" ? error.error : `Livevyn kunde inte läsas in (${response.status}).`,
          response.status, typeof error.code === "string" ? error.code : undefined,
          typeof error.routeId === "string" ? error.routeId : undefined,
        );
      }
      return parsePlannerOutgoingView(body, organizationId!, routeIds);
    },
  });
  const error = live ? guardError ?? query.error : null;
  const projected = live && !error && !authLoading ? query.data : undefined;
  const perRouteResources: Record<string, PlannerOutgoingRouteResources> =
    live ? projected?.perRouteResources ?? EMPTY_RESOURCES : EMPTY_RESOURCES;
  return {
    routes: live ? projected?.routes ?? EMPTY_ROUTES : planRoutes,
    stops: live ? projected?.stops ?? EMPTY_STOPS : planStops,
    omittedRouteIds: live ? projected?.omittedRouteIds ?? EMPTY_IDS : EMPTY_IDS,
    // Deliberately route-keyed: the same asset may have different approved
    // names/colors/pairs in distinct outgoing snapshots. Never flatten by asset.
    perRouteResources,
    isLoading: live && !error && (authLoading || (routeIds.length > 0 && !projected)),
    isFetching: live && query.isFetching,
    error,
    refetch: query.refetch,
  };
}
