import { useEffect, useMemo, useState } from "react";
import { Link, useSearch } from "wouter";
import { Plus, Edit2, Clock, MapPin, Phone, Mail, Coffee, BarChart3, Link2, UserCog, AlertTriangle, Search } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { buildProfileByResourceId } from "@/lib/resources";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { VehicleForm } from "@/pages/Vehicles";
import { useAppUsers } from "@/pages/Users";
import type { Vehicle } from "@workspace/api-client-react";

const hm = (v?: string | null) => (v ? v.slice(0, 5) : null);
const range = (a?: string | null, b?: string | null) => (hm(a) && hm(b) ? `${hm(a)}–${hm(b)}` : null);

/**
 * Förare: driver-focused view of canonical resources (vehicle + operational profile).
 * Creation and edits go through VehicleForm's atomic create/update; no separate driver CRUD.
 */
export default function Drivers() {
  const { hasRole } = useAuth();
  if (!hasRole("admin", "dispatcher")) {
    return <AppLayout><p role="alert" className="p-5">Du saknar behörighet att hantera förare.</p></AppLayout>;
  }
  return <DriverResources />;
}

function DriverResources() {
  const { user, isAdmin } = useAuth();
  const { data: vehicles, isLoading, isError, refetch } = useVehicles();
  const { data: drivers } = useDrivers();
  // Admin-only: never fetched for dispatchers.
  const { data: users, isLoading: accountsLoading, isError: accountsError } = useAppUsers(user?.organizationId, isAdmin);
  const search = useSearch();
  const focusId = useMemo(() => new URLSearchParams(search).get("resourceId"), [search]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [creating, setCreating] = useState(false);

  const profiles = useMemo(() => buildProfileByResourceId(vehicles, drivers), [vehicles, drivers]);
  const accountByResource = useMemo(() => {
    const m = new Map<string, { id: string; name: string; email: string }[]>();
    users?.forEach((u) => {
      if (!u.resourceId) return;
      m.set(u.resourceId, [...(m.get(u.resourceId) ?? []), u]);
    });
    return m;
  }, [users]);

  useEffect(() => {
    if (!focusId || !vehicles) return;
    const el = document.getElementById(`driver-row-${focusId}`);
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  }, [focusId, vehicles]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (vehicles ?? []).filter((v) => {
      if (!q) return true;
      const p = profiles.get(v.id);
      return [v.name, v.licensePlate, p?.phone, p?.email, p?.startAddress].some((x) => x?.toLowerCase().includes(q));
    });
  }, [vehicles, profiles, query]);

  if (isLoading) return <AppLayout><LoadingState message="Laddar förare…" /></AppLayout>;

  return (
    <AppLayout>
      <div className="p-5">
        <div className="mb-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Förare</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Arbetstid, lunchrast och start-/slutadress per resurs. Samma profil som under Resurser.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sök förare" aria-label="Sök förare" className="h-9 w-48 pl-8 text-xs" />
            </div>
            {isAdmin && (
              <Button asChild size="sm" variant="outline" className="gap-1.5 text-xs">
                <Link href="/users"><UserCog className="h-3.5 w-3.5" /> Användarkonton</Link>
              </Button>
            )}
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => setCreating(true)} data-testid="button-add-driver">
              <Plus className="h-3.5 w-3.5" /> Ny förare
            </Button>
          </div>
        </div>

        {isError && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Kunde inte hämta förare.
            <Button size="sm" variant="outline" onClick={() => void refetch()}>Försök igen</Button>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <DualHorizontalScroll label="Rulla horisontellt">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs text-muted-foreground">
                  <th className="whitespace-nowrap p-3 font-semibold">Förare</th>
                  <th className="whitespace-nowrap p-3 font-semibold">Kontakt</th>
                  <th className="whitespace-nowrap p-3 font-semibold">Arbetstid</th>
                  <th className="whitespace-nowrap p-3 font-semibold">Lunchrast</th>
                  <th className="whitespace-nowrap p-3 font-semibold">Startadress</th>
                  <th className="whitespace-nowrap p-3 font-semibold">Slutadress</th>
                  {isAdmin && <th className="whitespace-nowrap p-3 font-semibold">Konto</th>}
                  <th className="sticky right-0 z-10 bg-muted p-3 text-right font-semibold shadow-[-1px_0_0_0_hsl(var(--border))]">Åtgärder</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((v) => {
                  const p = profiles.get(v.id);
                  const accounts = accountByResource.get(v.id) ?? [];
                  const focused = focusId === v.id;
                  return (
                    <tr
                      key={v.id}
                      id={`driver-row-${v.id}`}
                      tabIndex={-1}
                      className={cn("group text-xs outline-none transition-colors", focused ? "bg-primary/10 ring-2 ring-inset ring-primary/40" : "hover:bg-muted/30")}
                    >
                      <td className="whitespace-nowrap p-3">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/20" style={{ backgroundColor: v.routeColor }} aria-hidden="true" />
                          <span className="text-sm font-bold text-foreground">{v.name}</span>
                        </div>
                        {v.licensePlate && <span className="mt-0.5 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{v.licensePlate}</span>}
                      </td>
                      <td className="whitespace-nowrap p-3 text-muted-foreground">
                        {p?.phone && <div className="flex items-center gap-1"><Phone className="h-3 w-3" />{p.phone}</div>}
                        {p?.email && <div className="flex items-center gap-1"><Mail className="h-3 w-3" />{p.email}</div>}
                        {!p?.phone && !p?.email && <span className="italic">Saknas</span>}
                      </td>
                      {p ? (
                        <>
                          <td className="whitespace-nowrap p-3 font-mono tabular-nums"><span className="inline-flex items-center gap-1"><Clock className="h-3 w-3 text-muted-foreground" />{range(p.workStartTime, p.workEndTime) ?? <span className="font-sans italic text-muted-foreground">Ej angiven</span>}</span></td>
                          <td className="whitespace-nowrap p-3 font-mono tabular-nums"><span className="inline-flex items-center gap-1"><Coffee className="h-3 w-3 text-muted-foreground" />{range(p.breakStartTime, p.breakEndTime) ?? <span className="font-sans italic text-muted-foreground">Ingen</span>}</span></td>
                          <td className="max-w-[220px] p-3"><Addr value={p.startAddress} /></td>
                          <td className="max-w-[220px] p-3"><Addr value={p.endAddress} /></td>
                        </>
                      ) : (
                        <td colSpan={4} className="p-3">
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" />Driftprofil behöver granskas under Resurser</span>
                        </td>
                      )}
                      {isAdmin && (
                        <td className="whitespace-nowrap p-3">
                          {accountsError ? <span role="status">Kontouppgifter kunde inte hämtas</span>
                            : accountsLoading ? <span role="status">Laddar kontouppgifter…</span>
                            : accounts.length ? accounts.map((a) => (
                            <Link key={a.id} href="/users" className="flex items-center gap-1 text-emerald-600 hover:underline dark:text-emerald-400" title={`Hanteras under Användare: ${a.email}`}>
                              <Link2 className="h-3 w-3" />{a.name}
                            </Link>
                          )) : <span className="text-muted-foreground">Inget konto</span>}
                        </td>
                      )}
                      <td className={cn("sticky right-0 z-10 px-3 py-1 text-right shadow-[-1px_0_0_0_hsl(var(--border))]", focused ? "bg-muted" : "bg-card group-hover:bg-muted")}>
                        <div className="flex items-center justify-end gap-1">
                          {p && (
                            <Button asChild variant="ghost" size="icon" className="h-11 w-11" title="Statistik">
                              <Link href={`/drivers/${p.id}`} aria-label={`Statistik: ${v.name}`}><BarChart3 className="h-5 w-5" /></Link>
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="icon" className="h-11 w-11 hover:bg-primary/10 hover:text-primary"
                            title={p ? "Redigera" : "Driftprofilen är tvetydig – granska under Resurser"}
                            aria-label={`Redigera ${v.name}`}
                            disabled={!p}
                            onClick={() => setEditing(v)}
                          >
                            <Edit2 className="h-5 w-5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={isAdmin ? 8 : 7} className="p-10 text-center">
                      <p className="font-medium text-foreground">{query ? "Inga förare matchar sökningen" : "Inga förare ännu"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Lägg till en förare med arbetstid och startadress för att börja planera.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </DualHorizontalScroll>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          En förare behöver inget inloggningskonto för att planeras. {isAdmin ? "Konton kopplas och underhålls under Användare; inga inbjudningar skickas automatiskt." : "Konton hanteras av administratör."}
        </p>

        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
            <DialogHeader>
              <DialogTitle>Ny förare</DialogTitle>
              <DialogDescription>Skapar en resurs med driftprofil i ett steg.</DialogDescription>
            </DialogHeader>
            {creating && <VehicleForm variant="driver" onSuccess={() => setCreating(false)} />}
          </DialogContent>
        </Dialog>

        <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]">
            <DialogHeader>
              <DialogTitle>Redigera förare</DialogTitle>
              <DialogDescription>{editing?.name}</DialogDescription>
            </DialogHeader>
            {editing && profiles.get(editing.id) && (
              <VehicleForm variant="driver" initialData={editing} initialDriver={profiles.get(editing.id)} onSuccess={() => setEditing(null)} />
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

function Addr({ value }: { value?: string | null }) {
  if (!value) return <span className="italic text-muted-foreground">Ej angiven</span>;
  return <span className="flex items-start gap-1 truncate" title={value}><MapPin className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" /><span className="truncate">{value}</span></span>;
}
