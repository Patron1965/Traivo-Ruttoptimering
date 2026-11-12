import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPlatformOrganizationServicesQueryKey,
  getListPlatformServicesQueryKey,
  useGetPlatformOrganizationServices,
  useListPlatformServices,
  useUpdatePlatformOrganizationServices,
} from "@workspace/api-client-react";
import type { OrganizationServicePolicy } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OrganizationRoutingConnection } from "./RoutingConnection";
const loginLabel = (value?: string) => value === "siths" ? "SITHS · Region Stockholm" : "E-post och lösenord";

type ProviderKey = "roadProvider" | "geocodingProvider" | "smsProvider";
type ToggleKey = "emailEnabled" | "aiEnabled" | "districtEnabled";

const providerFields: { key: ProviderKey; label: string; help: string; options: [string, string][] }[] = [
  { key: "roadProvider", label: "Vägdata · ruttplanering", help: "Körtider och avstånd vid operativ ruttplanering. Distriktsplanering har separat serverval nedan.", options: [["osrm", "OSRM"], ["geoapify", "Geoapify"]] },
  { key: "geocodingProvider", label: "Adressökning", help: "Översätter adresser till koordinater.", options: [["google", "Google"], ["nominatim", "Nominatim"]] },
  { key: "smsProvider", label: "SMS", help: "Kundaviseringar via SMS.", options: [["linkmobility", "LINK Mobility"], ["twilio", "Twilio"], ["46elks", "46elks"]] },
];
const toggleFields: { key: ToggleKey; label: string; help: string }[] = [
  { key: "emailEnabled", label: "E-post till kundens mottagare", help: "Aviseringar och utskick från kundens arbetsmiljö. Traivos återställningsmejl påverkas inte." },
  { key: "aiEnabled", label: "AI-funktioner", help: "Förslag och assistent i planeringen." },
  { key: "districtEnabled", label: "Sotningsdistrikt", help: "Ger kunden tillgång till hela distriktsmodulen: visning, import, planering, jobb och export. Avstängd tills superuser uttryckligen tillåter den. Befintliga data raderas inte. Serverval görs nedan." },
];
const providerLabel = (value: string) => value === "inherit" ? "Traivos standard" : value === "disabled" ? "Avstängd" : providerFields.flatMap(f => f.options).find(([v]) => v === value)?.[1] ?? value;

function errorMessage(failure: unknown) {
  const f = failure as { status?: number; data?: unknown };
  if (f.status === 409) return "Inställningarna har ändrats av någon annan. Dina osparade val finns kvar. Läs in sparat läge och gör om ändringen.";
  const data = f.data;
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return "Kunde inte spara. Dina osparade val finns kvar.";
}

export function OrganizationServices({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const key = getGetPlatformOrganizationServicesQueryKey(organizationId);
  const settings = useGetPlatformOrganizationServices(organizationId, { query: { queryKey: key, retry: false, refetchInterval: 60_000 } });
  const global = useListPlatformServices({ query: { queryKey: getListPlatformServicesQueryKey(), retry: false } });
  const update = useUpdatePlatformOrganizationServices({ mutation: { retry: false } });
  const [draft, setDraft] = useState<OrganizationServicePolicy | null>(null);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [saved, setSaved] = useState(false);

  const stored = settings.data?.policy;
  const current = draft ?? stored;
  const changes = stored && draft ? (Object.keys(draft) as (keyof OrganizationServicePolicy)[]).filter(k => draft[k] !== stored[k]) : [];
  const dirty = changes.length > 0;
  const restricts = changes.some(k => draft && (draft[k] === false || draft[k] === "disabled"));

  const edit = (patch: Partial<OrganizationServicePolicy>) => {
    if (!current || !settings.data) return;
    if (!draft) setBaseRevision(settings.data.revision);
    setDraft({ ...current, ...patch }); setSaved(false); setReview(false); setError("");
  };
  const reload = async () => {
    setError(""); setReview(false);
    await settings.refetch();
    if (!dirty) setDraft(null);
  };
  const discard = () => { setDraft(null); setBaseRevision(null); setError(""); setReview(false); };
  const save = () => {
    if (!draft || baseRevision === null) return;
    setError("");
    update.mutate({ organizationId, data: { revision: baseRevision, policy: draft } }, {
      onSuccess: result => {
        queryClient.setQueryData(key, result);
        setDraft(null); setBaseRevision(null); setReview(false); setSaved(true);
      },
      onError: failure => { setError(errorMessage(failure)); setReview(false); },
    });
  };
  const stale = dirty && settings.data && baseRevision !== null && settings.data.revision !== baseRevision;

  const globalIds: Record<string, string[]> = {
    roadProvider: ["osrm", "geoapify"], geocodingProvider: ["google", "nominatim"],
    smsProvider: ["sms-linkmobility", "sms-twilio", "sms-46elks"], emailEnabled: ["sendgrid"],
    aiEnabled: ["openai"], districtEnabled: ["district-osrm"],
  };
  const GlobalHint = ({ k }: { k: string }) => {
    if (global.isError) return <p className="text-xs text-muted-foreground">Global status kunde inte läsas.</p>;
    const hits = (global.data ?? []).filter(service => globalIds[k]?.includes(service.id));
    if (!hits.length) return null;
    return <p className="text-xs text-muted-foreground">Globalt: {hits.map(h => `${h.name} (${h.state === "enabled" ? "aktiverad" : h.state === "incomplete" ? "kräver konfiguration" : h.state === "available" ? "tillgänglig vid val" : "inaktiverad"})`).join(", ")}</p>;
  };

  return (
    <div className="space-y-5" data-testid="organization-services">
      <section className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl space-y-1">
            <h3 className="font-semibold">Tjänster för kunden</h3>
            <p className="text-sm text-muted-foreground">
              Styr vilka externa tjänster kunden får använda. Traivos standard följer plattformens globala val.
              Tillåtet betyder endast att kunden får använda tjänsten när Traivo har en global nyckel; det bevisar inte att anslutningen fungerar.
              Traivos återställningsmejl och felrapportering är globala och styrs inte här.
              {" "}Nya anrop och jobb följer sparade val. Redan påbörjade beräkningar avbryts inte; utskick kontrollerar aktuell tillåtelse på nytt.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={settings.isFetching} onClick={() => void reload()}>
            {settings.isFetching ? "Läser…" : "Läs in sparat läge"}
          </Button>
        </div>

        {settings.isLoading && <p role="status" className="text-sm">Läser kundens tjänsteinställningar…</p>}
        {settings.isError && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>Kunde inte läsa tjänsteinställningarna.</p>
            <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>Försök igen</Button>
          </div>
        )}

        {current && stored && settings.data && <>
          <div className="space-y-3 rounded-lg border p-4" data-testid="customer-login-settings">
            <h3 className="font-semibold">Kundens inloggning</h3>
            <p className="text-xs text-muted-foreground">Välj önskad inloggningstjänst för just denna kund. Superusers inloggning påverkas inte.</p>
            <Label htmlFor={`login-service-${organizationId}`}>Önskad inloggningstjänst</Label>
            <Select value={current.preferredLoginService ?? "password"} disabled={update.isPending}
              onValueChange={(value: "password" | "siths") => edit({ preferredLoginService: value })}>
              <SelectTrigger id={`login-service-${organizationId}`} data-testid="select-login-service"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="password">E-post och lösenord</SelectItem>
                {settings.data.sithsEligible && <SelectItem value="siths">SITHS · Region Stockholm</SelectItem>}
              </SelectContent>
            </Select>
            {!settings.data.sithsEligible && <p className="text-xs text-muted-foreground">SITHS-kopplingen gäller endast Region Stockholm.</p>}
            <p className="text-xs">Aktiv inloggning: <strong>E-post och lösenord</strong></p>
            <p className="text-xs" data-testid="login-connection-status">
              Sparat val: {loginLabel(stored.preferredLoginService)} · Status: {settings.data.loginConnectionStatus === "not_configured" ? "Inte konfigurerad" : "Aktiv"}
            </p>
            {current.preferredLoginService === "siths" && <p className="rounded-md bg-muted p-3 text-sm">
              SITHS är ännu inte aktiverat i huvudappen. Den separata testkopplingen aktiverar inte kundens inloggning.
              E-post och lösenord fortsätter fungera tills en kundbunden anslutning är verifierad och aktiverad.
            </p>}
          </div>
          <div className={dirty ? "rounded-md border border-amber-500 bg-amber-50 p-2 text-xs text-amber-950" : "rounded-md bg-muted p-2 text-xs text-muted-foreground"} role="status">
            {dirty ? `Osparade ändringar (${changes.length}). Sparad version ${baseRevision ?? settings.data.revision}.` : `Visar sparat läge · version ${settings.data.revision}.`}
            {stale && " Servern har en nyare version; spara kommer att avvisas. Läs in sparat läge efter att ha förkastat dina val."}
          </div>

          <p className="text-xs text-muted-foreground">NVIDIA cuOpt har i dag ett globalt anslutningsprov, men inget körbart kundflöde för optimering. Därför visas ingen aktiveringsknapp för kunden här.</p>

          <div className="grid gap-4 sm:grid-cols-3">
            {providerFields.map(field => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`svc-${field.key}-${organizationId}`}>{field.label}</Label>
                <Select value={current[field.key]} disabled={update.isPending} onValueChange={value => edit({ [field.key]: value } as Partial<OrganizationServicePolicy>)}>
                  <SelectTrigger id={`svc-${field.key}-${organizationId}`} data-testid={`select-${field.key}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Traivos standard</SelectItem>
                    <SelectItem value="disabled">Avstängd för kunden</SelectItem>
                    {field.options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{field.help}</p>
                {current[field.key] !== stored[field.key] && <p className="text-xs text-amber-800">Sparat: {providerLabel(stored[field.key])}</p>}
                <GlobalHint k={field.key} />
              </div>
            ))}
          </div>

          <div className="divide-y rounded-lg border">
            {toggleFields.map(field => (
              <div key={field.key} className="flex items-start justify-between gap-4 p-3">
                <div className="space-y-0.5">
                  <Label htmlFor={`svc-${field.key}-${organizationId}`}>{field.label}</Label>
                  <p className="text-xs text-muted-foreground">{field.help}</p>
                  {current[field.key] !== stored[field.key] && <p className="text-xs text-amber-800">Sparat: {stored[field.key] ? "tillåten" : "avstängd"}</p>}
                  <GlobalHint k={field.key} />
                </div>
                <Switch id={`svc-${field.key}-${organizationId}`} data-testid={`switch-${field.key}`} checked={current[field.key]} disabled={update.isPending}
                  onCheckedChange={checked => edit({ [field.key]: checked } as Partial<OrganizationServicePolicy>)} />
              </div>
            ))}
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {saved && !dirty && <p role="status" className="text-sm text-emerald-700">Tjänsteinställningarna är sparade.</p>}

          {review && dirty && (
            <div role="alert" className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 space-y-2">
              <p className="font-medium">Granska ändringarna</p>
              <ul className="list-disc pl-5 text-xs">
                {changes.map(k => k === "preferredLoginService"
                  ? <li key={k}>Önskad inloggning: {loginLabel(stored[k])} → {loginLabel(draft![k])}. Aktiv inloggning ändras inte.</li>
                  : <li key={k}>{[...providerFields, ...toggleFields].find(f => f.key === k)?.label}: {String(typeof stored[k] === "boolean" ? (stored[k] ? "tillåten" : "avstängd") : providerLabel(stored[k] as string))} → {String(typeof draft![k] === "boolean" ? (draft![k] ? "tillåten" : "avstängd") : providerLabel(draft![k] as string))}</li>)}
              </ul>
              {restricts && <p className="text-xs">Avstängning kan blockera ny planering och nya utskick. För distrikt spärras även visning och export. Befintliga data raderas inte och redan påbörjade beräkningar avbryts inte.</p>}
              <p className="text-xs">En explicit leverantör som saknar global konfiguration avvisas av servern.</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={update.isPending} data-testid="button-confirm-services">{update.isPending ? "Sparar…" : "Bekräfta och spara"}</Button>
                <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => setReview(false)}>Tillbaka</Button>
              </div>
            </div>
          )}

          {!review && (
            <div className="flex gap-2">
              <Button disabled={!dirty || update.isPending} onClick={() => setReview(true)} data-testid="button-review-services">Granska och spara</Button>
              <Button variant="outline" disabled={!dirty || update.isPending} onClick={discard}>Förkasta ändringar</Button>
            </div>
          )}
        </>}
      </section>
      <OrganizationRoutingConnection organizationId={organizationId} />
    </div>
  );
}
