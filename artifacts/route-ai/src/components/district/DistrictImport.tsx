import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, RotateCcw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseImportFile, type ParsedImportFile } from "@/lib/import-file";
import type { ImportMapping, ImportPayload, ImportPreview } from "@/lib/district-api";
import { buildSourceKey, buildSourceRows } from "@/lib/district-source-rows";
import { useCommitDistrictImport, usePreviewDistrictImport } from "@/hooks/use-districts";
import { PagedList } from "./Pager";

const FIELDS: { key: keyof ImportMapping; label: string; hints: RegExp }[] = [
  { key: "objectNumber", label: "Objektnummer", hints: /^(objekt|obj|objektnr|objektnummer|object|id)/i },
  { key: "address", label: "Adress", hints: /(adress|address|gata)/i },
  { key: "latitude", label: "Latitud (WGS84)", hints: /^(lat|latitud|latitude|y_wgs)/i },
  { key: "longitude", label: "Longitud (WGS84)", hints: /^(lon|lng|long|longitud|longitude|x_wgs)/i },
];

function orderedRows(parsed: ParsedImportFile): { sourceRowNumber: number; values: string[] }[] {
  return [...parsed.rows, ...parsed.rejectedRows].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
}

function guessMapping(headers: string[]): ImportMapping {
  const pick = (re: RegExp) => headers.find((h) => re.test(h.trim())) ?? "";
  return { objectNumber: pick(FIELDS[0].hints), address: pick(FIELDS[1].hints), latitude: pick(FIELDS[2].hints), longitude: pick(FIELDS[3].hints) };
}

export function DistrictImport({ planId, hasDataset, onDone }: { planId: string; hasDataset: boolean; onDone: () => void }) {
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedImportFile | null>(null);
  const [fileBytes, setFileBytes] = useState<ArrayBuffer | null>(null);
  const [parseError, setParseError] = useState("");
  const [mapping, setMapping] = useState<ImportMapping>({ objectNumber: "", address: "", latitude: "", longitude: "" });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const previewMutation = usePreviewDistrictImport(planId);
  const commit = useCommitDistrictImport(planId);

  const rowsPayload = useMemo(() => {
    if (!parsed) return null;
    const rows = buildSourceRows(parsed);
    return rows;
  }, [parsed]);
  // sourceKey: bounded hash of exact file bytes + mapping, identical across retries.
  const buildPayload = async (): Promise<ImportPayload | null> =>
    rowsPayload && fileBytes ? { rows: rowsPayload, mapping, sourceKey: await buildSourceKey(fileBytes, mapping) } : null;

  const mappingComplete = FIELDS.every((f) => mapping[f.key]) && new Set(Object.values(mapping)).size === 4;
  // Every data row, malformed or empty included, is sent with its physical
  // sourceRowNumber; server issue rowNumbers refer to those file lines.
  const structural = parsed?.rejectedRows ?? [];
  const ordered = useMemo(() => (parsed ? orderedRows(parsed) : []), [parsed]);
  const needsConsent = !!preview && preview.rejected > 0;
  const rowByNumber = useMemo(() => new Map(ordered.map((r) => [r.sourceRowNumber, r])), [ordered]);

  const onFile = async (file: File) => {
    setParseError(""); setPreview(null); setConsent(false); commit.reset(); previewMutation.reset();
    try {
      const [result, hash] = await Promise.all([parseImportFile(file, { preserveValues: true }), file.arrayBuffer()]);
      setParsed(result); setFileBytes(hash); setFileName(file.name); setMapping(guessMapping(result.headers));
    } catch (error) {
      setParsed(null); setParseError(error instanceof Error ? error.message : "Filen kunde inte läsas.");
    }
  };

  const runPreview = () => { void buildPayload().then((payload) => { if (payload) previewMutation.mutate(payload, { onSuccess: (p) => { setPreview(p); setConsent(false); } }); }); };
  const runCommit = () => { void buildPayload().then((payload) => { if (payload) commit.mutate({ ...payload, confirmValidOnly: needsConsent ? consent : false }); }); };

  if (commit.data) {
    return (
      <div className="space-y-4 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-5" data-testid="status-import-done">
        <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5 text-emerald-500" />Underlaget är aktiverat</div>
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Totalt" value={commit.data.total} /><Stat label="Importerade" value={commit.data.valid} /><Stat label="Avvisade" value={commit.data.rejected} />
        </dl>
        <Button onClick={onDone} data-testid="button-import-continue">Gå till kartan</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="panel-district-import">
      {hasDataset && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="note">
          Planen har redan ett underlag. Ett nytt underlag kan inte läsas in i samma plan. Skapa en ny distriktsplan för en ny eller uppdaterad grundfil.
        </p>
      )}
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-6 text-center hover:border-primary/60 focus-within:border-primary">
        <Upload className="h-6 w-6 text-muted-foreground" />
        <span className="text-sm font-medium">{fileName || "Välj CSV- eller Excelfil"}</span>
        <span className="text-xs text-muted-foreground">Geokodade poster med WGS84 latitud/longitud. Källvärden sparas exakt som i filen.</span>
        <input type="file" accept=".csv,.xlsx,.xls,.xlsb" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} data-testid="input-district-file" />
      </label>
      {parseError && <p role="alert" className="text-sm text-destructive">{parseError}</p>}

      {parsed && (
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><FileSpreadsheet className="h-4 w-4" />Kolumnmappning</h3>
          <p className="text-xs text-muted-foreground">{parsed.sourceRowCount.toLocaleString("sv-SE")} datarader, {parsed.headers.length} kolumner. Alla originalkolumner sparas och kan väljas vid export.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label>{f.label}</Label>
                <Select value={mapping[f.key] || undefined} onValueChange={(v) => { setMapping({ ...mapping, [f.key]: v }); setPreview(null); }}>
                  <SelectTrigger data-testid={`select-map-${f.key}`}><SelectValue placeholder="Välj kolumn" /></SelectTrigger>
                  <SelectContent>{parsed.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            ))}
          </div>
          {!mappingComplete && <p className="text-xs text-muted-foreground">Välj fyra olika kolumner.</p>}
          <Button onClick={runPreview} disabled={!mappingComplete || previewMutation.isPending} data-testid="button-import-preview">
            {previewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Granska rader
          </Button>
          {previewMutation.error && <ErrorLine error={previewMutation.error} onRetry={runPreview} />}
        </section>
      )}

      {preview && parsed && (
        <section className="space-y-4" data-testid="panel-import-review">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Filrader" value={parsed.sourceRowCount} />
            <Stat label="Giltiga" value={preview.valid} tone="ok" />
            <Stat label="Avvisade" value={preview.rejected} tone={preview.rejected ? "warn" : undefined} />
            <Stat label="Misstänkta dubbletter" value={preview.duplicateCandidates.length} tone={preview.duplicateCandidates.length ? "warn" : undefined} />
          </dl>
          <p className="text-xs text-muted-foreground" data-testid="text-reconciliation">
            Avstämning: {parsed.sourceRowCount} filrader, {preview.total} granskade = {preview.valid} giltiga + {preview.rejected} avvisade. Radnummer avser filens rader.
            {structural.length > 0 && <> Varav {structural.length} med fel kolumnantal eller tomma, som avvisas.</>}
            {(preview.total !== ordered.length || preview.valid + preview.rejected !== preview.total) && <strong className="text-destructive"> Avstämningen går inte ihop ({preview.total} granskade, {ordered.length} skickade). Importera inte; kontakta support.</strong>}
          </p>
          {preview.issues.length > 0 && (
            <div className="rounded-md border p-3">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avvisade rader</h4>
              <PagedList testId="list-import-issues" pageSize={50}
                items={preview.issues.map((i) => ({ row: i.rowNumber, reason: i.reason }))}
                render={(item, idx) => <li key={idx} className="flex gap-3 py-1.5 text-xs"><span className="w-16 shrink-0 font-mono text-muted-foreground">Rad {item.row}</span><span>{item.reason}</span></li>} />
            </div>
          )}
          {preview.duplicateCandidates.length > 0 && (
            <div className="rounded-md border p-3">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Misstänkta dubbletter</h4>
              <p className="mb-2 text-xs text-muted-foreground">Visas för granskning. Inga poster slås ihop automatiskt; båda raderna importeras som egna objekt.</p>
              <PagedList testId="list-import-duplicates" pageSize={50} items={preview.duplicateCandidates}
                render={(d, idx) => <li key={idx} className="py-1.5 text-xs">Rad {d.rowNumber} liknar rad {d.otherRowNumber} · {rowByNumber.get(d.rowNumber)?.values[parsed.headers.indexOf(mapping.address)] ?? ""}</li>} />
            </div>
          )}
          {needsConsent && (
            <label className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} data-testid="checkbox-valid-only" />
              <span>Jag förstår att {preview.rejected.toLocaleString("sv-SE")} rader inte importeras och vill bara importera de {preview.valid.toLocaleString("sv-SE")} giltiga.</span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={runCommit} disabled={commit.isPending || preview.valid === 0 || (needsConsent && !consent) || preview.total !== ordered.length || preview.valid + preview.rejected !== preview.total} data-testid="button-import-commit">
              {commit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Importera {preview.valid.toLocaleString("sv-SE")} poster
            </Button>
          </div>
          {commit.error && <ErrorLine error={commit.error} onRetry={runCommit} note="Återförsök skickar exakt samma underlag och ger inga dubbletter." />}
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone === "warn" ? "text-amber-500" : tone === "ok" ? "text-emerald-500" : ""}`}>{value.toLocaleString("sv-SE")}</dd>
    </div>
  );
}

export function ErrorLine({ error, onRetry, note }: { error: unknown; onRetry?: () => void; note?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
      <AlertTriangle className="h-4 w-4 text-destructive" />
      <span className="flex-1">{error instanceof Error ? error.message : "Något gick fel."}{note && <span className="block text-xs text-muted-foreground">{note}</span>}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry} data-testid="button-retry"><RotateCcw className="mr-1 h-3.5 w-3.5" />Försök igen</Button>}
    </div>
  );
}
