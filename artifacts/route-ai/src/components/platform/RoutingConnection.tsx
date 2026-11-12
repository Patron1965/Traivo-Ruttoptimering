import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPlatformOrganizationRoutingQueryKey,
  useGetPlatformOrganizationRouting,
  useGetPlatformRouting,
  useUpdatePlatformOrganizationRouting,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const INHERIT = "__shared__";

export function RoutingConnection() {
  const status = useGetPlatformRouting();
  return (
    <section className="rounded-lg border border-border bg-card p-3 text-left space-y-2" aria-label="Traivos gemensamma vägdatatjänst">
      <h2 className="text-sm font-semibold">Gemensam vägdatatjänst · OSRM</h2>
      <p className="text-xs text-muted-foreground" role="status" data-testid="status-shared-routing">
        {status.isLoading ? "Läser serverkonfiguration…" : status.isError
          ? "Kunde inte läsa konfigurationen."
          : status.data?.shared.configured
            ? "Gemensam server är konfigurerad. Kunder använder den som standard."
            : status.data?.shared.error || "Traivos gemensamma vägdatatjänst är inte konfigurerad."}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Anslutningar och driftkrav</summary>
        <div className="mt-2 space-y-2">
          <p>Serveradresser och åtkomst ställs in av driftansvarig. Kundspecifika servrar väljs nedan för respektive företag.</p>
          <p>Status visar konfiguration, inte verifierad tillgänglighet eller kapacitet. Den publika OSRM-demonstrationen används inte för distriktsjobb.</p>
          {status.data?.catalogError && <p role="alert" className="text-destructive">{status.data.catalogError}</p>}
          <ul>{status.data?.dedicated.map((server) => (
            <li key={server.id}>{server.name}: {server.configured ? "konfigurerad" : "ej tillgänglig"}</li>
          ))}</ul>
          {!status.data?.dedicated.length && <p>Inga kundspecifika serveranslutningar finns konfigurerade.</p>}
        </div>
      </details>
      {status.isError && <Button size="sm" variant="outline" onClick={() => void status.refetch()}>Försök igen</Button>}
    </section>
  );
}

export function OrganizationRoutingConnection({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const catalog = useGetPlatformRouting();
  const settings = useGetPlatformOrganizationRouting(organizationId);
  const update = useUpdatePlatformOrganizationRouting();
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const selected = draft ?? settings.data?.serverId ?? INHERIT;
  const servers = catalog.data?.dedicated ?? [];
  const missingSelection = selected !== INHERIT && !servers.some((server) => server.id === selected);
  const loaded = Boolean(settings.data && catalog.data);
  const dirty = selected !== (settings.data?.serverId ?? INHERIT);
  const savedServerName = settings.data?.serverId
    ? servers.find((server) => server.id === settings.data?.serverId)?.name ?? settings.data?.effectiveServerId
    : "Traivos gemensamma server";

  const save = () => {
    setSaved(false);
    update.mutate({ organizationId, data: { serverId: selected === INHERIT ? null : selected } }, {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetPlatformOrganizationRoutingQueryKey(organizationId), result);
        setDraft(null);
        setSaved(true);
      },
    });
  };

  return (
    <section className="mb-5 rounded-xl border bg-card p-4 space-y-3" aria-label="Kundens vägdatatjänst" data-testid="organization-routing-settings">
      <h3 className="font-semibold">Distriktsoptimering · vägdatatjänst</h3>
      <p className="text-sm text-muted-foreground">Gemensam Traivo-server är standard. Välj en separat, godkänd anslutning endast om kunden behöver en egen server. Inställningen gäller nya distriktsjobb.</p>
      {settings.isLoading || catalog.isLoading ? <p role="status" className="text-sm">Läser inställningar…</p> : null}
      {settings.isError || catalog.isError ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Kunde inte läsa serverinställningarna.</p>
          <Button variant="outline" size="sm" onClick={() => { void settings.refetch(); void catalog.refetch(); }}>Försök igen</Button>
        </div>
      ) : null}
      {loaded && (
        <>
          <Label htmlFor={`routing-server-${organizationId}`}>Serveranslutning</Label>
          <Select value={selected} disabled={update.isPending} onValueChange={(value) => { setDraft(value); setSaved(false); update.reset(); }}>
            <SelectTrigger id={`routing-server-${organizationId}`} data-testid="select-organization-routing"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT}>Traivos gemensamma server (standard)</SelectItem>
              {servers.map((server) => <SelectItem key={server.id} value={server.id} disabled={!server.configured}>{server.name}</SelectItem>)}
              {missingSelection && <SelectItem value={selected} disabled>Nuvarande server saknas i katalogen</SelectItem>}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground" data-testid="text-effective-routing">
            Sparad anslutning: {savedServerName}.
            {" "}{settings.data?.configured ? "Konfigurerad; tillgänglighet är inte testad." : settings.data?.error || "Inte konfigurerad."}
          </p>
          {dirty && <p className="text-xs text-muted-foreground">Nya jobb skickar koordinater till den valda tjänsten. Befintliga jobb och resultat byter inte server.</p>}
          {update.isError && <p role="alert" className="text-sm text-destructive">Kunde inte spara anslutningen. Kontrollera serverkonfigurationen och försök igen.</p>}
          {saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">Servervalet är sparat.</p>}
          <Button onClick={save} disabled={!dirty || update.isPending || missingSelection} data-testid="button-save-organization-routing">
            {update.isPending ? "Sparar…" : "Spara serverval"}
          </Button>
        </>
      )}
    </section>
  );
}