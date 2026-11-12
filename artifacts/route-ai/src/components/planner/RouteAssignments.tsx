import type { ReactNode } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { useTranslation } from "react-i18next";
import type { Driver, Route, Stop, Vehicle } from "@workspace/api-client-react";
import {
  AlertCircle, BatteryCharging, CheckCircle2, ChevronDown, Clock, Coffee, GripVertical, Loader2, MapPin, Navigation, Warehouse, Zap,
} from "lucide-react";
import { RouteReoptimizationMenu } from "@/components/routes/RouteReoptimizationMenu";
import { DEPOT_LOCATION } from "@/lib/constants";
import { formatTimeWindow, isLateForWindow } from "@/lib/planner-workflow";
import { cn } from "@/lib/utils";
import { stopTitle } from "./SourceJobList";
import { formatMinutes, type OptimizedRouteResult, type SaveStatus } from "./types";

const clock = (iso: string) => new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });

export function serviceStartByStop(route: OptimizedRouteResult): Map<string, string> {
  const map = new Map<string, string>();
  route.workdayTimeline?.forEach((item) => { if (item.type === "service" && item.stopId) map.set(item.stopId, item.startAt); });
  return map;
}

export function RouteAssignments({
  routes, vehiclesById, stopsById, driverByVehicleId, existingRoutes, drivers, vehicles, stops,
  saveStatus, saveMessage, onDragEnd, onReoptimizationSaved, onOpenStop, activeStopId,
}: {
  routes: OptimizedRouteResult[];
  vehiclesById: Map<string, Vehicle>;
  stopsById: Map<string, Stop>;
  driverByVehicleId: Map<string, Driver>;
  existingRoutes: Route[] | undefined;
  drivers: Driver[];
  vehicles: Vehicle[];
  stops: Stop[];
  saveStatus: SaveStatus;
  saveMessage: string | null;
  onDragEnd: (result: DropResult) => void;
  onReoptimizationSaved: (planId: string) => Promise<void>;
  onOpenStop: (stopId: string) => void;
  activeStopId: string | null;
}) {
  const { t } = useTranslation();
  const menuRoute = (candidate: OptimizedRouteResult) => {
    const v = vehiclesById.get(candidate.vehicleId);
    const persisted = existingRoutes?.find((existing) => existing.id === candidate.routeId);
    return {
      id: candidate.routeId,
      planId: candidate.planId,
      planRevision: candidate.planRevision,
      status: persisted?.status ?? "optimized",
      vehicleId: candidate.vehicleId,
      draftId: persisted?.draftId ?? null,
      name: v?.name ? `${v.name} ${t("common.route")}` : t("common.route"),
      handoffStatus: persisted?.handoffStatus ?? "pending",
      handoffDriverId: persisted?.handoffDriverId ?? null,
      planningSummary: persisted?.planningSummary ?? undefined,
      totalStops: candidate.stops.filter((stop) => !stop.isChargingStop).length,
      totalDistanceKm: candidate.distanceKm,
      totalDurationMin: candidate.durationMin,
      depotSnapshot: candidate.depotSnapshot,
      plannerItinerary: candidate.stops,
    };
  };
  const planRoutes = routes.map(menuRoute);

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">{t("planner.dragHint")}</p>
        {saveStatus !== "idle" && (
          <div
            role={saveStatus === "error" || saveStatus === "conflict" ? "alert" : "status"}
            data-testid="planner-save-status"
            className={cn("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              saveStatus === "error" || saveStatus === "conflict" ? "border-destructive/40 bg-destructive/5 text-destructive"
                : saveStatus === "saved" ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                  : "border-primary/30 bg-primary/5 text-muted-foreground")}
          >
            {saveStatus === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saveStatus === "saved" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
            {saveStatus === "saving" ? "Sparar ruttändringar…" : saveMessage}
          </div>
        )}

        {routes.map((route, routeIdx) => {
          const vehicle = vehiclesById.get(route.vehicleId);
          const driver = driverByVehicleId.get(route.vehicleId);
          const starts = serviceStartByStop(route);
          const summary = route.workdaySummary;
          const jobCount = route.stops.filter((s) => !s.isChargingStop).length;
          const hasLocked = route.stops.some((entry) => {
            const status = stopsById.get(entry.stopId)?.status;
            return status === "completed" || status === "in_progress";
          });
          return (
            <details key={route.routeId} open data-testid="planner-route" data-route-id={route.routeId} data-plan-id={route.planId}
              className="group/route overflow-hidden rounded-lg border border-border bg-card">
              <summary className="flex cursor-pointer list-none items-center gap-2 border-b border-border/70 bg-muted/30 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
                <span className="h-6 w-1 shrink-0 rounded-full" style={{ backgroundColor: vehicle?.routeColor }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{vehicle?.name ?? driver?.name ?? "Okänd resurs"}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{vehicle?.name || t("common.vehicle")}</span>
                </span>
                <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  <span className="block">{jobCount} jobb</span>
                  {summary && <span className={cn("block", summary.overtimeMin > 0 && "font-semibold text-destructive")}>{formatMinutes(summary.totalMin)}</span>}
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <RouteReoptimizationMenu
                    route={menuRoute(route)}
                    planRoutes={planRoutes}
                    drivers={drivers}
                    vehicles={vehicles}
                    stops={stops}
                    depotLatitude={DEPOT_LOCATION.lat}
                    depotLongitude={DEPOT_LOCATION.lng}
                    onSaved={onReoptimizationSaved}
                  />
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/route:rotate-180" />
              </summary>
              {summary && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-border/60 px-2.5 py-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                  <span>Pass {Math.round(summary.totalMin)}/{Math.round(summary.shiftMin)}m</span>
                  <span>Körning {summary.nonReturnDrivingMin}m</span>
                  <span>Service {summary.serviceMin}m</span>
                  {summary.waitingMin > 0 && <span>Väntan {summary.waitingMin}m</span>}
                  {summary.breakMin > 0 && <span>Rast {summary.breakMin}m</span>}
                  {summary.overtimeMin > 0 && <span className="font-semibold text-destructive">Övertid {summary.overtimeMin}m</span>}
                  <span className="ml-auto text-foreground">Slut {clock(summary.shiftEndAt)}</span>
                </div>
              )}
              {hasLocked && (
                <div data-testid={`locked-route-stops-${route.routeId}`} className="flex items-center gap-1.5 border-b border-border/60 bg-muted/20 px-2.5 py-1 text-[11px] text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />Slutförda och pågående stopp är låsta och behåller sin plats.
                </div>
              )}
              {route.geographicOverlapExplanation && (
                <div data-testid="geographic-overlap-explanation" className="flex items-start gap-1.5 border-b border-amber-500/20 bg-amber-500/5 px-2.5 py-1 text-[11px] text-amber-800 dark:text-amber-200">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /><span>{route.geographicOverlapExplanation.message}</span>
                </div>
              )}
              {route.workdayTimeline && (
                <details className="group/tl border-b border-border/60">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-1.5"><Clock className="h-3 w-3" />Arbetspass (tidslinje)</span>
                    <ChevronDown className="h-3 w-3 transition-transform group-open/tl:rotate-180" />
                  </summary>
                  <ol className="space-y-0.5 px-2.5 pb-2 pt-1 text-[11px]">
                    {route.workdayTimeline.map((item, index) => {
                      const start = clock(item.startAt);
                      const row = (icon: ReactNode, label: string, tone = "text-muted-foreground") => (
                        <li key={index} className={cn("flex items-center gap-2", tone)}>
                          <span className="w-9 shrink-0 font-mono tabular-nums opacity-70">{start}</span>{icon}<span className="truncate">{label}</span>
                        </li>
                      );
                      if (item.type === "depot_start" || item.type === "depot_end") {
                        const address = item.type === "depot_start" ? route.depotSnapshot?.start?.address : route.depotSnapshot?.end?.address;
                        return row(<Warehouse className="h-3 w-3 shrink-0" />, `${item.type === "depot_start" ? "Startdepå" : "Slutdepå"}${address ? ` · ${address}` : ""}`);
                      }
                      if (item.type === "break") return row(<Coffee className="h-3 w-3 shrink-0" />, `Rast (${Math.round(item.durationMin)}m)`, "text-orange-700 dark:text-orange-300");
                      if (item.type === "return") return row(<Navigation className="h-3 w-3 shrink-0" />, `Återresa (${Math.round(item.durationMin)}m, ${item.distanceKm?.toFixed(1)}km)`);
                      if (item.type === "charging") return row(<Zap className="h-3 w-3 shrink-0" />, `Laddning (${Math.round(item.durationMin)}m)`, "text-emerald-700 dark:text-emerald-300");
                      if (item.type === "service") {
                        const stop = stopsById.get(item.stopId || "");
                        return row(<MapPin className="h-3 w-3 shrink-0 text-primary" />, `${stop ? stopTitle(stop) : "Stopp"} (${Math.round(item.durationMin)}m)`, "text-foreground");
                      }
                      return null;
                    })}
                  </ol>
                </details>
              )}
              <Droppable droppableId={`driver-${routeIdx}`}>
                {(provided, snapshot) => (
                  <div ref={provided.innerRef} {...provided.droppableProps} data-testid="planner-route-dropzone" data-route-id={route.routeId}
                    className={cn("min-h-[44px] p-1 transition-colors", snapshot.isDraggingOver && "bg-primary/5")}>
                    {(() => {
                      let dragIdx = 0;
                      return route.stops.map((stopRef) => {
                        if (stopRef.isChargingStop) {
                          return (
                            <div key={stopRef.stopId} data-testid="planner-charging-stop" data-station-id={stopRef.stopId}
                              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">
                              <span className="w-3.5" />
                              <BatteryCharging className="h-3.5 w-3.5" />
                              <span className="truncate font-medium">{stopRef.chargingStationName}</span>
                              <span className="ml-auto text-muted-foreground">{t("planner.chargingStop")}</span>
                            </div>
                          );
                        }
                        const currentDragIndex = dragIdx++;
                        const stop = stopsById.get(stopRef.stopId);
                        const isLifecycleLocked = stop?.status === "completed" || stop?.status === "in_progress" || stop?.status === "failed" || stop?.status === "skipped";
                        const start = starts.get(stopRef.stopId);
                        const late = isLateForWindow(stop?.timeWindowEnd, start);
                        const window = stop ? formatTimeWindow(stop.timeWindowStart, stop.timeWindowEnd) : null;
                        return (
                          <Draggable key={stopRef.stopId} draggableId={stopRef.stopId} index={currentDragIndex}
                            isDragDisabled={saveStatus === "saving" || isLifecycleLocked}>
                            {(dragProvided, dragSnapshot) => (
                              <div ref={dragProvided.innerRef} {...dragProvided.draggableProps} data-testid="planner-stop" data-stop-id={stopRef.stopId}
                                className={cn("flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs transition-colors",
                                  dragSnapshot.isDragging ? "border-primary bg-card shadow-lg" : "border-transparent hover:bg-muted/40",
                                  activeStopId === stopRef.stopId && "border-primary/50 bg-primary/5")}>
                                <div {...dragProvided.dragHandleProps} data-testid="planner-drag-handle" data-locked={isLifecycleLocked ? "true" : "false"}
                                  aria-disabled={isLifecycleLocked} title={isLifecycleLocked ? "Stoppet är låst och behåller sin position" : undefined}
                                  className={isLifecycleLocked ? "cursor-not-allowed text-muted-foreground/40" : "cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"}>
                                  <GripVertical className="h-3.5 w-3.5" />
                                </div>
                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] font-bold text-primary">{currentDragIndex + 1}</span>
                                <button type="button" onClick={() => onOpenStop(stopRef.stopId)} className="min-w-0 flex-1 text-left" data-testid={`button-open-stop-${stopRef.stopId}`}>
                                  <span className="block truncate font-medium">{stop ? stopTitle(stop) : t("common.stop")}</span>
                                  <span className="block truncate text-[11px] text-muted-foreground">{stop?.address}</span>
                                </button>
                                <span className="shrink-0 text-right font-mono text-[10px] tabular-nums">
                                  {start && <span className={cn("block", late ? "font-semibold text-destructive" : "text-foreground")}>{clock(start)}</span>}
                                  {window && <span className={cn("block", late ? "text-destructive" : "text-muted-foreground")}>{window}</span>}
                                </span>
                              </div>
                            )}
                          </Draggable>
                        );
                      });
                    })()}
                    {provided.placeholder}
                    {route.stops.length === 0 && <p className="py-3 text-center text-[11px] italic text-muted-foreground">{t("planner.dropStopsHere")}</p>}
                  </div>
                )}
              </Droppable>
            </details>
          );
        })}
      </div>
    </DragDropContext>
  );
}
