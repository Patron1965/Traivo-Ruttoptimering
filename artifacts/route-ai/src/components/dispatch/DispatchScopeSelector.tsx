import { CalendarDays, FolderKanban, X } from "lucide-react";
import type { DispatchPlanOption, DispatchScopeStatus } from "@/lib/dispatch-scope";

interface Props {
  options: DispatchPlanOption[];
  planId: string | null;
  routeId: string | null;
  day: string | null;
  days: string[];
  status: DispatchScopeStatus;
  onChange: (next: { planId: string | null; day: string | null }) => void;
}

const selectCls = "h-8 rounded-md border border-border bg-background px-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-primary/30";

export function DispatchScopeSelector({ options, planId, routeId, day, days, status, onChange }: Props) {
  const scoped = Boolean(planId || routeId);
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-xs" data-testid="dispatch-scope-selector">
      <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <label htmlFor="dispatch-scope-plan" className="sr-only">Plan</label>
      <select id="dispatch-scope-plan" data-testid="select-dispatch-plan"
        className={`${selectCls} max-w-[220px] ${!scoped ? "border-primary/50 ring-1 ring-primary/20" : ""}`}
        value={planId ?? ""}
        onChange={(e) => onChange({ planId: e.target.value || null, day: null })}>
        <option value="">{routeId && !planId ? "Enskild rutt" : "Välj plan…"}</option>
        {options.map((o) => (
          <option key={o.planId} value={o.planId}>
            {o.label} · {o.days.length > 1 ? `${o.days[0]} – ${o.days.at(-1)}` : o.days[0] ?? "utan datum"} · {o.routeCount} rutter{o.terminal ? " · avslutad" : ""}
          </option>
        ))}
      </select>
      {scoped && days.length > 0 && (
        <>
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <label htmlFor="dispatch-scope-day" className="sr-only">Dag</label>
          {days.length === 1 ? (
            <span className="rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono tabular-nums" data-testid="text-dispatch-day">{days[0]}</span>
          ) : (
            <select id="dispatch-scope-day" data-testid="select-dispatch-day"
              className={`${selectCls} font-mono tabular-nums ${status === "needsDay" ? "border-amber-500/70 ring-1 ring-amber-500/30" : ""}`}
              value={day ?? ""}
              onChange={(e) => onChange({ planId, day: e.target.value || null })}>
              <option value="">Välj dag…</option>
              {days.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </>
      )}
      {scoped && (
        <button type="button" data-testid="button-clear-dispatch-scope" title="Byt plan"
          className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-muted-foreground hover:text-foreground"
          onClick={() => onChange({ planId: null, day: null })}>
          <X className="h-3.5 w-3.5" /> Byt
        </button>
      )}
    </div>
  );
}

export function DispatchScopeGuidance({ status, hasPlans }: { status: DispatchScopeStatus; hasPlans: boolean }) {
  if (status === "ready") return null;
  return (
    <div className="mx-3 my-2 flex items-center gap-2 rounded-md border border-dashed border-primary/40 bg-primary/5 px-3 py-2 text-xs" data-testid="dispatch-scope-guidance">
      {status === "needsDay" ? <CalendarDays className="h-4 w-4 text-amber-600" /> : <FolderKanban className="h-4 w-4 text-primary" />}
      <span>
        {status === "needsDay"
          ? "Planen spänner flera dagar. Välj dag för att visa förare och rutter."
          : hasPlans ? "Välj en plan ovan. Tidslinjen visar bara rutter från vald plan och dag." : "Inga planer ännu. Skapa en plan för att börja."}
      </span>
    </div>
  );
}
