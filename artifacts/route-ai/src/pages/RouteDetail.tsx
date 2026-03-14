import { useEffect, useState, useMemo } from "react";
import { useRoute, useRouteStops, useUpdateRoute } from "@/hooks/use-routes";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { useUpdateStop } from "@/hooks/use-stops";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { sv, enUS } from "date-fns/locale";
import { ROUTE_COLORS, DEPOT_LOCATION } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { MapContainer, TileLayer, Marker, Polyline, Popup, ZoomControl } from "react-leaflet";
import L from "leaflet";
import { renderToString } from "react-dom/server";
import { fetchRouteGeometry } from "@/lib/osrm";
import {
  ArrowLeft,
  MapPin,
  Clock,
  Gauge,
  Leaf,
  Truck,
  User,
  CheckCircle2,
  XCircle,
  SkipForward,
  Package,
  Warehouse,
} from "lucide-react";

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: "bg-muted/50", text: "text-muted-foreground", label: "routes.statusDraft" },
  optimized: { bg: "bg-primary/20", text: "text-primary", label: "routes.statusOptimized" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "routes.statusInProgress" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400", label: "routes.statusCompleted" },
  cancelled: { bg: "bg-destructive/20", text: "text-destructive", label: "routes.statusCancelled" },
};

const STOP_STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  pending: { bg: "bg-muted/50", text: "text-muted-foreground" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  failed: { bg: "bg-destructive/20", text: "text-destructive" },
  skipped: { bg: "bg-orange-500/20", text: "text-orange-400" },
};

function createNumberedIcon(color: string, label: string) {
  const html = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 32, height: 32 }}>
      <div className="absolute inset-0 rounded-full opacity-20" style={{ backgroundColor: color, transform: "scale(1.5)" }} />
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill={color} stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3" fill="white"/>
      </svg>
      <span className="absolute top-[6px] font-bold text-[10px] text-gray-900">{label}</span>
    </div>
  );
  return L.divIcon({ html, className: "custom-leaflet-icon", iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32] });
}

function createDepotIcon() {
  const html = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 32, height: 32 }}>
      <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center border-2 border-primary shadow-lg shadow-primary/40">
        <Warehouse className="w-5 h-5 text-primary" />
      </div>
    </div>
  );
  return L.divIcon({ html, className: "custom-leaflet-icon", iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32] });
}

interface RouteDetailProps {
  id: string;
}

export default function RouteDetail({ id }: RouteDetailProps) {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const dateLocale = i18n.language === "sv" ? sv : enUS;
  const queryClient = useQueryClient();

  const { data: route, isLoading: routeLoading } = useRoute(id);
  const { data: stops, isLoading: stopsLoading } = useRouteStops(id);
  const { data: vehicles } = useVehicles();
  const { data: drivers } = useDrivers();
  const updateStop = useUpdateStop();
  const updateRoute = useUpdateRoute();

  const sortedStops = useMemo(() => {
    if (!stops) return [];
    return [...stops].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
  }, [stops]);

  const vehicle = useMemo(() => {
    if (!route?.vehicleId || !vehicles) return null;
    return vehicles.find((v) => v.id === route.vehicleId) || null;
  }, [route?.vehicleId, vehicles]);

  const driver = useMemo(() => {
    if (!vehicle || !drivers) return null;
    return drivers.find((d) => d.vehicleId === vehicle.id) || null;
  }, [vehicle, drivers]);

  const completedCount = sortedStops.filter((s) => s.status === "completed").length;
  const totalCount = sortedStops.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const [routeGeometry, setRouteGeometry] = useState<[number, number][]>([]);
  useEffect(() => {
    setRouteGeometry([]);
    if (sortedStops.length === 0) return;
    let cancelled = false;
    const waypoints: [number, number][] = [
      [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
      ...sortedStops.map((s) => [s.latitude, s.longitude] as [number, number]),
      [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
    ];
    fetchRouteGeometry(waypoints).then((geo) => {
      if (!cancelled) setRouteGeometry(geo);
    });
    return () => { cancelled = true; };
  }, [sortedStops]);

  const handleStatusChange = (stopId: string, status: "completed" | "failed" | "skipped") => {
    updateStop.mutate(
      { id: stopId, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/routes", id, "stops"] });
          queryClient.invalidateQueries({ queryKey: ["/api/routes"] });

          if (!route) return;

          const updatedStops = sortedStops.map((s) =>
            s.id === stopId ? { ...s, status } : s
          );
          const terminalStatuses = ["completed", "failed", "skipped"];
          const allTerminal = updatedStops.every((s) => terminalStatuses.includes(s.status));
          const anyNonPending = updatedStops.some((s) => s.status !== "pending");

          if (allTerminal) {
            const allCompleted = updatedStops.every((s) => s.status === "completed");
            if (allCompleted) {
              updateRoute.mutate({
                id: route.id,
                data: { status: "completed" },
              });
            }
          } else if (anyNonPending && route.status !== "in_progress") {
            updateRoute.mutate({
              id: route.id,
              data: { status: "in_progress" },
            });
          }
        },
      }
    );
  };

  if (routeLoading || stopsLoading) {
    return (
      <AppLayout>
        <div className="p-8">
          <LoadingState message={t("routeDetail.loading")} />
        </div>
      </AppLayout>
    );
  }

  if (!route) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
          <p className="text-destructive">{t("routeDetail.notFound")}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/routes")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("routeDetail.backToRoutes")}
          </Button>
        </div>
      </AppLayout>
    );
  }

  const routeStyle = STATUS_STYLES[route.status] || STATUS_STYLES.draft;
  const routeColor = ROUTE_COLORS[0];

  const fallbackPath: [number, number][] = sortedStops.length > 0
    ? [
        [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
        ...sortedStops.map((s) => [s.latitude, s.longitude] as [number, number]),
        [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
      ]
    : [];
  const polylinePath = routeGeometry.length > 0 ? routeGeometry : fallbackPath;

  const mapCenter: [number, number] = sortedStops.length > 0
    ? [
        sortedStops.reduce((sum, s) => sum + s.latitude, 0) / sortedStops.length,
        sortedStops.reduce((sum, s) => sum + s.longitude, 0) / sortedStops.length,
      ]
    : [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng];

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/routes")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{route.name}</h1>
              <span className={cn("px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wide", routeStyle.bg, routeStyle.text)}>
                {t(routeStyle.label)}
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {route.date ? format(new Date(route.date), "PPP", { locale: dateLocale }) : t("common.noDate")}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {vehicle && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Truck className="h-3.5 w-3.5" />
                {t("common.vehicle")}
              </div>
              <p className="font-semibold text-sm">{vehicle.name}</p>
              <p className="text-xs text-muted-foreground">{vehicle.licensePlate}</p>
            </div>
          )}
          {driver && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <User className="h-3.5 w-3.5" />
                {t("routeDetail.driver")}
              </div>
              <p className="font-semibold text-sm">{driver.name}</p>
            </div>
          )}
          <div className="p-3 rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <MapPin className="h-3.5 w-3.5" />
              {t("common.stops")}
            </div>
            <p className="font-semibold text-sm">{route.totalStops}</p>
          </div>
          {route.totalDistanceKm != null && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Gauge className="h-3.5 w-3.5" />
                {t("common.distance")}
              </div>
              <p className="font-semibold text-sm">{route.totalDistanceKm} km</p>
            </div>
          )}
          {route.totalDurationMin != null && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Clock className="h-3.5 w-3.5" />
                {t("common.duration")}
              </div>
              <p className="font-semibold text-sm">{Math.floor(route.totalDurationMin / 60)}h {Math.round(route.totalDurationMin % 60)}m</p>
            </div>
          )}
          {route.co2EmissionsKg != null && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Leaf className="h-3.5 w-3.5" />
                {t("common.co2")}
              </div>
              <p className="font-semibold text-sm">{route.co2EmissionsKg} kg</p>
            </div>
          )}
        </div>

        {totalCount > 0 && (
          <div className="p-4 rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{t("routeDetail.progress")}</span>
              <span className="text-sm text-muted-foreground">
                {completedCount}/{totalCount} {t("routeDetail.delivered")}
              </span>
            </div>
            <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  progressPercent === 100 ? "bg-emerald-500" : "bg-primary"
                )}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-border bg-card overflow-hidden" style={{ height: 400 }}>
            {sortedStops.length > 0 ? (
              <MapContainer center={mapCenter} zoom={12} className="w-full h-full z-0" zoomControl={false}>
                <ZoomControl position="bottomright" />
                <TileLayer
                  url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
                />
                <Marker position={[DEPOT_LOCATION.lat, DEPOT_LOCATION.lng]} icon={createDepotIcon()}>
                  <Popup><div className="p-2 font-bold">{t("map.centralDepot")}</div></Popup>
                </Marker>
                {polylinePath.length > 0 && (
                  <Polyline positions={polylinePath} pathOptions={{ color: routeColor, weight: 4, opacity: 0.8 }} />
                )}
                {sortedStops.map((stop, idx) => (
                  <Marker key={stop.id} position={[stop.latitude, stop.longitude]} icon={createNumberedIcon(routeColor, (idx + 1).toString())}>
                    <Popup>
                      <div className="p-2 min-w-[180px]">
                        <h4 className="font-bold">{stop.notes || t("common.deliveryStop")}</h4>
                        <p className="text-sm text-muted-foreground mt-1">{stop.address}</p>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                <MapPin className="h-8 w-8 opacity-30" />
              </div>
            )}
          </div>

          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
            <h2 className="text-lg font-semibold mb-3 sticky top-0 bg-background py-1">{t("routeDetail.stopList")}</h2>
            {sortedStops.map((stop, idx) => {
              const stopStyle = STOP_STATUS_STYLES[stop.status] || STOP_STATUS_STYLES.pending;
              const isTerminal = stop.status === "completed" || stop.status === "failed" || stop.status === "skipped";
              return (
                <div key={stop.id} className="p-3 rounded-xl border border-border bg-card hover:bg-card/80 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold" style={{ backgroundColor: `${routeColor}20`, color: routeColor }}>
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-medium text-sm truncate">{stop.notes || stop.address}</p>
                        <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-medium uppercase", stopStyle.bg, stopStyle.text)}>
                          {t(`routeDetail.stop_${stop.status}`)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{stop.address}</p>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                        {stop.timeWindowStart && stop.timeWindowEnd && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {format(new Date(stop.timeWindowStart), "HH:mm")} - {format(new Date(stop.timeWindowEnd), "HH:mm")}
                          </span>
                        )}
                        {(stop.weightKg != null || stop.volumeM3 != null) && (
                          <span className="flex items-center gap-1">
                            <Package className="h-3 w-3" />
                            {stop.weightKg != null && `${stop.weightKg}kg`}
                            {stop.weightKg != null && stop.volumeM3 != null && " / "}
                            {stop.volumeM3 != null && `${stop.volumeM3}m³`}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {stop.serviceDurationMin} {t("common.mins")}
                        </span>
                      </div>
                    </div>
                    {!isTerminal && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                          onClick={() => handleStatusChange(stop.id, "completed")}
                          title={t("routeDetail.markDelivered")}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleStatusChange(stop.id, "failed")}
                          title={t("routeDetail.markFailed")}
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2 text-orange-500 hover:text-orange-400 hover:bg-orange-500/10"
                          onClick={() => handleStatusChange(stop.id, "skipped")}
                          title={t("routeDetail.markSkipped")}
                        >
                          <SkipForward className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {sortedStops.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>{t("routeDetail.noStops")}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
