import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Ban, Crosshair, Loader2, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { districtApi, type JobInput, type DistrictEndpoint, type DistrictJob, type DistrictPoint, type DistrictZone } from "@/lib/district-api";
import { ZONE_TARGET } from "@/lib/district-geo";
import { useCancelDistrictJob, useDistrictJob, useStartDistrictJob } from "@/hooks/use-districts";
import { ErrorLine } from "./DistrictImport";
import { ResultPanel } from "./ResultPanel";
import { JobStatus } from "./JobStatus";

import { selectOptimizationZone, type OptimizeState } from "@/lib/district-zone-selection";
export { initialOptimizeState, type OptimizeState } from "@/lib/district-zone-selection";

const STATUS: Record<DistrictJob["status"], string> = {
  queued: "I kö", running: "Optimerar", completed: "Klar", failed: "Misslyckades", cancelled: "Avbruten", stale: "Inaktuell",
};

export function describeEndpoint(ep: DistrictEndpoint | null | undefined, byId: ReadonlyMap<string, DistrictPoint>) {
  if (!ep) return "Inte vald";
  if (ep.pointId) { const p = byId.get(ep.pointId); return p ? `${p.objectNumber} · ${p.address}` : "Post"; }
  return `Kartpunkt ${ep.latitude?.toFixed(5)}, ${ep.longitude?.toFixed(5)}`;
}

interface Props {
  planId: string;
  canWrite: boolean;
  zones: readonly DistrictZone[];
  jobs: readonly DistrictJob[];
  counts: ReadonlyMap<string, number>;
  byId: ReadonlyMap<string, DistrictPoint>;
  points: readonly DistrictPoint[];
  state: OptimizeState;
  setState: (next: OptimizeState) => void;
}

export function OptimizePanel({ planId, canWrite, zones, jobs, counts, byId, points, state, setState }: Props) {
  const [bulkScope,setBulkScope]=useState<"off"|"zone"|"plan">("off");
  const [exceptionText,setExceptionText]=useState("");
  const [acknowledged,setAcknowledged]=useState("");
  const preview=useMutation({mutationFn:({zoneId,input,key}:{zoneId:string;input:JobInput;key:string})=>
    districtApi.previewBulk(planId,zoneId,input).then(result=>({result,key}))});
  const start = useStartDistrictJob(planId);
  const cancel = useCancelDistrictJob(planId);
  const zone = zones.find((z) => z.id === state.zoneId);
  const zoneJobs = useMemo(() => jobs.filter((j) => j.zoneId === state.zoneId).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")), [jobs, state.zoneId]);
  const jobQuery = useDistrictJob(planId, state.jobId);
  const job = jobQuery.data?.job;
  const size = zone ? counts.get(zone.id) ?? 0 : 0;
  const zonePoints = useMemo(() => points.filter((p) => p.zoneId === state.zoneId), [points, state.zoneId]);
  const isBulk=bulkScope!=="off";
  const exceptions=exceptionText.trim()?exceptionText.trim().split("\n").map(line=>{
    const [pointId,meters,...reason]=line.split(";");
    return {pointId:pointId?.trim()??"",maxSnapMeters:Number(meters),reason:reason.join(";").trim()};
  }):[];
  const previewKey=JSON.stringify([planId,state.zoneId,zone?.revision,state.start,bulkScope,exceptions]);
  const checkedPreview=preview.data?.key===previewKey?preview.data.result:undefined;
  const bulkReady=checkedPreview?.ready && !!checkedPreview.previewHash && acknowledged===previewKey;
  const jobInput=():JobInput=>({expectedRevision:zone!.revision,mode:isBulk?"open":state.mode,start:state.start!,
    end:!isBulk && state.mode==="open" && state.useEnd && state.end?state.end:undefined,serviceMinutes:state.serviceMinutes,
    ...(isBulk?{bulkScope:bulkScope as "zone"|"plan",bulkPreviewHash:checkedPreview?.previewHash,distanceExceptions:exceptions}:{})});

  const selectZone = (zoneId: string) => {
    setState(selectOptimizationZone(state, zoneId, jobs));
  };

  const run = () => {
    if (!zone || !state.start || (isBulk && !bulkReady)) return;
    start.mutate(
      { zoneId: zone.id, input: jobInput() },
      { onSuccess: (j) => setState({ ...state, jobId: j.id, pick: null }) },
    );
  };

  const active = job && (job.status === "queued" || job.status === "running");
  const endInvalid = state.mode === "open" && state.useEnd && !state.end;

  return (
    <div className="space-y-4" data-testid="panel-optimize">
      <div className="space-y-1">
        <Label>Zon</Label>
        <Select value={state.zoneId ?? ""} onValueChange={selectZone} disabled={start.isPending}>
          <SelectTrigger data-testid="select-opt-zone"><SelectValue placeholder="Välj zon att optimera" /></SelectTrigger>
          <SelectContent>{zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name} ({(counts.get(z.id) ?? 0).toLocaleString("sv-SE")})</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {zones.length === 0 && <p className="text-sm text-muted-foreground">Skapa en zon först under fliken Zoner.</p>}
      {!zone && zones.length > 0 && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm" role="status">
          <p className="font-medium">Ingen optimering har startats här.</p>
          <ol className="list-inside list-decimal space-y-1 text-xs text-muted-foreground">
            <li>Välj en sparad zon ovan.</li>
            <li>Välj startpunkt på kartan eller bland zonens poster.</li>
            <li>Tryck på Optimera poster för att starta beräkningen.</li>
          </ol>
        </div>
      )}

      {zone && (
        <>
          {size > ZONE_TARGET * 1.1 && (
            <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs" role="note">
              {size.toLocaleString("sv-SE")} poster överstiger riktvärdet {ZONE_TARGET}. Alla poster tas med, men beräkningen tar längre tid och kan nekas av kapacitetskontrollen. Dela gärna zonen.
            </p>
          )}
          <fieldset className="space-y-3 rounded-lg border p-3" disabled={!canWrite || start.isPending || !!active}>
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Virtuellt fordon</legend>
            <Label htmlFor="bulk-scope">Beräkningsmotor och urval</Label>
            <select id="bulk-scope" className="w-full rounded border bg-background p-2 text-sm" value={bulkScope}
              onChange={e=>{setBulkScope(e.target.value as typeof bulkScope);setAcknowledged("");}} data-testid="select-bulk-scope">
              <option value="off">Vanlig zonoptimering (högst 750 poster)</option>
              <option value="zone">Stor vägoptimering — hela valda zonen</option>
              <option value="plan">Stor vägoptimering — hela underlaget, även utan zon</option>
            </select>
            {isBulk && <p className="text-xs text-muted-foreground">Separat utvecklingsberäkning: ett virtuellt fordon, extern kartstart, fritt sista stopp och ingen depotretur. Olösta rader bevaras utan vägordning. Inga order eller chaufförsuppdrag skapas.</p>}
            {!isBulk && <>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 text-xs">
              {(["loop", "open"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setState({ ...state, mode: m })} aria-pressed={state.mode === m}
                  className={`rounded px-2 py-1.5 font-medium ${state.mode === m ? "bg-card shadow" : "text-muted-foreground"}`} data-testid={`button-mode-${m}`}>
                  {m === "loop" ? "Sluten slinga" : "Öppen ordning"}
                </button>
              ))}
            </div>
            </>}
            <EndpointRow label="Start" value={describeEndpoint(state.start, byId)} picking={state.pick === "start"} onPick={() => setState({ ...state, pick: state.pick === "start" ? null : "start" })}
              zonePoints={isBulk?[]:zonePoints} onSelectPoint={(id) => setState({ ...state, start: { pointId: id } })} testId="start" />
            {isBulk && <>
              {state.start?.pointId && <p className="text-xs text-amber-600">Välj en extern startpunkt på kartan, inte en källpost.</p>}
              <details className="text-xs">
                <summary className="cursor-pointer">Uttryckliga avståndsundantag</summary>
                <p className="my-2">Endast efter manuell positionsgranskning. En rad per objekt: punkt-ID; högsta väganknytningsavstånd i meter (251–1000); skäl. Samplacerade objekt måste godkännas separat. Inga originalkoordinater ändras.</p>
                <textarea className="min-h-20 w-full rounded border bg-background p-2" aria-label="Avståndsundantag" value={exceptionText} onChange={e=>setExceptionText(e.target.value)} />
                <details><summary>Punkt-ID i urvalet</summary><div className="max-h-40 overflow-auto">{(bulkScope==="plan"?points:zonePoints).map(p=><p key={p.id}>{p.objectNumber} · {p.address} · {p.id}</p>)}</div></details>
              </details>
              <Button type="button" variant="outline" disabled={!state.start || !!state.start.pointId || preview.isPending}
                onClick={()=>{setAcknowledged("");preview.mutate({zoneId:zone.id,input:jobInput(),key:previewKey});}} data-testid="button-bulk-preview">
                {preview.isPending?"Kontrollerar positioner…":"Kontrollera kapacitet och positioner"}
              </Button>
              {preview.error && <ErrorLine error={preview.error} />}
              {checkedPreview && <div className="space-y-2 rounded border border-amber-500/50 p-2 text-xs" role="status">
                {checkedPreview.warnings.map((warning,i)=><p key={i}>{warning}</p>)}
                {checkedPreview.datasetIdentity && <p>Vägdata: {checkedPreview.datasetIdentity}</p>}
                {checkedPreview.ready && <label className="flex items-start gap-2">
                  <input type="checkbox" checked={acknowledged===previewKey} onChange={e=>setAcknowledged(e.target.checked?previewKey:"")} data-testid="checkbox-bulk-warnings" />
                  Jag har granskat kapacitet, positioner och eventuella uttryckliga undantag.
                </label>}
              </div>}
            </>}
            {!isBulk && state.mode === "open" && (
              <>
                <label className="flex items-center justify-between text-sm"><span>Fast slutpunkt</span><Switch checked={state.useEnd} onCheckedChange={(v) => setState({ ...state, useEnd: v })} data-testid="switch-use-end" /></label>
                {state.useEnd && <EndpointRow label="Slut" value={describeEndpoint(state.end, byId)} picking={state.pick === "end"} onPick={() => setState({ ...state, pick: state.pick === "end" ? null : "end" })}
                  zonePoints={zonePoints} onSelectPoint={(id) => setState({ ...state, end: { pointId: id } })} testId="end" />}
              </>
            )}
            <div className="flex items-center gap-2 text-sm"><Label htmlFor="svc" className="flex-1">Servicetid per post (min)</Label>
              <Input id="svc" type="number" min={0} max={240} className="w-20" value={state.serviceMinutes} onChange={(e) => setState({ ...state, serviceMinutes: Math.max(0, Number(e.target.value) || 0) })} data-testid="input-service-minutes" /></div>
            <p className="text-[11px] text-muted-foreground">Ingen förare, skift, kapacitet eller tidsfönster. Tider är uppskattningar, inte en genomförbar dagsrutt.</p>
            {canWrite && (
              <Button className="w-full" onClick={run} disabled={!state.start || (!isBulk && endInvalid) || (isBulk && !bulkReady) || start.isPending || !!active} data-testid="button-start-job">
                {start.isPending || active ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                {start.isPending ? "Startar optimering…" : active ? "Optimering pågår…" : `Optimera ${(bulkScope==="plan"?points.length:size).toLocaleString("sv-SE")} poster`}
              </Button>
            )}
            {!state.start && <p className="text-xs text-amber-600 dark:text-amber-400">Välj en startpunkt för att kunna starta optimeringen.</p>}
            {endInvalid && <p className="text-xs text-amber-600 dark:text-amber-400">Välj slutpunkt eller stäng av Fast slutpunkt.</p>}
          </fieldset>
          {start.isPending && <p className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />Skickar jobbet till servern. Beräkningen har ännu inte bekräftats.</p>}
          {start.error && <ErrorLine error={start.error} onRetry={run} />}

          {state.jobId && jobQuery.isLoading && <p className="flex items-center gap-2 rounded-lg border p-3 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />Hämtar optimeringens status…</p>}
          {jobQuery.error && <ErrorLine error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />}
          {job && (
            <div className="space-y-2 rounded-lg border p-3" data-testid="status-job" aria-live="polite">
              <JobStatus job={job} />
              {job.status === "failed" && <p className="text-[11px] text-muted-foreground">Ingen fågelvägsberäkning eller delresultat används. Åtgärda felet (t.ex. vägdatatjänst saknas eller täcker inte alla poster) och kör om.</p>}
              {job.status === "stale" && <p className="text-xs text-amber-600 dark:text-amber-400">Zonens innehåll eller start/slut ändrades medan jobbet pågick. Resultatet publiceras inte; kör om.</p>}
              <div className="flex gap-2">
                {active && canWrite && <Button size="sm" variant="outline" onClick={() => cancel.mutate(job.id)} disabled={cancel.isPending} data-testid="button-cancel-job"><Ban className="mr-1 h-3.5 w-3.5" />Avbryt</Button>}
                {!active && job.status !== "completed" && canWrite && <Button size="sm" variant="outline" onClick={run} disabled={!state.start} data-testid="button-rerun-job"><RotateCcw className="mr-1 h-3.5 w-3.5" />Kör om</Button>}
              </div>
              {cancel.error && <ErrorLine error={cancel.error} />}
            </div>
          )}
          {zoneJobs.length > 1 && (
            <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Tidigare jobb ({zoneJobs.length})</summary>
              <ul className="mt-1 space-y-1">{zoneJobs.map((j) => (
                <li key={j.id}><button className={`w-full rounded px-2 py-1 text-left hover:bg-muted ${j.id === state.jobId ? "bg-muted" : ""}`} onClick={() => setState({ ...state, jobId: j.id, from: 1, to: 1 })} data-testid={`button-open-job-${j.id}`}>
                  {STATUS[j.status]} · {j.createdAt ? new Date(j.createdAt).toLocaleString("sv-SE") : j.id.slice(0, 8)}{j.id !== zoneJobs[0].id || j.revision !== zone.revision ? " · inaktuell" : ""}{j.mode ? ` · ${j.mode === "loop" ? "sluten" : "öppen"}` : ""}
                </button></li>
              ))}</ul>
            </details>
          )}
          {job?.status === "completed" && job.result && (
            <ResultPanel planId={planId} canWrite={canWrite} job={job} zone={zone} result={job.result} byId={byId}
              from={state.from} to={state.to} superseded={!!zoneJobs[0] && zoneJobs[0].id !== job.id} setRange={(from, to) => setState({ ...state, from, to })} />
          )}
        </>
      )}
    </div>
  );
}

function EndpointRow({ label, value, picking, onPick, zonePoints, onSelectPoint, testId }: {
  label: string; value: string; picking: boolean; onPick: () => void; zonePoints: readonly DistrictPoint[]; onSelectPoint: (id: string) => void; testId: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm"><span>{label}</span>
        <Button type="button" size="sm" variant={picking ? "default" : "ghost"} className="h-7" onClick={onPick} data-testid={`button-pick-${testId}`}><Crosshair className="mr-1 h-3.5 w-3.5" />{picking ? "Klicka på kartan" : "Välj på karta"}</Button>
      </div>
      <p className="truncate text-xs text-muted-foreground" data-testid={`text-${testId}-endpoint`}>{value}</p>
      <Select onValueChange={onSelectPoint}>
        <SelectTrigger className="h-8 text-xs" data-testid={`select-${testId}-point`}><SelectValue placeholder="…eller välj bland zonens poster" /></SelectTrigger>
        <SelectContent className="max-h-72">{zonePoints.slice(0, 1000).map((p) => <SelectItem key={p.id} value={p.id}>{p.objectNumber} · {p.address}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}
