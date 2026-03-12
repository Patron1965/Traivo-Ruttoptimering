import { AppLayout } from "@/components/layout/AppLayout";
import { RouteMap } from "@/components/map/RouteMap";
import { useRoutes } from "@/hooks/use-routes";
import { useStops } from "@/hooks/use-stops";
import { useVehiclePositions, useGeofenceEvents } from "@/hooks/use-tracking";
import { LoadingState } from "@/components/ui/LoadingState";
import { useQueries } from "@tanstack/react-query";
import { getGetRouteStopsQueryOptions } from "@workspace/api-client-react";
import { useMemo } from "react";
import { Truck, MapPin, Radio, Battery, Navigation, Clock } from "lucide-react";
import { ROUTE_COLORS } from "@/lib/constants";
import { formatDistance, formatDuration } from "@/lib/utils";
import { useTranslation } from "react-i18next";

export default function MapPage() {
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops();
  const { data: positions } = useVehiclePositions();
  const { data: geofenceEvents } = useGeofenceEvents(20);
  const { t } = useTranslation();

  const routeQueries = useQueries({
    queries: (routes || []).map(route => getGetRouteStopsQueryOptions(route.id))
  });

  const isLoading = loadingRoutes || loadingStops || routeQueries.some(q => q.isLoading);

  const fullRoutesData = useMemo(() => {
    if (!routes) return [];
    return routes.map((route, idx) => ({
      ...route,
      stopsList: routeQueries[idx]?.data || []
    }));
  }, [routes, routeQueries]);

  const unassignedStops = useMemo(() => {
    if (!allStops) return [];
    return allStops.filter(s => !s.routeId);
  }, [allStops]);

  if (isLoading) return <AppLayout><LoadingState message={t("map.initializingMap")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-full w-full">
        <div className="w-80 border-r border-border bg-card/50 backdrop-blur-sm flex flex-col hidden lg:flex shrink-0">
          <div className="p-4 border-b border-border">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              {t("map.liveRoutes")}
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {fullRoutesData.map((route, i) => (
              <div key={route.id} className="bg-background rounded-xl p-4 border border-border shadow-sm group hover:border-primary/50 transition-colors">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: ROUTE_COLORS[i % ROUTE_COLORS.length] }} />
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
              </div>
            ))}

            {fullRoutesData.length === 0 && (
              <div className="text-center p-8 text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{t("map.noActiveRoutes")}</p>
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
                    <div key={`${pos.vehicleId}-${pos.routeId || idx}`} className="bg-background rounded-xl p-3 border border-border shadow-sm mb-2">
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
                    </div>
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
            />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
