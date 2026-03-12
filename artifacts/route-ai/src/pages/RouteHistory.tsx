import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { useListRoutes, type Route } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import { useVehicles } from "@/hooks/use-vehicles";
import { useMemo } from "react";
import { Clock, MapPin, Route as RouteIcon, Gauge, Leaf, Fuel, Zap } from "lucide-react";
import { format } from "date-fns";
import { formatDistance, formatDuration } from "@/lib/utils";

export default function RouteHistory() {
  const { data: routes, isLoading } = useListRoutes(
    { organizationId: ORG_ID, status: "completed" as const },
  );
  const { data: vehicles } = useVehicles();

  const vehiclesById = useMemo(() => {
    const map = new Map<string, { name: string; vehicleType: string }>();
    vehicles?.forEach((v) => map.set(v.id, { name: v.name, vehicleType: v.vehicleType }));
    return map;
  }, [vehicles]);

  if (isLoading) return <AppLayout><LoadingState message="Loading route history..." /></AppLayout>;

  const completedRoutes = routes ?? [];

  return (
    <AppLayout>
      <div className="p-6 md:p-8 max-w-7xl mx-auto animate-in fade-in">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
            <Clock className="h-7 w-7 text-primary" /> Route History
          </h1>
          <p className="text-muted-foreground mt-1">Past completed routes and their performance</p>
        </div>

        {completedRoutes.length === 0 ? (
          <div className="bg-card rounded-2xl border border-card-border p-12 text-center shadow-xl shadow-black/5">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-muted-foreground">No completed routes yet</p>
            <p className="text-sm text-muted-foreground mt-1">Routes will appear here once they are marked as completed.</p>
          </div>
        ) : (
          <div className="bg-card rounded-2xl border border-card-border shadow-xl shadow-black/5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-muted/50 border-b border-border">
                    <th className="p-4 font-semibold text-muted-foreground text-sm">Route Name</th>
                    <th className="p-4 font-semibold text-muted-foreground text-sm">Date</th>
                    <th className="p-4 font-semibold text-muted-foreground text-sm">Driver / Vehicle</th>
                    <th className="p-4 font-semibold text-muted-foreground text-sm">Stops</th>
                    <th className="p-4 font-semibold text-muted-foreground text-sm">Distance</th>
                    <th className="p-4 font-semibold text-muted-foreground text-sm">Duration</th>
                    <th className="p-4 font-semibold text-muted-foreground text-sm">CO₂</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {completedRoutes.map((route: Route) => {
                    const veh = route.vehicleId ? vehiclesById.get(route.vehicleId) : null;
                    return (
                      <tr key={route.id} className="hover:bg-muted/30 transition-colors">
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <RouteIcon className="h-4 w-4 text-primary" />
                            <span className="font-medium">{route.name}</span>
                          </div>
                        </td>
                        <td className="p-4 text-muted-foreground text-sm">
                          {format(new Date(route.date), "MMM do, yyyy")}
                        </td>
                        <td className="p-4">
                          {veh ? (
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${veh.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                                {veh.vehicleType === 'electric' ? <Zap className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                              </span>
                              <span className="text-sm">{veh.name}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </td>
                        <td className="p-4">
                          <span className="inline-flex items-center gap-1 text-sm">
                            <MapPin className="h-3 w-3 text-muted-foreground" /> {route.totalStops}
                          </span>
                        </td>
                        <td className="p-4 text-sm">{formatDistance(route.totalDistanceKm ?? 0)}</td>
                        <td className="p-4 text-sm">{formatDuration(route.totalDurationMin ?? 0)}</td>
                        <td className="p-4">
                          <span className="inline-flex items-center gap-1 text-sm">
                            <Leaf className="h-3 w-3 text-emerald-500" />
                            {(route.co2EmissionsKg ?? 0).toFixed(1)} kg
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
