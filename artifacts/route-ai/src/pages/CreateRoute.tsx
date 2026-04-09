import { useState, useMemo } from "react";
import { useLocation, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers, useUpdateDriver } from "@/hooks/use-drivers";
import { useStops, useUpdateStop } from "@/hooks/use-stops";
import { useRoutes, useCreateRoute } from "@/hooks/use-routes";
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
  Loader2,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  Search,
  ChevronDown,
  X,
  Phone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function SectionSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-20 rounded-xl border-2 border-border bg-muted/20 animate-pulse"
        />
      ))}
    </div>
  );
}

export default function CreateRoute() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: vehicles, isLoading: loadingVehicles, isError: errorVehicles, refetch: refetchVehicles } = useVehicles();
  const { data: drivers, isLoading: loadingDrivers, isError: errorDrivers, refetch: refetchDrivers } = useDrivers();
  const { data: allStops, isLoading: loadingStops, isError: errorStops, refetch: refetchStops } = useStops();
  const { data: routes } = useRoutes();
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
  const [vehicleSearch, setVehicleSearch] = useState("");
  const [driverDropdownOpen, setDriverDropdownOpen] = useState<string | null>(null);

  const routesById = useMemo(() => {
    const map = new Map<string, string>();
    routes?.forEach((r) => map.set(r.id, r.name));
    return map;
  }, [routes]);

  const sortedStops = useMemo(() => {
    if (!allStops) return [];
    return [...allStops].sort((a, b) => {
      if (!a.routeId && b.routeId) return -1;
      if (a.routeId && !b.routeId) return 1;
      return a.address.localeCompare(b.address);
    });
  }, [allStops]);

  const activeDrivers = useMemo(
    () => drivers?.filter((d) => d.isActive) || [],
    [drivers]
  );

  const vehiclesById = useMemo(() => {
    const map = new Map<string, string>();
    vehicles?.forEach((v) => map.set(v.id, v.name));
    return map;
  }, [vehicles]);

  const driverByVehicleId = useMemo(() => {
    const map = new Map<string, typeof activeDrivers[number]>();
    activeDrivers.forEach((d) => {
      if (d.vehicleId) map.set(d.vehicleId, d);
    });
    return map;
  }, [activeDrivers]);

  const filteredVehicles = useMemo(() => {
    if (!vehicles) return [];
    if (!vehicleSearch.trim()) return vehicles;
    const q = vehicleSearch.toLowerCase().trim();
    return vehicles.filter((v) => {
      const linkedDriver = driverByVehicleId.get(v.id);
      return (
        v.name.toLowerCase().includes(q) ||
        v.licensePlate.toLowerCase().includes(q) ||
        (linkedDriver?.name?.toLowerCase().includes(q)) ||
        (linkedDriver?.phone?.toLowerCase().includes(q))
      );
    });
  }, [vehicles, vehicleSearch, driverByVehicleId]);

  const selectedVehicle = vehicles?.find((v) => v.id === selectedVehicleId);
  const selectedDriver = activeDrivers.find((d) => d.id === selectedDriverId);

  const selectedStopsData = useMemo(
    () => (allStops || []).filter((s) => selectedStopIds.has(s.id)),
    [allStops, selectedStopIds]
  );

  const totalWeight = selectedStopsData.reduce((sum, s) => sum + (s.weightKg || 0), 0);
  const totalVolume = selectedStopsData.reduce((sum, s) => sum + (s.volumeM3 || 0), 0);

  const capacityWarning = selectedVehicle && (
    (selectedVehicle.capacityKg && totalWeight > selectedVehicle.capacityKg) ||
    (selectedVehicle.capacityVolume && totalVolume > selectedVehicle.capacityVolume)
  );

  const reassignCount = selectedStopsData.filter((s) => s.routeId).length;

  const toggleStop = (id: string) => {
    setSelectedStopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllStops = () => {
    if (selectedStopIds.size === sortedStops.length && sortedStops.length > 0) {
      setSelectedStopIds(new Set());
    } else {
      setSelectedStopIds(new Set(sortedStops.map((s) => s.id)));
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
                <h2 className="font-bold text-lg">{t("createRoute.vehicleAndDriver")}</h2>
                <span className="text-xs text-muted-foreground ml-auto">
                  {t("createRoute.driverOptional")}
                </span>
              </div>

              {(loadingVehicles || loadingDrivers) ? (
                <SectionSkeleton rows={3} />
              ) : (errorVehicles || errorDrivers) ? (
                <div className="text-sm text-destructive py-6 text-center space-y-2">
                  <AlertTriangle className="h-8 w-8 mx-auto opacity-60" />
                  <p>{t("createRoute.loadError")}</p>
                  <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => { refetchVehicles(); refetchDrivers(); }}>
                    <RefreshCw className="h-3 w-3" />
                    {t("createRoute.retry")}
                  </Button>
                </div>
              ) : !vehicles || vehicles.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center space-y-2">
                  <Truck className="h-8 w-8 mx-auto opacity-30" />
                  <p>{t("createRoute.noVehicles")}</p>
                  <Link href="/vehicles">
                    <Button variant="link" size="sm" className="text-xs gap-1">
                      {t("createRoute.goToVehicles")}
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </Link>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={vehicleSearch}
                      onChange={(e) => setVehicleSearch(e.target.value)}
                      placeholder={t("createRoute.searchVehicleDriver")}
                      className="w-full h-10 rounded-xl border border-border bg-background pl-9 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
                    />
                    {vehicleSearch && (
                      <button onClick={() => setVehicleSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="hidden sm:grid grid-cols-[1fr_100px_80px_90px_1fr_40px] gap-2 px-3 text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
                    <span>{t("createRoute.vehicle")}</span>
                    <span>{t("vehicles.licensePlate")}</span>
                    <span>{t("common.type")}</span>
                    <span>{t("vehicles.capacity")}</span>
                    <span>{t("createRoute.driver")}</span>
                    <span></span>
                  </div>

                  <div className="space-y-1 max-h-[400px] overflow-y-auto">
                    {filteredVehicles.length === 0 ? (
                      <div className="text-sm text-muted-foreground py-6 text-center">
                        {t("createRoute.noSearchResults")}
                      </div>
                    ) : (
                      filteredVehicles.map((v) => {
                        const linkedDriver = driverByVehicleId.get(v.id);
                        const isSelected = selectedVehicleId === v.id;
                        const currentDriverForRow = isSelected ? selectedDriver : linkedDriver;
                        const willReassign =
                          isSelected &&
                          selectedDriverId &&
                          selectedDriver &&
                          selectedDriver.vehicleId &&
                          selectedDriver.vehicleId !== v.id;

                        return (
                          <div key={v.id} className="relative">
                            <button
                              onClick={() => {
                                if (isSelected) {
                                  setSelectedVehicleId(null);
                                  setSelectedDriverId(null);
                                } else {
                                  setSelectedVehicleId(v.id);
                                  const driver = driverByVehicleId.get(v.id);
                                  setSelectedDriverId(driver?.id || null);
                                }
                                setDriverDropdownOpen(null);
                              }}
                              className={cn(
                                "w-full text-left px-3 py-2.5 rounded-xl border-2 transition-all duration-150",
                                isSelected
                                  ? "border-primary bg-primary/5 shadow-md shadow-primary/10"
                                  : "border-transparent hover:border-muted-foreground/20 hover:bg-muted/30"
                              )}
                            >
                              <div className="sm:grid sm:grid-cols-[1fr_100px_80px_90px_1fr_40px] sm:gap-2 sm:items-center">
                                <div className="flex items-center gap-2 min-w-0">
                                  {isSelected && (
                                    <div className="h-5 w-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                                      <Check className="h-3 w-3 text-primary-foreground" />
                                    </div>
                                  )}
                                  <span className={cn("font-semibold text-sm truncate", !isSelected && "ml-7")}>
                                    {v.name}
                                  </span>
                                </div>

                                <span className="hidden sm:block text-xs text-muted-foreground truncate">
                                  {v.licensePlate}
                                </span>

                                <span className="hidden sm:flex items-center gap-1 text-xs">
                                  {v.vehicleType === "electric" ? (
                                    <span className="flex items-center gap-1 text-emerald-400">
                                      <Zap className="h-3 w-3" /> EV
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1 text-muted-foreground">
                                      <Fuel className="h-3 w-3" /> {t("createRoute.fossil")}
                                    </span>
                                  )}
                                </span>

                                <span className="hidden sm:block text-xs text-muted-foreground">
                                  {v.capacityKg}kg / {v.capacityVolume}m³
                                </span>

                                <div className="hidden sm:flex items-center gap-2 min-w-0">
                                  {currentDriverForRow ? (
                                    <div className="flex items-center gap-2 min-w-0">
                                      <User className="h-3 w-3 text-violet-400 shrink-0" />
                                      <span className="text-xs truncate">{currentDriverForRow.name}</span>
                                      {currentDriverForRow.phone && (
                                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
                                          <Phone className="h-2.5 w-2.5" />
                                          {currentDriverForRow.phone}
                                        </span>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-xs text-muted-foreground italic">{t("drivers.noDriver")}</span>
                                  )}
                                </div>

                                <div className="hidden sm:block">
                                  {isSelected && activeDrivers.length > 0 && (
                                    <span
                                      role="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDriverDropdownOpen(driverDropdownOpen === v.id ? null : v.id);
                                      }}
                                      className="inline-flex items-center justify-center h-7 w-7 rounded-lg hover:bg-muted transition-colors"
                                    >
                                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="sm:hidden mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span>{v.licensePlate}</span>
                                <span className="text-[10px]">•</span>
                                {v.vehicleType === "electric" ? (
                                  <span className="flex items-center gap-1 text-emerald-400">
                                    <Zap className="h-3 w-3" /> EV
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1">
                                    <Fuel className="h-3 w-3" /> {t("createRoute.fossil")}
                                  </span>
                                )}
                                <span className="text-[10px]">•</span>
                                <span>{v.capacityKg}kg / {v.capacityVolume}m³</span>
                              </div>

                              <div className="sm:hidden mt-1 flex items-center gap-2 text-xs">
                                {currentDriverForRow ? (
                                  <>
                                    <User className="h-3 w-3 text-violet-400 shrink-0" />
                                    <span className="truncate">{currentDriverForRow.name}</span>
                                    {currentDriverForRow.phone && (
                                      <span className="flex items-center gap-1 text-muted-foreground">
                                        <Phone className="h-2.5 w-2.5" />
                                        {currentDriverForRow.phone}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span className="text-muted-foreground italic">{t("drivers.noDriver")}</span>
                                )}
                                {isSelected && activeDrivers.length > 0 && (
                                  <span
                                    role="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDriverDropdownOpen(driverDropdownOpen === v.id ? null : v.id);
                                    }}
                                    className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary"
                                  >
                                    {t("createRoute.changeDriver")}
                                    <ChevronDown className="h-3 w-3" />
                                  </span>
                                )}
                              </div>

                              {willReassign && (
                                <p className="text-[10px] text-amber-400 mt-1.5 flex items-center gap-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  {t("createRoute.driverReassignNote")}
                                </p>
                              )}
                            </button>

                            {driverDropdownOpen === v.id && isSelected && (
                              <div className="absolute z-20 right-0 sm:right-2 top-full mt-1 w-64 bg-popover border border-border rounded-xl shadow-xl p-1 max-h-48 overflow-y-auto">
                                <button
                                  onClick={() => {
                                    setSelectedDriverId(null);
                                    setDriverDropdownOpen(null);
                                  }}
                                  className={cn(
                                    "w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-muted transition-colors",
                                    !selectedDriverId && "bg-muted"
                                  )}
                                >
                                  <span className="text-muted-foreground italic">{t("drivers.noDriver")}</span>
                                </button>
                                {activeDrivers.map((d) => (
                                  <button
                                    key={d.id}
                                    onClick={() => {
                                      setSelectedDriverId(d.id);
                                      setDriverDropdownOpen(null);
                                    }}
                                    className={cn(
                                      "w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-muted transition-colors",
                                      selectedDriverId === d.id && "bg-muted"
                                    )}
                                  >
                                    <div className="font-medium">{d.name}</div>
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      {d.phone && (
                                        <span className="flex items-center gap-1">
                                          <Phone className="h-2.5 w-2.5" />
                                          {d.phone}
                                        </span>
                                      )}
                                      {d.vehicleId && vehiclesById.get(d.vehicleId) && (
                                        <span className="flex items-center gap-1 px-1 py-0.5 rounded bg-muted/50 text-[10px]">
                                          <Truck className="h-2.5 w-2.5" />
                                          {vehiclesById.get(d.vehicleId)}
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
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
                {sortedStops.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={selectAllStops}
                  >
                    {selectedStopIds.size === sortedStops.length && sortedStops.length > 0
                      ? t("createRoute.deselectAll")
                      : t("createRoute.selectAll")}
                  </Button>
                )}
              </div>

              {loadingStops ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-16 rounded-xl border-2 border-border bg-muted/20 animate-pulse"
                    />
                  ))}
                </div>
              ) : errorStops ? (
                <div className="text-sm text-destructive py-6 text-center space-y-2">
                  <AlertTriangle className="h-8 w-8 mx-auto opacity-60" />
                  <p>{t("createRoute.loadError")}</p>
                  <Button variant="outline" size="sm" className="text-xs gap-1" onClick={() => refetchStops()}>
                    <RefreshCw className="h-3 w-3" />
                    {t("createRoute.retry")}
                  </Button>
                </div>
              ) : sortedStops.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center space-y-2">
                  <MapPin className="h-8 w-8 mx-auto opacity-30" />
                  <p>{t("createRoute.noStopsAnywhere")}</p>
                  <Link href="/stops">
                    <Button variant="link" size="sm" className="text-xs gap-1">
                      {t("createRoute.goToStops")}
                      <ExternalLink className="h-3 w-3" />
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                  {sortedStops.map((stop) => {
                    const isAssigned = !!stop.routeId;
                    const routeName = isAssigned
                      ? routesById.get(stop.routeId!) || t("common.unknown")
                      : null;
                    const isSelected = selectedStopIds.has(stop.id);

                    return (
                      <button
                        key={stop.id}
                        onClick={() => toggleStop(stop.id)}
                        className={cn(
                          "w-full text-left p-3 rounded-xl border-2 transition-all duration-150 flex items-center gap-3",
                          isSelected
                            ? "border-amber-500 bg-amber-500/5"
                            : isAssigned
                              ? "border-border/60 bg-muted/10 hover:border-muted-foreground/30"
                              : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                        )}
                      >
                        <div
                          className={cn(
                            "h-5 w-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors",
                            isSelected
                              ? "border-amber-500 bg-amber-500"
                              : "border-muted-foreground/40"
                          )}
                        >
                          {isSelected && (
                            <Check className="h-3 w-3 text-white" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium truncate">{stop.address}</p>
                            {isAssigned && (
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex items-center gap-1">
                                <RouteIcon className="h-2.5 w-2.5" />
                                {routeName}
                              </span>
                            )}
                          </div>
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
                          {isAssigned && isSelected && (
                            <p className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              {t("createRoute.stopReassignWarning")}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
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

              {reassignCount > 0 && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium flex items-start gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  {t("createRoute.reassignWarning", { count: reassignCount })}
                </div>
              )}

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
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.saving")}
                </>
              ) : (
                <>
                  {t("createRoute.createBtn")}
                  <ChevronRight className="h-5 w-5" />
                </>
              )}
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
