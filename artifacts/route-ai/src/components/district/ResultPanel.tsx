import { useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { downloadDistrictExport, type DistrictJob, type DistrictPoint, type DistrictResult, type DistrictZone } from "@/lib/district-api";
import { resolveInterval } from "@/lib/district-geo";
import { useCreateDistrictExport } from "@/hooks/use-districts";
import { PagedList } from "./Pager";
import { ErrorLine } from "./DistrictImport";

export function isJobStale(job: DistrictJob, zone: DistrictZone | undefined, superseded = false) {
  return superseded || job.status === "stale" || (!!zone && job.revision !== zone.revision) || !zone || !!zone.deletedAt;
}

const km = (m: number) => `${(m / 1000).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} km`;
const hm = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };

interface Props {
  planId: string;
  canWrite: boolean;
  job: DistrictJob;
  zone: DistrictZone | undefined;
  result: DistrictResult;
  byId: ReadonlyMap<string, DistrictPoint>;
  from: number;
  to: number;
  setRange: (from: number, to: number) => void;
  superseded: boolean;
}

export function ResultPanel({ planId, canWrite, job, zone, result, byId, from, to, setRange, superseded }: Props) {
  const n = result.orderedPointIds.length;
  // Wrap is decided by the persisted job configuration, never local UI state.
  const loop = job.mode === "loop";
  const stale = isJobStale(job, zone, superseded);
  const interval = resolveInterval(n, from, to, loop);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3" data-testid="panel-result">
      {stale && (
        <p role="alert" className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />Resultatet är inaktuellt: zonens innehåll har ändrats eller en nyare optimering (annan start/slut) har startats. Nya uttag är blockerade. Tidigare uttag kan fortfarande hämtas under Uttag.
        </p>
      )}
      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md border px-2 py-1.5"><dt className="text-[10px] uppercase text-muted-foreground">Stopp</dt><dd className="font-semibold tabular-nums" data-testid="text-result-stops">{n}</dd></div>
        <div className="rounded-md border px-2 py-1.5"><dt className="text-[10px] uppercase text-muted-foreground">Sträcka</dt><dd className="font-semibold tabular-nums">{km(result.distanceMeters)}</dd></div>
        <div className="rounded-md border px-2 py-1.5"><dt className="text-[10px] uppercase text-muted-foreground">Körtid</dt><dd className="font-semibold tabular-nums">{hm(result.driveSeconds)}</dd></div>
      </dl>
      {!job.mode && <p role="alert" className="text-xs text-destructive">Jobbet saknar sparad ordningstyp; intervall kan inte gå förbi slutet.</p>}
      <p className="text-[11px] text-muted-foreground">{job.mode === "loop" ? "Sluten slinga" : job.mode === "open" ? "Öppen ordning" : "Okänd ordningstyp"}. Uppskattning{result.serviceSeconds ? ` inkl. ${hm(result.serviceSeconds)} service` : ""}, inte ett löfte om genomförbar dagsrutt.</p>
      {result.warnings.length > 0 && <ul className="list-inside list-disc text-xs text-amber-600 dark:text-amber-400">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {job.bulkScope && <p className="text-xs text-muted-foreground">Välj Hela för ett radbevarande uttag: alla originalkolumner och olösta/avvisade rader följer med. Ruttordning 0 betyder att position saknas; källstatus och positionsvarning finns i filen. Deluttag omfattar endast valda positionerade objekt.</p>}

      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex items-end gap-2">
          <div className="space-y-1"><Label htmlFor="from" className="text-xs">Från nr</Label><Input id="from" type="number" min={1} max={n} className="h-8 w-20" value={from} onChange={(e) => setRange(Number(e.target.value), to)} data-testid="input-range-from" /></div>
          <div className="space-y-1"><Label htmlFor="to" className="text-xs">Till nr</Label><Input id="to" type="number" min={1} max={n} className="h-8 w-20" value={to} onChange={(e) => setRange(from, Number(e.target.value))} data-testid="input-range-to" /></div>
          <Button size="sm" variant="outline" className="h-8" onClick={() => setRange(1, n)} data-testid="button-range-all">Hela</Button>
        </div>
        <p className="text-xs" aria-live="polite" data-testid="text-range-summary">
          {interval.ok ? <>{interval.indexes.length} stopp valda{interval.wraps && <> · går förbi slut ({n}) och fortsätter från 1</>}</> : <span className="text-destructive">{interval.error}</span>}
        </p>
        <p className="text-[11px] text-muted-foreground">Klicka en rad för att sätta start, skift+klick för att sätta slut.</p>
        {canWrite && <Button className="w-full" size="sm" disabled={stale || !interval.ok} onClick={() => setOpen(true)} data-testid="button-open-export"><Download className="mr-1 h-3.5 w-3.5" />Skapa uttag</Button>}
      </div>

      <PagedList testId="list-result" pageSize={100} items={result.orderedPointIds}
        render={(id, i) => {
          const p = byId.get(id);
          const inRange = interval.ok && interval.indexes.includes(i);
          return (
            <li key={id}>
              <button className={`flex w-full items-center gap-2 px-1 py-1 text-left text-xs hover:bg-muted ${inRange ? "bg-amber-500/10" : ""}`}
                onClick={(e) => (e.shiftKey ? setRange(from, i + 1) : setRange(i + 1, Math.max(i + 1, to)))} data-testid={`row-result-${i + 1}`}>
                <span className="w-9 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="w-20 shrink-0 truncate font-mono">{p?.objectNumber ?? "?"}</span>
                <span className="min-w-0 flex-1 truncate">{p?.address ?? id}</span>
                {p?.exported && <span className="rounded bg-muted px-1 text-[10px]">exp.</span>}
              </button>
            </li>
          );
        }} />

      {open && interval.ok && (
        <ExportDialog planId={planId} jobId={job.id} byId={byId} ids={interval.indexes.map((i) => result.orderedPointIds[i])} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function ExportDialog({ planId, jobId, ids, byId, onClose }: { planId: string; jobId: string; ids: string[]; byId: ReadonlyMap<string, DistrictPoint>; onClose: () => void }) {
  const create = useCreateDistrictExport(planId);
  const columnOptions = useMemo(() => Object.keys(byId.get(ids[0])?.original ?? {}), [byId, ids]);
  const [columns, setColumns] = useState<string[]>([]);
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx");
  const overlap = useMemo(() => ids.filter((id) => byId.get(id)?.exported).length, [ids, byId]);
  const [confirm, setConfirm] = useState(false);
  const [serverOverlap, setServerOverlap] = useState(0);
  const [downloadError, setDownloadError] = useState("");
  const needsConfirm = overlap > 0 || serverOverlap > 0;

  const submit = () => {
    setDownloadError("");
    create.mutate({ jobId, pointIds: ids, columns, confirmReexport: confirm }, {
      onSuccess: (res) => {
        if (res.overlapPointIds.length > 0 && !confirm) { setServerOverlap(res.overlapPointIds.length); return; }
        downloadDistrictExport(planId, res.export.id, format).then(onClose, (e) => setDownloadError(e instanceof Error ? e.message : "Filen kunde inte hämtas."));
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Uttag av {ids.length} stopp</DialogTitle>
          <DialogDescription>Filen innehåller objektnummer, ursprungligt ruttordningsnummer och uttagets ordningsnummer. Exporterat betyder inte utfört eller mottaget av huvudsystemet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-xs">
            {(["xlsx", "csv"] as const).map((f) => <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={`rounded px-2 py-1.5 font-medium ${format === f ? "bg-card shadow" : "text-muted-foreground"}`} data-testid={`button-format-${f}`}>{f.toUpperCase()}</button>)}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between"><Label>Originalkolumner</Label>
              <button className="text-xs underline" onClick={() => setColumns(columns.length === columnOptions.length ? [] : columnOptions)} data-testid="button-toggle-columns">{columns.length === columnOptions.length ? "Inga" : "Alla"}</button></div>
            <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2">
              {columnOptions.map((c) => (
                <label key={c} className="flex items-center gap-2 text-xs"><Checkbox checked={columns.includes(c)} onCheckedChange={(v) => setColumns(v === true ? [...columns, c] : columns.filter((x) => x !== c))} data-testid={`checkbox-column-${c}`} /><span className="truncate">{c}</span></label>
              ))}
            </div>
          </div>
          {needsConfirm && (
            <label className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
              <Checkbox checked={confirm} onCheckedChange={(v) => setConfirm(v === true)} data-testid="checkbox-confirm-reexport" />
              <span>{Math.max(overlap, serverOverlap)} av stoppen finns i tidigare uttag. Jag vill exportera dem igen medvetet.</span>
            </label>
          )}
          {create.error && <ErrorLine error={create.error} />}
          {downloadError && <ErrorLine error={new Error(downloadError)} note="Uttaget är sparat. Hämta filen igen under Uttag." />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Avbryt</Button>
          <Button onClick={submit} disabled={create.isPending || (needsConfirm && !confirm)} data-testid="button-create-export">
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Skapa och hämta {format.toUpperCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
