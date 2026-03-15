import { useRoutes, useDeleteRoute } from "@/hooks/use-routes";
import { useDrivers, useUpdateDriver } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Route as RouteIcon, Trash2, MapPin, Clock, Gauge, Download, User, Plus } from "lucide-react";
import { Link, useLocation } from "wouter";
import { format } from "date-fns";
import { sv, enUS } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Route, getExportRouteUrl } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ContinuousOptimization } from "@/components/ContinuousOptimization";

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-muted/50", text: "text-muted-foreground" },
  optimized: { bg: "bg-primary/20", text: "text-primary" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  cancelled: { bg: "bg-destructive/20", text: "text-destructive" },
};

export default function Routes() {
  const { data: routes, isLoading, error } = useRoutes();
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();
  const deleteRoute = useDeleteRoute();
  const updateDriver = useUpdateDriver();
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const dateLocale = i18n.language === "sv" ? sv : enUS;

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
      <div className="p-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t("routes.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("routes.subtitle")}</p>
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
          <div className="space-y-4">
            {routes.map((route: Route) => {
              const style = STATUS_STYLES[route.status] || STATUS_STYLES.draft;
              return (
                <div
                  key={route.id}
                  className="p-5 rounded-xl border border-border bg-card hover:bg-card/80 transition-colors cursor-pointer"
                  onClick={(e) => { if ((e.target as HTMLElement).closest('button, a, [role="combobox"]')) return; navigate(`/routes/${route.id}`); }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <RouteIcon className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-primary hover:underline">{route.name}</h3>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{route.date ? format(new Date(route.date), "PPP", { locale: dateLocale }) : t("common.noDate")}</span>
                          {route.vehicleId && (
                            <>
                              <span className="text-border">•</span>
                              <span>{vehicleNameById.get(route.vehicleId) || t("common.vehicle")}</span>
                              {driverByVehicleId.get(route.vehicleId) && (
                                <>
                                  <span className="text-border">•</span>
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

                    <div className="flex items-center gap-6">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        <span>{route.totalStops} {t("common.stops")}</span>
                      </div>

                      {route.totalDistanceKm != null && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Gauge className="h-4 w-4" />
                          <span>{route.totalDistanceKm} km</span>
                        </div>
                      )}

                      {route.totalDurationMin != null && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Clock className="h-4 w-4" />
                          <span>{Math.floor(route.totalDurationMin / 60)}h {Math.round(route.totalDurationMin % 60)}m</span>
                        </div>
                      )}

                      {route.vehicleId && (route.status === "draft" || route.status === "optimized") && (
                        <Select
                          value={driverByVehicleId.get(route.vehicleId)?.id || "__none__"}
                          onValueChange={(val) => handleAssignDriver(route.vehicleId!, val)}
                        >
                          <SelectTrigger className="w-[160px] h-8 text-xs">
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

                      <span className={cn("px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wide", style.bg, style.text)}>
                        {t(`routes.status${route.status.charAt(0).toUpperCase()}${route.status.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}
                      </span>

                      <a
                        href={`${getExportRouteUrl(route.id)}?organizationId=${ORG_ID}`}
                        download={`${route.name}.csv`}
                        className="p-2 rounded-lg text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                        title={t("common.exportCsv")}
                      >
                        <Download className="h-4 w-4" />
                      </a>

                      <button
                        onClick={() => deleteRoute.mutate({ id: route.id })}
                        className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
