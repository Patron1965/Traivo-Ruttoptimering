import { useState, useMemo, useCallback, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useRoutes, useRouteStops } from "@/hooks/use-routes";
import { useDrivers } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops, useUpdateStop } from "@/hooks/use-stops";
import { GanttTimeline } from "@/components/dispatch/GanttTimeline";
import { StopDetailPanel } from "@/components/dispatch/StopDetailPanel";
import { DispatchSidebar } from "@/components/dispatch/DispatchSidebar";
import { RouteMap } from "@/components/map/RouteMap";
import { LoadingState } from "@/components/ui/LoadingState";
import { ROUTE_COLORS, ORG_ID } from "@/lib/constants";
import { computeSchedule, type ScheduledRow, type ScheduledStop } from "@/lib/scheduling";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarClock,
  GripHorizontal,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Send,
  MapPin,
  Route as RouteIcon,
  Package,
} from "lucide-react";
import type { Route, Stop } from "@workspace/api-client-react";

export default function Dispatch() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops();
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();

  const updateStop = useUpdateStop();

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedRowIdx, setSelectedRowIdx] = useState<number>(0);
  const [highlightedRouteId, setHighlightedRouteId] = useState<string | null>(null);
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [mapHeight, setMapHeight] = useState(45);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [planLiveMode, setPlanLiveMode] = useState<"plan" | "live">("plan");
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const driversById = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    drivers?.forEach((d) => {
      if (d.vehicleId && d.isActive) {
        map.set(d.vehicleId, { id: d.id, name: d.name });
      }
    });
    return map;
  }, [drivers]);

  const vehiclesById = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        vehicleType: string;
        capacityKg: number | null;
        capacityVolume: number | null;
      }
    >();
    vehicles?.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const activeRoutes = useMemo(
    () =>
      routes?.filter(
        (r) =>
          r.status === "optimized" ||
          r.status === "in_progress" ||
          r.status === "draft",
      ) || [],
    [routes],
  );

  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, Stop[]>();
    if (!allStops) return map;
    allStops.forEach((s) => {
      if (s.routeId) {
        const arr = map.get(s.routeId) || [];
        arr.push(s);
        map.set(s.routeId, arr);
      }
    });
    return map;
  }, [allStops]);

  const unassignedStops = useMemo(
    () => allStops?.filter((s) => !s.routeId) || [],
    [allStops],
  );

  const scheduledRows: ScheduledRow[] = useMemo(() => {
    const routeRows = activeRoutes.map((route, idx) => {
      const vehicle = route.vehicleId
        ? vehiclesById.get(route.vehicleId)
        : undefined;
      const driver = route.vehicleId
        ? driversById.get(route.vehicleId)
        : undefined;

      const routeStops = stopsByRouteId.get(route.id) || [];
      const scheduled = computeSchedule(routeStops, route.date);

      const totalWeight = scheduled.reduce((s, st) => s + st.weightKg, 0);
      const totalVolume = scheduled.reduce((s, st) => s + st.volumeM3, 0);
      const capKg = vehicle?.capacityKg ?? 0;
      const capPct = capKg > 0 ? (totalWeight / capKg) * 100 : 0;

      return {
        routeId: route.id,
        routeName: route.name,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? t("dispatch.unassigned"),
        vehicleId: route.vehicleId ?? "",
        vehicleName: vehicle?.name ?? t("dispatch.noVehicle"),
        vehicleType: vehicle?.vehicleType ?? "fossil",
        capacityKg: vehicle?.capacityKg ?? 0,
        capacityVolume: vehicle?.capacityVolume ?? 0,
        totalWeightKg: totalWeight,
        totalVolumeM3: totalVolume,
        capacityPercent: capPct,
        color: ROUTE_COLORS[idx % ROUTE_COLORS.length],
        stops: scheduled,
      };
    });

    if (unassignedStops.length > 0) {
      const today = new Date().toISOString().split("T")[0];
      const unplannedScheduled = computeSchedule(unassignedStops, today);
      const totalWeight = unplannedScheduled.reduce((s, st) => s + st.weightKg, 0);
      const totalVolume = unplannedScheduled.reduce((s, st) => s + st.volumeM3, 0);
      routeRows.push({
        routeId: "unplanned",
        routeName: t("dispatch.unplanned"),
        driverId: null,
        driverName: t("dispatch.unplanned"),
        vehicleId: "",
        vehicleName: t("dispatch.noVehicle"),
        vehicleType: "fossil",
        capacityKg: 0,
        capacityVolume: 0,
        totalWeightKg: totalWeight,
        totalVolumeM3: totalVolume,
        capacityPercent: 0,
        color: "#64748B",
        stops: unplannedScheduled,
      });
    }

    return routeRows;
  }, [activeRoutes, vehiclesById, driversById, stopsByRouteId, unassignedStops, t]);

  const totalStopsCount = scheduledRows.reduce((s, r) => s + r.stops.length, 0);
  const routeRowsCount = scheduledRows.filter((r) => r.routeId !== "unplanned").length;

  const mapRoutes = useMemo(() => {
    return activeRoutes.map((route, idx) => {
      const routeStops = stopsByRouteId.get(route.id) || [];
      const sorted = [...routeStops].sort(
        (a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0),
      );
      return {
        ...route,
        stopsList: sorted,
      };
    });
  }, [activeRoutes, stopsByRouteId]);

  const handleToggleHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId((prev) => (prev === routeId ? null : routeId));
    },
    [],
  );

  const handleSetHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId(routeId);
    },
    [],
  );

  const handleMapSelectStop = useCallback(
    (stopId: string) => {
      if (selectedStopId === stopId) {
        setSelectedStopId(null);
      } else {
        setSelectedStopId(stopId);
        for (let i = 0; i < scheduledRows.length; i++) {
          if (scheduledRows[i].stops.some((s) => s.stopId === stopId)) {
            setSelectedRowIdx(i);
            break;
          }
        }
      }
    },
    [selectedStopId, scheduledRows],
  );

  const selectedStop = useMemo(() => {
    if (!selectedStopId) return null;
    for (const row of scheduledRows) {
      const found = row.stops.find((s) => s.stopId === selectedStopId);
      if (found) return found;
    }
    return null;
  }, [selectedStopId, scheduledRows]);

  const selectedRow = scheduledRows[selectedRowIdx] ?? null;

  const handleSelectStop = useCallback(
    (stopId: string, rowIdx: number) => {
      if (selectedStopId === stopId) {
        setSelectedStopId(null);
        setFocusStopId(null);
      } else {
        setSelectedStopId(stopId);
        setSelectedRowIdx(rowIdx);
        setFocusStopId(stopId);
      }
    },
    [selectedStopId],
  );

  const handleReassignStops = useCallback(
    async (stopIds: string[], targetRouteId: string) => {
      const newRouteId = targetRouteId === "unplanned" ? null : targetRouteId;
      const targetRow = scheduledRows.find((r) => r.routeId === targetRouteId);
      const existingStopsCount = targetRow?.stops.length ?? 0;

      try {
        await Promise.all(
          stopIds.map((stopId, idx) => {
            const stop = allStops?.find((s) => s.id === stopId);
            if (!stop) return Promise.resolve();
            return updateStop.mutateAsync({
              id: stopId,
              data: {
                address: stop.address,
                latitude: stop.latitude,
                longitude: stop.longitude,
                routeId: newRouteId,
                sequenceOrder: existingStopsCount + idx + 1,
              },
            });
          }),
        );
        toast({
          title: t("dispatch.stopsReassigned"),
          description: t("dispatch.stopsReassignedDesc", { count: stopIds.length }),
        });
      } catch {
        toast({
          title: t("common.somethingWentWrong"),
          variant: "destructive",
        });
      }
    },
    [allStops, scheduledRows, updateStop, toast, t],
  );

  const handleDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const container = containerRef.current;
      if (!container) return;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const rect = container.getBoundingClientRect();
        const pct = ((ev.clientY - rect.top) / rect.height) * 100;
        setMapHeight(Math.max(20, Math.min(75, pct)));
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  const todayStr = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  if (loadingRoutes || loadingStops) {
    return (
      <AppLayout>
        <LoadingState message={t("dispatch.loading")} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex h-full w-full">
        <DispatchSidebar
          rows={scheduledRows}
          highlightedRouteId={highlightedRouteId}
          onSelectRoute={handleToggleHighlightRoute}
          unplannedCount={unassignedStops.length}
        />

        <div className="flex-1 flex flex-col min-w-0" ref={containerRef}>
          <div className="shrink-0 px-4 py-2 border-b border-border bg-card/80 backdrop-blur-sm flex items-center gap-3 flex-wrap">
            <CalendarClock className="h-5 w-5 text-primary shrink-0" />
            <div className="mr-2">
              <h1 className="text-sm font-bold leading-tight">{t("dispatch.title")}</h1>
              <p className="text-[11px] text-muted-foreground">{todayStr}</p>
            </div>

            <div className="flex items-center bg-muted/50 rounded-md p-0.5 border border-border/50">
              <button
                type="button"
                className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors cursor-pointer ${
                  planLiveMode === "plan"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setPlanLiveMode("plan")}
              >
                {t("dispatch.planMode")}
              </button>
              <button
                type="button"
                className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors cursor-pointer ${
                  planLiveMode === "live"
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setPlanLiveMode("live")}
              >
                {t("dispatch.liveMode")}
              </button>
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <RouteIcon className="h-3.5 w-3.5" />
                  <span className="font-semibold text-foreground">{routeRowsCount}</span> {t("dispatch.routesLabel")}
                </span>
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  <span className="font-semibold text-foreground">{totalStopsCount}</span> {t("common.stops")}
                </span>
                <span className={`flex items-center gap-1 ${unassignedStops.length > 0 ? "text-destructive" : ""}`}>
                  <Package className="h-3.5 w-3.5" />
                  <span className="font-semibold">{unassignedStops.length}</span> {t("dispatch.unplannedLabel")}
                </span>
              </div>

              <div className="h-5 w-px bg-border/60 mx-1" />

              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold bg-primary/10 text-primary rounded-md hover:bg-primary/20 transition-colors cursor-pointer"
                onClick={() => navigate("/planner")}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t("dispatch.optimize")}
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold bg-muted text-foreground rounded-md hover:bg-muted/80 transition-colors cursor-pointer"
                onClick={() =>
                  toast({
                    title: t("dispatch.sentToDrivers"),
                    description: t("dispatch.sentToDriversDesc"),
                  })
                }
              >
                <Send className="h-3.5 w-3.5" />
                {t("dispatch.sendToDrivers")}
              </button>
            </div>
          </div>

          <div
            className="relative"
            style={{ height: `${mapHeight}%` }}
          >
            <div className="w-full h-full p-2">
              <div className="w-full h-full rounded-xl overflow-hidden shadow-inner border border-border/50">
                <RouteMap
                  routes={mapRoutes}
                  unassignedStops={unassignedStops}
                  interactive={true}
                  selectedStopId={selectedStopId}
                  onSelectStop={handleMapSelectStop}
                  highlightedRouteId={highlightedRouteId}
                  onHighlightRoute={handleSetHighlightRoute}
                  focusStopId={focusStopId}
                />
              </div>
            </div>
          </div>

          <div
            className="h-2 bg-border/50 hover:bg-primary/30 cursor-row-resize flex items-center justify-center transition-colors shrink-0"
            onMouseDown={handleDividerMouseDown}
          >
            <GripHorizontal className="h-3 w-3 text-muted-foreground" />
          </div>

          <div
            className="flex-1 min-h-0 overflow-hidden"
          >
            {scheduledRows.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                <div className="text-center">
                  <CalendarClock className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p>{t("dispatch.noRoutes")}</p>
                </div>
              </div>
            ) : (
              <div className="relative h-full">
                <div className="absolute top-1 right-3 z-30 flex items-center gap-1 bg-card/90 backdrop-blur-sm rounded-md border border-border px-1.5 py-1 shadow-md">
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                    onClick={() => setZoomLevel((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                    disabled={zoomLevel <= 0.5}
                    aria-label={t("dispatch.zoomOut")}
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[10px] font-mono text-muted-foreground min-w-[36px] text-center select-none" data-testid="zoom-level">
                    {Math.round(zoomLevel * 100)}%
                  </span>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                    onClick={() => setZoomLevel((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
                    disabled={zoomLevel >= 3}
                    aria-label={t("dispatch.zoomIn")}
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>
                </div>
                <GanttTimeline
                  rows={scheduledRows}
                  selectedStopId={selectedStopId}
                  onSelectStop={handleSelectStop}
                  zoomLevel={zoomLevel}
                  highlightedRouteId={highlightedRouteId}
                  onHighlightRoute={handleSetHighlightRoute}
                  scrollToRouteId={highlightedRouteId}
                  onReassignStops={handleReassignStops}
                />
              </div>
            )}
          </div>
        </div>

        {selectedStop && selectedRow && (
          <StopDetailPanel
            stop={selectedStop}
            routeColor={selectedRow.color}
            driverName={selectedRow.driverName}
            vehicleName={selectedRow.vehicleName}
            onClose={() => setSelectedStopId(null)}
          />
        )}
      </div>
    </AppLayout>
  );
}
