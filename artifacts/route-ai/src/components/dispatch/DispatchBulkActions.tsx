import { useEffect, useState } from "react";
import type { Route, Stop } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, CalendarClock, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import { useTranslation } from "react-i18next";
import { canConfirmPlanningDeviation } from "@/lib/planning-deviation";
import type { PlannerRecommendation } from "@/lib/planner-corrections";
import { MoveConsequences } from "./MoveConsequences";
import { NewProjectFromStops } from "./NewProjectFromStops";

type MoveResult = { conflicts: string[]; error?: string; status?: number };
export type DispatchRouteRequest = { routeId: string | null; nonce: number; targetIndex?: number; origin?: "polygon" | "move" };

function nextStockholmDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = new Date(Date.UTC(Number(value("year")), Number(value("month")) - 1, Number(value("day")) + 1));
  return day.toISOString().slice(0, 10);
}

export function DispatchBulkActions({ selectedStopIds, setSelectedStopIds, stops, routes, routeDriverNames, canEdit, requestMove, routeRequest }: {
  routeRequest?: DispatchRouteRequest | null;
  routeDriverNames: ReadonlyMap<string, string>;
  selectedStopIds: Set<string>;
  setSelectedStopIds: (ids: Set<string>) => void;
  stops: Stop[];
  routes: Route[];
  canEdit: boolean;
  requestMove: (ids: string[], routeId: string | null, targetIndex: number, force?: boolean, expectedPreviewDigest?: string, optimizeTargetRoute?: boolean) => Promise<MoveResult>;
}) {
  const { t } = useTranslation();
  const conflictText = (codes: string[]) => codes.length ? codes.map(code => {
    if (code === "WORKING_HOURS") return t("import.overlapReasonWorkingHours");
    if (code === "CAPACITY") return t("import.overlapReasonCapacity");
    return t("common.errorRequestFailed");
  }).join(", ") : t("common.errorRequestFailed");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"route" | "date" | "unassign">("route");
  const [routeId, setRouteId] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [acceptedDeviationKey, setAcceptedDeviationKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!routeRequest) return;
    setAction(routeRequest.origin === "polygon" ? "route" : routeRequest.routeId === null ? "unassign" : "route"); setRouteId(routeRequest.routeId ?? ""); setOpen(true);
    setError(null); setAcceptedDeviationKey(null);
  }, [routeRequest]);
  const [routePreview, setRoutePreview] = useState<{
    key: string;
    canMove: boolean;
    conflicts: string[];
    targetStopCount: number;
    previewDigest: string;
    force: boolean;
    consequences?: PlannerRecommendation["consequences"];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [infeasiblePreviewKey, setInfeasiblePreviewKey] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Keep each source route's itinerary order, not the API list's creation
  // order. The preview and atomic move must receive the same ordered group.
  const routeOrder = new Map(routes.map((route, index) => [route.id, index]));
  const selected = stops.filter((stop) => selectedStopIds.has(stop.id)).sort((a, b) => {
    const aRoute = a.routeId ? routeOrder.get(a.routeId) ?? routes.length : routes.length;
    const bRoute = b.routeId ? routeOrder.get(b.routeId) ?? routes.length : routes.length;
    return aRoute - bRoute || (a.sequenceOrder ?? Infinity) - (b.sequenceOrder ?? Infinity);
  });
  const sources = [...new Set(selected.map((stop) => stop.routeId).filter((id): id is string => Boolean(id)))];
  const sourceNames = sources.map((id) => routes.find((route) => route.id === id)?.name ?? id);
  const sourceUnavailable = sources.some((id) => {
    const route = routes.find((candidate) => candidate.id === id);
    return !route || ["completed", "cancelled"].includes(route.status);
  });
  const earliest = nextStockholmDate();
  const lockedStops = selected.some((stop) => stop.status !== "pending");
  const polygonReview = routeRequest?.origin === "polygon";
  const optimizeTargetRoute = polygonReview && action === "route";
  const eligibleRoutes = routes.filter((route) => !["completed", "cancelled"].includes(route.status)
    && (!polygonReview || routeDriverNames.has(route.id))
    && (polygonReview || routeRequest?.routeId === route.id || !(sources.length === 1 && sources[0] === route.id && selected.every((stop) => stop.routeId === route.id))));
  const previewKey = JSON.stringify({
    action, routeId, optimizeTargetRoute, targetIndex: routeRequest?.routeId === routeId ? routeRequest.targetIndex : undefined,
    stopIds: selected.map((stop) => stop.id).sort(),
    routeRevisions: [...new Set([...sources, routeId].filter(Boolean))]
      .sort().map((id) => ({ routeId: id, planRevision: routes.find((route) => route.id === id)?.planRevision })),
  });
  const previewAllowed = Boolean(selectedStopIds.size && open && action !== "date"
    && (action !== "route" || routeId) && canEdit && !lockedStops && !sourceUnavailable
    && selected.length === selectedStopIds.size);
  useEffect(() => {
    setRoutePreview(null);
    setPreviewError(null);
    setElapsedSeconds(0);
    if (!previewAllowed) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    const ticker = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    const deadline = window.setTimeout(() => {
      setPreviewError("Förhandskontrollen tog för lång tid och avbröts här. Inga stopp har flyttats. Försök igen eller välj färre stopp.");
      controller.abort();
      window.clearInterval(ticker);
    }, 180_000);
    const routeRevisions = [...new Set([...sources, ...(action === "route" ? [routeId] : [])])].sort().map((id) => ({
      routeId: id, planRevision: routes.find((route) => route.id === id)?.planRevision,
    }));
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/stops/dispatch-move/preview", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            stopIds: selected.map((stop) => stop.id), routeId: action === "unassign" ? null : routeId,
            targetIndex: action === "unassign" ? 0 : routeRequest?.routeId === routeId && routeRequest.targetIndex != null
              ? routeRequest.targetIndex : stops.filter((stop) => stop.routeId === routeId).length,
            routeRevisions,
            optimizeTargetRoute,
            force: acceptedDeviationKey === previewKey,
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok && body.code === "DISPATCH_TARGET_INFEASIBLE" && !controller.signal.aborted) {
          setInfeasiblePreviewKey(previewKey);
        }
        if (!response.ok) throw new Error(
          body.code === "DISPATCH_TARGET_INFEASIBLE"
            ? "Alla stopp ryms inte i mottagarens rutt inom tillåtna arbetstider och övriga krav. Välj färre stopp eller en annan förare. Ingenting har flyttats."
            : body.code === "DISPATCH_TARGET_UNAVAILABLE"
              ? "Mottagarrutten är fryst eller saknar verifierat planeringsunderlag. Välj en annan rutt eller åtgärda underlaget först."
              : body.code === "ROAD_DATA_UNAVAILABLE"
                ? "Vägdata för ruttens nya sträckor kunde inte hämtas. Stoppets adress kan vara korrekt även om de nya sträckorna inte kan beräknas. Ingenting har flyttats. Försök igen."
                : response.status === 409
                  ? "Planen eller resurserna har ändrats. Ladda om och granska urvalet på nytt."
                  : "Förhandskontrollen kunde inte slutföras. Ingenting har flyttats.");
        if (typeof body.previewDigest !== "string" || !body.previewDigest) {
          throw new Error("Förhandskontrollen gav inget giltigt resultat. Inga stopp har flyttats. Försök igen.");
        }
        if (!controller.signal.aborted) setRoutePreview({
          key: previewKey, canMove: body.canMove === true,
          conflicts: Array.isArray(body.conflicts) ? body.conflicts : [],
          targetStopCount: body.targetStopCount,
          previewDigest: typeof body.previewDigest === "string" ? body.previewDigest : "",
          force: acceptedDeviationKey === previewKey,
          consequences: body.consequences,
        });
      } catch (failure) {
        if (!controller.signal.aborted) setPreviewError(failure instanceof Error ? failure.message : "Förhandskontrollen misslyckades.");
      } finally {
        window.clearInterval(ticker);
        window.clearTimeout(deadline);
      }
    }, 200);
    return () => { window.clearTimeout(timer); window.clearTimeout(deadline); window.clearInterval(ticker); controller.abort(); };
  }, [open, action, routeId, canEdit, lockedStops, sourceUnavailable, selectedStopIds.size, previewKey, acceptedDeviationKey, previewAttempt, previewAllowed]);
  if (!selectedStopIds.size) return null;
  const canSubmit = canEdit && !sourceUnavailable && !lockedStops && selected.length === selectedStopIds.size && !busy
    && (action !== "date" ? (action === "unassign" || eligibleRoutes.some((route) => route.id === routeId))
      && routePreview?.key === previewKey && routePreview.force === (acceptedDeviationKey === previewKey)
      && Boolean(routePreview.previewDigest) && (routePreview.canMove ||
        (canConfirmPlanningDeviation(routePreview.conflicts) && acceptedDeviationKey === previewKey))
      : Boolean(targetDate && targetDate >= earliest));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const stopIds = selected.map((stop) => stop.id);
      if (action !== "date") {
        // The board's existing move request owns revision checks and invalidation.
        const destination = routes.find((route) => route.id === routeId);
        if (action === "route" && !destination) throw new TrustedLocalizedError("Målrutten finns inte längre. Ladda om och försök igen.");
        const force = routePreview?.key === previewKey
          && canConfirmPlanningDeviation(routePreview.conflicts) && acceptedDeviationKey === previewKey;
        const index = routeRequest?.routeId === routeId && routeRequest.targetIndex != null
          ? routeRequest.targetIndex : stops.filter((stop) => stop.routeId === routeId).length;
        const result = await requestMove(stopIds, action === "unassign" ? null : routeId, action === "unassign" ? 0 : index, force, routePreview?.previewDigest, optimizeTargetRoute);
        if (result.status === 409 || result.error || (!force && result.conflicts.length)) {
          throw new TrustedLocalizedError(`Flytten kräver ny granskning. ${conflictText(result.conflicts)}`);
        }
      } else {
        const routeRevisions = sources.map((id) => {
          const route = routes.find((item) => item.id === id);
          if (!route || ["completed", "cancelled"].includes(route.status)) {
            throw new Error("En källrutt kan inte ändras. Ladda om och granska urvalet.");
          }
          return { routeId: id, planRevision: route.planRevision };
        });
        const response = await fetch("/api/stops/dispatch-defer", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stopIds, targetDate, routeRevisions }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          if (response.status === 409) throw new TrustedLocalizedError("Planen har ändrats sedan urvalet gjordes. Ladda om, granska och försök igen.");
          const failure = new Error(typeof body.error === "string" ? body.error : "Kunde inte flytta stoppen till valt datum.");
          Object.assign(failure, { status: response.status, data: body });
          throw failure;
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
          queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        ]);
      }
      // Keep the confirmed route move visible through the timeline's existing
      // selection outline. Never draw a speculative position before saving.
      if (action !== "route") setSelectedStopIds(new Set());
      setOpen(false);
      setRouteId("");
      setTargetDate("");
    } catch (failure) {
      setError(localizeError(failure, t, { fallbackKey: "common.errorRequestFailed" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2" data-testid="dispatch-bulk-toolbar">
        <span className="rounded bg-primary px-2 py-1 text-xs font-bold tabular-nums text-primary-foreground" data-testid="dispatch-selected-count">{selectedStopIds.size} markerade stopp</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">Karta och tidslinje delar samma urval.</span>
        <button type="button" data-testid="dispatch-bulk-open" disabled={!canEdit}
          onClick={() => { setError(null); setOpen(true); }}
          className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
          <ArrowRightLeft className="h-3.5 w-3.5" /> Hantera markerade
        </button>
        <button type="button" data-testid="dispatch-bulk-clear" onClick={() => setSelectedStopIds(new Set())}
          className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-semibold text-muted-foreground hover:bg-muted">
          <X className="h-3.5 w-3.5" /> Avmarkera
        </button>
        {!canEdit && <span className="w-full text-xs text-muted-foreground">Live-vyn är skrivskyddad. Växla till Plan för att ändra stopp.</span>}
      </div>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <DialogContent className="max-h-[85dvh] max-w-xl overflow-y-auto" data-testid="dispatch-bulk-dialog">
          <DialogTitle>Hantera {selectedStopIds.size} markerade stopp</DialogTitle>
          <DialogDescription>Granska urval och källrutter innan du bekräftar. Ingen ändring görs förrän du bekräftar.</DialogDescription>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Från {sourceNames.length ? sourceNames.join(", ") : "Oplanerade order"}</p>
              <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto text-sm" data-testid="dispatch-bulk-preview">
                {selected.map((stop) => <li key={stop.id} className="border-t border-border/60 pt-1">{stop.address || stop.notes || stop.id} <span className="text-xs text-muted-foreground">· {routes.find((route) => route.id === stop.routeId)?.name ?? "Oplanerad"}</span></li>)}
              </ul>
              {selected.length !== selectedStopIds.size && <p className="mt-2 text-xs text-destructive">Några valda stopp är inte längre tillgängliga. Avmarkera och välj igen.</p>}
              {sourceUnavailable && <p className="mt-2 text-xs text-destructive">En källrutt är avslutad eller saknas. Urvalet kan inte ändras.</p>}
              {lockedStops && <p className="mt-2 text-xs text-destructive">Påbörjade eller avslutade stopp kan inte flyttas. Ändra urvalet först.</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {canEdit && <NewProjectFromStops stops={selected} routes={routes}
                onDone={() => { setOpen(false); setSelectedStopIds(new Set()); }} />}
              <button type="button" data-testid="dispatch-bulk-action-route" aria-pressed={action === "route"} onClick={() => { setAction("route"); setError(null); }} className={`rounded-md border px-3 py-2 text-xs font-semibold ${action === "route" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>{polygonReview ? "Flytta till förare och optimera rutten" : "Flytta till rutt"}</button>
              <button type="button" data-testid="dispatch-bulk-action-unassign" aria-pressed={action === "unassign"} onClick={() => { setAction("unassign"); setRouteId(""); setError(null); }} className="rounded-md border border-border px-3 py-2 text-xs font-semibold">Gör oplanerade</button>
              {!polygonReview && <button type="button" data-testid="dispatch-bulk-action-date" aria-pressed={action === "date"} onClick={() => { setAction("date"); setError(null); }} className={`inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs font-semibold ${action === "date" ? "border-primary bg-primary/10 text-primary" : "border-border"}`}><CalendarClock className="h-3.5 w-3.5" /> Senare datum</button>}
            </div>
            {action === "route" ? (
              <label className="block text-xs font-semibold">{polygonReview ? "Förare och befintlig målrutt" : "Målrutt"}
                <select data-testid="dispatch-bulk-route" value={routeId} onChange={(event) => setRouteId(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                  <option value="">Välj en befintlig rutt</option>
                  {eligibleRoutes.map((route) => <option key={route.id} value={route.id}>{routeDriverNames.get(route.id) ? `${routeDriverNames.get(route.id)} · ` : ""}{route.name} · {route.date}</option>)}
                </select>
                {polygonReview && routes.some(route => !["completed", "cancelled"].includes(route.status) && !routeDriverNames.has(route.id))
                  && <p className="mt-2 text-muted-foreground">Rutter där planens resurs inte kan verifieras visas inte. Uppdatera planen och granska resursen; systemet väljer aldrig en annan resurs automatiskt.</p>}
                {polygonReview && !eligibleRoutes.length && <p className="mt-2 text-muted-foreground">Ingen befintlig målrutt med entydigt tilldelad aktiv förare är tillgänglig. Ingen ny rutt skapas.</p>}
              </label>
            ) : action === "date" ? (
              <label className="block text-xs font-semibold">Nytt datum för oplanerade order
                <input type="date" data-testid="dispatch-bulk-date" min={earliest} value={targetDate} onChange={(event) => setTargetDate(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>
            ) : <p className="text-sm">Flytta tillbaka till planens ej tilldelade uppdrag.</p>}
            {previewAllowed && (
              <div className="rounded-md border border-border bg-muted/20 p-3 text-xs" data-testid="dispatch-bulk-feasibility">
                {previewError ? <div><p role="alert" className="text-red-700 dark:text-red-300">{previewError}</p>
                  <button type="button" className="mt-2 rounded border px-3 py-2 font-medium" onClick={() => setPreviewAttempt(value => value + 1)}>Försök igen</button></div>
                  : routePreview?.key !== previewKey ? <div role="status" aria-live="polite" data-testid="dispatch-bulk-preview-progress">
                    <p className="flex items-center gap-2"><Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />Beräknar konsekvens…</p>
                    <p className="mt-1 tabular-nums" aria-live="off">Väntat {elapsedSeconds} sekunder</p>
                    <p className="mt-1 text-muted-foreground">{optimizeTargetRoute ? "Kontrollerar vägdata och optimerar mottagarens rutt. Det kan ta några minuter." : "Kontrollerar rutt, förare och tidsfönster."} Inga stopp flyttas förrän du bekräftar.</p>
                  </div>
                    : routePreview.canMove
                      ? <p>{action === "unassign" ? "Uppdragen kan läggas tillbaka som ej tilldelade." : `${routePreview.targetStopCount} stopp på målrutten efter flytt.`} Inga blockerande konflikter hittades.</p>
                      : <p role="alert" className="text-red-700 dark:text-red-300">Flytten kan inte sparas utan ny granskning: {conflictText(routePreview.conflicts)}</p>}
                {routePreview?.key === previewKey && <MoveConsequences consequences={routePreview.consequences} />}
              </div>
            )}
            {error && <p role="alert" data-testid="dispatch-bulk-error" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error} Urvalet finns kvar; granska och försök igen.</p>}
            {action === "route" && optimizeTargetRoute && infeasiblePreviewKey === previewKey && (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={acceptedDeviationKey === previewKey} disabled={busy}
                  onChange={event => setAcceptedDeviationKey(event.target.checked ? previewKey : null)} />
                Tillåt överskriden sluttid och beräkna på nytt. Övriga krav kontrolleras fortfarande. Inget flyttas innan du bekräftar.
              </label>
            )}
            {action === "route" && routePreview?.key === previewKey && (!routePreview.canMove || acceptedDeviationKey === previewKey)
              && canConfirmPlanningDeviation(routePreview.conflicts) && (
                <label className="flex gap-2 rounded border border-amber-500/50 p-3 text-sm">
                  <input type="checkbox" data-testid="dispatch-bulk-accept-deviation" checked={acceptedDeviationKey === previewKey}
                    onChange={event => setAcceptedDeviationKey(event.target.checked ? previewKey : null)} />
                  Jag accepterar visad kapacitets-/arbetstidsavvikelse. Varningen sparas med uppdragen.
                </label>
              )}
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <button type="button" data-testid="dispatch-bulk-cancel" disabled={busy} onClick={() => setOpen(false)} className="rounded-md border border-border px-4 py-2 text-sm">Avbryt</button>
              <button type="button" data-testid="dispatch-bulk-confirm" disabled={!canSubmit} onClick={() => void submit()} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Sparar…" : action === "date" ? "Bekräfta nytt datum" : "Bekräfta flytt"}</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}