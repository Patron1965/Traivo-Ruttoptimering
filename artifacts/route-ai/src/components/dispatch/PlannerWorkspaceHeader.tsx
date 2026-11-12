import { Check, CircleAlert, CircleDashed, CircleHelp, CircleDot, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import type { MomentId, MomentState, WorkflowMoment, WorkspaceScope, ReviewScopeNotice } from "@/lib/planner-workspace";

export type MomentShortcut =
  | { kind: "action"; label: string; run: () => void }
  | { kind: "unavailable"; reason: string };

interface Props {
  scope: WorkspaceScope;
  moments: WorkflowMoment[];
  shortcuts: Partial<Record<MomentId, MomentShortcut>>;
  dataError?: string | null;
  liveStops?: ReadonlyArray<{ id: string; address: string; status: string }>;
  reviewNotice?: ReviewScopeNotice | null;
}

const STATE_STYLE: Record<MomentState, string> = {
  done: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
  attention: "border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  active: "border-primary/50 bg-primary/10 text-primary",
  pending: "border-border/70 text-muted-foreground",
  unknown: "border-dashed border-border text-muted-foreground",
};
const STATE_LABEL: Record<MomentState, string> = {
  done: "Klar", attention: "Kräver åtgärd", active: "Pågår", pending: "Ej påbörjad", unknown: "Okänt",
};
function StateIcon({ state }: { state: MomentState }) {
  const c = "h-3.5 w-3.5 shrink-0";
  if (state === "done") return <Check className={c} />;
  if (state === "attention") return <CircleAlert className={c} />;
  if (state === "active") return <CircleDot className={c} />;
  if (state === "unknown") return <CircleHelp className={c} />;
  return <CircleDashed className={c} />;
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-mono text-xs font-semibold tabular-nums" data-testid={testId}>{value}</span>
    </div>
  );
}

export function PlannerWorkspaceHeader({ scope, moments, shortcuts, dataError, liveStops, reviewNotice }: Props) {
  const kindLabel = scope.kind === "plan" ? "Plan" : scope.kind === "route" ? "Rutt" : "Alla planer";
  const r = scope.revision;
  const outgoing = scope.outgoingRevision;
  const outgoingLabel = outgoing.kind === "unanimous" ? `v${outgoing.value + 1}`
    : outgoing.kind === "mixed" ? `blandad (${outgoing.values.length} versioner)` : "ej verifierad";
  const revisionLabel = r.kind === "unanimous" ? `v${r.value + 1}` : r.kind === "mixed" ? `blandad (${r.values.length} versioner)` : "okänd";
  const h = scope.handoff;
  const handoffLabel = h.current === 0
    ? "Ingen aktuell utskickskvittens"
    : `${h.current}/${scope.routeCount} aktuella`;
  return (
    <section className="shrink-0 border-b border-border bg-card/70 px-3 py-2" data-testid="planner-workspace-header" data-scope-kind={scope.kind}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{kindLabel}</span>
          <h2 className="truncate text-sm font-bold" data-testid="text-workspace-title">{scope.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Stat label="Datum" value={scope.dateLabel} testId="text-workspace-date" />
          {scope.dateDetail && <span className="text-[11px] text-muted-foreground">{scope.dateDetail}</span>}
          <Stat label="Rutter" value={String(scope.routeCount)} testId="text-workspace-routes" />
          <Stat label="Uppdrag" value={scope.stopCount == null ? "okänt" : String(scope.stopCount)} testId="text-workspace-stops" />
          <Stat label="Ej tilldelade" value={scope.unassignedCount == null ? "okänt" : String(scope.unassignedCount)} testId="text-workspace-unassigned" />
          <Stat label="Fordon" value={String(scope.resourceCount)} testId="text-workspace-resources" />
          <Stat label="Arbetsversion" value={revisionLabel} testId="text-workspace-revision" />
          <Stat label="Utskicksversion" value={outgoingLabel} testId="text-workspace-outgoing-revision" />
          <Stat label="Kvittens" value={handoffLabel} testId="text-workspace-handoff" />
          {h.stale > 0 && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300" data-testid="status-handoff-stale">
              {h.stale} ändrade efter utskick
            </span>
          )}
          {h.unverified > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground" data-testid="status-handoff-unverified">
              {h.unverified} kvittens utan versionsbevis
            </span>
          )}
        </div>
      </div>
      {dataError && (
        <p role="alert" className="mt-1 text-xs font-semibold text-destructive" data-testid="text-workspace-error">{dataError}</p>
      )}
      <p className="mt-1 text-[10px] text-muted-foreground">
        Vägdata verifieras vid beräkning. Tillgänglig kontokvot är inte verifierad här; en konfigurerad tjänst är inte bevis på tillräcklig kvot eller godkänd planeringskvalitet.
      </p>
      {reviewNotice && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs" data-testid="review-scope-notice">
          <p className="font-semibold">{reviewNotice.routeCount} rutter i denna vy har en sparad granskningsflagga.</p>
          <p className="mt-1">
            Samma flagga kan markera både Planförslag och Granskning. Antalet markerade steg är inte antalet ofärdiga stopp.
            {" "}Aktuellt versionsbundet godkännande verifieras bara i den enskilda planens vy.
            Där kan stegen visas som Klar om godkännandet fortfarande gäller, även om den äldre flaggan finns kvar.
            Varningen här innebär inte i sig att planen behöver godkännas eller skickas igen.
          </p>
          {reviewNotice.plans.length > 0 && <ul className="mt-2 space-y-1">
            {reviewNotice.plans.map(plan => <li key={plan.planId}>
              <Link href={plan.href} className="break-words font-semibold underline underline-offset-2">
                Visa aktuellt granskningsbevis: {plan.label}
              </Link>
              {" "}({plan.routeCount} flaggade rutter)
            </li>)}
          </ul>}
          {reviewNotice.unlinkedRoutes.length > 0 && <p className="mt-2">
            Saknar plankoppling: {reviewNotice.unlinkedRoutes.map(route => route.label).join(", ")}.
            {" "}Aktuellt plangodkännande kan inte verifieras via en planlänk. Kontrollera dessa rutter separat.
          </p>}
          <p className="mt-2">Utförda stopp betyder inte att rutten är avslutad. Ruttens status visas under Utförande.</p>
        </div>
      )}
      {liveStops && <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2" data-testid="live-delivery-progress">
        <p className="text-sm font-semibold" role="status">
          Utförda stopp: {liveStops.filter(stop => stop.status === "completed").length}/{liveStops.length}
          <span className="ml-3 text-xs font-normal text-muted-foreground">
            Ej genomförda: {liveStops.filter(stop => stop.status === "failed").length}
            {" · "}Överhoppade: {liveStops.filter(stop => stop.status === "skipped").length}
          </span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Utförda stopp och avslutad rutt är olika tillstånd. Se ruttstatus under Utförande.</p>
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer">Visa leveransstatus per stopp</summary>
          <ul className="mt-2 space-y-1">
            {liveStops.map(stop => <li key={stop.id} data-testid={`execution-stop-${stop.id}`} className="flex items-center gap-2">
              {stop.status === "completed" ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className={stop.status === "completed" ? "font-semibold text-emerald-700 dark:text-emerald-400" : ""}>
                {stop.status === "completed" ? "Utfört" : stop.status === "failed" ? "Ej genomfört" : stop.status === "skipped" ? "Överhoppat" : stop.status === "in_progress" ? "Pågår" : "Återstår"}
              </span>
              <span>{stop.address}</span>
            </li>)}
          </ul>
        </details>
      </div>}
      <ol className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }} aria-label="Arbetsflöde">
        {moments.map((m, i) => {
          const sc = shortcuts[m.id];
          const body = (
            <>
              <span className="flex items-center gap-1.5 text-xs font-semibold">
                <span className="font-mono text-[10px] opacity-60">{i + 1}</span>
                <StateIcon state={m.state} />
                <span className="truncate">{m.label}</span>
                <span className="sr-only">: {STATE_LABEL[m.state]}</span>
              </span>
              <span className="block truncate text-[10px] text-foreground/70" title={m.evidence}>{m.evidence}</span>
            </>
          );
          return (
            <li key={m.id} data-testid={`moment-${m.id}`} data-state={m.state}>
              {sc?.kind === "action" ? (
                <button
                  type="button"
                  onClick={sc.run}
                  title={sc.label}
                  aria-label={`${m.label}: ${STATE_LABEL[m.state]}. ${sc.label}`}
                  data-testid={`button-moment-${m.id}`}
                  className={cn("block w-full min-w-0 rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", STATE_STYLE[m.state])}
                >
                  {body}
                </button>
              ) : (
                <div className={cn("min-w-0 rounded-md border px-2 py-1", STATE_STYLE[m.state])}>
                  {body}
                  {sc?.kind === "unavailable" && (
                    <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground" data-testid={`text-moment-unavailable-${m.id}`}>
                      <Info className="h-3 w-3 shrink-0" />
                      <span className="truncate" title={sc.reason}>{sc.reason}</span>
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
