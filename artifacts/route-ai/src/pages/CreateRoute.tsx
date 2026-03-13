import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers, useUpdateDriver } from "@/hooks/use-drivers";
import { useStops, useUpdateStop } from "@/hooks/use-stops";
import { useCreateRoute } from "@/hooks/use-routes";
import { ORG_ID } from "@/lib/constants";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import {
  Truck,
  User,
  MapPin,
  Route as RouteIcon,
  Check,
  ChevronRight,
  Zap,
  Fuel,
  ArrowLeft,
  Package,
  Clock,
  Weight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function CreateRoute() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: vehicles } = useVehicles();
  const { data: drivers } = useDrivers();
  const { data: allStops } = useStops();
  const createRoute = useCreateRoute();
  const updateStop = useUpdateStop();
  const updateDriver = useUpdateDriver();

  const [routeName, setRouteName] = useState("");
  const [routeDate, setRouteDate] = useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 16);
  });
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const unassignedStops = useMemo(
    () => allStops?.filter((s) => !s.routeId) || [],
    [allStops]
  );

  const activeDrivers = useMemo(
    () => drivers?.filter((d) => d.isActive) || [],
    [drivers]
  );

  const driversForVehicle = useMemo(() => {
    if (!selectedVehicleId) return activeDrivers;
    return activeDrivers.filter(
      (d) => !d.vehicleId || d.vehicleId === selectedVehicleId
    );
  }, [activeDrivers, selectedVehicleId]);

  const selectedVehicle = vehicles?.find((v) => v.id === selectedVehicleId);
  const selectedDriver = activeDrivers.find((d) => d.id === selectedDriverId);

  const selectedStopsData = useMemo(
    () => unassignedStops.filter((s) => selectedStopIds.has(s.id)),
    [unassignedStops, selectedStopIds]
  );

  const totalWeight = selectedStopsData.reduce((sum, s) => sum + (s.weightKg || 0), 0);
  const totalVolume = selectedStopsData.reduce((sum, s) => sum + (s.volumeM3 || 0), 0);

  const capacityWarning = selectedVehicle && (
    (selectedVehicle.capacityKg && totalWeight > selectedVehicle.capacityKg) ||
    (selectedVehicle.capacityVolume && totalVolume > selectedVehicle.capacityVolume)
  );

  const toggleStop = (id: string) => {
    setSelectedStopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllStops = () => {
    if (selectedStopIds.size === unassignedStops.length) {
      setSelectedStopIds(new Set());
    } else {
      setSelectedStopIds(new Set(unassignedStops.map((s) => s.id)));
    }
  };

  const canSave =
    routeName.trim() !== "" &&
    selectedVehicleId &&
    selectedStopIds.size > 0 &&
    !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);

    try {
      const route = await createRoute.mutateAsync({
        data: {
          organizationId: ORG_ID,
          name: routeName.trim(),
          date: new Date(routeDate).toISOString(),
          vehicleId: selectedVehicleId,
        },
      });

      const stopUpdates = Array.from(selectedStopIds).map((stopId, index) =>
        updateStop.mutateAsync({
          id: stopId,
          data: { routeId: route.id, sequenceOrder: index + 1 },
        })
      );
      await Promise.all(stopUpdates);

      if (selectedDriverId && selectedVehicleId) {
        const currentDriver = activeDrivers.find(
          (d) => d.vehicleId === selectedVehicleId && d.id !== selectedDriverId
        );
        if (currentDriver) {
          await updateDriver.mutateAsync({
            id: currentDriver.id,
            data: { vehicleId: null },
            params: { organizationId: ORG_ID },
          });
        }

        const driverObj = activeDrivers.find((d) => d.id === selectedDriverId);
        if (driverObj && driverObj.vehicleId !== selectedVehicleId) {
          await updateDriver.mutateAsync({
            id: selectedDriverId,
            data: { vehicleId: selectedVehicleId },
            params: { organizationId: ORG_ID },
          });
        }
      }

      toast({
        title: t("createRoute.success"),
        description: t("createRoute.successDesc", {
          name: routeName,
          count: selectedStopIds.size,
        }),
      });
      navigate("/routes");
    } catch {
      toast({
        title: t("createRoute.error"),
        description: t("createRoute.errorDesc"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="p-6 md:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/routes")}
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl md:text-3xl font-display font-bold">
              {t("createRoute.title")}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              {t("createRoute.subtitle")}
            </p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            <section className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center">
                  <RouteIcon className="h-5 w-5 text-primary" />
                </div>
                <h2 className="font-bold text-lg">{t("createRoute.routeInfo")}</h2>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1.5 block">
                    {t("createRoute.routeName")}
                  </label>
                  <input
                    type="text"
                    value={routeName}
                    onChange={(e) => setRouteName(e.target.value)}
                    placeholder={t("createRoute.routeNamePlaceholder")}
                    className="w-full h-11 rounded-xl border border-border bg-background px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1.5 block">
                    {t("createRoute.routeDate")}
                  </label>
                  <input
                    type="datetime-local"
                    value={routeDate}
                    onChange={(e) => setRouteDate(e.target.value)}
                    className="w-full h-11 rounded-xl border border-border bg-background px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow [color-scheme:dark]"
                  />
                </div>
              </div>
            </section>

            <section className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-blue-500/10 flex items-center justify-center">
                  <Truck className="h-5 w-5 text-blue-400" />
                </div>
                <h2 className="font-bold text-lg">{t("createRoute.selectVehicle")}</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {vehicles?.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      setSelectedVehicleId(v.id === selectedVehicleId ? null : v.id);
                      if (selectedDriverId) {
                        const d = activeDrivers.find((d) => d.id === selectedDriverId);
                        if (d?.vehicleId && d.vehicleId !== v.id && d.vehicleId !== selectedVehicleId) {
                          setSelectedDriverId(null);
                        }
                      }
                    }}
                    className={cn(
                      "text-left p-4 rounded-xl border-2 transition-all duration-200",
                      selectedVehicleId === v.id
                        ? "border-primary bg-primary/5 shadow-lg shadow-primary/10"
                        : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold">{v.name}</span>
                      {selectedVehicleId === v.id && (
                        <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                          <Check className="h-3.5 w-3.5 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {v.vehicleType === "electric" ? (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <Zap className="h-3 w-3" /> EV
                        </span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Fuel className="h-3 w-3" /> {t("createRoute.fossil")}
                        </span>
                      )}
                      <span>{v.licensePlate}</span>
                      <span>{v.capacityKg} kg</span>
                      <span>{v.capacityVolume} m³</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-xl bg-violet-500/10 flex items-center justify-center">
                  <User className="h-5 w-5 text-violet-400" />
                </div>
                <h2 className="font-bold text-lg">{t("createRoute.selectDriver")}</h2>
                <span className="text-xs text-muted-foreground ml-auto">
                  {t("createRoute.driverOptional")}
                </span>
              </div>
              {driversForVehicle.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  {t("createRoute.noDrivers")}
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {driversForVehicle.map((d) => (
                    <button
                      key={d.id}
                      onClick={() =>
                        setSelectedDriverId(d.id === selectedDriverId ? null : d.id)
                      }
                      className={cn(
                        "text-left p-4 rounded-xl border-2 transition-all duration-200",
                        selectedDriverId === d.id
                          ? "border-violet-500 bg-violet-500/5 shadow-lg shadow-violet-500/10"
                          : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                      )}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold">{d.name}</span>
                        {selectedDriverId === d.id && (
                          <div className="h-6 w-6 rounded-full bg-violet-500 flex items-center justify-center">
                            <Check className="h-3.5 w-3.5 text-white" />
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {d.phone || d.email || ""}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-amber-500/10 flex items-center justify-center">
                    <MapPin className="h-5 w-5 text-amber-400" />
                  </div>
                  <h2 className="font-bold text-lg">{t("createRoute.selectStops")}</h2>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={selectAllStops}
                >
                  {selectedStopIds.size === unassignedStops.length && unassignedStops.length > 0
                    ? t("createRoute.deselectAll")
                    : t("createRoute.selectAll")}
                </Button>
              </div>

              {unassignedStops.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  {t("createRoute.noStops")}
                </p>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                  {unassignedStops.map((stop) => (
                    <button
                      key={stop.id}
                      onClick={() => toggleStop(stop.id)}
                      className={cn(
                        "w-full text-left p-3 rounded-xl border-2 transition-all duration-150 flex items-center gap-3",
                        selectedStopIds.has(stop.id)
                          ? "border-amber-500 bg-amber-500/5"
                          : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                      )}
                    >
                      <div
                        className={cn(
                          "h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
                          selectedStopIds.has(stop.id)
                            ? "border-amber-500 bg-amber-500"
                            : "border-muted-foreground/40"
                        )}
                      >
                        {selectedStopIds.has(stop.id) && (
                          <Check className="h-3 w-3 text-white" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{stop.address}</p>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                          {stop.timeWindowStart && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {new Date(stop.timeWindowStart).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                              {stop.timeWindowEnd &&
                                ` – ${new Date(stop.timeWindowEnd).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}`}
                            </span>
                          )}
                          {stop.weightKg && (
                            <span className="flex items-center gap-1">
                              <Weight className="h-3 w-3" />
                              {stop.weightKg}kg
                            </span>
                          )}
                          {stop.volumeM3 && <span>{stop.volumeM3}m³</span>}
                          {stop.serviceDurationMin && <span>{stop.serviceDurationMin} min</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="lg:sticky lg:top-20 h-fit space-y-4">
            <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
              <h3 className="font-bold text-lg">{t("createRoute.summary")}</h3>

              <div className="space-y-3">
                <SummaryRow
                  icon={<RouteIcon className="h-4 w-4" />}
                  label={t("createRoute.routeName")}
                  value={routeName || "—"}
                />
                <SummaryRow
                  icon={<Truck className="h-4 w-4" />}
                  label={t("createRoute.vehicle")}
                  value={selectedVehicle?.name || "—"}
                />
                <SummaryRow
                  icon={<User className="h-4 w-4" />}
                  label={t("createRoute.driver")}
                  value={selectedDriver?.name || "—"}
                />
                <SummaryRow
                  icon={<MapPin className="h-4 w-4" />}
                  label={t("createRoute.stops")}
                  value={`${selectedStopIds.size} ${t("common.stops")}`}
                />
                <SummaryRow
                  icon={<Package className="h-4 w-4" />}
                  label={t("createRoute.load")}
                  value={`${totalWeight.toFixed(0)} kg / ${totalVolume.toFixed(1)} m³`}
                />
              </div>

              {capacityWarning && (
                <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs font-medium">
                  {t("createRoute.capacityWarning")}
                </div>
              )}
            </div>

            <Button
              onClick={handleSave}
              disabled={!canSave}
              size="lg"
              className="w-full gap-2 h-12 text-base font-bold rounded-xl"
            >
              {saving ? t("common.saving") : t("createRoute.createBtn")}
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-muted-foreground shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <p className="text-sm font-medium truncate">{value}</p>
      </div>
    </div>
  );
}
