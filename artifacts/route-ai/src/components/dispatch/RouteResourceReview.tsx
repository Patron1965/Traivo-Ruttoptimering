import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  usePreviewRouteResourceReplacement, useConfirmRouteResourceReplacement,
  type Route, type Vehicle, type Driver, type RouteResourceReplacementInput, type RouteResourceReplacementPreview,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { activeResourcePairs, onlyAuthorizedSoftConflicts, resourceConfirmation, resourceReviewRequest, resourceReviewError } from "@/lib/route-resource-review";
import { metricText } from "@/lib/planner-corrections";

export function RouteResourceReview(props: {
  route: Route; vehicles: Vehicle[]; drivers: Driver[]; onSaved?: () => void | Promise<void>;
}) {
  return <ResourceForm key={`${props.route.id}:${props.route.planRevision}`} {...props} />;
}

function ResourceForm({ route, vehicles, drivers, onSaved }: {
  route: Route; vehicles: Vehicle[]; drivers: Driver[]; onSaved?: () => void | Promise<void>;
}) {
  const pairs = activeResourcePairs(vehicles, drivers);
  const [selected, setSelected] = useState("");
  const [review, setReview] = useState<{
    request: Readonly<RouteResourceReplacementInput>; result: RouteResourceReplacementPreview;
  } | null>(null);
  const [acceptedSoft, setAcceptedSoft] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const preview = usePreviewRouteResourceReplacement({ mutation: { retry: false } });
  const confirm = useConfirmRouteResourceReplacement({ mutation: { retry: false } });
  const client = useQueryClient();
  const busy = preview.isPending || confirm.isPending;
  const blocked = !["draft", "optimized"].includes(route.status) || Boolean(route.sentAt)
    || route.handoffStatus !== "pending" || route.optimizationFrozen || Boolean(route.lockedFirstStopId);
  const currentPairExists = pairs.some(pair => pair.value === selected);
  function clear() {
    generation.current++; setReview(null); setReviewed(false); setAcceptedSoft(false); setError(null); setSaved(false);
  }
  async function calculate(force = false) {
    clear(); setAcceptedSoft(force);
    const request = resourceReviewRequest(route.id, route.planRevision ?? 0, selected, force);
    if (!request || !currentPairExists) return;
    const requestId = generation.current;
    try {
      const result = await preview.mutateAsync({ data: request });
      if (requestId === generation.current) setReview({ request, result });
    } catch (err) { if (requestId === generation.current) setError(resourceReviewError(err)); }
  }
  async function save() {
    if (!review || !reviewed || !currentPairExists || busy) return;
    const body = resourceConfirmation(review.request, review.result, acceptedSoft);
    if (!body) return;
    try {
      await confirm.mutateAsync({ data: body });
    } catch (err) {
      clear(); setError(`${resourceReviewError(err)} Inget nytt försök görs automatiskt. Förhandsgranska igen.`); return;
    }
    clear(); setSaved(true);
    await client.invalidateQueries({ predicate: query => query.queryKey.some(key =>
      typeof key === "string" && (key.startsWith("/api/routes") || key.startsWith("/api/stops"))) });
    try { await onSaved?.(); } catch { setError("Resursbytet sparades, men vyn kunde inte uppdateras. Ladda om; bekräfta inte samma ändring igen."); }
  }
  const canConfirm = review && reviewed && currentPairExists
    && resourceConfirmation(review.request, review.result, acceptedSoft);
  return <section aria-label="Granska resursbyte" className="space-y-3 rounded-md border p-3">
    <h3 className="font-medium">Tilldela eller byt resurs för {route.name}</h3>
    <p className="text-xs text-muted-foreground">Medlemskap och ordning behålls. Arbetsplanen ändras först efter granskning och bekräftelse. Godkänn planen igen före utskick.</p>
    {blocked ? <p className="text-sm">Välj en ännu ej utskickad rutt och lås upp rutt/förstastoppsregel före resursbyte.</p> : <>
      <label className="block text-sm">Resurs
        <select className="mt-1 w-full rounded-md border bg-background p-2" value={selected} disabled={busy}
          onChange={event => { clear(); setSelected(event.target.value); }}>
          <option value="">Välj resurs</option>
          {pairs.map(pair => <option key={pair.value} value={pair.value}>{pair.vehicle.name}</option>)}
        </select>
      </label>
      {currentPairExists && <p className="text-sm" data-testid="resource-pair-change">
        Ny resurs: {vehicles.find(vehicle => vehicle.id === selected.split(":")[0])?.name}
        {selected.split(":")[0] === route.vehicleId ? " (samma resurs)." : "."}
      </p>}
      {!pairs.length && <p className="text-sm">Inga aktiva resurser finns.</p>}
      <Button size="sm" variant="outline" disabled={busy || !currentPairExists} onClick={() => void calculate()}>Förhandsgranska resursbyte</Button>
    </>}
    {busy && <p role="status" className="text-sm">Beräknar konsekvens…</p>}
    {!busy && review && <div className="space-y-2 text-sm">
      {review.result.consequences.routes.map(item => <div className="rounded border p-2" key={item.routeId}>
        <p className="font-medium">{item.routeName}</p>
        <dl className="grid grid-cols-2 gap-x-2">
          <dt>Körning före → efter</dt><dd>{metricText(item.before.driveMin, " min")} → {metricText(item.after.driveMin, " min")}</dd>
          <dt>Arbetstid före → efter</dt><dd>{metricText(item.before.workMin, " min")} → {metricText(item.after.workMin, " min")}</dd>
          <dt>Sluttid före → efter</dt><dd>{metricText(item.before.endAt)} → {metricText(item.after.endAt)}</dd>
          <dt>Tidsfönsteravvikelser</dt><dd>{metricText(item.before.windowViolations)} → {metricText(item.after.windowViolations)}</dd>
          <dt>Antal uppdrag</dt><dd>{item.before.stopCount} → {item.after.stopCount}</dd>
        </dl>
      </div>)}
      {review.result.consequences.reason && <p>{review.result.consequences.reason}</p>}
      <p>Ej planerade i ändringen: {review.result.consequences.unplanned.before} → {review.result.consequences.unplanned.after}</p>
      {!!review.result.conflicts.length && <p role="alert">Avvikelser: {review.result.conflicts.join(", ")}. {!onlyAuthorizedSoftConflicts(review.result.conflicts) && "Hård begränsning — kan inte överstyras."}</p>}
      {onlyAuthorizedSoftConflicts(review.result.conflicts) && <label className="flex items-start gap-2">
        <input type="checkbox" checked={acceptedSoft} onChange={event => {
          if (event.target.checked) void calculate(true); else clear();
        }} />Jag accepterar uttryckligen tillåtna kapacitets-/arbetstidsavvikelser. Ny konsekvens beräknas före bekräftelse.
      </label>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={reviewed}
        onChange={event => setReviewed(event.target.checked)} />Jag har granskat resurspar, före/efter och eventuella okända mått.</label>
      <Button size="sm" disabled={!canConfirm} onClick={() => void save()}>Bekräfta resursbyte</Button>
      <Button size="sm" variant="ghost" onClick={clear}>Avbryt</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {saved && <p role="status" className="text-sm">Resursbytet sparades. Granska och godkänn arbetsplanen före utskick.</p>}
  </section>;
}
