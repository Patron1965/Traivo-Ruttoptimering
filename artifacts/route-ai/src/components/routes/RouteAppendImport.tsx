import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { applyRouteAppendImport, previewRouteAppendImport, type PreviewRouteAppendImportResponse, type Route } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { parseImportFile, type ParsedImportFile } from "@/lib/import-file";
import { APPEND_FIELDS, assertCompleteAppendFile, canAppendToRoute, canConfirmAppend, mapAppendRows, type AppendField, type AppendMapping } from "@/lib/route-append-import";
import { isGeneratedRouteDetailQueryKey } from "@/lib/route-query-cache";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";

export function RouteAppendImport({ route, enabled = true }: { route: Route | null; enabled?: boolean }) {
  const { user, hasRole } = useAuth();
  if (!hasRole("admin", "dispatcher") || !enabled) return null;
  if (!route) return <Button variant="outline" size="sm" disabled title="Välj en rutt uttryckligen i kartan eller listan.">Importera fler stopp (välj rutt)</Button>;
  if (!canAppendToRoute(route)) return null;
  return <AppendSession key={`${user?.organizationId}:${user?.id}:${user?.role}:${route.id}`} route={route} />;
}

function AppendSession({ route: latestRoute }: { route: Route }) {
  const [route, setRoute] = useState(latestRoute);
  const [addressEdits, setAddressEdits] = useState<Record<number, { address?: string; pickupAddress?: string }>>({});
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<ParsedImportFile | null>(null);
  const [mapping, setMapping] = useState<AppendMapping>({});
  const [preview, setPreview] = useState<PreviewRouteAppendImportResponse | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const active = useRef(true);
  const operation = useRef(0);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; operation.current++; controller.current?.abort(); };
  }, []);
  function reset() {
    operation.current++;
    controller.current?.abort();
    setFile(null); setMapping({}); setAddressEdits({}); setPreview(null); setAcknowledged(false); setError(""); setSaved(false); setSubmitted(false);
  }
  async function upload(uploaded: File) {
    const current = ++operation.current;
    setBusy(true); setError(""); setFile(null); setPreview(null); setAddressEdits({});
    try {
      const parsed = await parseImportFile(uploaded, { preserveValues: true });
      assertCompleteAppendFile(parsed);
      if (!active.current || operation.current !== current) return;
      const initial: AppendMapping = {};
      for (const [key, label] of Object.entries(APPEND_FIELDS)) {
        const header = parsed.headers.find(header => [key.toLowerCase(), label.toLowerCase()].includes(header.toLowerCase()));
        if (header) initial[key as AppendField] = header;
      }
      setFile(parsed); setMapping(initial);
    } catch (failure) { if (active.current && current === operation.current) setError(failure instanceof Error ? failure.message : "Filen kunde inte läsas."); }
    finally { if (active.current && current === operation.current) setBusy(false); }
  }
  async function validate() {
    if (!file || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const current = ++operation.current;
    controller.current = new AbortController();
    try {
      const stops = mapAppendRows(file, mapping, route.date).map(row => ({
        ...row, ...addressEdits[row.sourceRowNumber!],
      }));
      const result = await previewRouteAppendImport(route.id, { planRevision: route.planRevision, expectedRowCount: file.sourceRowCount, stops }, { signal: controller.current.signal });
      if (!active.current || current !== operation.current) return;
      if (result.routeId !== route.id || result.planRevision !== route.planRevision || result.counts.received !== file.sourceRowCount || result.counts.added !== file.sourceRowCount) throw new Error("Förhandsgranskningen stämmer inte med den valda rutten eller filens radantal.");
      setPreview(result); setAcknowledged(false);
    } catch (failure) { if (active.current && current === operation.current) setError(describeFailure(failure)); }
    finally { inFlight.current = false; if (active.current && current === operation.current) setBusy(false); }
  }
  async function confirm() {
    if (!preview || inFlight.current || !canConfirmAppend({ busy, submitted, duplicates: preview.duplicates.length, acknowledged, expiresAt: preview.expiresAt })) return;
    inFlight.current = true; setSubmitted(true); setBusy(true); setError("");
    try {
      await applyRouteAppendImport(route.id, { planRevision: route.planRevision, proposalId: preview.proposalId, digest: preview.digest, acknowledgeDuplicates: acknowledged });
      if (active.current) setSaved(true);
      toast({ title: "Stoppen är sparade", description: "Hela rutten har optimerats med befintliga och nya stopp." });
      try {
        await queryClient.invalidateQueries({
          predicate: query => ["/api/routes", "/api/stops", "/api/dashboard/stats"].includes(String(query.queryKey[0]))
            || isGeneratedRouteDetailQueryKey(query.queryKey)
            || String(query.queryKey[0]).includes("draft") || String(query.queryKey[0]).includes("workday")
            || String(query.queryKey[0]).includes("/import/route-plans/")
            || query.queryKey[0] === "getImportRoutePlanPlanningSummary",
        }, { throwOnError: true });
      } catch {
        toast({ title: "Sparat – vyn kunde inte uppdateras", description: "Ladda om sidan. Importera inte samma fil igen.", variant: "destructive" });
        if (active.current) setError("Sparat, men uppdateringen av vyn misslyckades. Ladda om sidan; importera inte filen igen.");
      }
    } catch (failure) {
      if (active.current) setError(`${describeFailure(failure)} Begäran skickas inte igen automatiskt. Vid nätverksfel: ladda om rutten och kontrollera om stoppen sparats innan en ny import.`);
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  return <>
    <Button variant="outline" size="sm" onClick={() => { reset(); setRoute(latestRoute); setOpen(true); }}>Importera fler stopp</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) reset(); } }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Importera fler stopp till {route.name}</DialogTitle>
          <DialogDescription>Befintliga stopp behålls. Hela rutten optimeras om. Inget sparas innan du bekräftar.</DialogDescription></DialogHeader>
        <p className="text-sm">Ruttens datum: {route.date.slice(0, 10)} · revision {route.planRevision}</p>
        {error && <p role="alert" className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}
        {saved ? <p role="status">Importen är sparad. Importera inte filen igen.</p> : !preview ? <>
          <label className="text-sm font-medium">Excel eller CSV
            <input type="file" accept=".csv,.xlsx,.xls,.xlsb" disabled={busy} className="block my-3" onChange={event => { const next = event.target.files?.[0]; if (next) void upload(next); }} />
          </label>
          {file && <>
            <p className="text-sm">{file.sourceRowCount} källrader. Alla kolumner bevaras som egna fält, även kolumner som inte kopplas nedan. Ingen rad hoppas över.</p>
            <div className="grid sm:grid-cols-2 gap-3">
              {(Object.entries(APPEND_FIELDS) as [AppendField, string][]).map(([field, label]) => <label key={field} className="text-sm">{label}{field === "address" ? " *" : ""}
                <select className="block w-full rounded-md border border-input bg-background p-2" value={mapping[field] ?? ""} disabled={busy} onChange={event => { setAddressEdits({}); setMapping(previous => ({ ...previous, [field]: event.target.value })); }}>
                  <option value="">Ej kopplad{field === "planningDate" ? " (ruttens datum)" : ""}</option>
                  {file.headers.map(header => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>)}
            </div>
            {mapping.address && <details open={Boolean(error)} className="rounded border p-3">
              <summary className="cursor-pointer font-medium">Granska och rätta adresser</summary>
              <p className="text-sm text-muted-foreground">Sök och välj en fullständig adress. Servern verifierar adresserna igen innan importen kan bekräftas. Ursprungliga filvärden behålls som källinformation.</p>
              <div className="space-y-3 max-h-72 overflow-y-auto">
                {file.rows.map(row => {
                  const sourceAddress = ["address", "postalCode", "city"].map(field => {
                    const header = mapping[field as AppendField];
                    return header ? row.values[file.headers.indexOf(header)] : "";
                  }).filter(Boolean).join(", ");
                  const pickupHeader = mapping.pickupAddress;
                  const pickup = pickupHeader ? row.values[file.headers.indexOf(pickupHeader)] : "";
                  return <fieldset key={row.sourceRowNumber} disabled={busy} className="space-y-1">
                    <legend className="text-sm">Källrad {row.sourceRowNumber}</legend>
                    <AddressAutocomplete value={addressEdits[row.sourceRowNumber]?.address ?? sourceAddress}
                      onChange={address => setAddressEdits(previous => ({ ...previous, [row.sourceRowNumber]: { ...previous[row.sourceRowNumber], address } }))} />
                    {pickup && <AddressAutocomplete value={addressEdits[row.sourceRowNumber]?.pickupAddress ?? pickup}
                      onChange={pickupAddress => setAddressEdits(previous => ({ ...previous, [row.sourceRowNumber]: { ...previous[row.sourceRowNumber], pickupAddress } }))} />}
                  </fieldset>;
                })}
              </div>
            </details>}
            <p className="text-sm text-muted-foreground">Tider tolkas i Europe/Stockholm. Tvetydiga adresser blockerar importen; rätta dem ovan och validera igen. Uppdragstyp anges med API-värden (delivery, pickup_delivery, field_service).</p>
            <Button disabled={busy || !mapping.address} onClick={() => void validate()}>{busy ? "Validerar adresser och optimerar…" : "Validera adresser och förhandsgranska"}</Button>
          </>}
        </> : <>
          <p className="font-medium">{preview.counts.existing} befintliga + {preview.counts.added} nya = {preview.counts.total} stopp</p>
          <p className="text-sm">Hela rutten: {preview.consequences.totalDistanceKm.toFixed(1)} km · {Math.round(preview.consequences.totalDurationMin)} minuter. Servern har kontrollerat arbetsdag och kapacitetskrav. Detaljerad arbetsdagstidslinje ingår inte i förhandsgranskningen.</p>
          <p className="text-sm">Giltig till {new Date(preview.expiresAt).toLocaleTimeString("sv-SE")}.</p>
          {!!preview.duplicates.length && <div className="rounded-md border border-amber-500 p-3 space-y-2">
            <p>Möjliga dubbletter (inga rader tas bort):</p>
            {preview.duplicates.map(item => <p className="text-sm" key={item.sourceRowNumber}>Källrad {item.sourceRowNumber}: {item.matchingStopIds.length} befintliga stopp; källrader {item.matchingSourceRowNumbers.join(", ") || "–"}.</p>)}
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy || submitted} onChange={event => setAcknowledged(event.target.checked)} />Jag har granskat dubbletterna och vill lägga till samtliga rader.</label>
          </div>}
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || submitted} onClick={() => setPreview(null)}>Ändra koppling</Button>
            <Button disabled={!canConfirmAppend({ busy, submitted, duplicates: preview.duplicates.length, acknowledged, expiresAt: preview.expiresAt })} onClick={() => void confirm()}>{busy ? "Sparar…" : "Bekräfta import och optimera hela rutten"}</Button>
          </div>
        </>}
      </DialogContent>
    </Dialog>
  </>;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const data = (error as Error & { data?: { message?: string; details?: { rowResults?: Array<{ sourceRowNumber: number; reasons: string[] }> } } }).data;
    if (data?.details?.rowResults) return data.details.rowResults.map(row => `Rad ${row.sourceRowNumber}: ${row.reasons.join(" ")}`).join("\n");
    return data?.message || error.message;
  }
  return "Importen kunde inte genomföras. Inga delrader sparas.";
}
