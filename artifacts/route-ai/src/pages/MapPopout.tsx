import { useState, useMemo, useEffect, useCallback } from "react";
import { useRoutes } from "@/hooks/use-routes";
import { useStops } from "@/hooks/use-stops";
import { RouteMap } from "@/components/map/RouteMap";
import { LoadingState } from "@/components/ui/LoadingState";
import { ROUTE_COLORS } from "@/lib/constants";
import { useDispatchChannel } from "@/hooks/use-dispatch-channel";
import { useTranslation } from "react-i18next";
import type { Stop } from "@workspace/api-client-react";
import { useVehicles } from "@/hooks/use-vehicles";
import { useLocation, useSearch } from "wouter";
import { mapPopoutHref, readDispatchScope, selectScopedRoutes, selectScopedUnassignedStops } from "@/lib/dispatch-scope";
import { useDispatchRouteSelection } from "@/hooks/use-dispatch-route-selection";
import { useAuth } from "@/lib/auth-context";
import { selectDriverRoute } from "@/lib/dispatch-route-selection";
import LiveMapPopout from "@/pages/LiveMapPopout";

export default function MapPopout() {
  const search = useSearch();
  // The live monitor shares this pathname so a platform workspace popup can
  // inherit its original scope; it is otherwise fully independent.
  if (new URLSearchParams(search).get("live") === "1") return <LiveMapPopout />;
  return <PlanningMapPopout />;
}

function PlanningMapPopout() {
  const { t } = useTranslation();
  const search = useSearch();
  const [, navigate] = useLocation();
  const scope = useMemo(() => readDispatchScope(search), [search]);
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops(undefined, true);
  const { data: vehicles } = useVehicles();
  const { user } = useAuth();

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const { highlightedRouteId, highlightedRouteIds, setHighlightedRouteId,
    setHighlightedRouteIds, scopeKey } = useDispatchRouteSelection(
      search, routes, `${user?.organizationId ?? ""}:${user?.id ?? ""}`,
    );
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [fitStopsRequest, setFitStopsRequest] = useState(0);

  const activeRoutes = useMemo(
    () => selectScopedRoutes(routes ?? [], scope),
    [routes, scope],
  );

  useEffect(() => {
    const onScopeChange = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !window.opener || event.source !== window.opener) return;
      if (event.data?.type !== "traivo-map-scope" || typeof event.data.search !== "string") return;
      navigate(mapPopoutHref(event.data.search), { replace: true });
    };
    window.addEventListener("message", onScopeChange);
    window.opener?.postMessage({ type: "traivo-map-ready" }, window.location.origin);
    return () => window.removeEventListener("message", onScopeChange);
  }, [navigate]);

  useEffect(() => {
    setSelectedStopId(null);
    setHoveredStopId(null);
    setHighlightedRouteId(scope.routeId ?? null);
    setFocusStopId(null);
    setFitStopsRequest((request) => request + 1);
  }, [scope]);

  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, Stop[]>();
    if (!allStops) return map;
    allStops.forEach((s) => {
      if (s.routeId) {
        const arr = map.get(s.routeId) ?? [];
        arr.push(s);
        map.set(s.routeId, arr);
      }
    });
    return map;
  }, [allStops]);

  const unassignedStops = useMemo(
    () => selectScopedUnassignedStops(allStops ?? [], scope, activeRoutes),
    [allStops, scope, activeRoutes],
  );

  const mapRoutes = useMemo(() => {
    const vehicleById = new Map(vehicles?.map((vehicle) => [vehicle.id, vehicle]) ?? []);
    return activeRoutes.map((route, idx) => {
      const routeStops = stopsByRouteId.get(route.id) ?? [];
      const sorted = [...routeStops].sort(
        (a, b) => (a.sequenceOrder ?? Infinity) - (b.sequenceOrder ?? Infinity),
      );
      return {
        ...route,
        stopsList: sorted,
        routeColor: route.vehicleId ? vehicleById.get(route.vehicleId)?.routeColor : undefined,
        color: route.vehicleId
          ? vehicleById.get(route.vehicleId)?.routeColor ?? ROUTE_COLORS[idx % ROUTE_COLORS.length]
          : ROUTE_COLORS[idx % ROUTE_COLORS.length],
      };
    });
  }, [activeRoutes, stopsByRouteId, vehicles]);

  const onChannelMessage = useCallback((msg: {
    type: string;
    stopId?: string | null;
    routeId?: string | null;
    routeIds?: string[];
    scopeKey?: string;
  }) => {
    if (msg.type === "hover") setHoveredStopId(msg.stopId ?? null);
    else if (msg.type === "select") setSelectedStopId(msg.stopId ?? null);
    else if (msg.type === "route-selection") {
      if (msg.scopeKey === scopeKey && Array.isArray(msg.routeIds)) setHighlightedRouteIds(msg.routeIds);
    }
    else if (msg.type === "highlight") setHighlightedRouteId(msg.routeId ?? null);
    else if (msg.type === "focus") {
      setFocusStopId(msg.stopId ?? null);
      setSelectedStopId(msg.stopId ?? null);
    } else if (msg.type === "ping") {
      // handled via send below
    } else if (msg.type === "close") {
      window.close();
    }
  }, [scopeKey, setHighlightedRouteId, setHighlightedRouteIds]);

  const { send } = useDispatchChannel("popout", onChannelMessage, () => window.opener);

  useEffect(() => {
    send({ type: "pong" });
    document.title = "Traivo Route — Karta";
    // The opener checks Window.closed. Unload also means reload, not close.
  }, [send]);

  const handleSelectStop = useCallback(
    (stopId: string) => {
      setSelectedStopId(stopId);
      send({ type: "select", stopId });
    },
    [send],
  );

  const handleHighlightRoute = useCallback(
    (routeId: string) => {
      const next = highlightedRouteId === routeId ? null : routeId;
      setHighlightedRouteId(next);
      send({ type: "route-selection", routeIds: next ? [next] : [], scopeKey });
    },
    [send, scopeKey, highlightedRouteId, setHighlightedRouteId],
  );

  const handleSelectDriverRoute = useCallback((routeId: string, additive: boolean) => {
    const ids = [...selectDriverRoute(highlightedRouteIds, routeId, additive)];
    setHighlightedRouteIds(ids);
    send({ type: "route-selection", routeIds: ids, scopeKey });
  }, [highlightedRouteIds, scopeKey, send, setHighlightedRouteIds]);

  const handleClearDriverRoutes = useCallback(() => {
    setHighlightedRouteIds([]);
    send({ type: "route-selection", routeIds: [], scopeKey });
  }, [scopeKey, send, setHighlightedRouteIds]);

  if (loadingRoutes || loadingStops) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background overflow-hidden">
      <header className="h-10 border-b border-border bg-card/80 backdrop-blur flex items-center px-3 shrink-0 gap-2">
        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-xs font-semibold">{t("dispatch.mapPopoutTitle")}</span>
        <span data-testid="map-popout-counts" className="text-[10px] text-muted-foreground ml-auto">
          {mapRoutes.length} {t("dispatch.routesLabel")} · {unassignedStops.length} {t("dispatch.unplannedLabel")}
        </span>
      </header>
      <div className="flex-1 min-h-0">
        <RouteMap
          planningActionsEnabled
          routes={mapRoutes}
          unassignedStops={unassignedStops}
          interactive
          selectedStopId={selectedStopId}
          onSelectStop={handleSelectStop}
          highlightedRouteId={highlightedRouteId}
          highlightedRouteIds={highlightedRouteIds}
          onHighlightRoute={handleHighlightRoute}
          onSelectDriverRoute={handleSelectDriverRoute}
          onClearDriverRoutes={handleClearDriverRoutes}
          focusStopId={focusStopId}
          hoveredStopId={hoveredStopId}
          preserveRouteVisibility
          fitStopsRequest={fitStopsRequest}
        />
      </div>
    </div>
  );
}
