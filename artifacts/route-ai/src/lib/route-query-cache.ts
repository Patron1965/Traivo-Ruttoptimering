import type { QueryClient } from "@tanstack/react-query";

const GENERATED_ROUTE_QUERY_PREFIX = "/api/routes/";

// Keep these in lockstep with the generated API client key factories. Defining
// the URL-shaped keys locally also lets this cache helper remain usable by
// small, dependency-free tests and by code paths that do not load React.
const getGetRouteQueryKey = (routeId: string) =>
  [`/api/routes/${routeId}`] as const;
const getGetRouteStopsQueryKey = (routeId: string) =>
  [`/api/routes/${routeId}/stops`] as const;

/**
 * Generated route reads use a full URL-shaped key (`/api/routes/:id`) rather
 * than the list key (`/api/routes`). Keep the detail and detail/stops reads
 * together so derived route evidence cannot remain cached after a resource or
 * policy change.
 */
export function isGeneratedRouteDetailQueryKey(
  queryKey: readonly unknown[],
  routeIds?: ReadonlySet<string>,
): boolean {
  const first = queryKey[0];
  if (typeof first !== "string" || !first.startsWith(GENERATED_ROUTE_QUERY_PREFIX)) {
    return false;
  }
  const suffix = first.slice(GENERATED_ROUTE_QUERY_PREFIX.length);
  const [routeId, child] = suffix.split("/");
  if (!routeId || (child !== undefined && child !== "stops")) return false;
  return routeIds == null || routeIds.has(routeId);
}

/**
 * Invalidate every route projection when the affected route IDs are not
 * included in a realtime resource event. If IDs are available, retain the
 * bounded detail invalidation while still refreshing list/stats projections.
 */
export function invalidateRouteQueries(
  queryClient: QueryClient,
  routeIds?: readonly string[],
): Promise<unknown[]> {
  const routeIdSet = routeIds?.length ? new Set(routeIds) : undefined;
  const invalidations: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] }),
    queryClient.invalidateQueries({
      predicate: (query) =>
        isGeneratedRouteDetailQueryKey(query.queryKey, routeIdSet),
    }),
  ];

  for (const routeId of routeIds ?? []) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: getGetRouteQueryKey(routeId),
      }),
      queryClient.invalidateQueries({
        queryKey: getGetRouteStopsQueryKey(routeId),
      }),
    );
  }
  return Promise.all(invalidations);
}