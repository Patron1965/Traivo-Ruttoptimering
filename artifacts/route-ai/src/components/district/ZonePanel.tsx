import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, MousePointerClick, Pencil, Plus, Search, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import type { DistrictPoint, DistrictZone, LatLng } from "@/lib/district-api";
import { ZONE_COLORS, ZONE_TARGET } from "@/lib/district-geo";
import { useDeleteDistrictZone, useSaveDistrictZone } from "@/hooks/use-districts";
import { PagedList } from "./Pager";
import { ErrorLine } from "./DistrictImport";

export interface ZoneDraft {
  zoneId: string | null;
  expectedRevision: number;
  name: string;
  color: string;
  polygon: LatLng[];
  manualAdd: Set<string>;
  manualRemove: Set<string>;
  drawing: boolean;
}

export function newDraft(index: number): ZoneDraft {
  return { zoneId: null, expectedRevision: 0, name: `Zon ${index + 1}`, color: ZONE_COLORS[index % ZONE_COLORS.length], polygon: [], manualAdd: new Set(), manualRemove: new Set(), drawing: false };
}

interface Props {
  planId: string;
  canWrite: boolean;
  points: readonly DistrictPoint[];
  zones: readonly DistrictZone[];
  counts: ReadonlyMap<string, number>;
  draft: ZoneDraft | null;
  members: ReadonlySet<string>;
  setDraft: (next: ZoneDraft | null) => void;
  onEdit: (zone: DistrictZone) => void;
  onFocusZone: (zoneId: string | null) => void;
  selectedZoneId: string | null;
}

export function ZonePanel(props: Props) {
  const { zones, counts, draft, canWrite, points } = props;
  const unzoned = points.length - [...counts.values()].reduce((a, b) => a + b, 0);
  const [toDelete, setToDelete] = useState<DistrictZone | null>(null);
  const del = useDeleteDistrictZone(props.planId);

  if (draft) return <ZoneEditor {...props} draft={draft} />;

  return (
    <div className="space-y-4" data-testid="panel-zones">
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <Kpi label="Poster" value={points.length} /><Kpi label="Zoner" value={zones.length} /><Kpi label="Ej zonindelade" value={unzoned} />
      </div>
      {canWrite && (
        <Button className="w-full" onClick={() => props.setDraft(newDraft(zones.length))} data-testid="button-new-zone"><Plus className="mr-2 h-4 w-4" />Ny zon med polygon</Button>
      )}
      {zones.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          Inga zoner ännu. Rita en polygon runt ett sammanhängande område på kartan för att skapa den första.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {zones.map((z) => {
            const n = counts.get(z.id) ?? 0;
            return (
              <li key={z.id} className={`group flex items-center gap-2 rounded-md border px-3 py-2 ${props.selectedZoneId === z.id ? "border-primary bg-primary/10" : "bg-card"}`} data-testid={`row-zone-${z.id}`}>
                <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: z.color }} />
                <button type="button" className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-pressed={props.selectedZoneId === z.id} onClick={() => props.onFocusZone(z.id)} data-testid={`button-focus-zone-${z.id}`}>
                  <div className="truncate text-sm font-medium">{z.name}</div>
                  <div className={`text-xs tabular-nums ${n > ZONE_TARGET * 1.1 ? "text-amber-500" : "text-muted-foreground"}`}>{n.toLocaleString("sv-SE")} poster · rev {z.revision}</div>
                </button>
                {canWrite && <>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => props.onEdit(z)} aria-label={`Redigera ${z.name}`} data-testid={`button-edit-zone-${z.id}`}><Pencil className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setToDelete(z)} aria-label={`Ta bort ${z.name}`} data-testid={`button-delete-zone-${z.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                </>}
              </li>
            );
          })}
        </ul>
      )}
      {del.error && <ErrorLine error={del.error} />}
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ta bort {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {(counts.get(toDelete?.id ?? "") ?? 0).toLocaleString("sv-SE")} poster blir ej zonindelade. Grundunderlaget, tidigare optimeringar och uttagshistorik bevaras.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" data-testid="button-confirm-delete-zone"
              onClick={() => toDelete && del.mutate({ zoneId: toDelete.id, expectedRevision: toDelete.revision }, { onSettled: () => setToDelete(null) })}>
              Ta bort zon
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ZoneEditor({ planId, points, zones, draft, members, setDraft }: Props & { draft: ZoneDraft }) {
  const save = useSaveDistrictZone(planId);
  const [query, setQuery] = useState("");
  const [overlapOpen, setOverlapOpen] = useState(false);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const zoneName = useMemo(() => new Map(zones.map((z) => [z.id, z.name])), [zones]);
  const serverZone = draft.zoneId ? zones.find((z) => z.id === draft.zoneId) : undefined;
  const revisionMoved = !!serverZone && serverZone.revision !== draft.expectedRevision;

  const memberList = useMemo(() => points.filter((p) => members.has(p.id)), [points, members]);
  const overlaps = useMemo(() => memberList.filter((p) => p.zoneId && p.zoneId !== draft.zoneId), [memberList, draft.zoneId]);
  const overlapByZone = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of overlaps) m.set(p.zoneId!, (m.get(p.zoneId!) ?? 0) + 1);
    return m;
  }, [overlaps]);
  const search = query.trim().toLocaleLowerCase("sv-SE");
  const searchHits = useMemo(() => (search.length < 2 ? [] : points.filter((p) => p.objectNumber.toLocaleLowerCase("sv-SE").includes(search) || p.address.toLocaleLowerCase("sv-SE").includes(search))), [points, search]);

  const toggle = (id: string, include: boolean) => {
    const manualAdd = new Set(draft.manualAdd), manualRemove = new Set(draft.manualRemove);
    if (include) { manualRemove.delete(id); manualAdd.add(id); } else { manualAdd.delete(id); manualRemove.add(id); }
    setDraft({ ...draft, manualAdd, manualRemove });
  };

  const submit = (transfers: string[] | undefined, excluded: string[] = []) => {
    const exclude = new Set(excluded);
    const pointIds = memberList.filter((p) => !exclude.has(p.id)).map((p) => p.id);
    save.mutate(
      { zoneId: draft.zoneId, expectedRevision: draft.expectedRevision, input: { name: draft.name.trim(), color: draft.color, pointIds, transfers, polygon: draft.polygon.length >= 3 ? draft.polygon : undefined } },
      { onSuccess: () => { setOverlapOpen(false); setDraft(null); } },
    );
  };
  const onSave = () => (overlaps.length > 0 ? (setConfirmTransfer(false), setOverlapOpen(true)) : submit(undefined));
  const excludeOverlaps = () => {
    const manualRemove = new Set(draft.manualRemove), manualAdd = new Set(draft.manualAdd);
    for (const p of overlaps) { manualRemove.add(p.id); manualAdd.delete(p.id); }
    setDraft({ ...draft, manualAdd, manualRemove });
    submit(undefined, overlaps.map((p) => p.id));
  };

  const count = members.size;
  return (
    <div className="space-y-4" data-testid="panel-zone-editor">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{draft.zoneId ? "Redigera zon" : "Ny zon"}</h3>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDraft(null)} aria-label="Stäng utan att spara" data-testid="button-cancel-zone"><X className="h-4 w-4" /></Button>
      </div>
      {revisionMoved && (
        <p role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">Zonen har sparats av någon annan (rev {serverZone!.revision}). Ditt utkast finns kvar men sparning kommer att nekas; stäng och öppna zonen igen för att utgå från senaste versionen.</p>
      )}
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div className="space-y-1"><Label htmlFor="zone-name">Namn</Label><Input id="zone-name" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="input-zone-name" /></div>
        <div className="space-y-1"><Label>Färg</Label>
          <div className="flex max-w-[132px] flex-wrap gap-1">{ZONE_COLORS.map((c) => (
            <button key={c} type="button" onClick={() => setDraft({ ...draft, color: c })} aria-label={`Färg ${c}`} aria-pressed={draft.color === c}
              className={`h-5 w-5 rounded-sm ${draft.color === c ? "ring-2 ring-foreground ring-offset-1 ring-offset-background" : ""}`} style={{ background: c }} data-testid={`button-color-${c.slice(1)}`} />
          ))}</div>
        </div>
      </div>

      <div className={`rounded-lg border p-3 ${count > ZONE_TARGET * 1.1 ? "border-amber-500/60 bg-amber-500/5" : "bg-card"}`} data-testid="status-zone-count" aria-live="polite">
        <div className="flex items-baseline justify-between"><span className="text-3xl font-bold tabular-nums">{count.toLocaleString("sv-SE")}</span><span className="text-xs text-muted-foreground">riktvärde cirka {ZONE_TARGET}</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted"><div className="h-full" style={{ width: `${Math.min(100, (count / ZONE_TARGET) * 100)}%`, background: draft.color }} /></div>
        <div className="mt-2 text-xs text-muted-foreground">{draft.manualAdd.size} tillagda och {draft.manualRemove.size} borttagna manuellt · {overlaps.length} tillhör andra zoner</div>
        {count > ZONE_TARGET * 1.1 && <p className="mt-2 flex gap-1.5 text-xs text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />Urvalet är större än riktvärdet. Inget kapas: överväg att dela området i {Math.ceil(count / ZONE_TARGET)} zoner för jämnare slingor.</p>}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={draft.drawing ? "default" : "outline"} aria-pressed={draft.drawing} onClick={() => setDraft({ ...draft, drawing: !draft.drawing })} data-testid="button-toggle-draw">
            <MousePointerClick className="mr-1 h-3.5 w-3.5" />{draft.drawing ? "Avsluta ritning" : "Rita / lägg till hörn"}
          </Button>
          <Button size="sm" variant="outline" disabled={draft.polygon.length === 0} onClick={() => setDraft({ ...draft, polygon: draft.polygon.slice(0, -1) })} data-testid="button-undo-vertex"><Undo2 className="mr-1 h-3.5 w-3.5" />Ångra hörn</Button>
          <Button size="sm" variant="ghost" disabled={draft.polygon.length === 0} onClick={() => setDraft({ ...draft, polygon: [] })} data-testid="button-clear-polygon">Rensa polygon</Button>
        </div>
        <p className="text-[11px] text-muted-foreground" aria-live="polite">{draft.drawing ? `Ritläge aktivt · ${draft.polygon.length} hörn. Klicka på kartan för varje hörn. Minst tre hörn bildar en polygon. Avsluta ritningen när du är klar.` : "Välj Rita / lägg till hörn för att rita polygonen. Dra i hörnen för att justera, dubbelklicka på ett hörn för att ta bort det. När ritläget är av kan du klicka på en enskild post (inzoomat) för att växla den in/ut ur zonen."} Polygonen styr urvalet, inte körvägen.</p>
      </div>

      <div className="space-y-2">
        <div className="relative"><Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input className="pl-7" placeholder="Sök objektnummer eller adress" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="input-search-points" /></div>
        {search.length >= 2 && (
          <PagedList testId="list-search-points" pageSize={25} items={searchHits}
            empty={<p className="text-xs text-muted-foreground">Inga träffar.</p>}
            render={(p) => <PointRow key={p.id} point={p} included={members.has(p.id)} otherZone={p.zoneId && p.zoneId !== draft.zoneId ? zoneName.get(p.zoneId) : undefined} onToggle={toggle} />} />
        )}
        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium">Poster i utkastet ({count.toLocaleString("sv-SE")})</summary>
          <div className="mt-2"><PagedList testId="list-draft-members" pageSize={50} items={memberList}
            render={(p) => <PointRow key={p.id} point={p} included otherZone={p.zoneId && p.zoneId !== draft.zoneId ? zoneName.get(p.zoneId) : undefined} onToggle={toggle} />} /></div>
        </details>
      </div>

      {save.error && <ErrorLine error={save.error} />}
      <Button className="w-full" onClick={onSave} disabled={save.isPending || !draft.name.trim() || count === 0} data-testid="button-save-zone">
        {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Spara zon ({count.toLocaleString("sv-SE")} poster)
      </Button>

      <AlertDialog open={overlapOpen} onOpenChange={setOverlapOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{overlaps.length.toLocaleString("sv-SE")} poster tillhör redan andra zoner</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>Varje post kan bara tillhöra en zon. Välj om de ska flyttas hit eller uteslutas.</p>
                <ul className="list-inside list-disc">{[...overlapByZone].map(([id, n]) => <li key={id}>{n.toLocaleString("sv-SE")} från {zoneName.get(id) ?? "okänd zon"}</li>)}</ul>
                <label className="flex items-start gap-2 pt-2"><Checkbox checked={confirmTransfer} onCheckedChange={(v) => setConfirmTransfer(v === true)} data-testid="checkbox-confirm-transfer" /><span>Flytta dessa poster till {draft.name || "zonen"}. Tidigare optimeringar för berörda zoner blir inaktuella.</span></label>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <Button variant="outline" onClick={excludeOverlaps} disabled={save.isPending || overlaps.length === count} data-testid="button-exclude-overlaps">Uteslut överlapp</Button>
            <Button onClick={() => submit(overlaps.map((p) => p.id))} disabled={!confirmTransfer || save.isPending} data-testid="button-transfer-overlaps">Flytta och spara</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PointRow({ point, included, otherZone, onToggle }: { point: DistrictPoint; included: boolean; otherZone?: string; onToggle: (id: string, include: boolean) => void }) {
  return (
    <li className="flex items-center gap-2 py-1.5 text-xs" data-testid={`row-point-${point.id}`}>
      <Checkbox checked={included} onCheckedChange={(v) => onToggle(point.id, v === true)} aria-label={`${included ? "Ta bort" : "Lägg till"} ${point.objectNumber}`} data-testid={`checkbox-point-${point.id}`} />
      <span className="w-20 shrink-0 truncate font-mono">{point.objectNumber}</span>
      <span className="min-w-0 flex-1 truncate">{point.address}</span>
      {otherZone && <span className="shrink-0 rounded bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">{otherZone}</span>}
      {point.exported && <span className="shrink-0 rounded bg-muted px-1.5 text-[10px]">exp.</span>}
    </li>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md border bg-card px-2 py-2"><div className="text-lg font-semibold tabular-nums">{value.toLocaleString("sv-SE")}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div></div>;
}
