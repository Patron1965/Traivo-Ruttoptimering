import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { useOptimizeRoutes } from "@/hooks/use-routes";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo } from "react";
import { ORG_ID, DEPOT_LOCATION } from "@/lib/constants";
import { Cpu, CheckCircle2, AlertCircle, Truck, MapPin, GripVertical, Zap, BatteryCharging } from "lucide-react";
import { RouteMap } from "@/components/map/RouteMap";
import { formatDistance } from "@/lib/utils";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { type Stop, type Vehicle, type Route } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";

interface OptimizedStopRef {
  stopId: string;
  sequenceOrder: number;
  estimatedArrival: string;
  distanceFromPreviousKm: number;
  isChargingStop?: boolean;
  chargingStationName?: string;
}

interface OptimizedRouteResult {
  vehicleId: string;
  routeId: string;
  stops: OptimizedStopRef[];
  distanceKm: number;
  durationMin: number;
  co2EmissionsKg: number;
  chargingStopsInserted?: number;
}

export default function Planner() {
  const { data: vehicles, isLoading: loadingV } = useVehicles();
  const { data: stops, isLoading: loadingS } = useStops();
  const optimizeMutation = useOptimizeRoutes();
  const { t } = useTranslation();

  const [selectedVehicleIds, setSelectedVehicleIds] = useState<Set<string>>(new Set());
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [dndRoutes, setDndRoutes] = useState<OptimizedRouteResult[] | null>(null);

  const unassignedStops = useMemo(() => stops?.filter(s => !s.routeId) || [], [stops]);
  const activeVehicles = useMemo(() => vehicles?.filter(v => v.isActive) || [], [vehicles]);

  const stopsById = useMemo(() => {
    const map = new Map<string, Stop>();
    stops?.forEach(s => map.set(s.id, s));
    return map;
  }, [stops]);

  const vehiclesById = useMemo(() => {
    const map = new Map<string, Vehicle>();
    vehicles?.forEach(v => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const mapRoutes = useMemo(() => {
    const source = dndRoutes || (optimizeMutation.data?.routes as OptimizedRouteResult[] | undefined);
    if (!source) return undefined;
    return source.map((r) => {
      const vehicle = vehiclesById.get(r.vehicleId);
      const stopsList = r.stops
        .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
        .map((ref) => stopsById.get(ref.stopId))
        .filter((s): s is Stop => !!s)
        .map((s, idx) => ({ ...s, sequenceOrder: idx + 1 }));
      return {
        id: r.routeId,
        name: vehicle?.name ? `${vehicle.name} ${t("common.route")}` : t("common.route"),
        status: "optimized" as const,
        organizationId: ORG_ID,
        vehicleId: r.vehicleId,
        date: new Date().toISOString(),
        totalDistanceKm: r.distanceKm,
        totalDurationMin: r.durationMin,
        co2EmissionsKg: r.co2EmissionsKg,
        totalStops: stopsList.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stopsList,
      } satisfies Route & { stopsList: Stop[] };
    });
  }, [dndRoutes, optimizeMutation.data, vehiclesById, stopsById, t]);

  const toggleVehicle = (id: string) => {
    const next = new Set(selectedVehicleIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedVehicleIds(next);
  };

  const toggleStop = (id: string) => {
    const next = new Set(selectedStopIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedStopIds(next);
  };

  const handleOptimize = () => {
    if (selectedVehicleIds.size === 0 || selectedStopIds.size === 0) return;
    
    optimizeMutation.mutate({
      data: {
        organizationId: ORG_ID,
        vehicleIds: Array.from(selectedVehicleIds),
        stopIds: Array.from(selectedStopIds),
        depotLatitude: DEPOT_LOCATION.lat,
        depotLongitude: DEPOT_LOCATION.lng
      }
    }, {
      onSuccess: (data) => {
        setDndRoutes(data.routes as OptimizedRouteResult[]);
      }
    });
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination || !dndRoutes) return;

    const sourceDriverIdx = parseInt(result.source.droppableId.replace("driver-", ""));
    const destDriverIdx = parseInt(result.destination.droppableId.replace("driver-", ""));
    const sourceIdx = result.source.index;
    const destIdx = result.destination.index;

    const newRoutes = dndRoutes.map(r => ({ ...r, stops: [...r.stops] }));

    const sourceDraggable = newRoutes[sourceDriverIdx].stops.filter(s => !s.isChargingStop);
    const destDraggable = sourceDriverIdx === destDriverIdx ? sourceDraggable : newRoutes[destDriverIdx].stops.filter(s => !s.isChargingStop);

    const [movedStop] = sourceDraggable.splice(sourceIdx, 1);
    destDraggable.splice(destIdx, 0, movedStop);

    const sourceCharging = newRoutes[sourceDriverIdx].stops.filter(s => s.isChargingStop);
    newRoutes[sourceDriverIdx].stops = [...sourceCharging, ...sourceDraggable];
    if (sourceDriverIdx !== destDriverIdx) {
      const destCharging = newRoutes[destDriverIdx].stops.filter(s => s.isChargingStop);
      newRoutes[destDriverIdx].stops = [...destCharging, ...destDraggable];
    }

    newRoutes.forEach(route => {
      route.stops.forEach((stop, idx) => {
        stop.sequenceOrder = idx + 1;
      });
    });

    setDndRoutes(newRoutes);
  };

  if (loadingV || loadingS) return <AppLayout><LoadingState message={t("planner.loadingPlanner")} /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-full w-full flex-col lg:flex-row">
        
        <div className="w-full lg:w-[450px] flex flex-col border-r border-border bg-card/30 z-10 shadow-2xl overflow-hidden shrink-0">
          <div className="p-6 border-b border-border bg-card/80 backdrop-blur-md">
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Cpu className="text-primary h-6 w-6" /> {t("planner.title")}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{t("planner.subtitle")}</p>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            {dndRoutes ? (
              <DragDropContext onDragEnd={handleDragEnd}>
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" /> {t("planner.routeAssignments")}
                    </h3>
                    <Button variant="outline" size="sm" onClick={() => setDndRoutes(null)}>
                      {t("common.reset")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("planner.dragHint")}</p>
                  
                  {dndRoutes.map((route, routeIdx) => {
                    const vehicle = vehiclesById.get(route.vehicleId);
                    return (
                      <div key={route.routeId} className="rounded-xl border border-border bg-card/50 overflow-hidden">
                        <div className="p-3 bg-muted/30 border-b border-border flex items-center gap-2">
                          <Truck className="h-4 w-4 text-primary" />
                          <span className="font-semibold text-sm">{vehicle?.name || t("common.vehicle")}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{route.stops.length} {t("common.stops")}</span>
                        </div>
                        <Droppable droppableId={`driver-${routeIdx}`}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.droppableProps}
                              className={`min-h-[60px] p-2 space-y-1 transition-colors ${snapshot.isDraggingOver ? 'bg-primary/5' : ''}`}
                            >
                              {(() => {
                                const chargingStops = route.stops.filter(s => s.isChargingStop);
                                const deliveryStops = route.stops.filter(s => !s.isChargingStop);
                                return (
                                  <>
                                    {chargingStops.length > 0 && (
                                      <div className="space-y-1 mb-1">
                                        {chargingStops.map((cs) => (
                                          <div
                                            key={cs.stopId}
                                            className="flex items-center gap-2 p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-sm"
                                          >
                                            <div className="w-4" />
                                            <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-500 text-xs font-bold flex items-center justify-center shrink-0">
                                              <BatteryCharging className="h-3.5 w-3.5" />
                                            </span>
                                            <div className="flex-1 min-w-0">
                                              <p className="font-medium truncate text-emerald-500">{cs.chargingStationName}</p>
                                              <p className="text-xs text-muted-foreground">{t("planner.chargingStop")}</p>
                                            </div>
                                            <Zap className="h-4 w-4 text-emerald-500 shrink-0" />
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                    {deliveryStops.map((stopRef, dragIdx) => {
                                      const stop = stopsById.get(stopRef.stopId);
                                      return (
                                        <Draggable key={stopRef.stopId} draggableId={stopRef.stopId} index={dragIdx}>
                                          {(provided, snapshot) => (
                                            <div
                                              ref={provided.innerRef}
                                              {...provided.draggableProps}
                                              className={`flex items-center gap-2 p-2 rounded-lg border text-sm transition-all ${
                                                snapshot.isDragging 
                                                  ? 'border-primary bg-card shadow-lg shadow-primary/10' 
                                                  : 'border-border/50 bg-card/50 hover:bg-muted/30'
                                              }`}
                                            >
                                              <div {...provided.dragHandleProps} className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground">
                                                <GripVertical className="h-4 w-4" />
                                              </div>
                                              <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center shrink-0">
                                                {dragIdx + 1}
                                              </span>
                                              <div className="flex-1 min-w-0">
                                                <p className="font-medium truncate">{stop?.notes || t("common.stop")}</p>
                                                <p className="text-xs text-muted-foreground truncate">{stop?.address}</p>
                                              </div>
                                            </div>
                                          )}
                                        </Draggable>
                                      );
                                    })}
                                  </>
                                );
                              })()}
                              {provided.placeholder}
                              {route.stops.length === 0 && (
                                <p className="text-xs text-muted-foreground text-center py-4 italic">{t("planner.dropStopsHere")}</p>
                              )}
                            </div>
                          )}
                        </Droppable>
                      </div>
                    );
                  })}
                </div>
              </DragDropContext>
            ) : (
              <>
                <section>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <Truck className="h-5 w-5" /> {t("planner.availableFleet")}
                    </h3>
                    <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded-md font-bold">
                      {selectedVehicleIds.size} {t("common.selected")}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {activeVehicles.map(v => (
                      <div key={v.id} className="flex items-center space-x-3 p-3 rounded-xl border border-border/50 hover:bg-muted/50 transition-colors">
                        <Checkbox id={`v-${v.id}`} checked={selectedVehicleIds.has(v.id)} onCheckedChange={() => toggleVehicle(v.id)} />
                        <label htmlFor={`v-${v.id}`} className="flex-1 cursor-pointer text-sm font-medium leading-none">
                          {v.name} <span className="text-muted-foreground font-normal ml-1">({v.capacityKg}kg)</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <MapPin className="h-5 w-5" /> {t("planner.unassignedStops")}
                    </h3>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedStopIds(new Set(unassignedStops.map(s=>s.id)))}>{t("common.all")}</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedStopIds(new Set())}>{t("common.none")}</Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {unassignedStops.length === 0 ? (
                      <p className="text-sm text-muted-foreground italic p-4 text-center border border-dashed rounded-xl">{t("planner.noUnassignedStops")}</p>
                    ) : (
                      unassignedStops.map(s => (
                        <div key={s.id} className="flex items-start space-x-3 p-3 rounded-xl border border-border/50 hover:bg-muted/50 transition-colors">
                          <Checkbox id={`s-${s.id}`} checked={selectedStopIds.has(s.id)} onCheckedChange={() => toggleStop(s.id)} className="mt-1" />
                          <label htmlFor={`s-${s.id}`} className="flex-1 cursor-pointer">
                            <p className="text-sm font-bold leading-none mb-1">{s.notes || t("common.deliveryStop")}</p>
                            <p className="text-xs text-muted-foreground line-clamp-1">{s.address}</p>
                          </label>
                        </div>
                      ))
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          {!dndRoutes && (
            <div className="p-6 border-t border-border bg-card/80 backdrop-blur-md">
              <Button 
                className="w-full py-6 text-lg font-bold shadow-xl shadow-primary/20 group"
                onClick={handleOptimize}
                disabled={selectedVehicleIds.size === 0 || selectedStopIds.size === 0 || optimizeMutation.isPending}
              >
                {optimizeMutation.isPending ? (
                  t("planner.optimizingRoutes")
                ) : (
                  <>
                    {t("planner.generateRoutes")} <Cpu className="ml-2 h-5 w-5 group-hover:rotate-12 transition-transform" />
                  </>
                )}
              </Button>
              {optimizeMutation.isError && (
                <p className="text-sm text-destructive mt-3 flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" /> {t("planner.optimizationFailed")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 relative flex flex-col bg-background/50">
          {optimizeMutation.isSuccess && optimizeMutation.data && !dndRoutes && (
            <div className="absolute top-4 left-4 right-4 z-20 animate-in slide-in-from-top-4 fade-in">
              <div className="bg-card border border-primary/50 shadow-2xl shadow-primary/10 rounded-2xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold">{t("planner.optimizationComplete")}</h3>
                    <p className="text-muted-foreground text-sm">
                      {t("planner.generatedRoutes", { count: optimizeMutation.data.routes.length, distance: formatDistance(optimizeMutation.data.totalDistanceKm) })}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(optimizeMutation.data.routes as OptimizedRouteResult[]).some(r => (r.chargingStopsInserted ?? 0) > 0) && (
                    <div className="px-4 py-2 bg-emerald-500/10 text-emerald-500 rounded-lg text-sm font-medium flex items-center gap-2">
                      <BatteryCharging className="h-4 w-4" />
                      {t("planner.chargingStopsInserted", { count: (optimizeMutation.data.routes as OptimizedRouteResult[]).reduce((sum, r) => sum + (r.chargingStopsInserted ?? 0), 0) })}
                    </div>
                  )}
                  {optimizeMutation.data.unassignedStopIds.length > 0 && (
                    <div className="px-4 py-2 bg-amber-500/10 text-amber-500 rounded-lg text-sm font-medium flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      {t("planner.stopsCouldntBeAssigned", { count: optimizeMutation.data.unassignedStopIds.length })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 p-4 pb-4">
            <div className="w-full h-full rounded-2xl overflow-hidden shadow-inner border border-border/50 relative">
               <RouteMap 
                 routes={mapRoutes}
                 unassignedStops={mapRoutes ? [] : unassignedStops} 
                 interactive={true}
               />
               {!dndRoutes && !optimizeMutation.isSuccess && (
                 <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
                   <div className="bg-background/90 backdrop-blur-md px-6 py-3 rounded-full border border-border shadow-xl text-sm font-medium">
                     {t("planner.selectStopsAndVehicles")}
                   </div>
                 </div>
               )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
