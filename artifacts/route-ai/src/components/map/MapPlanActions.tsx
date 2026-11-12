import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Route } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { useRoutes } from "@/hooks/use-routes";
import { useStops } from "@/hooks/use-stops";
import { useDrivers } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { resolvePlanReviewDepot } from "@/lib/plan-review";
import { resolveMapPlanTarget, resourceEditBlockReason } from "@/lib/map-plan-actions";
import { invalidateRouteQueries } from "@/lib/route-query-cache";
import { RouteReoptimizationMenu } from "@/components/routes/RouteReoptimizationMenu";
import { RouteDriverAction } from "@/components/dispatch/RouteDriverAction";
import { Step7Adjust } from "@/components/import/Step7Adjust";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

/** Visual highlights never implicitly choose one of several operational targets. */
export default function MapPlanActions({ visibleRoutes, selected }: {
  visibleRoutes: Route[];
  selected: ReadonlySet<string>;
}) {
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const routesQuery = useRoutes();
  const stopsQuery = useStops();
  const driversQuery = useDrivers();
  const vehiclesQuery = useVehicles();
  const [editing, setEditing] = useState<Route[] | null>(null);
  const drivers = driversQuery.data ?? [];
  const vehicles = vehiclesQuery.data ?? [];
  // Always use every route in the plan, including routes hidden on the map.
  const { route, planRoutes } = resolveMapPlanTarget(visibleRoutes, selected, routesQuery.data ?? []);
  const depot = resolvePlanReviewDepot(planRoutes, drivers, new Set(vehicles.filter(v => v.isActive).map(v => v.id)));
  const editingDepot = editing && resolvePlanReviewDepot(editing, drivers, new Set(vehicles.filter(v => v.isActive).map(v => v.id)));
  const ready = ![routesQuery, stopsQuery, driversQuery, vehiclesQuery].some(q => q.isLoading || q.isError);
  const blockReason = resourceEditBlockReason(planRoutes, !!depot);
  const canEdit = ready && !blockReason;
  const refresh = async () => {
    await Promise.all([
      invalidateRouteQueries(queryClient),
      queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
      queryClient.invalidateQueries({ queryKey: ["planning-drafts"] }),
    ]);
  };
  const close = async () => { setEditing(null); await refresh(); };

  if (!hasRole("admin", "dispatcher")) return null;
  return (
    <div className="mt-2 border-t border-border pt-2 space-y-2" data-testid="map-plan-actions">
      <p className="px-2 text-muted-foreground">Planändringar sparas separat från kartans markeringar.</p>
      {!route && <p className="px-2">Markera exakt en rutt för att välja vilken plan du vill ändra.</p>}
      {route && (
        <>
          <p className="px-2 font-semibold break-words">{route.name}</p>
          {ready && (
            <div className="[&_button]:w-full" data-testid="map-change-route-resource">
              <RouteDriverAction route={route} vehicles={vehicles} drivers={drivers} explicitLabel />
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                Byt till en annan registrerad resurs för denna rutt före utskick. Stoppen och ordningen behålls.
              </p>
            </div>
          )}
          <Button size="sm" variant="outline" className="w-full" disabled={!canEdit}
            data-testid="map-edit-plan-drivers" onClick={() => setEditing([...planRoutes])}>
            Lägg till / ta bort resurser
          </Button>
          {!ready && <p role="status">Planunderlaget kunde inte hämtas eller laddas fortfarande.</p>}
          {ready && !canEdit && <p className="px-2 text-muted-foreground">
            {blockReason}
          </p>}
          {ready && depot && route.status !== "completed" && route.status !== "cancelled" && (
            <RouteReoptimizationMenu route={route} planRoutes={planRoutes} drivers={drivers}
              vehicles={vehicles} stops={stopsQuery.data ?? []} {...depot}
              className="w-full" onSaved={refresh} />
          )}
        </>
      )}
      <Dialog open={!!editing} onOpenChange={open => { if (!open) void close(); }}>
        <DialogContent className="max-w-[96vw] w-[1400px] h-[92vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Ändra resurser och optimera planen</DialogTitle>
            <DialogDescription>
              Välj resurser och beräkna om arbetsplanen. Stopp kan fördelas om eller bli oplanerade.
              Chaufförskonton raderas inte. Inget skickas automatiskt till förarna.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">
            {editing && editingDepot && (
              <Step7Adjust
                routes={editing.map(item => ({
                  routeId: item.id, planId: item.planId, name: item.name,
                  vehicleId: item.vehicleId!,
                  driverId: item.planningSummary?.selectedPairValues?.find(pair => pair.startsWith(`${item.vehicleId}:`))?.split(":")[1]
                    ?? item.handoffDriverId ?? drivers.find(driver => driver.vehicleId === item.vehicleId && driver.isActive)?.id ?? "",
                  stopCount: item.totalStops, totalDistanceKm: item.totalDistanceKm ?? 0,
                  totalDurationMin: item.totalDurationMin ?? 0, planRevision: item.planRevision,
                  status: "optimized" as const,
                }))}
                unplannedStops={(stopsQuery.data ?? []).filter(stop => !stop.routeId && stop.planningPlanId === editing[0].planId)}
                unplannedDiagnostics={[]} vehicles={vehicles} drivers={drivers}
                {...editingDepot} allowResourceSelection
                onValidated={close} onNext={() => { void close(); }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
