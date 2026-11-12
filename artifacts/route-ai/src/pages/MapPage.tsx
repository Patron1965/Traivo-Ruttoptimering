import { AppLayout } from "@/components/layout/AppLayout";
import { RouteMap } from "@/components/map/RouteMap";
import { useRoutes } from "@/hooks/use-routes";
import { useStops } from "@/hooks/use-stops";
import { useVehiclePositions, useGeofenceEvents } from "@/hooks/use-tracking";
import { LoadingState } from "@/components/ui/LoadingState";
import { useQueries } from "@tanstack/react-query";
import { getGetRouteStopsQueryOptions } from "@workspace/api-client-react";
import { useEffect, useMemo, useState } from "react";
import { Truck, MapPin, Radio, Battery, Navigation, Clock, Thermometer } from "lucide-react";
import { ROUTE_COLORS } from "@/lib/constants";
import { formatDistance, formatDuration } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useVehicles } from "@/hooks/use-vehicles";
import { selectMapRoutes, selectLiveRouteItems } from "@/lib/live-map";
import { liveMapPoint, liveRouteFocusPoints } from "@/lib/live-map-focus";

export default function MapPage() {
  const routesQuery = useRoutes();
  const stopsQuery = useStops();
  const positionsQuery = useVehiclePositions();
  const eventsQuery = useGeofenceEvents(20);
  const { data: routes, isLoading: loadingRoutes } = routesQuery;
  const { data: allStops, isLoading: loadingStops } = stopsQuery;
  const { data: vehicles } = useVehicles();
  const { t } = useTranslation();
  const [showPredictions, setShowPredictions] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selection, setSelection] = useState<{ routeId: string; vehicleKey?: string } | null>(null);
  const [focusBounds, setFocusBounds] = useState<{ coordinates: [number, number][]; request: number } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [positionUnavailable, setPositionUnavailable] = useState(false);
  const visibleRoutes = selectMapRoutes(routesQuery.isError ? [] : routes || [], showHistory);
  const positions = showHistory || positionsQuery.isError || routesQuery.isError ? [] : selectLiveRouteItems(positionsQuery.data || [], routes || []);
  const geofenceEvents = showHistory || eventsQuery.isError || routesQuery.isError ? [] : selectLiveRouteItems(eventsQuery.data || [], routes || []);

  const routeQueries = useQueries({
    queries: visibleRoutes.map(route => ({
      ...getGetRouteStopsQueryOptions(route.id),
      refetchInterval: 15000,
    }))
  });

  const isLoading = loadingRoutes || loadingStops || routeQueries.some(q => q.isLoading);
  const hasError = routesQuery.isError || stopsQuery.isError || routeQueries.some(q => q.isError)
    || (!showHistory && (positionsQuery.isError || eventsQuery.isError));
  const retry = () => {
    void routesQuery.refetch();
    void stopsQuery.refetch();
    void positionsQuery.refetch();
    void eventsQuery.refetch();
    routeQueries.forEach(q => void q.refetch());
  };

  const fullRoutesData = useMemo(() => {
    if (!routes) return [];
    const vehicleById = new Map(vehicles?.map((vehicle) => [vehicle.id, vehicle]) ?? []);
    return visibleRoutes.map((route, idx) => ({
      ...route,
      stopsList: routeQueries[idx]?.isError ? [] : routeQueries[idx]?.data || [],
      routeColor: route.vehicleId ? vehicleById.get(route.vehicleId)?.routeColor : undefined,
    }));
  }, [routes, visibleRoutes, routeQueries, vehicles]);

  const unassignedStops = useMemo(() => {
    if (!allStops || showHistory || stopsQuery.isError) return [];
    return allStops.filter(s => !s.routeId && s.status !== "completed" && s.status !== "failed");
  }, [allStops, showHistory, stopsQuery.isError]);

  const selectRoute = (routeId: string, vehicleKey?: string, point?: [number, number][]) => {
    const coordinates = point?.length ? point : liveRouteFocusPoints(fullRoutesData.find(route => route.id === routeId));
    setSelection({ routeId, vehicleKey });
    setPositionUnavailable(coordinates.length === 0);
    setFocusRequest(focusRequest + 1);
    setFocusBounds({ coordinates, request: focusRequest + 1 });
  };
  const clearSelection = () => {
    setSelection(null);
    setFocusBounds(null);
    setPositionUnavailable(false);
    setFocusRequest(request => request + 1);
  };
  const visibleRouteKey = visibleRoutes.map(route => route.id).join(",");
  useEffect(() => {
    if (selection && !visibleRoutes.some(route => route.id === selection.routeId)) {
      clearSelection();
    }
  }, [visibleRouteKey, selection]);
  const changeHistory = (history: boolean) => {
    setShowHistory(history);
    clearSelection();
  };

  if (isLoading) return <AppLayout><LoadingState message={t("map.initializingMap")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex flex-col h-full w-full">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
          <button type="button" aria-pressed={!showHistory} onClick={() => changeHistory(false)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${!showHistory ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{t("map.liveRoutes")}</button>
          <button type="button" aria-pressed={showHistory} onClick={() => changeHistory(true)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${showHistory ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{t("map.history")}</button>
          {selection && <button type="button" onClick={clearSelection} className="rounded-lg px-3 py-2 text-sm font-semibold bg-muted">{t("map.showAllRoutes", { defaultValue: "Visa alla rutter" })}</button>}
          <p className="text-sm text-muted-foreground">{t(showHistory ? "map.historyDescription" : "map.liveDescription")}</p>
        </div>
        {positionUnavailable && <p role="status" className="px-4 py-2 text-sm text-muted-foreground">{t("map.positionUnavailable", { defaultValue: "Position saknas för den valda rutten. Kartan kan inte centreras." })}</p>}
        {hasError && <div role="alert" className="px-4 py-3 bg-destructive/10 text-sm">{t("map.fetchError")} <button type="button" onClick={retry} className="underline font-semibold">{t("map.retry")}</button></div>}
        {!hasError && !isLoading && fullRoutesData.length === 0 && <p role="status" className="px-4 py-3 text-sm text-muted-foreground">{t(showHistory ? "map.noHistory" : "map.noActiveRoutes")}</p>}
        <div className="flex flex-1 min-h-0 w-full">
        <div className="w-80 border-r border-border bg-card/50 backdrop-blur-sm flex flex-col hidden lg:flex shrink-0">
          <div className="p-4 border-b border-border">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              {t(showHistory ? "map.history" : "map.liveRoutes")}
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {fullRoutesData.map((route, i) => (
              <button type="button" key={route.id} data-testid={`live-route-${route.id}`}
                aria-pressed={selection?.routeId === route.id}
                onClick={() => selectRoute(route.id)}
                className={`w-full text-left bg-background rounded-xl p-4 border shadow-sm group hover:border-primary/50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selection?.routeId === route.id ? "border-primary ring-2 ring-primary/30" : "border-border"}`}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: route.routeColor ?? ROUTE_COLORS[i % ROUTE_COLORS.length] }} />
                  <h3 className="font-bold truncate" title={route.name}>{route.name}</h3>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  <div className="bg-muted px-2 py-1.5 rounded text-center">
                    <p className="text-muted-foreground text-xs uppercase tracking-wider">{t("common.stops")}</p>
                    <p className="font-semibold">{route.totalStops}</p>
                  </div>
                  <div className="bg-muted px-2 py-1.5 rounded text-center">
                    <p className="text-muted-foreground text-xs uppercase tracking-wider">{t("common.distance")}</p>
                    <p className="font-semibold">{route.totalDistanceKm ? formatDistance(route.totalDistanceKm) : '--'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Truck className="h-3 w-3" />
                  <span>{t(`map.status${route.status.charAt(0).toUpperCase()}${route.status.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}</span>
                </div>
              </button>
            ))}

            {!hasError && fullRoutesData.length === 0 && (
              <div className="text-center p-8 text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{t(showHistory ? "map.noHistory" : "map.noActiveRoutes")}</p>
              </div>
            )}

            {positions && positions.length > 0 && (
              <>
                <div className="border-t border-border pt-4 mt-4">
                  <h3 className="font-bold text-sm flex items-center gap-2 mb-3 text-emerald-500">
                    <Radio className="h-4 w-4 animate-pulse" />
                    {t("map.liveVehicles")} ({positions.length})
                  </h3>
                  {positions.map((pos, idx) => (
                    <button type="button" key={`${pos.vehicleId}-${pos.routeId || idx}`}
                      data-testid={`live-vehicle-${pos.vehicleId}-${pos.routeId || idx}`}
                      aria-pressed={selection?.vehicleKey === `${pos.vehicleId}-${pos.routeId || idx}`}
                      onClick={() => pos.routeId && selectRoute(pos.routeId, `${pos.vehicleId}-${pos.routeId || idx}`, liveMapPoint(pos))}
                      className={`w-full text-left bg-background rounded-xl p-3 border shadow-sm mb-2 hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selection?.vehicleKey === `${pos.vehicleId}-${pos.routeId || idx}` ? "border-primary ring-2 ring-primary/30" : "border-border"}`}>
                      <div className="flex items-center gap-2">
                        <div className={`h-8 w-8 rounded-full flex items-center justify-center ${
                          pos.vehicleType === "electric" ? "bg-emerald-500/10" : "bg-amber-500/10"
                        }`}>
                          <Truck className={`h-4 w-4 ${pos.vehicleType === "electric" ? "text-emerald-500" : "text-amber-500"}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm truncate">{pos.vehicleName}</p>
                          <p className="text-[10px] text-muted-foreground">{pos.licensePlate}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold">{pos.speedKmh} km/h</p>
                        </div>
                      </div>
                      {pos.nextStopAddress && (
                        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                          <Navigation className="h-3 w-3" />
                          <span className="truncate">{pos.nextStopAddress}</span>
                          {pos.etaMinutes != null && (
                            <span className="ml-auto flex items-center gap-0.5 text-primary font-semibold shrink-0">
                              <Clock className="h-3 w-3" />
                              {pos.etaMinutes}m
                            </span>
                          )}
                        </div>
                      )}
                      {pos.batteryPercent != null && (
                        <div className="mt-2 flex items-center gap-2">
                          <Battery className="h-3 w-3 text-emerald-500" />
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                pos.batteryPercent > 50 ? "bg-emerald-500" : pos.batteryPercent > 20 ? "bg-amber-500" : "bg-destructive"
                              }`}
                              style={{ width: `${pos.batteryPercent}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-semibold">{Math.round(pos.batteryPercent)}%</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {geofenceEvents && geofenceEvents.length > 0 && (
              <div className="border-t border-border pt-4 mt-4">
                <h3 className="font-bold text-sm flex items-center gap-2 mb-3 text-violet-500">
                  <Radio className="h-4 w-4" />
                  {t("map.activityFeed")}
                </h3>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {geofenceEvents.map((event) => (
                    <div key={event.id} className="flex items-start gap-2 text-xs py-1.5 border-b border-border/30 last:border-0">
                      <div className={`mt-0.5 h-2 w-2 rounded-full shrink-0 ${
                        event.eventType === "entered" ? "bg-emerald-500" : "bg-amber-500"
                      }`} />
                      <div>
                        <p className="font-medium">
                          {event.vehicleName}{" "}
                          <span className="text-muted-foreground">
                            {event.eventType === "entered" ? t("map.arrivedAt") : t("map.departedFrom")}
                          </span>
                        </p>
                        <p className="text-muted-foreground truncate max-w-[200px]">{event.stopAddress}</p>
                        <p className="text-[10px] text-muted-foreground/60">
                          {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 relative">
          <div className="absolute inset-4 z-10 rounded-2xl overflow-hidden shadow-2xl shadow-black/20 border border-border/50">
            <RouteMap
              routes={fullRoutesData}
              unassignedStops={unassignedStops}
              vehiclePositions={positions || undefined}
              highlightedRouteId={selection?.routeId}
              onHighlightRoute={selectRoute}
              focusBounds={focusBounds}
              fitStopsRequest={focusRequest}
              showPredictions={showPredictions}
            />
          </div>
          <button
            type="button"
            aria-pressed={showPredictions}
            onClick={() => setShowPredictions(!showPredictions)}
            className={`absolute top-24 right-8 z-20 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg border backdrop-blur-md transition-all text-sm font-semibold ${
              showPredictions
                ? "bg-orange-500 text-white border-orange-600 shadow-orange-500/30"
                : "bg-card/90 text-foreground border-border hover:border-primary/50"
            }`}
          >
            <Thermometer className="h-4 w-4" />
            {t("predictions.heatmap")}
          </button>
        </div>
        </div>
      </div>
    </AppLayout>
  );
}
