import { useState, useMemo, useCallback, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useRoutes, useRouteStops } from "@/hooks/use-routes";
import { useDrivers } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { GanttTimeline } from "@/components/dispatch/GanttTimeline";
import { StopDetailPanel } from "@/components/dispatch/StopDetailPanel";
import { RouteMap } from "@/components/map/RouteMap";
import { LoadingState } from "@/components/ui/LoadingState";
import { ROUTE_COLORS, ORG_ID } from "@/lib/constants";
import { computeSchedule, type ScheduledRow, type ScheduledStop } from "@/lib/scheduling";
import { useTranslation } from "react-i18next";
import { CalendarClock, GripHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import type { Route, Stop } from "@workspace/api-client-react";

export default function Dispatch() {
  const { t } = useTranslation();
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops();
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedRowIdx, setSelectedRowIdx] = useState<number>(0);
  const [mapHeight, setMapHeight] = useState(45);
  const [zoomLevel, setZoomLevel] = useState(1);
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
      } else {
        setSelectedStopId(stopId);
        setSelectedRowIdx(rowIdx);
      }
    },
    [selectedStopId],
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
        <div className="flex-1 flex flex-col" ref={containerRef}>
          <div className="shrink-0 px-6 py-3 border-b border-border bg-card/80 backdrop-blur-sm flex items-center gap-3">
            <CalendarClock className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-lg font-bold">{t("dispatch.title")}</h1>
              <p className="text-xs text-muted-foreground">
                {t("dispatch.subtitle", { count: scheduledRows.length })}
              </p>
            </div>
            <div className="ml-auto text-xs text-muted-foreground">
              {scheduledRows.reduce((s, r) => s + r.stops.length, 0)}{" "}
              {t("common.stops")} ·{" "}
              {scheduledRows.length} {t("dispatch.routesLabel")}
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
