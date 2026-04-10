import { useRoutes, useDeleteRoute } from "@/hooks/use-routes";
import { useDrivers, useUpdateDriver } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Route as RouteIcon, Trash2, MapPin, Clock, Gauge, Download, User, Plus, Shield } from "lucide-react";
import { Link, useLocation } from "wouter";
import { format } from "date-fns";
import { sv, enUS } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Route, getExportRouteUrl } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import { useTranslation } from "react-i18next";
import { useMemo, useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ContinuousOptimization } from "@/components/ContinuousOptimization";
import { useSustainabilityStats } from "@/hooks/use-sustainability";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { renderToString } from "react-dom/server";

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-muted/50", text: "text-muted-foreground" },
  optimized: { bg: "bg-primary/20", text: "text-primary" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  cancelled: { bg: "bg-destructive/20", text: "text-destructive" },
};

function stopIcon(highlighted: boolean) {
  return L.divIcon({
    className: "",
    html: renderToString(
      <div className={cn(
        "flex items-center justify-center h-6 w-6 rounded-full border-2 shadow-lg",
        highlighted ? "bg-primary border-primary/60 text-white" : "bg-muted border-border text-muted-foreground"
      )}>
        <MapPin className="h-3 w-3" />
      </div>
    ),
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function FitStops({ stops }: { stops: Array<{ latitude: number; longitude: number }> }) {
  const map = useMap();
  useEffect(() => {
    if (stops.length === 0) return;
    const bounds = L.latLngBounds(stops.map((s) => [s.latitude, s.longitude]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }, [stops, map]);
  return null;
}

export default function Routes() {
  const { data: routes, isLoading, error } = useRoutes();
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();
  const { data: stops } = useStops();
  const { data: sustainabilityStats } = useSustainabilityStats();
  const deleteRoute = useDeleteRoute();
  const updateDriver = useUpdateDriver();
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const dateLocale = i18n.language === "sv" ? sv : enUS;

  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  const envScoreByRouteId = useMemo(() => {
    const map = new Map<string, { score: number; isNight: boolean }>();
    sustainabilityStats?.routeEnvironmentalScores?.forEach((s) => map.set(s.routeId, { score: s.environmentalScore, isNight: s.isNightRoute }));
    return map;
  }, [sustainabilityStats]);

  const activeDrivers = useMemo(() => drivers?.filter((d) => d.isActive) || [], [drivers]);

  const driverByVehicleId = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    activeDrivers.forEach((d) => {
      if (d.vehicleId) map.set(d.vehicleId, { id: d.id, name: d.name });
    });
    return map;
  }, [activeDrivers]);

  const vehicleNameById = useMemo(() => {
    const map = new Map<string, string>();
    vehicles?.forEach((v) => map.set(v.id, v.name));
    return map;
  }, [vehicles]);

  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, Array<{ id: string; address: string; latitude: number; longitude: number; notes?: string | null }>>();
    stops?.forEach((s) => {
      if (s.routeId) {
        if (!map.has(s.routeId)) map.set(s.routeId, []);
        map.get(s.routeId)!.push({ id: s.id, address: s.address, latitude: s.latitude, longitude: s.longitude, notes: s.notes ?? null });
      }
    });
    return map;
  }, [stops]);

  const selectedRouteStops = selectedRouteId ? (stopsByRouteId.get(selectedRouteId) || []) : [];

  const handleAssignDriver = (vehicleId: string, driverId: string) => {
    const current = driverByVehicleId.get(vehicleId);
    if (driverId === "__none__") {
      if (current) {
        updateDriver.mutate({ id: current.id, data: { vehicleId: null }, params: { organizationId: ORG_ID } });
      }
    } else {
      const doAssign = () => {
        updateDriver.mutate({ id: driverId, data: { vehicleId }, params: { organizationId: ORG_ID } });
      };
      if (current && current.id !== driverId) {
        updateDriver.mutate(
          { id: current.id, data: { vehicleId: null }, params: { organizationId: ORG_ID } },
          { onSuccess: doAssign }
        );
      } else {
        doAssign();
      }
    }
  };

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{t("routes.title")}</h1>
                <p className="text-muted-foreground text-sm mt-0.5">{t("routes.subtitle")}</p>
              </div>
              <Link href="/routes/create">
                <Button className="gap-2">
                  <Plus className="h-4 w-4" />
                  {t("routes.createRoute")}
                </Button>
              </Link>
            </div>

            <ContinuousOptimization />

            {isLoading && <LoadingState message={t("routes.loadingRoutes")} />}
            {error && <p className="text-destructive">{t("routes.failedToLoad")}</p>}

            {routes && routes.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <RouteIcon className="h-12 w-12 mx-auto mb-4 opacity-30" />
                <p>{t("routes.noRoutes")}</p>
              </div>
            )}

            {routes && routes.length > 0 && (
              <div className="space-y-2 mt-4">
                {routes.map((route: Route) => {
                  const style = STATUS_STYLES[route.status] || STATUS_STYLES.draft;
                  const isSelected = selectedRouteId === route.id;
                  return (
                    <div
                      key={route.id}
                      className={cn(
                        "p-4 rounded-xl border transition-colors cursor-pointer",
                        isSelected
                          ? "border-primary bg-primary/5"
                          : "border-border bg-card hover:bg-card/80"
                      )}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button, a, [role="combobox"]')) return;
                        if (isSelected) {
                          navigate(`/routes/${route.id}`);
                        } else {
                          setSelectedRouteId(route.id);
                        }
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                            <RouteIcon className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <h3 className="font-semibold text-sm text-primary hover:underline">{route.name}</h3>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{route.date ? format(new Date(route.date), "PPP", { locale: dateLocale }) : t("common.noDate")}</span>
                              {route.vehicleId && (
                                <>
                                  <span className="text-border">·</span>
                                  <span>{vehicleNameById.get(route.vehicleId) || t("common.vehicle")}</span>
                                  {driverByVehicleId.get(route.vehicleId) && (
                                    <>
                                      <span className="text-border">·</span>
                                      <span className="inline-flex items-center gap-1">
                                        <User className="h-3 w-3" />
                                        {driverByVehicleId.get(route.vehicleId)!.name}
                                      </span>
                                    </>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <MapPin className="h-3.5 w-3.5" />
                            <span>{route.totalStops} {t("common.stops")}</span>
                          </div>

                          {route.totalDistanceKm != null && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Gauge className="h-3.5 w-3.5" />
                              <span>{route.totalDistanceKm} km</span>
                            </div>
                          )}

                          {route.totalDurationMin != null && (
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Clock className="h-3.5 w-3.5" />
                              <span>{Math.floor(route.totalDurationMin / 60)}h {Math.round(route.totalDurationMin % 60)}m</span>
                            </div>
                          )}

                          {envScoreByRouteId.has(route.id) && (() => {
                            const env = envScoreByRouteId.get(route.id)!;
                            const color = env.score >= 70 ? "text-emerald-500 bg-emerald-500/10" : env.score >= 40 ? "text-yellow-500 bg-yellow-500/10" : "text-red-500 bg-red-500/10";
                            return (
                              <div className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-medium ${color}`} title={t("env.envScore")}>
                                <Shield className="h-3 w-3" />
                                {env.score}
                              </div>
                            );
                          })()}

                          {route.vehicleId && (route.status === "draft" || route.status === "optimized") && (
                            <Select
                              value={driverByVehicleId.get(route.vehicleId)?.id || "__none__"}
                              onValueChange={(val) => handleAssignDriver(route.vehicleId!, val)}
                            >
                              <SelectTrigger className="w-[140px] h-7 text-xs">
                                <User className="h-3 w-3 mr-1 shrink-0" />
                                <SelectValue placeholder={t("drivers.assignDriver")} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">{t("drivers.noDriver")}</SelectItem>
                                {activeDrivers.map((d) => (
                                  <SelectItem key={d.id} value={d.id}>
                                    {d.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}

                          <span className={cn("px-2.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide", style.bg, style.text)}>
                            {t(`routes.status${route.status.charAt(0).toUpperCase()}${route.status.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}
                          </span>

                          <a
                            href={`${getExportRouteUrl(route.id)}?organizationId=${ORG_ID}`}
                            download={`${route.name}.csv`}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                            title={t("common.exportCsv")}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>

                          <button
                            onClick={() => deleteRoute.mutate({ id: route.id })}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="w-[45%] shrink-0 border-l border-border relative">
          <MapContainer
            center={[59.33, 18.07]}
            zoom={11}
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
              url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            />
            {selectedRouteStops.length > 0 && <FitStops stops={selectedRouteStops} />}
            {selectedRouteStops.map((stop, i) => (
              <Marker
                key={stop.id}
                position={[stop.latitude, stop.longitude]}
                icon={stopIcon(true)}
              >
                <Popup className="dark-popup">
                  <div className="text-xs">
                    <p className="font-bold">#{i + 1} {stop.address}</p>
                    {stop.notes && <p className="text-muted-foreground">{stop.notes}</p>}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>

          {!selectedRouteId && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
              <div className="text-center text-muted-foreground">
                <RouteIcon className="h-10 w-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">{t("routes.selectRouteToPreview") || "Klicka på en rutt för att visa stopp"}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
