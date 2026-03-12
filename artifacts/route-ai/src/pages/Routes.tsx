import { useRoutes, useDeleteRoute } from "@/hooks/use-routes";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Route as RouteIcon, Trash2, MapPin, Clock, Gauge } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-muted/50", text: "text-muted-foreground" },
  optimized: { bg: "bg-primary/20", text: "text-primary" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  cancelled: { bg: "bg-destructive/20", text: "text-destructive" },
};

export default function Routes() {
  const { data: routes, isLoading, error } = useRoutes();
  const deleteRoute = useDeleteRoute();

  return (
    <AppLayout>
      <div className="p-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">All Routes</h1>
            <p className="text-muted-foreground mt-1">View and manage delivery routes</p>
          </div>
        </div>

        {isLoading && <LoadingState message="Loading routes..." />}
        {error && <p className="text-destructive">Failed to load routes.</p>}

        {routes && routes.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <RouteIcon className="h-12 w-12 mx-auto mb-4 opacity-30" />
            <p>No routes yet. Use the Route Planner to create optimized routes.</p>
          </div>
        )}

        {routes && routes.length > 0 && (
          <div className="space-y-4">
            {routes.map((route: any) => {
              const style = STATUS_STYLES[route.status] || STATUS_STYLES.draft;
              return (
                <div
                  key={route.id}
                  className="p-5 rounded-xl border border-border bg-card hover:bg-card/80 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <RouteIcon className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-semibold">{route.name}</h3>
                        <p className="text-xs text-muted-foreground">
                          {route.date ? format(new Date(route.date), "PPP") : "No date"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-6">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <MapPin className="h-4 w-4" />
                        <span>{route.totalStops} stops</span>
                      </div>

                      {route.totalDistanceKm != null && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Gauge className="h-4 w-4" />
                          <span>{route.totalDistanceKm} km</span>
                        </div>
                      )}

                      {route.totalDurationMin != null && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Clock className="h-4 w-4" />
                          <span>{Math.floor(route.totalDurationMin / 60)}h {Math.round(route.totalDurationMin % 60)}m</span>
                        </div>
                      )}

                      <span className={cn("px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wide", style.bg, style.text)}>
                        {route.status}
                      </span>

                      <button
                        onClick={() => deleteRoute.mutate({ id: route.id })}
                        className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
