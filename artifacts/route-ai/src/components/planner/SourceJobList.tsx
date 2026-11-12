import type { Stop } from "@workspace/api-client-react";
import { ChevronRight, Clock, MapPin } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatTimeWindow } from "@/lib/planner-workflow";
import { STOP_STATUS_LABEL, STOP_STATUS_TONE } from "./types";

export function stopTitle(stop: Stop): string {
  return stop.customerSiteName || stop.customerName || stop.notes || "Jobb utan kundnamn";
}

export function JobRow({ stop, selected, onToggle, onOpen, active }: {
  stop: Stop;
  selected?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
  active?: boolean;
}) {
  const window = formatTimeWindow(stop.timeWindowStart, stop.timeWindowEnd);
  return (
    <div
      data-testid={`row-job-${stop.id}`}
      className={cn(
        "group flex items-start gap-2 border-b border-border/50 px-3 py-2 text-sm transition-colors",
        selected ? "bg-primary/[0.06]" : "hover:bg-muted/40",
        active && "ring-1 ring-inset ring-primary/60",
      )}
    >
      {onToggle && (
        <Checkbox
          data-testid={`checkbox-job-${stop.id}`}
          checked={!!selected}
          onCheckedChange={onToggle}
          aria-label={`Välj ${stopTitle(stop)}`}
          className="mt-0.5"
        />
      )}
      <button type="button" onClick={onOpen} data-testid={`button-open-job-${stop.id}`} className="flex min-w-0 flex-1 items-start gap-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-semibold leading-tight">{stopTitle(stop)}</span>
            {stop.customerName && stop.customerSiteName && (
              <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">{stop.customerName}</span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{stop.address}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={cn("rounded px-1.5 py-px font-medium", STOP_STATUS_TONE[stop.status])}>{STOP_STATUS_LABEL[stop.status] ?? stop.status}</span>
            {window ? (
              <span className="inline-flex items-center gap-1 rounded bg-secondary/70 px-1.5 py-px font-mono tabular-nums text-secondary-foreground">
                <Clock className="h-3 w-3" />{window}
              </span>
            ) : (
              <span className="text-muted-foreground/70">Inget tidsfönster</span>
            )}
          </span>
        </span>
        <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
      </button>
    </div>
  );
}

export function SourceJobList({ stops, totalInScope, selectedIds, hiddenSelected, activeId, onToggle, onSelectAll, onClear, onOpen, emptyMessage }: {
  stops: Stop[];
  totalInScope: number;
  selectedIds: ReadonlySet<string>;
  hiddenSelected: number;
  activeId: string | null;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onOpen: (id: string) => void;
  emptyMessage: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5 text-xs">
        <span className="text-muted-foreground" data-testid="text-jobs-selected">
          <strong className="font-mono text-foreground tabular-nums">{selectedIds.size}</strong> av {totalInScope} valda
          {hiddenSelected > 0 && <span className="ml-1 text-amber-700 dark:text-amber-300">({hiddenSelected} dolda av filter)</span>}
        </span>
        <span className="flex gap-1">
          <button type="button" data-testid="button-select-visible-jobs" onClick={onSelectAll} disabled={stops.length === 0}
            className="rounded px-1.5 py-0.5 font-semibold text-primary hover:bg-primary/10 disabled:opacity-40">Välj synliga</button>
          <button type="button" data-testid="button-clear-jobs" onClick={onClear} disabled={selectedIds.size === 0}
            className="rounded px-1.5 py-0.5 font-semibold text-muted-foreground hover:bg-muted disabled:opacity-40">Rensa</button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {stops.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">{emptyMessage}</p>
        ) : stops.map((stop) => (
          <JobRow key={stop.id} stop={stop} selected={selectedIds.has(stop.id)} active={activeId === stop.id}
            onToggle={() => onToggle(stop.id)} onOpen={() => onOpen(stop.id)} />
        ))}
      </div>
    </div>
  );
}
