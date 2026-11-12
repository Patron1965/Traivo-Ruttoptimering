import React, { useState, useEffect } from "react";
import { enterWorkspace } from "@/lib/workspace-context";
import { useQueryClient } from "@tanstack/react-query";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ShieldAlert, Plus, Search, Building2, Users, Edit2, Mail, Shield, Key, ArrowRight, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { OrganizationUsage } from "@/components/platform/OrganizationUsage";
import { ExternalServices } from "@/components/platform/ExternalServices";
import { SupportSummary } from "@/components/platform/SupportSummary";
import { OrganizationServices } from "@/components/platform/OrganizationServices";

import {
  useListPlatformOrganizations,
  useCreatePlatformOrganization,
  useUpdatePlatformOrganization,
  useListPlatformUsers,
  useInvitePlatformUser,
  useUpdatePlatformUser,
  useInitiatePlatformPasswordReset,
  useChangePlatformOrganizationLifecycle,
  getListPlatformOrganizationsQueryKey,
  getListPlatformUsersQueryKey
} from "@workspace/api-client-react";
import type {
  PlatformUser, PlatformOrganization
} from "@workspace/api-client-react";

export default function PlatformAdmin() {
  const { user, logout, isLoggingOut } = useAuth();

  if (!user?.isPlatformAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <div className="p-8 flex flex-col items-center justify-center text-center gap-3 min-h-[50vh]">
          <ShieldAlert className="h-10 w-10 text-destructive" />
          <h2 className="text-xl font-bold">Åtkomst nekad</h2>
          <p className="text-muted-foreground max-w-md">
            Endast Traivo Superuser kan se kundföretag och plattformsinställningar.
          </p>
          <a href="/">Till min organisations arbetsmiljö</a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <header className="p-4 border-b flex items-center justify-between">
        <div><h1 className="font-bold">Traivo Superuser · Kundföretag</h1><p className="text-sm text-muted-foreground">Leverantörsadministration · Separat från kundernas arbetsmiljöer</p></div>
        <Button variant="outline" disabled={isLoggingOut} onClick={() => void logout()}>Logga ut</Button>
      </header>
      {user.platformPasswordOnlyTestMode && (
        <div role="alert" className="border-b border-amber-500 bg-amber-50 p-4 text-sm text-amber-950">
          Tillfälligt testläge är aktivt: MFA-kravet för Traivo Superuser är avstängt.
          Inloggning med enbart lösenord tillåts. Detta ger lägre säkerhet och ska stängas av efter testet.
        </div>
      )}
      <div className="flex-1 min-h-0"><PlatformAdminContent /></div>
    </div>
  );
}

function PlatformAdminContent() {
  const [selectedOrg, setSelectedOrg] = useState<PlatformOrganization | null>(null);
  const [showSecurity, setShowSecurity] = useState(false);
  
  return (
    <div className="h-full flex flex-col md:flex-row overflow-hidden bg-background">
      <div className={cn(
        "flex-1 md:max-w-md lg:max-w-lg border-r border-border flex flex-col min-h-0",
         selectedOrg && "hidden md:flex" 
      )}>
        <div className="p-3 border-b border-border shrink-0 space-y-2">
          <ExternalServices />
          <Button variant="outline" size="sm" onClick={() => setShowSecurity(value => !value)}>
            {showSecurity ? "Visa kundföretag" : "Traivos säkerhetshändelser"}
          </Button>
        </div>
        {showSecurity ? <PlatformSecurityEvents /> : (
        <OrganizationList 
           selectedOrgId={selectedOrg?.id ?? null}
           onSelect={setSelectedOrg}
        />)}
      </div>
      
      <div className={cn(
        "flex-1 flex flex-col min-h-0 bg-muted/10",
         !selectedOrg && "hidden md:flex items-center justify-center text-center p-8"
      )}>
         {selectedOrg ? (
            <OrganizationDetail key={selectedOrg.id} org={selectedOrg} onUpdated={setSelectedOrg} onBack={() => setSelectedOrg(null)} onLifecycleDone={() => setSelectedOrg(null)} />
        ) : (
          <div className="max-w-md text-muted-foreground space-y-4">
            <Building2 className="h-12 w-12 mx-auto text-muted-foreground/50" />
            <p>Välj en organisation i listan för att hantera dess användare och inställningar.</p>
          </div>
        )}
      </div>
    </div>
  );
}

type PlatformSecurityEvent = {
  id: string; createdAt: string; action: string; organizationId: string | null;
  userEmail: string | null; resourceType: string | null; statusCode: string | null;
  attemptId?: string | null; providerId?: string | null;
};

const emailOutcomeLabels: Record<string, string> = {
  accepted: "Accepterat av Resend – leverans inte verifierad",
  rejected: "Leverantörsförfrågan nekad",
  timeout: "Timeout – utskicket kan ha skett, ingen automatisk omsändning",
  unknown: "Osäkert leverantörssvar – ingen automatisk omsändning",
  delivered: "Verifierat levererat till mottagarens mejlserver (inte bevis på läsning)",
  bounced: "Mejlet studsade", complained: "Mejlet rapporterades som skräppost",
  delivery_delayed: "Leveransen är fördröjd", failed: "Leveransen misslyckades",
  unconfirmed: "Leverans ännu inte verifierad",
  unavailable: "Leveransbevis kunde inte hämtas – kontrollera Resend-åtkomst eller försök senare",
};

function PlatformSecurityEvents() {
  const [events, setEvents] = useState<PlatformSecurityEvent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [checking, setChecking] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<Record<string, string>>({});
  async function checkDelivery(id: string) {
    setChecking(id);
    try {
      const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/platform/security-events/${id}/check-delivery`, {
        method: "POST", credentials: "include",
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setDelivery(current => ({ ...current, [id]: emailOutcomeLabels[result.outcome] ?? "Okänd status" }));
    } catch {
      setDelivery(current => ({ ...current, [id]: "Kunde inte kontrollera leverans." }));
    } finally { setChecking(null); }
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/platform/security-events`, {
      credentials: "include", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`Kunde inte läsa säkerhetshändelser (${response.status}).`);
      return response.json() as Promise<{ items: PlatformSecurityEvent[] }>;
    }).then(data => { setEvents(data.items); setBusy(false); })
      .catch(cause => { if (!controller.signal.aborted) { setError(cause.message); setBusy(false); } });
    return () => controller.abort();
  }, []);
  return <div className="overflow-y-auto p-4 space-y-3" data-testid="platform-security-events">
    <h2 className="font-semibold">Traivos säkerhetshändelser</h2>
    <p className="text-xs text-muted-foreground">Senaste 100 plattformshändelser. Kundernas egna loggar visas inte här.</p>
    {busy && <p>Läser händelser…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!busy && !error && !events.length && <p>Inga händelser ännu.</p>}
    {events.map(event => <div key={event.id} className="rounded border p-3 text-xs space-y-1">
      <p className="font-medium">{event.action}</p>
      {event.action.startsWith("platform.email_code.") && <>
        <p>{emailOutcomeLabels[event.action.slice("platform.email_code.".length)] ?? "Okänd status"}</p>
        <p>Försök: {event.attemptId} {event.providerId && `· Resend-id: ${event.providerId}`}</p>
        {event.action === "platform.email_code.accepted" && event.providerId && <button
          className="underline" disabled={checking !== null} onClick={() => checkDelivery(event.id)}>
          {checking === event.id ? "Kontrollerar…" : "Kontrollera leverans hos Resend"}
        </button>}
        {delivery[event.id] && <p role="status">{delivery[event.id]}</p>}
      </>}
      <p>{new Date(event.createdAt).toLocaleString("sv-SE")} · {event.userEmail ?? "Okänd aktör"}</p>
      <p className="text-muted-foreground">Företag: {event.organizationId ?? "Traivo"} · Resultat: {event.statusCode ?? "okänt"}</p>
    </div>)}
  </div>;
}

function OrganizationList({ 
  selectedOrgId, 
  onSelect 
}: { 
  selectedOrgId: string | null; 
  onSelect: (org: PlatformOrganization) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [enteringOrg, setEnteringOrg] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [page, setPage] = useState(1);
  const [showArchived, setShowArchived] = useState(false);
  const pageSize = 20;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, isError } = useListPlatformOrganizations({ 
    search: debouncedSearch || undefined, 
    page, 
    pageSize,
    includeArchived: showArchived ? "true" : "false",
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-4 border-b border-border bg-card space-y-4 shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight">Organisationer</h1>
          <CreateOrgDialog />
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Sök organisationer..." 
            className="pl-9 bg-background"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" data-testid="toggle-show-archived" checked={showArchived}
            onChange={e => { setShowArchived(e.target.checked); setPage(1); }} />
          Visa arkiverade företag
        </label>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {workspaceError && <p role="alert" className="p-2 text-sm text-destructive">{workspaceError}</p>}
        {isLoading && <LoadingState message="Laddar organisationer..." />}
        {isError && (
          <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md m-2">
            Kunde inte hämta organisationer.
          </div>
        )}
        
        {data?.items.map(org => (
          <div key={org.id} className="rounded-lg border border-border/50 pb-2">
          <button
             onClick={() => onSelect(org)}
            className={cn(
              "w-full text-left p-3 rounded-lg border transition-all flex items-center justify-between group",
              selectedOrgId === org.id 
                ? "bg-primary text-primary-foreground border-primary shadow-sm" 
                : "bg-card border-transparent hover:border-border hover:bg-muted/50"
            )}
          >
            <div className="min-w-0 pr-4">
              <div className="font-semibold truncate flex items-center gap-2">{org.name}{org.archivedAt && <ArchivedBadge />}</div>
              <div className={cn(
                "text-xs truncate flex items-center gap-1.5 mt-0.5",
                selectedOrgId === org.id ? "text-primary-foreground/80" : "text-muted-foreground"
              )}>
                <Building2 className="h-3 w-3 shrink-0" />
                {org.operatingMode === "transport" ? "Transport" : org.operatingMode === "field_service" ? "Fältservice" : "Blandat"}
              </div>
            </div>
            <ArrowRight className={cn(
              "h-4 w-4 shrink-0 transition-transform",
              selectedOrgId === org.id ? "text-primary-foreground/80 translate-x-1" : "text-muted-foreground opacity-0 group-hover:opacity-100"
            )} />
          </button>
          {!org.archivedAt && <Button variant="outline" size="sm" className="mx-3" disabled={enteringOrg !== null} onClick={async () => {
            setEnteringOrg(org.id); setWorkspaceError("");
            try { await enterWorkspace(org.id); }
            catch (error) { setWorkspaceError(error instanceof Error ? error.message : "Företagsåtkomsten kunde inte öppnas."); setEnteringOrg(null); }
          }}>{enteringOrg === org.id ? "Öppnar…" : "Hantera företaget"}</Button>}
          </div>
        ))}

        {data?.items.length === 0 && !isLoading && (
          <div className="p-8 text-center text-muted-foreground text-sm">
            Inga organisationer hittades.
          </div>
        )}
      </div>

      {data && data.total > pageSize && (
        <div className="p-3 border-t border-border bg-card shrink-0 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {((page - 1) * pageSize) + 1}-{Math.min(page * pageSize, data.total)} av {data.total}
          </span>
          <div className="flex gap-1">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Föregående
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setPage(p => p + 1)}
              disabled={page * pageSize >= data.total}
            >
              Nästa
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const companyFields = [
  ["registrationNumber", "Organisationsnummer"], ["contactPerson", "Kontaktperson"],
  ["phone", "Telefon"], ["street", "Gatuadress"], ["postalCode", "Postnummer"],
  ["city", "Ort"], ["country", "Land"], ["invoiceEmail", "Faktura-e-post"],
] as const;
type CompanyDetails = NonNullable<PlatformOrganization["companyDetails"]>;
function CompanyFields({ value, onChange, disabled = false }: {
  value: CompanyDetails; onChange: (value: CompanyDetails) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="grid grid-cols-2 gap-3">
    <legend className="mb-2 text-sm font-semibold">Företagsuppgifter (valfritt)</legend>
    {companyFields.map(([key, label]) => <label key={key} className="space-y-1 text-sm">
      <span>{label}</span><Input type={key === "invoiceEmail" ? "email" : "text"}
        maxLength={key === "street" ? 300 : key === "contactPerson" ? 200 : key === "postalCode" ? 40 : 100}
        value={value[key] ?? ""} onChange={e => onChange({ ...value, [key]: e.target.value.trim() ? e.target.value : null })} />
    </label>)}
  </fieldset>;
}

function CreateOrgDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [companyDetails, setCompanyDetails] = useState<CompanyDetails>({});
  const [operatingMode, setOperatingMode] = useState<"transport" | "field_service" | "mixed">("transport");
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createMutation = useCreatePlatformOrganization();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({
      data: { name, email, operatingMode, companyDetails }
    }, {
      onSuccess: () => {
        toast({ title: "Organisation skapad", description: `${name} har lagts till. Öppna företaget och bjud in första administratören under Användare.` });
        queryClient.invalidateQueries({ queryKey: getListPlatformOrganizationsQueryKey() });
        setOpen(false);
        setName("");
        setEmail("");
        setCompanyDetails({});
        setOperatingMode("transport");
      },
      onError: () => {
        toast({ title: "Ett fel uppstod", description: "Kunde inte skapa organisationen.", variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 h-8">
          <Plus className="h-3.5 w-3.5" /> Ny
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px] max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Skapa ny organisation</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="org-name">Företagsnamn</Label>
            <Input id="org-name" value={name} onChange={e => setName(e.target.value)} required placeholder="T.ex. Acme Logistics AB" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-email">E-postadress</Label>
            <Input id="org-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="kontakt@foretaget.se" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-mode">Verksamhetstyp</Label>
            <Select value={operatingMode} onValueChange={(v: any) => setOperatingMode(v)}>
              <SelectTrigger id="org-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="transport">Transport / Logistik</SelectItem>
                <SelectItem value="field_service">Fältservice / Hantverkare</SelectItem>
                <SelectItem value="mixed">Blandad verksamhet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <CompanyFields value={companyDetails} onChange={setCompanyDetails} disabled={createMutation.isPending} />
          <p className="text-xs text-muted-foreground">Välj Hantera företaget för att arbeta med ditt eget Superuser-konto direkt. Bjud separat in kundens egen administratör under Användare; kunden väljer sitt lösenord via en säker e-postlänk.</p>
          <div className="pt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Avbryt</Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Skapar..." : "Skapa organisation"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditOrganizationDialog({ org, onUpdated }: { org: PlatformOrganization; onUpdated: (org: PlatformOrganization) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(org.name);
  const [email, setEmail] = useState(org.email);
  const [operatingMode, setOperatingMode] = useState<PlatformOrganization["operatingMode"]>(org.operatingMode);
  const [error, setError] = useState("");
  const [companyDetails, setCompanyDetails] = useState<CompanyDetails>(org.companyDetails ?? {});
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdatePlatformOrganization();

  const setDialogOpen = (next: boolean) => {
    if (update.isPending) return;
    if (next) {
      setName(org.name);
      setEmail(org.email);
      setOperatingMode(org.operatingMode);
      setCompanyDetails(org.companyDetails ?? {});
    }
    setError("");
    setOpen(next);
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || trimmedName.length > 200) {
      setError("Ange ett organisationsnamn på högst 200 tecken.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError("Ange en giltig e-postadress.");
      return;
    }
    setError("");
    update.mutate({ organizationId: org.id, data: { name: trimmedName, email: trimmedEmail, operatingMode, companyDetails } }, {
      onSuccess: (updated) => {
        onUpdated(updated);
        void queryClient.invalidateQueries({ queryKey: getListPlatformOrganizationsQueryKey() });
        setOpen(false);
        toast({ title: "Organisation uppdaterad", description: "Ändringarna har sparats." });
      },
      onError: (failure) => {
        const data: unknown = (failure as { data?: unknown }).data;
        setError(data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "Kunde inte spara organisationen. Försök igen.");
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5"><Edit2 className="h-4 w-4" /> Redigera organisation</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px] max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>Redigera organisation</DialogTitle></DialogHeader>
        <form onSubmit={save} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="edit-org-name">Organisationsnamn</Label>
            <Input id="edit-org-name" value={name} onChange={e => setName(e.target.value)} maxLength={200} required disabled={update.isPending} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-org-email">Kontaktadress</Label>
            <Input id="edit-org-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required disabled={update.isPending} />
            <p className="text-xs text-muted-foreground">Detta är organisationens kontaktadress, inte en användares inloggningsadress. Befintliga användarkonton ändras inte.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-org-mode">Verksamhetstyp</Label>
            <Select value={operatingMode} onValueChange={(value: PlatformOrganization["operatingMode"]) => setOperatingMode(value)} disabled={update.isPending}>
              <SelectTrigger id="edit-org-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="transport">Transport / Logistik</SelectItem>
                <SelectItem value="field_service">Fältservice / Hantverkare</SelectItem>
                <SelectItem value="mixed">Blandad verksamhet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <CompanyFields value={companyDetails} onChange={setCompanyDetails} disabled={update.isPending} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" disabled={update.isPending} onClick={() => setDialogOpen(false)}>Avbryt</Button>
            <Button type="submit" disabled={update.isPending}>{update.isPending ? "Sparar..." : "Spara ändringar"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchivedBadge() {
  return <span data-testid="badge-archived" className="shrink-0 rounded-sm border border-amber-500/60 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">Arkiverad</span>;
}

type LifecycleAction = "archive" | "restore" | "delete";
const lifecycleCopy: Record<LifecycleAction, { title: string; button: string; done: string }> = {
  archive: { title: "Arkivera företag", button: "Arkivera", done: "Företaget har arkiverats." },
  restore: { title: "Återställ företag", button: "Återställ", done: "Företaget är aktivt igen." },
  delete: { title: "Radera företag permanent", button: "Radera permanent", done: "Företaget har raderats permanent." },
};

function OrganizationLifecycle({ org, onDone }: { org: PlatformOrganization; onDone: () => void }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mutation = useChangePlatformOrganizationLifecycle();
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const isHome = user?.organizationId === org.id;
  const archived = !!org.archivedAt;
  const open = (next: LifecycleAction) => { setAction(next); setConfirmation(""); setError(""); };
  const close = () => { if (!mutation.isPending) setAction(null); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!action || confirmation !== org.name) return;
    setError("");
    mutation.mutate({ organizationId: org.id, data: { action, confirmationName: confirmation } }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListPlatformOrganizationsQueryKey() });
        toast({ title: lifecycleCopy[action].title, description: lifecycleCopy[action].done });
        setAction(null);
        onDone();
      },
      onError: (failure) => {
        const data: unknown = (failure as { data?: unknown }).data;
        setError(data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "Åtgärden kunde inte genomföras. Försök igen.");
      },
    });
  };
  return <section className="mb-5 rounded-xl border bg-card p-4" aria-labelledby="lifecycle-heading" data-testid="section-org-lifecycle">
    <h3 id="lifecycle-heading" className="mb-1 font-semibold">Företagets livscykel</h3>
    {isHome ? <p className="text-sm text-muted-foreground">Detta är din egen hemorganisation och kan inte arkiveras eller raderas här.</p> : <>
      <p className="mb-3 text-sm text-muted-foreground">
        {archived ? `Arkiverad ${new Date(org.archivedAt!).toLocaleString("sv-SE")}. Återställ för att göra företaget aktivt, eller radera permanent.`
          : "Arkivering döljer företaget från listan och stoppar åtkomst. Permanent radering kräver att företaget först arkiveras."}
      </p>
      <div className="flex flex-wrap gap-2">
        {archived ? <>
          <Button size="sm" variant="outline" data-testid="button-restore-org" onClick={() => open("restore")}>Återställ</Button>
          <Button size="sm" variant="destructive" data-testid="button-delete-org" onClick={() => open("delete")}>Radera permanent</Button>
        </> : <Button size="sm" variant="outline" data-testid="button-archive-org" onClick={() => open("archive")}>Arkivera företag</Button>}
      </div>
    </>}
    <Dialog open={action !== null} onOpenChange={next => { if (!next) close(); }}>
      <DialogContent className="sm:max-w-[480px]">
        {action && <>
          <DialogHeader><DialogTitle>{lifecycleCopy[action].title}</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            {action === "delete" ? <div role="note" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm space-y-1">
              <p className="font-semibold">Detta kan inte ångras.</p>
              <p>Företaget raderas permanent tillsammans med användare, stopp, rutter och verksamhetshistorik. Traivos säkerhetslogg behålls för spårbarhet.</p>
              <p>Raderingen nekas av servern om företaget har aktiva rutter.</p>
            </div> : action === "archive" ? <p className="text-sm">Företaget döljs från den aktiva listan och kan inte användas förrän det återställs. Ingen data raderas.</p>
              : <p className="text-sm">Företaget blir aktivt igen och visas i den vanliga listan.</p>}
            <div className="space-y-1">
              <Label htmlFor="lifecycle-confirm">Skriv företagets exakta namn för att bekräfta: <strong className="break-all">{org.name}</strong></Label>
              <Input id="lifecycle-confirm" data-testid="input-lifecycle-confirm" autoComplete="off" value={confirmation}
                onChange={e => setConfirmation(e.target.value)} disabled={mutation.isPending} />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" disabled={mutation.isPending} onClick={close}>Avbryt</Button>
              <Button type="submit" data-testid="button-confirm-lifecycle" variant={action === "delete" ? "destructive" : "default"}
                disabled={mutation.isPending || confirmation !== org.name}>
                {mutation.isPending ? "Arbetar…" : lifecycleCopy[action].button}
              </Button>
            </div>
          </form>
        </>}
      </DialogContent>
    </Dialog>
  </section>;
}

function OrganizationDetail({ org, onBack, onUpdated, onLifecycleDone }: { org: PlatformOrganization; onBack: () => void; onUpdated: (org: PlatformOrganization) => void; onLifecycleDone: () => void }) {
  const orgId = org.id;
  const [entering, setEntering] = useState(false);
  const [entryError, setEntryError] = useState("");
  const { data: users, isLoading: usersLoading, isError: usersError } = useListPlatformUsers(orgId);
  const [detailTab, setDetailTab] = useState<"usage" | "users" | "services">("users");
  const [support, setSupport] = useState(false);
  useEffect(() => { setSupport(false); setDetailTab("users"); }, [orgId]);
  if (support) return <SupportSummary organization={org} onExit={() => setSupport(false)} />;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="p-6 border-b border-border bg-card shrink-0 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" className="md:hidden -ml-2" onClick={onBack}>
            <X className="h-5 w-5" />
          </Button>
           <div className="min-w-0">
              <h2 className="text-2xl font-bold tracking-tight break-words flex flex-wrap items-center gap-2">{org.name}{org.archivedAt && <ArchivedBadge />}</h2>
             <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground mt-1">
              <Mail className="h-3.5 w-3.5" />
               <span>{org.email}</span>
              <span className="px-1.5 py-0.5 rounded-sm bg-muted text-[10px] uppercase font-semibold tracking-wider">
                 {org.id}
              </span>
            </div>
          </div>
         <div className="flex flex-col gap-2">
           <Button disabled={entering || Boolean(org.archivedAt)} onClick={async () => {
             setEntering(true); setEntryError("");
             try { await enterWorkspace(org.id); }
             catch (error) { setEntryError(error instanceof Error ? error.message : "Företagsåtkomsten kunde inte öppnas."); setEntering(false); }
           }}>{entering ? "Öppnar…" : "Hantera företaget"}</Button>
           <p className="text-xs text-muted-foreground max-w-sm">Du använder ditt eget Superuser-konto. Bjud separat in kundens egen administratör; det behövs inte för din åtkomst.</p>
           {entryError && <p role="alert" className="text-sm text-destructive">{entryError}</p>}
           <EditOrganizationDialog org={org} onUpdated={onUpdated} />
         </div>
        </div>
      </div>

      <div className="px-6 border-b border-border bg-card flex gap-6 shrink-0">
        <button type="button" onClick={() => setSupport(true)} className="py-3 text-sm font-semibold">Öppna skrivskyddad supportöversikt</button>
        <button type="button" data-testid="button-platform-usage" onClick={() => setDetailTab("usage")} className={cn("py-3 text-sm font-semibold border-b-2 transition-colors", detailTab === "usage" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>Användning</button>
        <button type="button" data-testid="button-platform-users" onClick={() => setDetailTab("users")} className={cn("py-3 text-sm font-semibold border-b-2 transition-colors", detailTab === "users" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>Användare</button>
        <button type="button" data-testid="button-platform-services" onClick={() => setDetailTab("services")} className={cn("py-3 text-sm font-semibold border-b-2 transition-colors", detailTab === "services" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>Tjänster</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <OrganizationLifecycle org={org} onDone={onLifecycleDone} />
        <section className="mb-5 rounded-xl border bg-card p-4">
          <h3 className="mb-3 font-semibold">Företagsuppgifter</h3>
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            {companyFields.map(([key, label]) => <div key={key}>
              <dt className="text-muted-foreground">{label}</dt><dd className="break-words">{org.companyDetails?.[key] || "Ej angivet"}</dd>
            </div>)}
          </dl>
        </section>
        {detailTab === "services" ? <OrganizationServices key={orgId} organizationId={orgId} /> : detailTab === "usage" ? <OrganizationUsage key={orgId} organizationId={orgId} /> : <>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Användare</h3>
          </div>
          <InviteUserDialog orgId={orgId} firstAdmin={users?.length === 0} />
        </div>

         {usersLoading ? (
          <div className="py-8"><LoadingState message="Laddar användare..." /></div>
         ) : usersError ? (
           <div className="p-8 text-center text-destructive">Kunde inte hämta användare.</div>
        ) : users?.length === 0 ? (
          <div className="p-8 text-center bg-card border border-border rounded-xl text-muted-foreground">
            Företaget är tomt och fristående. Du kan redan välja Hantera företaget med ditt Superuser-konto. Bjud separat in kundens egen administratör när kunden ska få tillgång. Aktiveringslänken skickas via e-post; kunden loggar därefter in via /login.
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border text-xs text-muted-foreground">
                  <th className="p-3 font-semibold font-medium">Namn</th>
                  <th className="p-3 font-semibold font-medium">E-post</th>
                  <th className="p-3 font-semibold font-medium">Roll</th>
                  <th className="p-3 font-semibold font-medium text-right">Åtgärder</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users?.map(u => (
                  <UserRow key={u.id} user={u} orgId={orgId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        </>}
      </div>
    </div>
  );
}

function UserRow({ user, orgId }: { user: PlatformUser, orgId: string }) {
  const [isEditOpen, setIsEditOpen] = useState(false);

  const getRoleBadge = (role: string, isPlatformAdmin: boolean) => {
    if (isPlatformAdmin) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/10 text-red-500"><ShieldAlert className="h-3 w-3" /> Systemadmin</span>;
    if (role === "admin") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-500/10 text-orange-500"><Shield className="h-3 w-3" /> Org Admin</span>;
    if (role === "dispatcher") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/10 text-blue-500">Planerare</span>;
    if (role === "driver") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-500">Förare</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/10 text-slate-500">Läsbehörig</span>;
  };

  return (
    <tr className="group hover:bg-muted/30 transition-colors">
      <td className="p-3 font-medium text-sm">{user.name}{user.isActive === false && <span className="block text-xs text-destructive">Inaktivt konto</span>}</td>
      <td className="p-3 text-xs text-muted-foreground">{user.email}</td>
      <td className="p-3">{getRoleBadge(user.role, user.isPlatformAdmin)}</td>
      <td className="p-3 text-right">
        <div className="flex flex-wrap items-center justify-end gap-1">
          {!user.isPlatformAdmin && user.isActive !== false && <ResetPasswordButton orgId={orgId} userId={user.id} userName={user.name} />}
          
          <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
            <DialogTrigger asChild>
              <Button disabled={user.isPlatformAdmin} title="Redigera användare" aria-label={`Redigera ${user.name}`} variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                <Edit2 className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader><DialogTitle>Redigera användare</DialogTitle></DialogHeader>
              <EditUserForm user={user} orgId={orgId} onSuccess={() => setIsEditOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </td>
    </tr>
  );
}

function ResetPasswordButton({ orgId, userId, userName }: { orgId: string, userId: string, userName: string }) {
  const { toast } = useToast();
  const resetMutation = useInitiatePlatformPasswordReset();
  
  const handleReset = () => {
    if (!confirm(`Skicka en ny aktiverings-/återställningslänk till ${userName}? Användaren väljer själv sitt lösenord. Tidigare länkar blir ogiltiga.`)) return;
    
    resetMutation.mutate({
      organizationId: orgId,
      userId: userId
    }, {
      onSuccess: () => {
        toast({ title: "Återställning skickad", description: `Ett mail med instruktioner har skickats till användaren.` });
      },
      onError: () => {
        toast({ title: "Fel uppstod", description: "Kunde inte initiera lösenordsåterställning.", variant: "destructive" });
      }
    });
  };

  return (
    <Button 
      variant="ghost" 
      size="sm"
      className="h-auto min-h-8 w-auto shrink-0 px-2 py-1.5 text-muted-foreground hover:text-orange-500 hover:bg-orange-500/10"
      onClick={handleReset}
      disabled={resetMutation.isPending}
      title="Skicka ny aktiverings- eller återställningslänk"
    >
      <Key className="h-4 w-4 mr-1" /> Skicka lösenordslänk
    </Button>
  );
}

function EditUserForm({ user, orgId, onSuccess }: { user: PlatformUser, orgId: string, onSuccess: () => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [isActive, setIsActive] = useState(user.isActive ?? true);
  const [error, setError] = useState("");
  const [role, setRole] = useState<"admin" | "dispatcher" | "driver" | "viewer">(user.role as any);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdatePlatformUser();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateMutation.mutate({
      organizationId: orgId,
      userId: user.id,
      data: { name, role, email: email.trim().toLowerCase(), isActive }
    }, {
      onSuccess: () => {
        toast({ title: "Användare uppdaterad", description: "Ändringarna har sparats." });
        queryClient.invalidateQueries({ queryKey: getListPlatformUsersQueryKey(orgId) });
        onSuccess();
      },
      onError: (failure) => {
        const data = (failure as { data?: { error?: string } }).data;
        setError(data?.error || "Kunde inte uppdatera användaren.");
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-2">
      <div className="space-y-2">
        <Label htmlFor="edit-name">Namn</Label>
        <Input id="edit-name" value={name} onChange={e => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>E-postadress</Label>
        <Input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        <p className="text-xs text-muted-foreground">Ändrad inloggningsadress loggar ut användaren och ogiltigförklarar gamla aktiverings- och återställningslänkar. Skicka därefter en ny länk vid behov. Företagets kontaktmejl ändras inte.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="edit-role">Behörighetsnivå</Label>
        <Select value={role} onValueChange={(v: any) => setRole(v)}>
          <SelectTrigger id="edit-role"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Administratör</SelectItem>
            <SelectItem value="dispatcher">Planerare</SelectItem>
            <SelectItem value="driver">Förare</SelectItem>
            <SelectItem value="viewer">Läsbehörig</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} /> Aktivt konto</label>
      <p className="text-xs text-muted-foreground">Inaktiva konton kan inte logga in. Sista aktiva administratören måste finnas kvar.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="pt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onSuccess}>Avbryt</Button>
        <Button type="submit" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? "Sparar..." : "Spara ändringar"}
        </Button>
      </div>
    </form>
  );
}

function InviteUserDialog({ orgId, firstAdmin = false }: { orgId: string; firstAdmin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "dispatcher" | "driver" | "viewer">(firstAdmin ? "admin" : "dispatcher");
  useEffect(() => { if (!open) setRole(firstAdmin ? "admin" : "dispatcher"); }, [firstAdmin, open]);
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const inviteMutation = useInvitePlatformUser();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    inviteMutation.mutate({
      organizationId: orgId,
      data: { name, email, role }
    }, {
      onSuccess: () => {
        toast({ title: "Inbjudan skickad", description: `${name} har bjudits in till organisationen.` });
        queryClient.invalidateQueries({ queryKey: getListPlatformUsersQueryKey(orgId) });
        setOpen(false);
        setName("");
        setEmail("");
        setRole("dispatcher");
      },
      onError: (error) => {
        // A delivery failure can happen after the account has been created.
        // Refresh the list so the operator can send a reset link instead of
        // trying to create a duplicate account.
        queryClient.invalidateQueries({ queryKey: getListPlatformUsersQueryKey(orgId) });
        const data: unknown = (error as { data?: unknown }).data;
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error : "Kunde inte bjuda in användaren.";
        toast({ title: "Inbjudan kunde inte slutföras", description: message, variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 h-8">
          <Plus className="h-3.5 w-3.5" /> {firstAdmin ? "Bjud in första administratören" : "Bjud in användare"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Bjud in till organisationen</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="user-name">Fullständigt namn</Label>
            <Input id="user-name" value={name} onChange={e => setName(e.target.value)} required placeholder="T.ex. Anna Andersson" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-email">E-postadress</Label>
            <Input id="user-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="anna@foretaget.se" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="user-role">Behörighetsnivå</Label>
            <Select value={role} onValueChange={(v: any) => setRole(v)}>
              <SelectTrigger id="user-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Administratör</SelectItem>
                <SelectItem value="dispatcher">Planerare</SelectItem>
                <SelectItem value="driver">Förare</SelectItem>
                <SelectItem value="viewer">Läsbehörig</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="pt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Avbryt</Button>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? "Skickar..." : "Skicka inbjudan"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
