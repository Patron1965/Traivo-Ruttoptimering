import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { useOptimizeRoutes } from "@/hooks/use-routes";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo } from "react";
import { ORG_ID, DEPOT_LOCATION } from "@/lib/constants";
import { Cpu, CheckCircle2, AlertCircle, Truck, MapPin, GripVertical } from "lucide-react";
import { RouteMap } from "@/components/map/RouteMap";
import { formatDistance } from "@/lib/utils";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { type Stop, type Vehicle, type Route } from "@workspace/api-client-react";

interface OptimizedRouteResult {
  vehicleId: string;
  routeId: string;
  stops: { stopId: string; sequenceOrder: number; estimatedArrival: string; distanceFromPreviousKm: number }[];
  distanceKm: number;
  durationMin: number;
  co2EmissionsKg: number;
}

export default function Planner() {
  const { data: vehicles, isLoading: loadingV } = useVehicles();
  const { data: stops, isLoading: loadingS } = useStops();
  const optimizeMutation = useOptimizeRoutes();

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
        name: vehicle?.name ? `${vehicle.name} Route` : `Route`,
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
  }, [dndRoutes, optimizeMutation.data, vehiclesById, stopsById]);

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

    const [movedStop] = newRoutes[sourceDriverIdx].stops.splice(sourceIdx, 1);
    newRoutes[destDriverIdx].stops.splice(destIdx, 0, movedStop);

    newRoutes.forEach(route => {
      route.stops.forEach((stop, idx) => {
        stop.sequenceOrder = idx + 1;
      });
    });

    setDndRoutes(newRoutes);
  };

  if (loadingV || loadingS) return <AppLayout><LoadingState message="Loading planner..." /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-full w-full flex-col lg:flex-row">
        
        <div className="w-full lg:w-[450px] flex flex-col border-r border-border bg-card/30 z-10 shadow-2xl overflow-hidden shrink-0">
          <div className="p-6 border-b border-border bg-card/80 backdrop-blur-md">
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Cpu className="text-primary h-6 w-6" /> AI Optimizer
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Select resources to generate optimal routes.</p>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            {dndRoutes ? (
              <DragDropContext onDragEnd={handleDragEnd}>
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Route Assignments
                    </h3>
                    <Button variant="outline" size="sm" onClick={() => setDndRoutes(null)}>
                      Reset
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Drag stops between drivers to reassign them.</p>
                  
                  {dndRoutes.map((route, routeIdx) => {
                    const vehicle = vehiclesById.get(route.vehicleId);
                    return (
                      <div key={route.routeId} className="rounded-xl border border-border bg-card/50 overflow-hidden">
                        <div className="p-3 bg-muted/30 border-b border-border flex items-center gap-2">
                          <Truck className="h-4 w-4 text-primary" />
                          <span className="font-semibold text-sm">{vehicle?.name || "Vehicle"}</span>
                          <span className="text-xs text-muted-foreground ml-auto">{route.stops.length} stops</span>
                        </div>
                        <Droppable droppableId={`driver-${routeIdx}`}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.droppableProps}
                              className={`min-h-[60px] p-2 space-y-1 transition-colors ${snapshot.isDraggingOver ? 'bg-primary/5' : ''}`}
                            >
                              {route.stops.map((stopRef, stopIdx) => {
                                const stop = stopsById.get(stopRef.stopId);
                                return (
                                  <Draggable key={stopRef.stopId} draggableId={stopRef.stopId} index={stopIdx}>
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
                                          {stopIdx + 1}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                          <p className="font-medium truncate">{stop?.notes || "Stop"}</p>
                                          <p className="text-xs text-muted-foreground truncate">{stop?.address}</p>
                                        </div>
                                      </div>
                                    )}
                                  </Draggable>
                                );
                              })}
                              {provided.placeholder}
                              {route.stops.length === 0 && (
                                <p className="text-xs text-muted-foreground text-center py-4 italic">Drop stops here</p>
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
                      <Truck className="h-5 w-5" /> Available Fleet
                    </h3>
                    <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded-md font-bold">
                      {selectedVehicleIds.size} selected
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
                      <MapPin className="h-5 w-5" /> Unassigned Stops
                    </h3>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedStopIds(new Set(unassignedStops.map(s=>s.id)))}>All</Button>
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedStopIds(new Set())}>None</Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {unassignedStops.length === 0 ? (
                      <p className="text-sm text-muted-foreground italic p-4 text-center border border-dashed rounded-xl">No unassigned stops.</p>
                    ) : (
                      unassignedStops.map(s => (
                        <div key={s.id} className="flex items-start space-x-3 p-3 rounded-xl border border-border/50 hover:bg-muted/50 transition-colors">
                          <Checkbox id={`s-${s.id}`} checked={selectedStopIds.has(s.id)} onCheckedChange={() => toggleStop(s.id)} className="mt-1" />
                          <label htmlFor={`s-${s.id}`} className="flex-1 cursor-pointer">
                            <p className="text-sm font-bold leading-none mb-1">{s.notes || "Delivery Stop"}</p>
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
                  "Optimizing Routes..."
                ) : (
                  <>
                    Generate Routes <Cpu className="ml-2 h-5 w-5 group-hover:rotate-12 transition-transform" />
                  </>
                )}
              </Button>
              {optimizeMutation.isError && (
                <p className="text-sm text-destructive mt-3 flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" /> Optimization failed. Try again.
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
                    <h3 className="text-xl font-bold">Optimization Complete</h3>
                    <p className="text-muted-foreground text-sm">
                      Generated {optimizeMutation.data.routes.length} routes covering {formatDistance(optimizeMutation.data.totalDistanceKm)}
                    </p>
                  </div>
                </div>
                {optimizeMutation.data.unassignedStopIds.length > 0 && (
                  <div className="px-4 py-2 bg-amber-500/10 text-amber-500 rounded-lg text-sm font-medium flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {optimizeMutation.data.unassignedStopIds.length} stops couldn't be assigned
                  </div>
                )}
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
                     Select stops and vehicles to preview optimization
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
