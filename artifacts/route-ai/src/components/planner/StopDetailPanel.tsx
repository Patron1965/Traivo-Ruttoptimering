import type { Stop } from "@workspace/api-client-react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTimeWindow } from "@/lib/planner-workflow";
import { STOP_STATUS_LABEL, STOP_STATUS_TONE } from "./types";
import { stopTitle } from "./SourceJobList";

function Field({ label, value, mono }: { label: string; value?: string | number | null; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 py-1 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono tabular-nums")}>{value}</dd>
    </div>
  );
}

/** Secondary job information on demand; keeps the list itself lean. */
export function StopDetailPanel({ stop, onClose }: { stop: Stop; onClose: () => void }) {
  const custom = Object.entries(stop.customFields ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  return (
    <aside
      data-testid="panel-stop-detail"
      className="absolute right-3 top-3 z-[1001] flex max-h-[calc(100%-1.5rem)] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-right-2"
    >
      <header className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" data-testid="text-detail-title">{stopTitle(stop)}</p>
          <p className="truncate text-xs text-muted-foreground">{stop.address}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Stäng" data-testid="button-close-detail"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
          <span className={cn("rounded px-1.5 py-px font-medium", STOP_STATUS_TONE[stop.status])}>{STOP_STATUS_LABEL[stop.status] ?? stop.status}</span>
          <span className="rounded bg-secondary/70 px-1.5 py-px font-mono text-secondary-foreground">
            {formatTimeWindow(stop.timeWindowStart, stop.timeWindowEnd) ?? "Inget tidsfönster"}
          </span>
        </div>
        <dl>
          <Field label="Kund" value={stop.customerName} />
          <Field label="Objekt" value={stop.customerSiteName} />
          <Field label="Referens" value={stop.externalRef ?? stop.shopifyOrderName} mono />
          <Field label="Servicetid" value={`${stop.serviceDurationMin} min`} mono />
          <Field label="Vikt" value={stop.weightKg != null ? `${stop.weightKg} kg` : null} mono />
          <Field label="Volym" value={stop.volumeM3 != null ? `${stop.volumeM3} m³` : null} mono />
          <Field label="Prioritet" value={stop.priority} mono />
          <Field label="Kategori" value={stop.serviceCategory} />
          <Field label="Kompetens" value={stop.requiredSkills?.join(", ")} />
          <Field label="Utrustning" value={stop.requiredEquipment?.join(", ")} />
        </dl>
        {(stop.notes || stop.serviceInstructions) && (
          <section className="mt-2 border-t border-border/60 pt-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Anteckningar</p>
            {stop.notes && <p className="whitespace-pre-wrap text-xs">{stop.notes}</p>}
            {stop.serviceInstructions && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{stop.serviceInstructions}</p>}
          </section>
        )}
        {(stop.contactName || stop.contactPhone || stop.contactEmail) && (
          <section className="mt-2 border-t border-border/60 pt-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Kontakt</p>
            <dl>
              <Field label="Namn" value={stop.contactName} />
              <Field label="Telefon" value={stop.contactPhone} mono />
              <Field label="E-post" value={stop.contactEmail} />
            </dl>
          </section>
        )}
        {custom.length > 0 && (
          <section className="mt-2 border-t border-border/60 pt-2">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Övriga fält</p>
            <dl>{custom.map(([k, v]) => <Field key={k} label={k} value={String(v)} />)}</dl>
          </section>
        )}
        <p className="mt-3 border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
          Registrerad {new Date(stop.createdAt).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}. Artiklar och ändringshistorik finns inte i stoppunderlaget.
        </p>
      </div>
    </aside>
  );
}
