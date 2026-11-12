import type { Driver, Vehicle } from "@workspace/api-client-react";
import { Clock, Truck } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export function ResourceList({ vehicles, driverByVehicleId, selectedIds, onToggle, onSelectAll, onClear }: {
  vehicles: Vehicle[];
  driverByVehicleId: Map<string, Driver>;
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5 text-xs">
        <span className="text-muted-foreground" data-testid="text-resources-selected">
          <strong className="font-mono text-foreground tabular-nums">{selectedIds.size}</strong> av {vehicles.length} aktiva resurser
        </span>
        <span className="flex gap-1">
          <button type="button" data-testid="button-select-all-resources" onClick={onSelectAll} disabled={vehicles.length === 0}
            className="rounded px-1.5 py-0.5 font-semibold text-primary hover:bg-primary/10 disabled:opacity-40">Välj alla</button>
          <button type="button" data-testid="button-clear-resources" onClick={onClear} disabled={selectedIds.size === 0}
            className="rounded px-1.5 py-0.5 font-semibold text-muted-foreground hover:bg-muted disabled:opacity-40">Rensa</button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {vehicles.length === 0 && <p className="px-6 py-10 text-center text-sm text-muted-foreground">Inga aktiva resurser finns registrerade.</p>}
        {vehicles.map((v) => {
          const driver = driverByVehicleId.get(v.id);
          const selected = selectedIds.has(v.id);
          const capacityKg = driver?.capacityKg != null ? Math.min(driver.capacityKg, v.capacityKg) : v.capacityKg;
          const hours = driver?.workStartTime && driver?.workEndTime ? `${driver.workStartTime.slice(0, 5)}–${driver.workEndTime.slice(0, 5)}` : null;
          return (
            <label key={v.id} htmlFor={`res-${v.id}`} data-testid={`row-resource-${v.id}`}
              className={cn("flex cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-2 text-sm transition-colors",
                selected ? "bg-primary/[0.06]" : "hover:bg-muted/40")}>
              <Checkbox id={`res-${v.id}`} data-testid={`checkbox-resource-${v.id}`} checked={selected} onCheckedChange={() => onToggle(v.id)} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: v.routeColor }} />
                  <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-semibold" data-testid={`text-resource-name-${v.id}`}>{v.name}</span>
                  {v.licensePlate && <span className="font-mono text-xs text-muted-foreground">{v.licensePlate}</span>}
                </span>
                {!driver && (
                  <span className="mt-0.5 block text-[11px] font-semibold text-amber-700 dark:text-amber-300" data-testid={`text-resource-review-${v.id}`}>
                    Driftprofil behöver granskas under Resurser
                  </span>
                )}
                <span className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="inline-flex items-center gap-1 rounded bg-secondary/70 px-1.5 py-px font-mono tabular-nums text-secondary-foreground" title="Arbetstid enligt resursprofil">
                    <Clock className="h-3 w-3" />{hours ?? "Arbetstid saknas"}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-px font-mono tabular-nums text-muted-foreground">{capacityKg} kg</span>
                  {v.vehicleType === "electric" && v.currentBatteryPercent != null && (
                    <span className="rounded bg-muted px-1.5 py-px font-mono tabular-nums text-muted-foreground">{Math.round(v.currentBatteryPercent)} %</span>
                  )}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="border-t border-border/60 px-3 py-1.5 text-[10px] leading-snug text-muted-foreground">
        Arbetstid visas från resursprofilen. Frånvaro per dag finns inte i underlaget och kontrolleras inte här.
      </p>
    </div>
  );
}
