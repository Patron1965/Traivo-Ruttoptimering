import { useState } from "react";
import { useListPlatformServices, getListPlatformServicesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CuoptConnection } from "./CuoptConnection";
import { RoutingConnection } from "./RoutingConnection";

const labels = {
  enabled: "Aktiverad",
  disabled: "Inaktiverad",
  incomplete: "Kräver konfiguration",
  available: "Tillgänglig vid val",
};
const colors = {
  enabled: "bg-emerald-100 text-emerald-900",
  disabled: "bg-muted text-muted-foreground",
  incomplete: "bg-amber-100 text-amber-950",
  available: "bg-blue-100 text-blue-950",
};

function ServicesContent() {
  const query = useListPlatformServices({ query: { queryKey: getListPlatformServicesQueryKey(), staleTime: 0, refetchInterval: 60_000, retry: false } });
  const [filter, setFilter] = useState("all");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Externa tjänster i denna servermiljö. Aktiverad betyder att tjänsten är vald och konfigurerad,
        inte att anslutning, leverans eller kvarvarande kvot har verifierats.
        Kundspecifika inställningar kan begränsa användningen ytterligare.
        Den här översikten ändrar inga inställningar och gör inga externa anrop.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="service-status-filter" className="text-sm">Visa status</label>
        <select id="service-status-filter" value={filter} onChange={event => setFilter(event.target.value)}
          className="rounded-md border bg-background p-2 text-sm">
          <option value="all">Alla tjänster</option>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? "Uppdaterar…" : "Uppdatera status"}
        </Button>
      </div>
      {query.isLoading && <p role="status">Läser tjänsternas konfiguration…</p>}
      {query.isError ? <p role="alert" className="text-destructive">Tjänsternas status kunde inte hämtas. Försök igen med Uppdatera status.</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {query.data?.filter(service => filter === "all" || service.state === filter).map(service => (
            <section key={service.id} className="rounded-lg border bg-card p-4 space-y-2">
              <h3 className="font-semibold">{service.name}</h3>
              <span className={`inline-block rounded px-2 py-1 text-xs font-medium ${colors[service.state]}`}>{labels[service.state]}</span>
              <p className="text-sm">{service.description}</p>
              <p className="text-xs text-muted-foreground">{service.detail}</p>
            </section>
          ))}
          {query.data && !query.data.some(service => filter === "all" || service.state === filter) &&
            <p className="text-sm text-muted-foreground">Inga tjänster med vald status.</p>}
        </div>
      )}
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">Vägdatakonfiguration och manuellt cuOpt-anslutningsprov</summary>
        <div className="mt-3 space-y-3"><RoutingConnection /><CuoptConnection /></div>
      </details>
    </div>
  );
}

export function ExternalServices() {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Externa tjänster</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-4xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>Traivo Superuser · Externa tjänster</DialogTitle></DialogHeader>
        {open && <ServicesContent />}
      </DialogContent>
    </Dialog>
  </>;
}
