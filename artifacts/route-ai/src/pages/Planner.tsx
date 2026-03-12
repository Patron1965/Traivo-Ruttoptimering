import { AppLayout } from "@/components/layout/AppLayout";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { useOptimizeRoutes, useRoutes } from "@/hooks/use-routes";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo } from "react";
import { ORG_ID, DEPOT_LOCATION } from "@/lib/constants";
import { Cpu, CheckCircle2, AlertCircle, Truck, MapPin } from "lucide-react";
import { RouteMap } from "@/components/map/RouteMap";
import { formatDistance, formatDuration } from "@/lib/utils";

export default function Planner() {
  const { data: vehicles, isLoading: loadingV } = useVehicles();
  const { data: stops, isLoading: loadingS } = useStops();
  const { data: routes } = useRoutes(); // Just to show if there are existing optimized routes
  const optimizeMutation = useOptimizeRoutes();

  const [selectedVehicleIds, setSelectedVehicleIds] = useState<Set<string>>(new Set());
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());

  const unassignedStops = useMemo(() => stops?.filter(s => !s.routeId) || [], [stops]);
  const activeVehicles = useMemo(() => vehicles?.filter(v => v.isActive) || [], [vehicles]);

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
    });
  };

  if (loadingV || loadingS) return <AppLayout><LoadingState message="Loading planner..." /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-full w-full flex-col lg:flex-row">
        
        {/* Left Panel: Configuration */}
        <div className="w-full lg:w-[450px] flex flex-col border-r border-border bg-card/30 z-10 shadow-2xl overflow-hidden shrink-0">
          <div className="p-6 border-b border-border bg-card/80 backdrop-blur-md">
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Cpu className="text-primary h-6 w-6" /> AI Optimizer
            </h1>
            <p className="text-sm text-muted-foreground mt-1">Select resources to generate optimal routes.</p>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            {/* Vehicles Selection */}
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
                    <label htmlFor={`v-${v.id}`} className="flex-1 cursor-pointer text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      {v.name} <span className="text-muted-foreground font-normal ml-1">({v.capacityKg}kg)</span>
                    </label>
                  </div>
                ))}
              </div>
            </section>

            {/* Stops Selection */}
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
                        <p className="text-sm font-bold leading-none mb-1">{s.customerName || "Customer"}</p>
                        <p className="text-xs text-muted-foreground line-clamp-1">{s.address}</p>
                      </label>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

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
        </div>

        {/* Right Panel: Map & Results */}
        <div className="flex-1 relative flex flex-col bg-background/50">
          
          {/* Overlay when optimization succeeds */}
          {optimizeMutation.isSuccess && optimizeMutation.data && (
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
                    {optimizeMutation.data.unassignedStopIds.length} stops couldn't be assigned (constraints)
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Map Preview */}
          <div className="flex-1 p-4 pb-4">
            <div className="w-full h-full rounded-2xl overflow-hidden shadow-inner border border-border/50 relative">
               <RouteMap 
                 unassignedStops={unassignedStops} 
                 interactive={true}
                 // If we had full populated routes immediately we'd pass them here,
                 // but since the map page handles that, we just show unassigned stops for context
                 // until the user navigates to the map page.
               />
               <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
                 <div className="bg-background/90 backdrop-blur-md px-6 py-3 rounded-full border border-border shadow-xl text-sm font-medium">
                   Select stops and vehicles to preview optimization
                 </div>
               </div>
            </div>
          </div>

        </div>
      </div>
    </AppLayout>
  );
}
