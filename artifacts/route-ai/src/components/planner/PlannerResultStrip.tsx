import type { ComponentProps } from "react";
import { useState } from "react";
import { AlertCircle, AlertTriangle, BatteryCharging, CheckCircle2, ChevronDown, Info } from "lucide-react";
import { UnassignedReasonsList } from "@/components/UnassignedReasons";
import { cn } from "@/lib/utils";

type Reasons = ComponentProps<typeof UnassignedReasonsList>["reasons"];

/**
 * One-line result and warning strip above the map. Blocking/unassigned
 * warnings are always visible; details expand inline instead of covering it.
 */
export function PlannerResultStrip({ summary, unassignedCount, unassignedReasons, chargingCount, overtimeRoutes, lateStops, dirty, technical }: {
  summary: string | null;
  unassignedCount: number;
  unassignedReasons: Reasons;
  chargingCount: number;
  overtimeRoutes: number;
  lateStops: number;
  dirty: boolean;
  technical: string | null;
}) {
  const [open, setOpen] = useState<"reasons" | "tech" | null>(null);
  const hasAnything = summary || unassignedCount || overtimeRoutes || lateStops || dirty || chargingCount;
  if (!hasAnything) return null;
  return (
    <div className="border-b border-border bg-card/70 text-xs" data-testid="optimization-result-summary">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        {summary && (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{summary}
          </span>
        )}
        {dirty && (
          <span role="status" data-testid="status-source-dirty" className="inline-flex items-center gap-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />Underlaget har ändrats sedan förslaget byggdes
          </span>
        )}
        {unassignedCount > 0 && (
          <button type="button" onClick={() => setOpen(open === "reasons" ? null : "reasons")} data-testid="button-unassigned-reasons"
            className="inline-flex items-center gap-1.5 rounded bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive hover:bg-destructive/15">
            <AlertCircle className="h-3.5 w-3.5" />
            <span data-testid="unassigned-stops-count">{unassignedCount} jobb kunde inte planeras</span>
            <ChevronDown className={cn("h-3 w-3 transition-transform", open === "reasons" && "rotate-180")} />
          </button>
        )}
        {overtimeRoutes > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive" data-testid="status-overtime">
            <AlertCircle className="h-3.5 w-3.5" />{overtimeRoutes} {overtimeRoutes === 1 ? "rutt" : "rutter"} med övertid
          </span>
        )}
        {lateStops > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-800 dark:text-amber-300" data-testid="status-late-stops">
            <AlertTriangle className="h-3.5 w-3.5" />{lateStops} efter tidsfönster
          </span>
        )}
        {chargingCount > 0 && (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><BatteryCharging className="h-3.5 w-3.5" />{chargingCount} laddstopp</span>
        )}
        {technical && (
          <button type="button" onClick={() => setOpen(open === "tech" ? null : "tech")} data-testid="button-technical-details"
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <Info className="h-3 w-3" />Teknisk info
          </button>
        )}
      </div>
      {open === "reasons" && unassignedCount > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-border/60 px-3 py-2 text-amber-900 dark:text-amber-200">
          <UnassignedReasonsList reasons={unassignedReasons} />
        </div>
      )}
      {open === "tech" && technical && (
        <p className="border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground" data-testid="optimization-performance-status">{technical}</p>
      )}
    </div>
  );
}
