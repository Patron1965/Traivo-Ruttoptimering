import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { Route } from "@workspace/api-client-react";
import { readDispatchScope, selectScopedRoutes } from "@/lib/dispatch-scope";
import { reconcileDriverRoutes, selectDriverRoute, singleDriverRoute } from "@/lib/dispatch-route-selection";

export function useDispatchRouteSelection(
  search: string,
  routes: Route[] | undefined,
  ownerKey: string,
) {
  const { planId, routeId, day } = readDispatchScope(search);
  const scopeKey = JSON.stringify([ownerKey, planId, routeId, day]);
  const allowed = useMemo(() => new Set(
    selectScopedRoutes(routes ?? [], { planId, routeId, day }).map((route) => route.id),
  ), [routes, planId, routeId, day]);
  const [selection, setSelection] = useState({ scopeKey, ids: new Set<string>() });
  const highlightedRouteIds = useMemo(() =>
    selection.scopeKey === scopeKey
      ? reconcileDriverRoutes(selection.ids, allowed)
      : new Set<string>(),
  [selection, scopeKey, allowed]);
  const highlightedRouteId = singleDriverRoute(highlightedRouteIds);
  const contextRef = useRef({ scopeKey, allowed, routesReady: Boolean(routes) });
  contextRef.current = { scopeKey, allowed, routesReady: Boolean(routes) };

  // Commit pruning so a removed route cannot become selected again if it returns.
  useEffect(() => {
    if (!routes) return;
    setSelection((current) => {
      const ids = current.scopeKey === scopeKey
        ? reconcileDriverRoutes(current.ids, allowed) : new Set<string>();
      return current.scopeKey === scopeKey && ids.size === current.ids.size
        ? current : { scopeKey, ids };
    });
  }, [scopeKey, routes, allowed]);

  const setHighlightedRouteIds = useCallback((ids: readonly string[]) => {
    const { scopeKey, allowed, routesReady } = contextRef.current;
    setSelection({ scopeKey, ids: routesReady ? reconcileDriverRoutes(new Set(ids), allowed) : new Set(ids) });
  }, []);
  const setHighlightedRouteId = useCallback((value: SetStateAction<string | null>) => {
    const { scopeKey, allowed, routesReady } = contextRef.current;
    setSelection((current) => {
      const ids = current.scopeKey === scopeKey
        ? reconcileDriverRoutes(current.ids, allowed) : new Set<string>();
      const next = typeof value === "function" ? value(singleDriverRoute(ids)) : value;
      return { scopeKey, ids: next && (!routesReady || allowed.has(next)) ? new Set([next]) : new Set<string>() };
    });
  }, []);
  const selectRoute = useCallback((id: string, additive: boolean) => {
    const { scopeKey, allowed } = contextRef.current;
    if (!allowed.has(id)) return;
    setSelection((current) => ({
      scopeKey,
      ids: selectDriverRoute(
        current.scopeKey === scopeKey ? reconcileDriverRoutes(current.ids, allowed) : new Set(),
        id, additive,
      ),
    }));
  }, []);
  const clearRoutes = useCallback(() => {
    setSelection({ scopeKey: contextRef.current.scopeKey, ids: new Set<string>() });
  }, []);

  return { scopeKey, highlightedRouteId, highlightedRouteIds, setHighlightedRouteId,
    setHighlightedRouteIds, selectRoute, clearRoutes };
}
