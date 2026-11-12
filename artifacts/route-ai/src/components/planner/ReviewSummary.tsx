import type { ReactNode } from "react";
import type { Driver, Stop, Vehicle } from "@workspace/api-client-react";
import { Link } from "wouter";
import { AlertCircle, ArrowUpRight, CheckCircle2, HelpCircle, ShieldCheck, Send } from "lucide-react";
import { isLateForWindow, localCheckState } from "@/lib/planner-workflow";
import { cn } from "@/lib/utils";
import { serviceStartByStop } from "./RouteAssignments";
import { formatMinutes, type OptimizedRouteResult } from "./types";

/**
 * Step 3: compact, factual check of each route. Approval and sending are not
 * performed here; they live in the scoped traffic control view, as separate
 * actions, so the planner never duplicates those writes.
 */
export function ReviewSummary({ routes, vehiclesById, driverByVehicleId, stopsById, unassignedCount, dispatchHref, statusChain, dirty, planDay }: {
  routes: OptimizedRouteResult[];
  vehiclesById: Map<string, Vehicle>;
  driverByVehicleId: Map<string, Driver>;
  stopsById: Map<string, Stop>;
  unassignedCount: number;
  dispatchHref: string | null;
  statusChain: ReactNode;
  dirty: boolean;
  planDay: string | null;
}) {
  const rows = routes.map((route) => {
    const starts = serviceStartByStop(route);
    const jobs = route.stops.filter((s) => !s.isChargingStop);
    const late = jobs.filter((s) => isLateForWindow(stopsById.get(s.stopId)?.timeWindowEnd, starts.get(s.stopId))).length;
    const checked = Boolean(route.workdayTimeline && route.workdaySummary);
    return { route, jobs: jobs.length, late, overtime: route.workdaySummary?.overtimeMin ?? 0, checked };
  });
  const conflicts = rows.reduce((n, r) => n + r.late + (r.overtime > 0 ? 1 : 0), 0) + unassignedCount;
  const missing = rows.filter((r) => !r.checked).length;
  const state = localCheckState({ issues: conflicts, routesMissingTimeline: missing });

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="table-route-review">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2.5 py-1.5 text-left font-semibold">Förare</th>
              <th className="px-1 py-1.5 text-right font-semibold">Jobb</th>
              <th className="px-1 py-1.5 text-right font-semibold">Arbetstid</th>
              <th className="px-2.5 py-1.5 text-right font-semibold">Lokal kontroll</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ route, jobs, late, overtime, checked }) => {
              const vehicle = vehiclesById.get(route.vehicleId);
              const driver = driverByVehicleId.get(route.vehicleId);
              const issues = [overtime > 0 ? `Övertid ${overtime}m` : null, late > 0 ? `${late} sena` : null].filter(Boolean);
              return (
                <tr key={route.routeId} className="border-t border-border/60" data-testid={`row-review-${route.routeId}`}>
                  <td className="px-2.5 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-1 shrink-0 rounded-full" style={{ backgroundColor: vehicle?.routeColor }} />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{vehicle?.name ?? driver?.name ?? "Okänd resurs"}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">{vehicle?.name}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-1 py-1.5 text-right font-mono tabular-nums">{jobs}</td>
                  <td className="px-1 py-1.5 text-right font-mono tabular-nums">
                    {route.workdaySummary ? formatMinutes(route.workdaySummary.totalMin) : formatMinutes(route.durationMin)}
                  </td>
                  <td className={cn("px-2.5 py-1.5 text-right",
                    issues.length ? "font-semibold text-destructive" : checked ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                    {issues.length ? issues.join(", ")
                      : checked ? <CheckCircle2 className="ml-auto h-3.5 w-3.5" aria-label="Inga avvikelser i lokal kontroll" />
                        : <span className="inline-flex items-center gap-1" title="Servern har inte returnerat någon tidslinje för rutten"><HelpCircle className="h-3.5 w-3.5" />Okänt</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-2.5 py-1.5 text-[11px]">
          <span className="text-muted-foreground">{planDay ?? "Okänd dag"} · {routes.length} rutter · {rows.reduce((n, r) => n + r.jobs, 0)} jobb</span>
          <span className={cn("font-semibold",
            state === "issues" ? "text-destructive" : state === "clear" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-300")}
            data-testid="text-conflict-total" data-state={state}>
            {state === "issues" && `${conflicts} avvikelser i lokal kontroll`}
            {state === "issues" && unassignedCount > 0 && ` (varav ${unassignedCount} oplanerade)`}
            {state === "clear" && "Inga avvikelser i lokal kontroll"}
            {state === "unknown" && `Ej fullständigt kontrollerat: ${missing} ${missing === 1 ? "rutt" : "rutter"} saknar tidslinje`}
          </span>
        </div>
        <p className="border-t border-border/60 px-2.5 py-1 text-[10px] leading-snug text-muted-foreground">
          Lokal kontroll omfattar övertid, planerad start efter tidsfönster och oplanerade jobb från senaste optimeringen. Det är inte en fullständig godkännandekontroll.
        </p>
      </div>

      {dirty && (
        <p role="status" className="flex items-start gap-1.5 rounded-md bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-medium text-amber-900 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Urvalet i steg 1 skiljer sig från det som förslaget byggdes på. Kontrollen gäller det sparade förslaget.
        </p>
      )}

      {statusChain}

      <div className="rounded-lg border border-border bg-card p-2.5">
        <ol className="space-y-1.5 text-xs">
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span><strong>Godkänn</strong> planen i trafikledningen, där tidsaxeln och alla rutter för vald dag visas.</span>
          </li>
          <li className="flex items-start gap-2">
            <Send className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span><strong>Skicka</strong> är ett eget, separat steg efter godkännandet. Inget skickas automatiskt härifrån.</span>
          </li>
        </ol>
        {dispatchHref ? (
          <Link href={dispatchHref} data-testid="link-dispatch-approval"
            className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90">
            Öppna i trafikledningen <ArrowUpRight className="h-4 w-4" />
          </Link>
        ) : (
          <p className="mt-2 text-[11px] text-muted-foreground">Planen saknar plan-id och kan inte öppnas i trafikledningen.</p>
        )}
      </div>
    </div>
  );
}
