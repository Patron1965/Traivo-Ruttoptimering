import { useState } from "react";
import type { Driver, Route, Stop, Vehicle } from "@workspace/api-client-react";
import { RouteReoptimizationMenu } from "@/components/routes/RouteReoptimizationMenu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { resolvePlanReviewDepot } from "@/lib/plan-review";

/** Selection is explicit: never silently target the first visible route. */
export function DispatchReoptimizationAction({ routes, drivers, vehicles, stops, selectedIds }: {
  routes: Route[]; drivers: Driver[]; vehicles: Vehicle[]; stops: Stop[];
  selectedIds?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const eligible = routes.filter(route => !["completed", "cancelled"].includes(route.status));
  const selected = eligible.filter(route => selectedIds?.has(route.id));
  const choices = selected.length ? selected : eligible;
  return <>
    <Button size="sm" variant="reroute" disabled={!eligible.length} onClick={() => setOpen(true)}>
      Rutta om
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rutta om</DialogTitle>
          <DialogDescription>
            Välj en rutt nedan. I dess meny kan du förhandsgranska återstående stopp
            eller hela planen. Genomförda stopp bevaras. En utskickad rutt ändras
            hos chauffören först efter nytt godkännande och utskick.
          </DialogDescription>
        </DialogHeader>
        {selected.length > 0 && <p className="text-sm">Visar {selected.length} markerade rutter.</p>}
        {choices.map(route => {
          const depot = resolvePlanReviewDepot([route], drivers,
            new Set(vehicles.filter(vehicle => vehicle.isActive).map(vehicle => vehicle.id)));
          return <div key={route.id} className="flex items-center justify-between gap-3 rounded border p-3">
          <span className="text-sm">{route.name}</span>
          {depot ? <RouteReoptimizationMenu
            route={route}
            planRoutes={route.planId ? routes.filter(candidate => candidate.planId === route.planId) : [route]}
            drivers={drivers} vehicles={vehicles} stops={stops}
            depotLatitude={depot.depotLatitude}
            depotLongitude={depot.depotLongitude}
          /> : <span role="status" className="text-xs text-destructive">Startplats saknas både i rutten och hos dess aktiva resurs. Ange start- och slutplats under Resurser innan du ruttar om.</span>}
        </div>;
        })}
      </DialogContent>
    </Dialog>
  </>;
}
