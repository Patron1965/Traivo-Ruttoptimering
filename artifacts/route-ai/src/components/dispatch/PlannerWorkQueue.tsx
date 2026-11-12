import { useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LockEvidenceBadges } from "./LockEvidenceBadges";
import type { ScheduledRow } from "@/lib/scheduling";
import type { Stop } from "@workspace/api-client-react";

export type WorkQueueTab = "action" | "unassigned" | "all";

interface Props {
  tab: WorkQueueTab;
  onTabChange: (tab: WorkQueueTab) => void;
  unassignedCount: number;
  actionPanel: ReactNode;
  unassignedPanel: ReactNode;
  rows: ScheduledRow[];
  unassignedStops: Stop[];
  selectedStopId: string | null;
  onSelectScheduled: (stopId: string, rowIdx: number) => void;
  onSelectUnassigned: (stopId: string) => void;
  onHoverStop: (stopId: string | null) => void;
  onClose: () => void;
}

export function PlannerWorkQueue(props: Props) {
  const { tab, onTabChange } = props;
  const [query, setQuery] = useState("");
  const all = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = [
      ...props.unassignedStops.map((s) => ({ id: s.id, address: s.address ?? "", group: "Ej tilldelad", color: "#64748B", rowIdx: -1, stop: s, frozen: false })),
      ...props.rows.flatMap((row, rowIdx) => row.routeId === "unplanned" ? [] : row.stops.map((s) => ({
        id: s.stopId, address: s.address ?? "", group: row.routeName, color: row.color, rowIdx,
        stop: { ...s, id: s.stopId }, frozen: row.optimizationFrozen,
      }))),
    ];
    return q ? items.filter((i) => i.address.toLowerCase().includes(q) || i.group.toLowerCase().includes(q)) : items;
  }, [props.rows, props.unassignedStops, query]);
  const allCount = props.unassignedStops.length + props.rows.reduce((n, r) => n + (r.routeId === "unplanned" ? 0 : r.stops.length), 0);

  const tabs: Array<{ id: WorkQueueTab; label: string; count?: number }> = [
    { id: "action", label: "Att åtgärda" },
    { id: "unassigned", label: "Ej tilldelade", count: props.unassignedCount },
    { id: "all", label: "Alla uppdrag", count: allCount },
  ];

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-card text-card-foreground" data-testid="planner-work-queue">
      <div className="flex shrink-0 items-stretch border-b border-border" role="tablist" aria-label="Arbetskö">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTabChange(t.id)}
            data-testid={`tab-queue-${t.id}`}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 border-b-2 px-1.5 py-2 text-[11px] font-semibold transition-colors",
              tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{t.label}</span>
            {t.count != null && <span className="rounded bg-muted px-1 font-mono text-[10px] tabular-nums">{t.count}</span>}
          </button>
        ))}
        <button type="button" onClick={props.onClose} aria-label="Stäng arbetskö" data-testid="button-close-queue"
          className="flex w-10 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden" role="tabpanel">
        {tab === "action" && <div className="flex min-h-0 w-full [&>aside]:w-full [&>aside]:border-l-0">{props.actionPanel}</div>}
        {tab === "unassigned" && <div className="flex min-h-0 w-full">{props.unassignedPanel}</div>}
        {tab === "all" && (
          <div className="flex min-h-0 w-full flex-col">
            <div className="shrink-0 border-b border-border p-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrera adress eller rutt"
                aria-label="Filtrera alla uppdrag" data-testid="input-filter-all-stops"
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            {allCount === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground" data-testid="text-all-empty">Inga uppdrag i denna vy.</p>
            ) : all.length === 0 ? (
              <p className="p-6 text-center text-xs text-muted-foreground">Inga träffar.</p>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto py-1">
                {all.map((i) => (
                  <li key={i.id}>
                    <button
                      type="button"
                      data-testid={`row-all-stop-${i.id}`}
                      aria-pressed={props.selectedStopId === i.id}
                      onMouseEnter={() => props.onHoverStop(i.id)}
                      onMouseLeave={() => props.onHoverStop(null)}
                      onFocus={() => props.onHoverStop(i.id)}
                      onBlur={() => props.onHoverStop(null)}
                      onClick={() => i.rowIdx < 0 ? props.onSelectUnassigned(i.id) : props.onSelectScheduled(i.id, i.rowIdx)}
                      className={cn("flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted/60",
                        props.selectedStopId === i.id && "bg-primary/10")}
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">{i.address || "Adress saknas"}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{i.group}</span>
                        <LockEvidenceBadges route={{ optimizationFrozen: i.frozen }} stop={i.stop} compact />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
