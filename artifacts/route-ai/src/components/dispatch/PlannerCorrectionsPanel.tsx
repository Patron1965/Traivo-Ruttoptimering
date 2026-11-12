import { useRef, useState } from "react";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlannerCorrections } from "@/hooks/use-planner-corrections";
import { manualCorrectionPosition, metricText, type AddressPreview, type PlannerRecommendations, type PlannerRecommendation } from "@/lib/planner-corrections";

/** Parent should key by stopId + plan scope so old selections cannot cross plans. */
export function PlannerCorrectionsPanel(props: {
  stopId: string; address: string; routeIds: string[]; onSaved?: () => void;
}) {
  return <CorrectionForm key={`${props.stopId}:${[...props.routeIds].sort().join(",")}`} {...props} />;
}

function Consequences({ item }: { item: PlannerRecommendation }) {
  const routes = item.consequences.routes;
  if (!routes?.length) return <p className="text-sm text-muted-foreground">
    Konsekvens okänd: {item.consequences.reason ?? "Verifierade före/efter-mått saknas."}
  </p>;
  return <div className="space-y-2 text-sm">{routes.map((route) => <div key={route.routeId}>
    <p>Berörd rutt: {route.routeName}</p>
    <dl className="grid grid-cols-2 gap-x-2">
      <dt>Körning före → efter</dt><dd>{metricText(route.before.driveMin, " min")} → {metricText(route.after.driveMin, " min")}</dd>
      <dt>Arbetstid före → efter</dt><dd>{metricText(route.before.workMin, " min")} → {metricText(route.after.workMin, " min")}</dd>
      <dt>Sluttid före → efter</dt><dd>{metricText(route.before.endAt)} → {metricText(route.after.endAt)}</dd>
      <dt>Tidsfönsteravvikelser</dt><dd>{metricText(route.before.windowViolations)} → {metricText(route.after.windowViolations)}</dd>
      <dt>Antal uppdrag</dt><dd>{route.before.stopCount} → {route.after.stopCount}</dd>
    </dl>
  </div>)}
    {item.consequences.unplanned && <p>Oplanerade bland valda uppdrag: {item.consequences.unplanned.before} → {item.consequences.unplanned.after}</p>}
    {item.consequences.reason && <p className="text-muted-foreground">{item.consequences.reason}</p>}
  </div>;
}

function CorrectionForm({ stopId, address: originalAddress, routeIds, onSaved }: {
  stopId: string; address: string; routeIds: string[]; onSaved?: () => void;
}) {
  const api = usePlannerCorrections();
  const [address, setAddress] = useState(originalAddress);
  const [manual, setManual] = useState(false);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [positionConfirmed, setPositionConfirmed] = useState(false);
  const [addressPreview, setAddressPreview] = useState<AddressPreview | null>(null);
  const [proposals, setProposals] = useState<PlannerRecommendations | null>(null);
  const [selected, setSelected] = useState<PlannerRecommendation | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const busy = api.address.isPending || api.recommendations.isPending || api.confirm.isPending;
  function resetReview() {
    generation.current++;
    setAddressPreview(null); setSelected(null); setReviewed(false); setError(null); setSaved(false);
  }
  async function previewAddress() {
    resetReview();
    const requestId = generation.current;
    const position = manual ? manualCorrectionPosition(latitude, longitude, positionConfirmed) : undefined;
    if (manual && !position) { setError("Ange giltiga koordinater och bekräfta den manuellt valda positionen."); return; }
    try {
      const result = await api.address.mutateAsync({ stopId, address, ...(position ? { position } : {}) });
      if (requestId === generation.current) setAddressPreview(result);
    } catch (err) { if (requestId === generation.current) setError((err as Error).message); }
  }
  async function recommend() {
    resetReview(); setProposals(null);
    const requestId = generation.current;
    try {
      const result = await api.recommendations.mutateAsync({ stopId, routeIds });
      if (requestId === generation.current) setProposals(result);
    } catch (err) { if (requestId === generation.current) setError((err as Error).message); }
  }
  async function confirm() {
    const token = selected?.token ?? addressPreview?.token;
    if (!token || !reviewed) return;
    try {
      await api.confirm.mutateAsync({ token, confirmed: true });
      resetReview(); setProposals(null); setSaved(true); onSaved?.();
    } catch (err) {
      resetReview(); setProposals(null);
      setError(`${(err as Error).message} Inget nytt förslag bekräftas automatiskt. Förhandsgranska igen.`);
    }
  }
  const hasPreview = Boolean(selected || addressPreview?.token);
  return <section className="space-y-3 rounded-md border p-3" aria-label="Rätta och föreslå resurs">
    <h3 className="font-medium">Rätta och granska</h3>
    <p className="text-xs text-muted-foreground">Förhandsgranskning ändrar inte planen. Ändringar måste granskas och bekräftas; därefter krävs nytt godkännande före utskick.</p>
    <div className="space-y-2">
      <span className="text-sm font-medium">Leveransadress</span>
      <AddressAutocomplete value={address} onChange={(value) => { resetReview(); setAddress(value); }} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={manual} disabled={busy}
        onChange={(event) => { resetReview(); setManual(event.target.checked); setPositionConfirmed(false); }} />
        Ange position manuellt</label>
      {manual && <fieldset disabled={busy} className="space-y-2">
        <label className="block text-sm">Latitud<Input value={latitude} inputMode="decimal" onChange={(e) => {
          resetReview(); setLatitude(e.target.value); setPositionConfirmed(false);
        }} /></label>
        <label className="block text-sm">Longitud<Input value={longitude} inputMode="decimal" onChange={(e) => {
          resetReview(); setLongitude(e.target.value); setPositionConfirmed(false);
        }} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={positionConfirmed}
          onChange={(e) => { resetReview(); setPositionConfirmed(e.target.checked); }} />
          Jag har kontrollerat denna manuellt valda position. Den är inte en automatiskt verifierad geokodning.</label>
      </fieldset>}
      <Button size="sm" variant="outline" disabled={busy || !address.trim()} onClick={() => void previewAddress()}>Förhandsgranska adressrättning</Button>
    </div>
    <Button size="sm" variant="outline" disabled={busy || routeIds.length === 0} onClick={() => void recommend()}>Föreslå resurs</Button>
    {busy && <p role="status" className="text-sm">Beräknar konsekvens…</p>}
    {proposals && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Verkliga befintliga resurspar, utan poängsättning. Infogning sist på rutten prövas.</p>
      {!proposals.recommendations.length && <p className="text-sm">Inget tillåtet resursförslag hittades i denna plan.</p>}
      {proposals.recommendations.map((item) => <div key={item.routeId} className="space-y-2 rounded border p-2">
        <p className="text-sm font-medium">{item.vehicleName ?? item.driverName}</p>
        <p className="text-sm">{item.routeName} · position {item.targetIndex + 1}</p>
        <Consequences item={item} />
        <Button size="sm" variant={selected?.routeId === item.routeId ? "default" : "outline"} disabled={busy}
          onClick={() => { resetReview(); setSelected(item); }}>Granska detta förslag</Button>
      </div>)}
      {proposals.unavailable.map((item) => <p className="text-xs text-muted-foreground" key={item.routeId}>{item.routeName}: {item.reason}</p>)}
    </div>}
    {addressPreview && <div className="rounded border p-2 text-sm">
      {addressPreview.kind === "unresolved" ? <p>{addressPreview.message}</p> : <>
        <p>Original: {addressPreview.original?.address} ({addressPreview.original?.latitude}, {addressPreview.original?.longitude})</p>
        <p>Förslag: {addressPreview.proposed?.address} ({addressPreview.proposed?.latitude}, {addressPreview.proposed?.longitude})</p>
        <p>{addressPreview.verification === "manual" ? "Manuellt bekräftad position — inte automatiskt verifierad." : "Exakt adressmatchning."}</p>
        <p>{addressPreview.consequences?.reason}</p>
        <p>Originalunderlaget bevaras i revisionsspåret.</p>
      </>}
    </div>}
    {hasPreview && <div className="space-y-2 border-t pt-2">
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reviewed} disabled={busy}
        onChange={(e) => setReviewed(e.target.checked)} />Jag har granskat förslaget och de redovisade konsekvenserna, inklusive okända mått.</label>
      <Button size="sm" disabled={busy || !reviewed} onClick={() => void confirm()}>Bekräfta ändring</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={resetReview}>Avbryt</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {saved && <p role="status" className="text-sm">Ändringen sparades i arbetsplanen. Granska och godkänn före utskick till förare.</p>}
  </section>;
}
