import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useImportCustomerRow,
  useListCustomers,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileSpreadsheet, Upload, AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { localizeError } from "@/lib/localize-error";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import {
  CUSTOMER_IMPORT_FIELDS,
  CUSTOMER_IMPORT_MAX_BYTES,
  CUSTOMER_IMPORT_MAX_ROWS,
  STATUS_LABEL,
  buildPreview,
  guessCustomerMapping,
  isImportable,
  sheetToRows,
  toCustomerInput,
  type CustomerImportField,
  type CustomerImportMapping,
  type PreviewRow,
  type RowStatus,
  type SheetRow,
} from "@/lib/customer-import";

type RunState = "pending" | "running" | "created" | "skipped" | "failed";

const STATUS_TONE: Record<RowStatus, string> = {
  ready: "bg-primary/10 text-primary",
  readyNoSite: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  invalid: "bg-destructive/10 text-destructive",
  existing: "bg-secondary text-muted-foreground",
  existingArchived: "bg-secondary text-muted-foreground",
  duplicateInFile: "bg-secondary text-muted-foreground",
};

const RUN_LABEL: Record<RunState, string> = {
  pending: "Väntar",
  running: "Sparar…",
  created: "Skapad",
  skipped: "Fanns redan – hoppades över",
  failed: "Misslyckades",
};

export function CustomerImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const owner = `${user?.organizationId ?? ""}:${user?.id ?? ""}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const queryClient = useQueryClient();
  const importRow = useImportCustomerRow();
  const importRef = useRef(importRow.mutateAsync);
  importRef.current = importRow.mutateAsync;

  const existingQuery = useListCustomers(
    { includeArchived: true },
    { query: { enabled: open, queryKey: getListCustomersQueryKey({ includeArchived: true }) } },
  );

  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<{ sheets: string[]; matrices: Record<string, unknown[][]> } | null>(null);
  const [sheet, setSheet] = useState("");
  const [mapping, setMapping] = useState<CustomerImportMapping>({});
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<number, { state: RunState; error?: string }>>({});
  const [runPreview, setRunPreview] = useState<PreviewRow[] | null>(null);

  const parsed = useMemo<{ headers: string[]; rows: SheetRow[] } | null>(() => {
    if (!workbook || !sheet) return null;
    return sheetToRows(workbook.matrices[sheet] ?? []);
  }, [workbook, sheet]);

  const tooMany = (parsed?.rows.length ?? 0) > CUSTOMER_IMPORT_MAX_ROWS;
  const preview = useMemo<PreviewRow[]>(() => {
    if (runPreview) return runPreview;
    if (!parsed || tooMany || mapping.name === undefined) return [];
    return buildPreview(parsed.rows, mapping, existingQuery.data ?? []);
  }, [parsed, tooMany, mapping, existingQuery.data, runPreview]);

  const counts = useMemo(() => {
    const c: Record<RowStatus, number> = { ready: 0, readyNoSite: 0, invalid: 0, existing: 0, existingArchived: 0, duplicateInFile: 0 };
    preview.forEach((p) => { c[p.status]++; });
    return c;
  }, [preview]);

  const importable = preview.filter((p) => isImportable(p.status));
  const done = importable.filter((p) => ["created", "skipped"].includes(results[p.rowNumber]?.state ?? "")).length;
  const failed = importable.filter((p) => results[p.rowNumber]?.state === "failed");
  const processed = importable.filter((p) => { const s = results[p.rowNumber]?.state; return s && s !== "pending" && s !== "running"; }).length;
  const created = importable.filter((p) => results[p.rowNumber]?.state === "created").length;
  const skippedServer = importable.filter((p) => results[p.rowNumber]?.state === "skipped").length;
  const started = Object.keys(results).length > 0;
  const remaining = importable.filter((p) => !["created", "skipped"].includes(results[p.rowNumber]?.state ?? ""));

  const reset = () => {
    setFileName(""); setFileError(null); setWorkbook(null); setSheet(""); setMapping({}); setResults({}); setRunPreview(null);
  };

  const handleFile = async (file: File) => {
    reset();
    setFileName(file.name);
    if (file.size > CUSTOMER_IMPORT_MAX_BYTES) { setFileError("Filen är större än 5 MB. Dela upp den och försök igen."); return; }
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const matrices: Record<string, unknown[][]> = {};
      for (const name of wb.SheetNames) {
        matrices[name] = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "" });
      }
      if (wb.SheetNames.length === 0) { setFileError("Filen innehåller inga kalkylblad."); return; }
      const first = wb.SheetNames.find((n) => sheetToRows(matrices[n]).rows.length > 0) ?? wb.SheetNames[0];
      setWorkbook({ sheets: wb.SheetNames, matrices });
      selectSheet(first, matrices);
    } catch {
      setFileError("Filen kunde inte läsas. Kontrollera att det är en Excel- eller CSV-fil.");
    }
  };

  const selectSheet = (name: string, matrices = workbook?.matrices) => {
    setSheet(name);
    setResults({});
    setMapping(guessCustomerMapping(sheetToRows(matrices?.[name] ?? []).headers));
  };

  const setField = (field: CustomerImportField, value: string) => {
    setResults({});
    setMapping((m) => {
      const next = { ...m };
      if (value === "none") delete next[field]; else next[field] = Number(value);
      return next;
    });
  };

  const run = async (rows: PreviewRow[]) => {
    if (rows.length === 0) return;
    const runOwner = ownerRef.current;
    setRunPreview(preview);
    setRunning(true);
    setResults((r) => { const n = { ...r }; rows.forEach((p) => { n[p.rowNumber] = { state: "pending" }; }); return n; });
    try {
      for (const row of rows) {
        if (!mounted.current || ownerRef.current !== runOwner) break;
        setResults((r) => ({ ...r, [row.rowNumber]: { state: "running" } }));
        try {
          const res = await importRef.current({ data: toCustomerInput(row.data) });
          setResults((r) => ({ ...r, [row.rowNumber]: { state: res.outcome === "created" ? "created" : "skipped" } }));
        } catch (e) {
          setResults((r) => ({ ...r, [row.rowNumber]: { state: "failed", error: localizeError(e, t) } }));
        }
      }
    } finally {
      setRunning(false);
      await queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    }
  };

  const close = (next: boolean) => {
    if (running) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const headers = parsed?.headers ?? [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="max-w-4xl max-h-[90dvh] flex flex-col gap-4"
        onEscapeKeyDown={(e) => { if (running) e.preventDefault(); }}
        onPointerDownOutside={(e) => { if (running) e.preventDefault(); }}
        data-testid="dialog-customer-import"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="h-5 w-5 text-primary" />Importera kunder från Excel</DialogTitle>
          <DialogDescription>
            Bygg kundregistret en gång och återanvänd det för både återkommande stopp och enstaka bokningar.
            Befintliga kunder uppdateras aldrig – de hoppas över. Adresser verifieras av servern innan en besöksplats sparas.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          <div className="flex flex-wrap items-end gap-3">
            <label className={cn("inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm cursor-pointer hover:bg-accent/50", running && "pointer-events-none opacity-50")}>
              <Upload className="h-4 w-4" />
              {fileName || "Välj fil (.xlsx, .xls, .csv, max 5 MB)"}
              <input
                type="file"
                accept=".xlsx,.xls,.xlsb,.csv"
                className="sr-only"
                disabled={running}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }}
                data-testid="input-customer-import-file"
              />
            </label>
            {workbook && workbook.sheets.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor="customer-import-sheet" className="text-xs">Kalkylblad</Label>
                <Select value={sheet} onValueChange={(v) => selectSheet(v)} disabled={running || started}>
                  <SelectTrigger id="customer-import-sheet" className="h-9 w-48" data-testid="select-customer-import-sheet"><SelectValue /></SelectTrigger>
                  <SelectContent>{workbook.sheets.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
          </div>

          {fileError && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>{fileError}</AlertDescription></Alert>}
          {tooMany && (
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription>
              Bladet har {parsed?.rows.length} rader med innehåll. Högst {CUSTOMER_IMPORT_MAX_ROWS} rader per import – dela upp filen.
            </AlertDescription></Alert>
          )}
          {parsed && !tooMany && parsed.rows.length === 0 && (
            <p className="text-sm text-muted-foreground">Bladet saknar datarader under rubrikraden.</p>
          )}

          {parsed && !tooMany && parsed.rows.length > 0 && (
            <fieldset className="rounded-lg border p-3" disabled={running || started}>
              <legend className="px-1 text-sm font-medium">Kolumnmappning</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2">
                {CUSTOMER_IMPORT_FIELDS.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <Label htmlFor={`map-${f.key}`} className="text-xs">{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>
                    <Select disabled={running || started} value={mapping[f.key] === undefined ? "none" : String(mapping[f.key])} onValueChange={(v) => setField(f.key, v)}>
                      <SelectTrigger id={`map-${f.key}`} className="h-8 text-xs" data-testid={`select-map-${f.key}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Används inte</SelectItem>
                        {headers.map((h, i) => <SelectItem key={i} value={String(i)}>{h || `Kolumn ${i + 1}`}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {mapping.name === undefined && <p className="mt-2 text-xs text-destructive">Välj vilken kolumn som innehåller kundnamn.</p>}
            </fieldset>
          )}

          {existingQuery.isError && (
            <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertDescription className="flex items-center gap-2">
              Befintliga kunder kunde inte hämtas för dubblettkontroll.
              <Button size="sm" variant="outline" onClick={() => existingQuery.refetch()}>Försök igen</Button>
            </AlertDescription></Alert>
          )}

          {preview.length > 0 && (
            <>
              <div className="flex flex-wrap gap-2 text-xs" data-testid="text-customer-import-summary">
                {(Object.keys(counts) as RowStatus[]).filter((k) => counts[k] > 0).map((k) => (
                  <span key={k} className={cn("rounded px-2 py-1 font-medium", STATUS_TONE[k])}>{STATUS_LABEL[k]}: {counts[k]}</span>
                ))}
              </div>
              {counts.readyNoSite > 0 && (
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {counts.readyNoSite} kunder saknar gatuadress och sparas utan besöksplats. Lägg till och verifiera en plats innan de kan bokas.
                </p>
              )}

              {started && (
                <div className="space-y-1" aria-live="polite">
                  <Progress value={importable.length ? (processed / importable.length) * 100 : 0} />
                  <p className="text-xs text-muted-foreground" data-testid="text-customer-import-progress">
                    {processed} av {importable.length} behandlade · {created} skapade · {skippedServer} fanns redan · {failed.length} misslyckades
                  </p>
                </div>
              )}

              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Rad</th>
                      <th className="px-2 py-1.5 font-medium">Kund</th>
                      <th className="px-2 py-1.5 font-medium">Kundnr</th>
                      <th className="px-2 py-1.5 font-medium">Adress</th>
                      <th className="px-2 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p) => {
                      const r = results[p.rowNumber];
                      return (
                        <tr key={p.rowNumber} className="border-t align-top" data-testid={`row-customer-import-${p.rowNumber}`}>
                          <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{p.rowNumber}</td>
                          <td className="px-2 py-1.5 font-medium">{p.data.name || <span className="italic text-muted-foreground">saknas</span>}</td>
                          <td className="px-2 py-1.5">{p.data.customerNumber}</td>
                          <td className="px-2 py-1.5">{[p.data.address, [p.data.postalCode, p.data.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || <span className="text-muted-foreground">Ingen plats</span>}</td>
                          <td className="px-2 py-1.5">
                            {r ? (
                              <span className={cn("rounded px-1.5 py-0.5 font-medium",
                                r.state === "created" && "bg-primary/10 text-primary",
                                r.state === "failed" && "bg-destructive/10 text-destructive",
                                (r.state === "skipped" || r.state === "pending" || r.state === "running") && "bg-secondary text-muted-foreground")}>
                                {RUN_LABEL[r.state]}
                              </span>
                            ) : (
                              <span className={cn("rounded px-1.5 py-0.5 font-medium", STATUS_TONE[p.status])}>
                                {p.status === "duplicateInFile" ? `Dubblett av rad ${p.duplicateOfRow}` : STATUS_LABEL[p.status]}
                              </span>
                            )}
                            {p.issues.length > 0 && <div className="mt-1 text-destructive">{p.issues.join(" · ")}</div>}
                            {r?.error && <div className="mt-1 text-destructive">{r.error}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => close(false)} disabled={running} data-testid="button-customer-import-close">
            {started && !running ? "Stäng" : "Avbryt"}
          </Button>
          {failed.length > 0 && !running && (
            <Button variant="outline" onClick={() => run(failed)} data-testid="button-customer-import-retry">
              <RotateCcw className="h-4 w-4 mr-1.5" />Försök igen med {failed.length} misslyckade
            </Button>
          )}
          {!started && (
            <Button
              onClick={() => run(remaining)}
              disabled={running || importable.length === 0 || existingQuery.isLoading || existingQuery.isError}
              data-testid="button-customer-import-start"
            >
              Importera {importable.length} kunder
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
