import type { QueryClient } from "@tanstack/react-query";
import type { Route } from "@workspace/api-client-react";

export type LockedFirstStopInput = {
  routeId: string;
  stopId: string | null;
  planRevision: number;
};

export class RouteLockRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    const body = data && typeof data === "object"
      ? data as Record<string, unknown>
      : {};
    const message = typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : "Could not update the first-stop lock";
    super(message);
    this.name = "RouteLockRequestError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : undefined;
    this.data = data;
  }
}

function routeQueryMatches(queryKey: readonly unknown[], routeId: string): boolean {
  return queryKey.some((part) => part === routeId)
    || queryKey.some((part) =>
      typeof part === "string"
      && (
        part === `/api/routes/${routeId}`
        || part === `/api/routes/${routeId}/stops`
        || part.startsWith(`/api/import/route-plans/`)
      ),
    );
}

/**
 * A lock changes the route ordering/schedule and the approval/draft
 * projections. Invalidate all of those projections together; a lock is not a
 * client-only annotation.
 */
export function invalidateRouteLockQueries(
  queryClient: QueryClient,
  routeId: string,
  organizationId?: string,
  planId?: string | null,
): Promise<unknown[]> {
  const invalidations: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
    queryClient.invalidateQueries({ queryKey: ["planning-drafts"] }),
    queryClient.invalidateQueries({
      predicate: (query) => {
        const stringParts = query.queryKey.filter(
          (part): part is string => typeof part === "string",
        );
        if (
          planId
          && stringParts.some((part) => part === planId)
          && stringParts.some((part) =>
            /approval|planning-summary|getImportRoutePlanPlanningSummary/i.test(part),
          )
        ) {
          return true;
        }
        if (
          planId
          && stringParts.some((part) =>
            part.includes(`/api/import/route-plans/${planId}/`),
          )
        ) {
          return true;
        }
        if (!routeQueryMatches(query.queryKey, routeId)) return false;
        return query.queryKey.some((part) =>
          typeof part === "string"
          && (
            part.includes("/approval")
            || part.includes("/planning-summary")
            || part === `/api/routes/${routeId}`
            || part === `/api/routes/${routeId}/stops`
          ),
        );
      },
    }),
  ];

  // These are the keys used by the route detail hooks (the generated route
  // client uses URL-shaped keys, while these hooks include organization).
  if (organizationId) {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: ["/api/routes", organizationId, routeId] }),
      queryClient.invalidateQueries({ queryKey: ["/api/routes", organizationId, routeId, "stops"] }),
    );
  }
  return Promise.all(invalidations);
}

export function patchRouteLockCaches(
  queryClient: QueryClient,
  savedRoute: Route,
  organizationId?: string,
): void {
  queryClient.setQueriesData(
    { queryKey: ["/api/routes"] },
    (cached: unknown) => {
      if (Array.isArray(cached)) {
        return cached.map((entry) =>
          entry && typeof entry === "object" && (entry as { id?: unknown }).id === savedRoute.id
            ? savedRoute
            : entry,
        );
      }
      if (cached && typeof cached === "object" && (cached as { id?: unknown }).id === savedRoute.id) {
        return savedRoute;
      }
      return cached;
    },
  );
  queryClient.setQueryData(
    ["/api/routes", organizationId, savedRoute.id],
    savedRoute,
  );
  queryClient.setQueryData(
    ["/api/routes", organizationId, savedRoute.id, "route"],
    savedRoute,
  );
}