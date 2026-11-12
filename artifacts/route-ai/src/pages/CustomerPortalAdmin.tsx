import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPortalAccounts, useCreatePortalAccount, useUpdatePortalAccount, useInvitePortalAccount,
  useGetPortalContacts, useUpdatePortalContact, useListCustomers, useListOrganizationStops, useListVehicles,
  getGetPortalAccountsQueryKey, getGetPortalContactsQueryKey, getListOrganizationStopsQueryKey,
  type PortalAccount, type PortalAccountInput, type PortalContact, type Vehicle,
} from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, Mail, Pencil, Plus, RefreshCw, Search, ShieldOff, ShieldCheck, Phone, X } from "lucide-react";

function errorText(error: unknown, fallback: string): string {
  const e = error as { status?: number; data?: { error?: unknown; message?: unknown } } | null;
  const msg = typeof e?.data?.error === "string" ? e.data.error : typeof e?.data?.message === "string" ? e.data.message : null;
  if (e?.status === 403) return "Du saknar behörighet. Endast administratörer kan hantera kundportalen.";
  if (e?.status === 409) return msg ?? "E-postadressen används redan av ett annat portalkonto.";
  return msg ?? fallback;
}

function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <span>{text}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Försök igen</Button>}
    </div>
  );
}

export default function CustomerPortalAdmin() {
  const { hasRole } = useAuth();
  if (!hasRole("admin")) {
    return <AppLayout><div className="p-8"><ErrorBox text="Kundportalen administreras endast av administratörer." /></div></AppLayout>;
  }
  return (
    <AppLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Kundportal</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Ge leveransmottagare inloggning till en lugn vy med bara sina egna leveranser, status, karta och godkänd arbetskontakt.
            </p>
          </div>
          <a href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/portal`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
            Öppna portalens inloggning <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </header>
        <Tabs defaultValue="accounts">
          <TabsList>
            <TabsTrigger value="accounts" data-testid="tab-portal-accounts">Konton</TabsTrigger>
            <TabsTrigger value="contacts" data-testid="tab-portal-contacts">Arbetskontakter</TabsTrigger>
          </TabsList>
          <TabsContent value="accounts" className="mt-5"><AccountsPanel /></TabsContent>
          <TabsContent value="contacts" className="mt-5"><ContactsPanel /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}

/* ---------------- Accounts ---------------- */

function AccountsPanel() {
  const accounts = useGetPortalAccounts();
  const customers = useListCustomers({ includeArchived: false });
  const [editing, setEditing] = useState<PortalAccount | "new" | null>(null);
  const [inviteFor, setInviteFor] = useState<PortalAccount | null>(null);
  const [revokeFor, setRevokeFor] = useState<PortalAccount | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const customerName = useMemo(() => new Map((customers.data ?? []).map(c => [c.id, c.name])), [customers.data]);

  const update = useUpdatePortalAccount({
    mutation: {
      onSuccess: (a) => { void qc.invalidateQueries({ queryKey: getGetPortalAccountsQueryKey() }); toast({ title: a.enabled ? "Kontot är aktiverat" : "Åtkomsten är återkallad", description: a.enabled ? undefined : "Aktiva sessioner och återställningslänkar har upphört." }); setRevokeFor(null); },
      onError: (e) => toast({ title: "Kunde inte spara", description: errorText(e, "Försök igen."), variant: "destructive" }),
    },
  });
  const invite = useInvitePortalAccount({
    mutation: {
      onSuccess: () => { toast({ title: "Inbjudan skickad", description: inviteFor ? `E-post skickad till ${inviteFor.email}.` : undefined }); setInviteFor(null); },
      onError: (e) => toast({ title: "Inbjudan kunde inte skickas", description: errorText(e, "Försök igen."), variant: "destructive" }),
    },
  });
  const setEnabled = (a: PortalAccount, enabled: boolean) => update.mutate({ id: a.id, data: { name: a.name, email: a.email, enabled, customerIds: a.customerIds, stopIds: a.stopIds } });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{accounts.data ? `${accounts.data.length} konton` : " "}</p>
        <Button onClick={() => setEditing("new")} data-testid="button-portal-account-new"><Plus className="mr-1.5 h-4 w-4" />Nytt konto</Button>
      </div>
      {accounts.isPending && <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>}
      {accounts.isError && <ErrorBox text={errorText(accounts.error, "Kontona kunde inte hämtas.")} onRetry={() => void accounts.refetch()} />}
      {accounts.isSuccess && accounts.data.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="font-medium">Inga portalkonton än</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Skapa ett konto, välj vilka kunder eller order det får se och skicka sedan en inbjudan när du är redo.</p>
        </div>
      )}
      <div className="divide-y rounded-xl border bg-card">
        {accounts.data?.map(a => (
          <div key={a.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5" data-testid={`row-portal-account-${a.id}`}>
            <div className="min-w-[220px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{a.name}</p>
                {a.enabled ? <Badge variant="secondary">Aktivt</Badge> : <Badge variant="outline" className="text-destructive">Återkallat</Badge>}
                <Badge variant="outline">Åtkomst via mejllänk</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{a.email}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {a.customerIds.length > 0 && <>Kunder: {a.customerIds.map(id => customerName.get(id) ?? "okänd kund").join(", ")}</>}
                {a.customerIds.length > 0 && a.stopIds.length > 0 && " · "}
                {a.stopIds.length > 0 && <>{a.stopIds.length} enskilda order</>}
                {a.customerIds.length === 0 && a.stopIds.length === 0 && "Ingen åtkomst beviljad"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(a)} data-testid={`button-portal-account-edit-${a.id}`}><Pencil className="mr-1.5 h-3.5 w-3.5" />Redigera</Button>
              <Button size="sm" variant="outline" onClick={() => setInviteFor(a)} disabled={!a.enabled} data-testid={`button-portal-account-invite-${a.id}`}><Mail className="mr-1.5 h-3.5 w-3.5" />Skicka inbjudan</Button>
              {a.enabled
                ? <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevokeFor(a)}><ShieldOff className="mr-1.5 h-3.5 w-3.5" />Återkalla</Button>
                : <Button size="sm" variant="ghost" onClick={() => setEnabled(a, true)} disabled={update.isPending}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />Aktivera</Button>}
            </div>
          </div>
        ))}
      </div>

      {editing && <AccountDialog account={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}

      <AlertDialog open={!!inviteFor} onOpenChange={o => { if (!o) setInviteFor(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Skicka inbjudan?</AlertDialogTitle>
            <AlertDialogDescription>En personlig engångslänk som öppnar kundportalen utan lösenord skickas till {inviteFor?.email}. Den gäller i 30 minuter. Tidigare oanvända inloggningslänkar slutar gälla.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction disabled={invite.isPending} onClick={e => { e.preventDefault(); if (inviteFor) invite.mutate({ id: inviteFor.id }); }}>{invite.isPending ? "Skickar…" : "Skicka e-post"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revokeFor} onOpenChange={o => { if (!o) setRevokeFor(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Återkalla åtkomst för {revokeFor?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Kontot loggas ut direkt och kan inte logga in förrän det aktiveras igen. Behörigheterna sparas.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Avbryt</AlertDialogCancel>
            <AlertDialogAction disabled={update.isPending} onClick={e => { e.preventDefault(); if (revokeFor) setEnabled(revokeFor, false); }}>{update.isPending ? "Sparar…" : "Återkalla"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AccountDialog({ account, onClose }: { account: PortalAccount | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<PortalAccountInput>(() => account
    ? { name: account.name, email: account.email, enabled: account.enabled, customerIds: [...account.customerIds], stopIds: [...account.stopIds] }
    : { name: "", email: "", enabled: true, customerIds: [], stopIds: [] });
  const [error, setError] = useState<string | null>(null);
  const done = (title: string) => { void qc.invalidateQueries({ queryKey: getGetPortalAccountsQueryKey() }); toast({ title }); onClose(); };
  const create = useCreatePortalAccount({ mutation: { onSuccess: () => done("Kontot är skapat. Ingen inbjudan har skickats ännu."), onError: e => setError(errorText(e, "Kontot kunde inte skapas.")) } });
  const update = useUpdatePortalAccount({ mutation: { onSuccess: () => done("Ändringarna är sparade"), onError: e => setError(errorText(e, "Ändringarna kunde inte sparas.")) } });
  const pending = create.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault(); setError(null);
    const data = { ...form, name: form.name.trim(), email: form.email.trim() };
    if (!data.name) return setError("Ange ett namn.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return setError("Ange en giltig e-postadress.");
    if (data.customerIds.length === 0 && data.stopIds.length === 0) return setError("Välj minst en kund eller en order som kontot ska få se.");
    if (account) update.mutate({ id: account.id, data }); else create.mutate({ data });
  };
  const toggle = (key: "customerIds" | "stopIds", id: string, max: number) => setForm(f => {
    const has = f[key].includes(id);
    if (!has && f[key].length >= max) return f;
    return { ...f, [key]: has ? f[key].filter(x => x !== id) : [...f[key], id] };
  });

  return (
    <Dialog open onOpenChange={o => { if (!o && !pending) onClose(); }}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{account ? "Redigera portalkonto" : "Nytt portalkonto"}</DialogTitle>
            <DialogDescription>
              {account ? "Att spara ändringar loggar ut kontots aktiva sessioner och gör tidigare åtkomstlänkar ogiltiga." : "Att spara skickar ingen e-post. Inbjudan skickas separat med knappen Skicka inbjudan."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><Label htmlFor="pa-name">Namn</Label><Input id="pa-name" maxLength={120} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} data-testid="input-portal-account-name" /></div>
            <div><Label htmlFor="pa-email">E-post</Label><Input id="pa-email" type="email" maxLength={254} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} data-testid="input-portal-account-email" />
              <p className="mt-1 text-xs text-muted-foreground">Måste vara unik bland alla portalkonton.</p></div>
          </div>
          <label className="flex items-center gap-3 text-sm"><Switch checked={form.enabled} onCheckedChange={v => setForm(f => ({ ...f, enabled: v }))} />Kontot får logga in</label>

          <CustomerPicker selected={form.customerIds} onToggle={id => toggle("customerIds", id, 200)} />
          <StopPicker selected={form.stopIds} onToggle={id => toggle("stopIds", id, 500)} onClear={() => setForm(f => ({ ...f, stopIds: [] }))} />

          {error && <ErrorBox text={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Avbryt</Button>
            <Button type="submit" disabled={pending} data-testid="button-portal-account-save">{pending ? "Sparar…" : account ? "Spara ändringar" : "Skapa konto"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CustomerPicker({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  const customers = useListCustomers({ includeArchived: false });
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (customers.data ?? []).filter(c => !needle || c.name.toLowerCase().includes(needle) || (c.email ?? "").toLowerCase().includes(needle));
  }, [customers.data, q]);
  return (
    <fieldset className="space-y-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Hela kunder ({selected.length}/200)</legend>
      <p className="text-xs text-muted-foreground">Kontot ser <strong>alla nuvarande och framtida</strong> order för valda kunder.</p>
      <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input className="pl-8" placeholder="Sök kund" value={q} onChange={e => setQ(e.target.value)} /></div>
      {customers.isPending && <Skeleton className="h-24 w-full" />}
      {customers.isError && <ErrorBox text={errorText(customers.error, "Kunderna kunde inte hämtas.")} onRetry={() => void customers.refetch()} />}
      {customers.isSuccess && (
        <div className="max-h-52 space-y-0.5 overflow-y-auto">
          {list.length === 0 && <p className="py-3 text-sm text-muted-foreground">Inga kunder matchar.</p>}
          {list.map(c => (
            <label key={c.id} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => onToggle(c.id)} />
              <span className="flex-1">{c.name}</span>{c.email && <span className="text-xs text-muted-foreground">{c.email}</span>}
            </label>
          ))}
        </div>
      )}
      {customers.isSuccess && <p className="text-xs text-muted-foreground">Visar {list.length} av {customers.data.length} kunder.</p>}
    </fieldset>
  );
}

function StopPicker({ selected, onToggle, onClear }: { selected: string[]; onToggle: (id: string) => void; onClear: () => void }) {
  const { user } = useAuth();
  const orgId = user?.organizationId ?? "";
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const params = { organizationId: orgId, search: applied || undefined, page, pageSize };
  const stops = useListOrganizationStops(params, { query: { enabled: !!orgId, queryKey: getListOrganizationStopsQueryKey(params) } });
  const [labels, setLabels] = useState<Record<string, string>>({});
  const items = stops.data?.items ?? [];
  const pages = stops.data ? Math.max(1, Math.ceil(stops.data.total / pageSize)) : 1;
  const label = (s: { address: string; customerName?: string | null; date?: string | null }) => [s.customerName, s.address, s.date].filter(Boolean).join(" · ");
  const pick = (s: (typeof items)[number]) => { setLabels(l => ({ ...l, [s.id]: label(s as never) })); onToggle(s.id); };

  return (
    <fieldset className="space-y-2 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Enskilda order ({selected.length}/500)</legend>
      <p className="text-xs text-muted-foreground">Kontot ser <strong>bara de valda</strong> orderna, inga framtida.</p>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map(id => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
              {labels[id] ?? `Order ${id.slice(0, 8)}`}
              <button type="button" aria-label="Ta bort" onClick={() => onToggle(id)}><X className="h-3 w-3" /></button>
            </span>
          ))}
          <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" onClick={onClear}>Rensa alla</Button>
        </div>
      )}
      <div className="flex gap-2" role="search">
        <Input aria-label="Sök enskilda order" placeholder="Sök adress, kund eller referens" maxLength={200} value={search}
          onChange={e => setSearch(e.target.value)} onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); setApplied(search.trim()); setPage(1); }
          }} />
        <Button type="button" variant="outline" onClick={() => { setApplied(search.trim()); setPage(1); }}>Sök</Button>
      </div>
      {stops.isPending && <Skeleton className="h-28 w-full" />}
      {stops.isError && <ErrorBox text={errorText(stops.error, "Orderna kunde inte hämtas.")} onRetry={() => void stops.refetch()} />}
      {stops.isSuccess && (
        <>
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {items.length === 0 && <p className="py-3 text-sm text-muted-foreground">Inga order matchar.</p>}
            {items.map(s => (
              <label key={s.id} className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <Checkbox checked={selected.includes(s.id)} onCheckedChange={() => pick(s)} />
                <span className="flex-1">{s.address}</span>
                <span className="text-xs text-muted-foreground">{[s.customerName, (s as { date?: string | null }).date].filter(Boolean).join(" · ")}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{stops.data.total} order totalt · sida {page} av {pages}</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={page <= 1 || stops.isFetching} onClick={() => setPage(p => p - 1)}>Föregående</Button>
              <Button type="button" size="sm" variant="outline" disabled={page >= pages || stops.isFetching} onClick={() => setPage(p => p + 1)}>Nästa</Button>
            </div>
          </div>
        </>
      )}
    </fieldset>
  );
}

/* ---------------- Contacts ---------------- */

function ContactsPanel() {
  const { user } = useAuth();
  const vehicles = useListVehicles({ organizationId: user?.organizationId });
  const contacts = useGetPortalContacts();
  const byVehicle = useMemo(() => new Map((contacts.data ?? []).map(c => [c.vehicleId, c])), [contacts.data]);
  const loading = vehicles.isPending || contacts.isPending;
  return (
    <section className="space-y-4">
      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
        Mottagare ser en kontakt bara när fordonet kör deras leverans och kontakten är <strong>godkänd</strong>. Ange ett arbetsnummer, till exempel en tjänstetelefon i bilen eller trafikledningen. Förarens privata nummer kopieras aldrig hit automatiskt.
      </div>
      {loading && <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>}
      {vehicles.isError && <ErrorBox text={errorText(vehicles.error, "Fordonen kunde inte hämtas.")} onRetry={() => void vehicles.refetch()} />}
      {contacts.isError && <ErrorBox text={errorText(contacts.error, "Kontakterna kunde inte hämtas.")} onRetry={() => void contacts.refetch()} />}
      {!loading && vehicles.isSuccess && contacts.isSuccess && (vehicles.data.length === 0
        ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Inga fordon finns. Lägg till fordon under Flotta först.</div>
        : <div className="divide-y rounded-xl border bg-card">{vehicles.data.map(v => <ContactRow key={v.id} vehicle={v} contact={byVehicle.get(v.id) ?? null} />)}</div>)}
    </section>
  );
}

function ContactRow({ vehicle, contact }: { vehicle: Vehicle; contact: PortalContact | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(contact?.name ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [enabled, setEnabled] = useState(contact?.enabled ?? false);
  const [error, setError] = useState<string | null>(null);
  const save = useUpdatePortalContact({
    mutation: {
      onSuccess: () => { void qc.invalidateQueries({ queryKey: getGetPortalContactsQueryKey() }); toast({ title: `Kontakt sparad för ${vehicle.name}` }); },
      onError: e => setError(errorText(e, "Kontakten kunde inte sparas. Kontrollera telefonnumret.")),
    },
  });
  const dirty = name !== (contact?.name ?? "") || phone !== (contact?.phone ?? "") || enabled !== (contact?.enabled ?? false);
  const submit = (e: FormEvent) => {
    e.preventDefault(); setError(null);
    if (enabled && (!name.trim() || !phone.trim())) return setError("Namn och telefonnummer krävs för att godkänna kontakten.");
    save.mutate({ vehicleId: vehicle.id, data: { name: name.trim(), phone: phone.trim(), enabled } });
  };
  return (
    <form onSubmit={submit} className="grid gap-3 px-4 py-3.5 md:grid-cols-[200px_1fr_1fr_auto_auto] md:items-center" data-testid={`row-portal-contact-${vehicle.id}`}>
      <div>
        <p className="font-medium">{vehicle.name}</p>
        <p className="text-xs text-muted-foreground">{vehicle.licensePlate || "Regnummer saknas"}</p>
      </div>
      <Input aria-label="Kontaktnamn" placeholder="Visningsnamn, t.ex. Förare bil 12" maxLength={120} value={name} onChange={e => setName(e.target.value)} />
      <div className="relative"><Phone className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input aria-label="Arbetsnummer" className="pl-8" type="tel" placeholder="Arbetsnummer" maxLength={40} value={phone} onChange={e => setPhone(e.target.value)} /></div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} />{enabled ? "Godkänd" : "Ej godkänd"}</label>
      <Button type="submit" size="sm" disabled={!dirty || save.isPending}>{save.isPending ? "Sparar…" : "Spara"}</Button>
      {error && <div className="md:col-span-5"><ErrorBox text={error} /></div>}
    </form>
  );
}
