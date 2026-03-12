import { AppLayout } from "@/components/layout/AppLayout";
import { RouteMap } from "@/components/map/RouteMap";
import { useRoutes, useRouteStops } from "@/hooks/use-routes";
import { useStops } from "@/hooks/use-stops";
import { LoadingState } from "@/components/ui/LoadingState";
import { useQueries } from "@tanstack/react-query";
import { getGetRouteStopsQueryOptions } from "@workspace/api-client-react";
import { useMemo } from "react";
import { Truck, MapPin } from "lucide-react";
import { ROUTE_COLORS } from "@/lib/constants";
import { formatDistance, formatDuration } from "@/lib/utils";

export default function MapPage() {
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops();

  // Fetch stops for all active routes dynamically
  const routeQueries = useQueries({
    queries: (routes || []).map(route => getGetRouteStopsQueryOptions(route.id))
  });

  const isLoading = loadingRoutes || loadingStops || routeQueries.some(q => q.isLoading);

  const fullRoutesData = useMemo(() => {
    if (!routes) return [];
    return routes.map((route, idx) => ({
      ...route,
      stopsList: routeQueries[idx]?.data || []
    }));
  }, [routes, routeQueries]);

  const unassignedStops = useMemo(() => {
    if (!allStops) return [];
    return allStops.filter(s => !s.routeId);
  }, [allStops]);

  if (isLoading) return <AppLayout><LoadingState message="Initializing live map..." /></AppLayout>;

  return (
    <AppLayout>
      <div className="flex h-full w-full">
        {/* Sidebar Route List */}
        <div className="w-80 border-r border-border bg-card/50 backdrop-blur-sm flex flex-col hidden lg:flex shrink-0">
          <div className="p-4 border-b border-border">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              Live Routes
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {fullRoutesData.map((route, i) => (
              <div key={route.id} className="bg-background rounded-xl p-4 border border-border shadow-sm group hover:border-primary/50 transition-colors">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: ROUTE_COLORS[i % ROUTE_COLORS.length] }} />
                  <h3 className="font-bold truncate" title={route.name}>{route.name}</h3>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm mb-3">
                  <div className="bg-muted px-2 py-1.5 rounded text-center">
                    <p className="text-muted-foreground text-xs uppercase tracking-wider">Stops</p>
                    <p className="font-semibold">{route.totalStops}</p>
                  </div>
                  <div className="bg-muted px-2 py-1.5 rounded text-center">
                    <p className="text-muted-foreground text-xs uppercase tracking-wider">Distance</p>
                    <p className="font-semibold">{route.totalDistanceKm ? formatDistance(route.totalDistanceKm) : '--'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Truck className="h-3 w-3" />
                  <span>{route.status.toUpperCase()}</span>
                </div>
              </div>
            ))}
            
            {fullRoutesData.length === 0 && (
              <div className="text-center p-8 text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No active routes found.</p>
              </div>
            )}
          </div>
        </div>

        {/* Map Area */}
        <div className="flex-1 relative">
          <div className="absolute inset-4 z-10 rounded-2xl overflow-hidden shadow-2xl shadow-black/20 border border-border/50">
            <RouteMap routes={fullRoutesData} unassignedStops={unassignedStops} />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
