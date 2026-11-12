import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Route, Stop, DispatchStopMoveInput, DispatchStopMovePreviewResponse } from "@workspace/api-client-react";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ImportWorkflow } from "@/pages/Import";
import { MoveConsequences } from "./MoveConsequences";
import { invalidateRouteQueries } from "@/lib/route-query-cache";
import { newProjectBlockReason } from "@/lib/new-project-from-stops";

export function NewProjectFromStops({ stops, routes, onDone }: {
  stops: Stop[]; routes: Route[]; onDone: () => void;
}) {
  const vehicles = useVehicles();
  const drivers = useDrivers();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date()));
  const [vehicleId, setVehicleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<DispatchStopMovePreviewResponse | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const sources = [...new Set(stops.flatMap(stop => stop.routeId ? [stop.routeId] : []))];
  const blockReason = newProjectBlockReason(stops, routes);
  const eligible = blockReason === null;
  const resources = (vehicles.data ?? []).filter(vehicle => vehicle.isActive
    && (drivers.data ?? []).filter(driver => driver.isActive && driver.vehicleId === vehicle.id).length === 1);
  const request: DispatchStopMoveInput = {
    stopIds: stops.map(stop => stop.id), routeId: null, targetIndex: 0,
    routeRevisions: sources.flatMap(id => {
      const route = routes.find(item => item.id === id);
      return route ? [{ routeId: id, planRevision: route.planRevision }] : [];
    }),
    newProject: { name: name.trim(), date, vehicleId },
  };
  const requestKey = JSON.stringify(request);
  useEffect(() => { setPreview(null); setError(""); }, [requestKey]);
  const valid = eligible && Boolean(name.trim() && date && resources.some(resource => resource.id === vehicleId));
  async function submit(confirm: boolean) {
    if (!valid || busy || (confirm && !preview?.canMove)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/stops/dispatch-move${confirm ? "" : "/preview"}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, ...(confirm ? { expectedPreviewDigest: preview!.previewDigest } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code === "ROAD_DATA_UNAVAILABLE"
        ? "Vägdata kunde inte hämtas för kvarvarande rutter. Inget projekt har skapats."
        : response.status === 409 ? "Planen, stoppen eller resursen har ändrats eller är spärrade. Granska på nytt."
        : "Svaret kunde inte bekräftas. Kontrollera Projekt och rutter innan du försöker igen.");
      if (!confirm) { setPreview(body); return; }
      if (!body.draftId) throw new Error("Svaret saknar projekt. Ladda om innan du försöker igen.");
      setDraftId(body.draftId);
      await Promise.all([invalidateRouteQueries(client),
        client.invalidateQueries({ queryKey: ["/api/stops"] }),
        client.invalidateQueries({ queryKey: ["planning-drafts"] })]);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error && !(err instanceof TypeError) && !(err instanceof SyntaxError)
        ? err.message : "Svaret kunde inte bekräftas. Kontrollera Projekt och rutter innan du försöker igen.");
    }
    finally { setBusy(false); }
  }
  function close() { if (busy) return; setOpen(false); if (draftId) onDone(); }
  return <>
    <Button type="button" size="sm" variant="default" disabled={!eligible}
      title={blockReason ?? "Välj en registrerad chaufför/fordon, även utan befintlig rutt."}
      onClick={() => setOpen(true)}>Nytt projekt med annan resurs</Button>
    <span className="w-full text-xs text-muted-foreground">
      {blockReason ?? "Välj en registrerad chaufför/fordon. Resursen behöver inte ha en befintlig rutt."}
    </span>
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className={draftId ? "max-w-[96vw] w-[1400px] h-[92vh] overflow-y-auto" : "max-h-[90vh] overflow-y-auto"}>
        <DialogTitle>{draftId ? "Planera det nya projektet" : "Nytt projekt från markerade stopp"}</DialogTitle>
        <DialogDescription>{draftId ? "Stoppen och vald resurs är sparade. Optimera och granska innan utskick."
          : `${stops.length} stopp flyttas till ett nytt projektutkast. Källrutterna räknas om. Inget skickas automatiskt.`}</DialogDescription>
        {draftId ? <ImportWorkflow embedded draftId={draftId} onComplete={close} /> : <div className="space-y-4">
          <label className="block text-sm">Projektnamn<input disabled={busy} maxLength={120} value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded border bg-background p-2" /></label>
          <label className="block text-sm">Datum<input disabled={busy} type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full rounded border bg-background p-2" /></label>
          <label className="block text-sm">Chaufför / fordon<select disabled={busy} value={vehicleId} onChange={e => setVehicleId(e.target.value)} className="mt-1 w-full rounded border bg-background p-2">
            <option value="">Välj resurs</option>{resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
          </select></label>
          {(vehicles.isError || drivers.isError) && <p role="alert">Resurserna kunde inte hämtas. Stäng och försök igen.</p>}
          {!vehicles.isLoading && !drivers.isLoading && !vehicles.isError && !drivers.isError && !resources.length
            && <p role="status">Inga aktiva resurser med entydigt planeringsunderlag finns tillgängliga.</p>}
          {!eligible && <p role="alert">Urvalet innehåller stopp som inte längre får flyttas till nytt projekt.</p>}
          {preview && <><MoveConsequences consequences={preview.consequences} />
            {!preview.canMove && <p role="alert">Källrutterna har blockerande konflikter. Projektet har inte skapats.</p>}</>}
          {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={close}>Avbryt</Button>
            <Button disabled={!valid || busy || Boolean(preview && !preview.canMove)} onClick={() => void submit(!!preview)}>
              {busy ? "Arbetar…" : preview ? "Skapa projekt" : "Granska flytten"}
            </Button>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
