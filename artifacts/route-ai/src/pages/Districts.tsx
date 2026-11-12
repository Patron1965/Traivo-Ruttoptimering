import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { intakeApi, intakeKey } from "@/lib/district-intake";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Eye, Hexagon, Loader2, Lock, MapPinned, Plus } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth-context";
import { useDistrictCapability } from "@/lib/use-district-capability";
import type { DistrictPoint, DistrictZone, LatLng } from "@/lib/district-api";
import { resolveDraftMembers, resolveInterval, pointInPolygon } from "@/lib/district-geo";
import { useCreateDistrictPlan, useDistrictJob, useDistrictPlan, useDistrictPlans, useDistrictPoints } from "@/hooks/use-districts";
import { DistrictMap, MapLegend, type MapMarker } from "@/components/district/DistrictMap";
import { JobStatus } from "@/components/district/JobStatus";
import { ErrorLine } from "@/components/district/DistrictImport";
import { DistrictIntakeImport as DistrictImport } from "@/components/district/DistrictIntakeImport";
import { ZonePanel, type ZoneDraft } from "@/components/district/ZonePanel";
import { OptimizePanel, initialOptimizeState, type OptimizeState } from "@/components/district/OptimizePanel";
import { selectOptimizationZone } from "@/lib/district-zone-selection";
import { ExportHistory } from "@/components/district/ExportHistory";

export default function Districts({ planId }: { planId?: string }) {
  const capability = useDistrictCapability();
  if (!capability.allowed) return <AppLayout><div className="p-6" role="status">
    {capability.loading ? "Kontrollerar tillgång till distriktsmodulen…" : capability.error
      ? "Kunde inte kontrollera tillgång till distriktsmodulen. Försök igen senare."
      : "Distriktsmodulen är inte tillgänglig för organisationen. Endast Traivo Superuser kan aktivera den."}
  </div></AppLayout>;
  return <DistrictsContent key={planId ?? "list"} planId={planId} />;
}

function DistrictsContent({ planId }: { planId?: string }) {
  const { user } = useAuth();
  if (user?.role === "driver") {
    return (
      <AppLayout>
        <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 p-6 text-center" data-testid="status-district-denied">
          <Lock className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Ingen åtkomst till distriktsplanering</h1>
          <p className="max-w-sm text-sm text-muted-foreground">Distriktsplanering är till för planerare. Kontakta din administratör om du behöver åtkomst.</p>
        </div>
      </AppLayout>
    );
  }
  const canWrite = user?.role === "admin" || user?.role === "dispatcher";
  return <AppLayout>{planId ? <PlanWorkspace planId={planId} canWrite={canWrite} /> : <PlanList canWrite={canWrite} />}</AppLayout>;
}

function PlanList({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading, error, refetch } = useDistrictPlans();
  const create = useCreateDistrictPlan();
  const [name, setName] = useState("");
  const [, navigate] = useLocation();
  const plans = [...(data?.plans ?? [])].sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8" data-testid="page-districts">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Distriktsplanering</p>
          <h1 className="text-2xl font-bold md:text-3xl">Sotningsdistrikt i kartzoner</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">Dela ett geokodat underlag i sammanhängande zoner, optimera cirka 500 stopp åt gången och ta ut besöksordningen till huvudsystemet. Skapar inga ordrar, rutter eller förarappsuppdrag.</p>
        </div>
        {!canWrite && <span className="inline-flex items-center gap-1.5 self-start rounded-full border px-3 py-1 text-xs text-muted-foreground"><Eye className="h-3.5 w-3.5" />Endast läsning</span>}
      </header>

      {canWrite && (
        <form className="flex flex-col gap-2 rounded-xl border bg-card p-4 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(name.trim(), { onSuccess: (p) => navigate(`/districts/${p.id}`) }); }}>
          <Input placeholder="Namn, t.ex. Västra Hisingen 2025" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="input-plan-name" />
          <Button type="submit" disabled={!name.trim() || create.isPending} data-testid="button-create-plan">{create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}Ny distriktsplan</Button>
        </form>
      )}
      {create.error && <ErrorLine error={create.error} />}

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />)}</div>
      ) : error ? (
        <ErrorLine error={error} onRetry={() => void refetch()} />
      ) : plans.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <Hexagon className="h-10 w-10 text-primary/60" />
          <p className="font-medium">Inga distriktsplaner ännu</p>
          <p className="max-w-sm text-sm text-muted-foreground">{canWrite ? "Skapa en plan och läs in din geokodade objektfil för att börja zonindela." : "När en planerare skapat en plan visas den här."}</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {plans.map((p) => (
            <li key={p.id}>
              <Link href={`/districts/${p.id}`} className="group flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/60" data-testid={`link-plan-${p.id}`}>
                <MapPinned className="mt-0.5 h-5 w-5 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.pointCount != null ? `${p.pointCount.toLocaleString("sv-SE")} poster` : "Ej inläst"}{p.zoneCount != null && ` · ${p.zoneCount} zoner`}
                    {(p.updatedAt ?? p.createdAt) && ` · ${new Date(p.updatedAt ?? p.createdAt!).toLocaleDateString("sv-SE")}`}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EMPTY_POINTS: DistrictPoint[] = [];

function PlanWorkspace({ planId, canWrite }: { planId: string; canWrite: boolean }) {
  const detail = useDistrictPlan(planId);
  const intakeQuery = useQuery({ queryKey: intakeKey(planId), queryFn: () => intakeApi.get(planId), enabled: canWrite, refetchInterval: 30000 });
  const pointsQuery = useDistrictPoints(planId);
  const points = pointsQuery.data?.points ?? EMPTY_POINTS;
  const zones = useMemo(() => (detail.data?.zones ?? []).filter((z) => !z.deletedAt), [detail.data?.zones]);
  const [tab, setTab] = useState<string>("zones");
  const [draft, setDraft] = useState<ZoneDraft | null>(null);
  const [opt, setOpt] = useState<OptimizeState>(initialOptimizeState);
  const focusZone = opt.zoneId;
  const jobQuery = useDistrictJob(planId, tab === "optimize" ? opt.jobId : null);

  const byId = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const zoneColors = useMemo(() => new Map(zones.map((z) => [z.id, z.color])), [zones]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of points) if (p.zoneId) m.set(p.zoneId, (m.get(p.zoneId) ?? 0) + 1);
    return m;
  }, [points]);
  const members = useMemo(() => (draft ? resolveDraftMembers(points, draft.polygon, draft.manualAdd, draft.manualRemove) : new Set<string>()), [draft, points]);

  const startEdit = (zone: DistrictZone) => {
    const polygon = zone.polygon ?? [];
    const current = new Set(points.filter((p) => p.zoneId === zone.id).map((p) => p.id));
    const manualAdd = new Set<string>(), manualRemove = new Set<string>();
    for (const p of points) {
      const inside = polygon.length >= 3 && pointInPolygon(p.latitude, p.longitude, polygon);
      if (current.has(p.id) && !inside) manualAdd.add(p.id);
      if (!current.has(p.id) && inside) manualRemove.add(p.id);
    }
    setDraft({ zoneId: zone.id, expectedRevision: zone.revision, name: zone.name, color: zone.color, polygon: [...polygon], manualAdd, manualRemove, drawing: false });
  };

  const togglePoint = (p: DistrictPoint) => {
    if (!draft || !canWrite) return;
    const include = !members.has(p.id);
    const manualAdd = new Set(draft.manualAdd), manualRemove = new Set(draft.manualRemove);
    if (include) { manualRemove.delete(p.id); manualAdd.add(p.id); } else { manualAdd.delete(p.id); manualRemove.add(p.id); }
    setDraft({ ...draft, manualAdd, manualRemove });
  };

  // Map configuration per tab.
  const result = tab === "optimize" && jobQuery.data?.job.status === "completed" ? jobQuery.data.job.result : undefined;
  const sequence = useMemo(() => (result ? new Map(result.orderedPointIds.map((id, i) => [id, i + 1])) : undefined), [result]);
  const highlight = useMemo(() => {
    if (!result) return undefined;
    const r = resolveInterval(result.orderedPointIds.length, opt.from, opt.to, jobQuery.data?.job.mode === "loop");
    return r.ok ? new Set(r.indexes.map((i) => result.orderedPointIds[i])) : undefined;
  }, [result, opt.from, opt.to, jobQuery.data?.job.mode]);
  const optFocus = useMemo(() => (tab === "optimize" && opt.zoneId ? new Set(points.filter((p) => p.zoneId === opt.zoneId).map((p) => p.id)) : null), [tab, opt.zoneId, points]);
  const zoneFocus = useMemo(() => (tab === "zones" && focusZone && !draft ? new Set(points.filter((p) => p.zoneId === focusZone).map((p) => p.id)) : null), [tab, focusZone, draft, points]);
  const markers = useMemo<MapMarker[]>(() => {
    if (tab !== "optimize") return [];
    const out: MapMarker[] = [];
    const add = (ep: OptimizeState["start"], label: string, tone: MapMarker["tone"]) => {
      if (!ep) return;
      const p = ep.pointId ? byId.get(ep.pointId) : undefined;
      const lat = p?.latitude ?? ep.latitude, lng = p?.longitude ?? ep.longitude;
      if (lat != null && lng != null) out.push({ lat, lng, label, tone });
    };
    add(opt.start, "S", "start");
    if (opt.mode === "open" && opt.useEnd) add(opt.end, "M", "end");
    return out;
  }, [tab, opt.start, opt.end, opt.mode, opt.useEnd, byId]);

  const onMapClick = (v: LatLng) => {
    if (tab === "zones" && draft?.drawing && canWrite) setDraft({ ...draft, polygon: [...draft.polygon, v] });
    if (tab === "optimize" && opt.pick) setOpt({ ...opt, [opt.pick]: { latitude: v.lat, longitude: v.lng }, pick: null });
  };
  const onPointClick = (p: DistrictPoint) => {
    if (tab === "zones") togglePoint(p);
    else if (tab === "optimize" && opt.pick) setOpt({ ...opt, [opt.pick]: { pointId: p.id }, pick: null });
  };

  if (detail.isLoading) return <div className="grid h-[calc(100dvh-4rem)] grid-cols-1 md:grid-cols-[380px_1fr]"><div className="space-y-3 p-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />)}</div><div className="hidden animate-pulse bg-muted md:block" /></div>;
  if (detail.error || !detail.data) return <div className="p-6"><ErrorLine error={detail.error ?? new Error("Planen hittades inte.")} onRetry={() => void detail.refetch()} /></div>;

  const hasDataset = (pointsQuery.data?.total ?? 0) > 0;
  const activeTab = !hasDataset && canWrite ? "import" : tab;

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col md:grid md:grid-cols-[400px_1fr]" data-testid="page-district-plan">
      <aside className="flex min-h-0 flex-col border-b md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Link href="/districts" className="rounded p-1 hover:bg-muted" aria-label="Alla distriktsplaner" data-testid="link-back-plans"><ArrowLeft className="h-4 w-4" /></Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold" data-testid="text-plan-name">{detail.data.plan.name}</h1>
            <p className="text-[11px] text-muted-foreground">{points.length.toLocaleString("sv-SE")} poster · {zones.length} zoner{!canWrite && " · endast läsning"}</p>
          </div>
        </div>
        {canWrite && intakeQuery.data?.intake && <div className="border-b px-4 py-2 text-xs" data-testid="district-source-summary">
          {intakeQuery.data.intake.total} källrader: {intakeQuery.data.intake.ready} på kartan, {intakeQuery.data.intake.unresolved} att granska, {intakeQuery.data.intake.rejected} avvisade.
          {(intakeQuery.data.intake.unresolved > 0 || intakeQuery.data.intake.rejected > 0) && <Button variant="link" size="sm" onClick={() => setTab("import")}>Granska kvarvarande rader</Button>}
        </div>}
        <Tabs value={activeTab} onValueChange={(v) => { setTab(v); if (v !== "zones") setDraft(null); }} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-4 mt-3 grid grid-cols-4">
            <TabsTrigger value="zones" disabled={!hasDataset} data-testid="tab-zones">Zoner</TabsTrigger>
            <TabsTrigger value="optimize" disabled={!hasDataset} data-testid="tab-optimize">Optimera</TabsTrigger>
            <TabsTrigger value="exports" data-testid="tab-exports">Uttag</TabsTrigger>
            <TabsTrigger value="import" disabled={!canWrite} data-testid="tab-import">Import</TabsTrigger>
          </TabsList>
          <div className="traivo-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            {pointsQuery.error && <ErrorLine error={pointsQuery.error} onRetry={() => void pointsQuery.refetch()} />}
            <TabsContent value="zones" className="mt-0">
              {pointsQuery.isLoading ? <div className="h-40 animate-pulse rounded-md bg-muted" /> : (
                <ZonePanel planId={planId} canWrite={canWrite} points={points} zones={zones} counts={counts} draft={draft} members={members}
                  setDraft={setDraft} onEdit={startEdit} selectedZoneId={focusZone}
                  onFocusZone={(id) => {
                    if (id) setOpt((current) => selectOptimizationZone(current, id, detail.data.jobs));
                  }} />
              )}
            </TabsContent>
            <TabsContent value="optimize" className="mt-0">
              <OptimizePanel planId={planId} canWrite={canWrite} zones={zones} jobs={detail.data.jobs} counts={counts} byId={byId} points={points} state={opt} setState={setOpt} />
            </TabsContent>
            <TabsContent value="exports" className="mt-0"><ExportHistory planId={planId} canDownload={canWrite} zones={detail.data.zones} jobs={detail.data.jobs} /></TabsContent>
            <TabsContent value="import" className="mt-0">
              {canWrite && <DistrictImport planId={planId} hasDataset={detail.data.imports.length > 0} onDone={() => setTab("zones")} />}
            </TabsContent>
          </div>
        </Tabs>
      </aside>
      {/* Keep Leaflet panes and controls below body-portaled dialogs. */}
      <section className="relative isolate min-h-[50dvh] flex-1" data-testid="district-map-region">
        {pointsQuery.isLoading && <div className="absolute inset-x-0 top-0 z-[500] h-1 animate-pulse bg-primary" role="status" aria-label="Läser in poster" />}
        <DistrictMap
          points={points}
          zoneColors={zoneColors}
          selected={draft ? members : undefined}
          focus={tab === "optimize" ? optFocus : zoneFocus}
          draftColor={draft?.color}
          polygon={draft?.polygon}
          editablePolygon={!!draft && canWrite}
          drawing={!!draft?.drawing && tab === "zones" && canWrite}
          onVertexMove={(i, v) => draft && setDraft({ ...draft, polygon: draft.polygon.map((x, j) => (j === i ? v : x)) })}
          onVertexRemove={(i) => draft && setDraft({ ...draft, polygon: draft.polygon.filter((_, j) => j !== i) })}
          onMapClick={onMapClick}
          onPointClick={onPointClick}
          route={result?.geometry}
          sequence={sequence}
          highlightSequence={highlight}
          markers={markers}
          fitKey={`${planId}:${points.length}:${tab === "optimize" ? opt.zoneId : focusZone}`}
          cursor={(draft?.drawing && tab === "zones") || opt.pick ? "crosshair" : "default"}
        />
        {draft?.drawing && tab === "zones" && canWrite && (
          <div role="status" data-testid="district-drawing-status" className="pointer-events-none absolute left-14 right-3 top-3 z-[500] rounded-lg border border-primary bg-card/95 px-4 py-3 text-sm text-card-foreground shadow-lg">
            <strong>Ritläge aktivt</strong> · Klicka på kartan för att lägga till hörn.
            <span className="block text-xs text-muted-foreground">{draft.polygon.length} hörn · Minst 3 behövs. Välj Avsluta ritning när du är klar.</span>
          </div>
        )}
        {tab === "optimize" && !opt.zoneId && (
          <div className="pointer-events-none absolute left-14 right-3 top-3 z-[500] rounded-lg border bg-card/95 px-4 py-3 text-sm text-card-foreground shadow-lg" role="status">
            <strong>Välj en zon i panelen för att börja.</strong>
            <span className="block text-xs text-muted-foreground">Fliken Optimera startar inte en beräkning automatiskt.</span>
          </div>
        )}
        {tab === "optimize" && jobQuery.data?.job && (
          <div className="pointer-events-none absolute left-14 right-3 top-3 z-[500] max-w-lg rounded-lg border bg-card/95 px-4 py-3 text-card-foreground shadow-lg">
            <JobStatus job={jobQuery.data.job} />
            {jobQuery.error && <p className="mt-2 text-xs text-destructive">Status kunde inte uppdateras. Senast kända status visas; se panelen för att försöka igen.</p>}
          </div>
        )}
        <MapLegend zoneCount={zones.length} />
      </section>
    </div>
  );
}
