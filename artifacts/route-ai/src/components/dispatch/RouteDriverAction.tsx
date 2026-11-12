import { useState } from "react";
import type { Driver, Route, Vehicle } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RouteResourceReview } from "./RouteResourceReview";

export function RouteDriverAction({ route, vehicles, drivers, currentDriverName, compact = false, explicitLabel = false }: {
  route: Route; vehicles: Vehicle[]; drivers: Driver[]; currentDriverName?: string; compact?: boolean; explicitLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = vehicles.find(vehicle => vehicle.id === route.vehicleId)?.name;
  const label = name ? "Byt resurs" : "Tilldela resurs";
  const blocked = !["draft", "optimized"].includes(route.status) || Boolean(route.sentAt) || route.handoffStatus !== "pending";
  const description = blocked
    ? "Chaufför/fordon kan bara bytas före utskick."
    : "Byt chaufför/fordon";
  return <>
    <span title={description}>
      <Button size="sm" variant="outline" disabled={blocked}
        className={compact ? "h-6 min-h-0 rounded px-1.5 py-0 text-[10px] leading-none text-muted-foreground border-border/60 shadow-none hover:text-foreground [@media(pointer:coarse)]:h-9" : undefined}
        aria-label={`${description} – ${route.name}`}
        data-testid={`route-driver-action-${route.id}`} onClick={() => setOpen(true)}>
        {compact ? "Byt" : explicitLabel ? "Byt chaufför/fordon" : label}
      </Button>
    </span>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>{label} – {route.name}</DialogTitle>
        <DialogDescription>Välj en resurs. Stopp och ordning behålls.</DialogDescription>
        <p className="text-sm">Nuvarande resurs: {name ?? "Ingen tilldelad"}</p>
        <RouteResourceReview route={route} vehicles={vehicles} drivers={drivers} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  </>;
}
