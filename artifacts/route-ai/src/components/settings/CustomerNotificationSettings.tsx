import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, MessageSquare, Info, Truck, CalendarCheck, CircleCheck, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.VITE_API_URL || "";

import type { CustomerNotificationConfig } from "@workspace/api-client-react";
type Channel = CustomerNotificationConfig["channel"];
type EventKey = "planned" | "approaching" | "completed";
type EventConfig = { enabled: boolean; sms: string; subject: string; email: string };
export type CustomerNotifications = CustomerNotificationConfig;
type FieldName = "sms" | "subject" | "email";

const LIMITS: Record<FieldName, number> = { sms: 1600, subject: 200, email: 5000 };

const DEFAULTS: CustomerNotifications = {
  channel: "sms",
  events: {
    planned: { enabled: false, sms: "Hej {{customer_name}}! Ditt besök är planerat till {{date}} {{time_window}}. {{company}}", subject: "Ditt besök är planerat", email: "Hej {{customer_name}}!\nDitt besök på {{address}} är planerat till {{date}} {{time_window}}.\n{{tracking_url}}\n{{company}}" },
    approaching: { enabled: false, sms: "Hej {{customer_name}}! Vi är på väg till dig på {{address}}. {{tracking_url}} {{company}}", subject: "Vi är på väg till dig", email: "Hej {{customer_name}}!\n{{resource_name}} är på väg till dig på {{address}}.\nFölj aktuell status: {{tracking_url}}\n{{company}}" },
    completed: { enabled: false, sms: "Hej {{customer_name}}! Ditt uppdrag på {{address}} är slutfört. {{company}}", subject: "Ditt uppdrag är slutfört", email: "Hej {{customer_name}}!\nDitt uppdrag på {{address}} är nu slutfört.\n{{tracking_url}}\n{{company}}" },
  },
};

const FIELDS: { token: string; label: string; example: string }[] = [
  { token: "{{customer_name}}", label: "Kundnamn", example: "Exempelkund AB" },
  { token: "{{address}}", label: "Adress", example: "Exempelvägen 12, 123 45 Exempelstad" },
  { token: "{{date}}", label: "Datum", example: "14 mars" },
  { token: "{{time_window}}", label: "Tidsfönster", example: "09:30–11:00" },
  { token: "{{resource_name}}", label: "Resurs", example: "Bil 7" },
  { token: "{{company}}", label: "Företag", example: "Ditt företag" },
  { token: "{{tracking_url}}", label: "Spårningslänk", example: "[exempellänk – ingen riktig länk]" },
];

const EVENTS: { key: EventKey; title: string; trigger: string; icon: typeof Truck }[] = [
  { key: "planned", title: "Leverans planerad", icon: CalendarCheck,
    trigger: "Skickas när en godkänd rutt skickas ut till förare. Optimeringar och utkast skickar aldrig." },
  { key: "approaching", title: "På väg till dig", icon: Truck,
    trigger: "Avstängd som standard. Skickas när den godkända körningen är aktiv och kunden är nästa destination, enligt samma villkor som kundkartan. SMS kräver en giltig kundlänk och skickas inte igen om den redan skickats manuellt." },
  { key: "completed", title: "Uppdrag slutfört", icon: CircleCheck,
    trigger: "Skickas endast när stoppet markeras slutfört, aldrig vid misslyckat eller överhoppat." },
];

function normalize(raw: unknown): CustomerNotifications {
  const r = (raw ?? {}) as Partial<CustomerNotifications>;
  const channel: Channel = r.channel === "email" || r.channel === "both" ? r.channel : "sms";
  const ev = (k: EventKey): EventConfig => {
    const e = (r.events?.[k] ?? {}) as Partial<EventConfig>;
    return {
      enabled: e.enabled === true,
      sms: typeof e.sms === "string" ? e.sms : DEFAULTS.events[k].sms,
      subject: typeof e.subject === "string" ? e.subject : DEFAULTS.events[k].subject,
      email: typeof e.email === "string" ? e.email : DEFAULTS.events[k].email,
    };
  };
  return { channel, events: { planned: ev("planned"), approaching: ev("approaching"), completed: ev("completed") } };
}

type AttemptStatus = "sending" | "sent" | "failed" | "unknown" | "missing_recipient" | "channel_unavailable" | "rejected";
type NotificationAttempt = { id: string; stopId: string; event: EventKey; channel: "sms" | "email"; status: AttemptStatus; createdAt: string; revision: number; updatedAt: string; history: Array<{status: string; at: string}> };

const EVENT_LABEL: Record<EventKey, string> = { planned: "Leverans planerad", approaching: "På väg till dig", completed: "Uppdrag slutfört" };
const STATUS_LABEL: Record<AttemptStatus, { text: string; tone: string }> = {
  rejected: { text: "Bekräftat avvisat – inte accepterat", tone: "text-destructive" },
  sent: { text: "Accepterat av leverantör", tone: "text-emerald-700 dark:text-emerald-400" },
  sending: { text: "Påbörjat, leverans ej bekräftad", tone: "text-amber-700 dark:text-amber-400" },
  failed: { text: "Utskicket kunde inte bekräftas", tone: "text-destructive" },
  unknown: { text: "Utskicket kunde inte bekräftas", tone: "text-destructive" },
  missing_recipient: { text: "Mottagare saknas (inget nummer/adress på stoppet)", tone: "text-muted-foreground" },
  channel_unavailable: { text: "Kanalen är inte konfigurerad hos leverantör", tone: "text-muted-foreground" },
};

function formatDate(v: string) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

function AttemptsTable({ attempts, organizationId }: { attempts: NotificationAttempt[]; organizationId?: string }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<NotificationAttempt | null>(null);
  const [recipient, setRecipient] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const recover = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Välj ett utskick.");
      const response = await fetch(`${API_BASE}/api/organizations/${organizationId}/customer-notifications/${selected.id}/recover`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: selected.revision, recipient }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Resultatet kunde inte bekräftas. Uppdatera listan innan du gör något mer.");
      }
    },
    onSuccess: () => {
      setSelected(null); setRecipient("");
      toast({ title: "Återhanteringen är behandlad", description: "Se aktuell status i listan. Leverans till kunden är inte bekräftad." });
    },
    onError: (error: Error) => toast({ title: "Kunde inte återhantera", description: error.message, variant: "destructive" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["/api/org-settings", organizationId] }),
  });
  return (
    <div className="bg-card rounded-xl border border-border" data-testid="section-notification-attempts">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        data-testid="button-toggle-attempts"
        className="flex w-full items-center justify-between gap-2 p-4 text-left"
      >
        <span className="text-sm font-medium">Senaste utskicksförsök <span className="text-muted-foreground font-normal">({attempts.length})</span></span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-border p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            "Accepterat av leverantör" betyder att LINK Mobility eller Resend tog emot meddelandet, inte att kunden fått det.
            Osäkra utskick försöks aldrig igen automatiskt, för att undvika dubbla meddelanden till kunden.
            Även manuella återförsök spärras vid osäkert resultat, serveravbrott och äldre obekräftade fel.
          </p>
          {selected && (
            <form className="space-y-2 border rounded p-3" onSubmit={e => { e.preventDefault(); recover.mutate(); }}>
              <p className="text-sm">Återhantera {EVENT_LABEL[selected.event]} via {selected.channel === "sms" ? "SMS" : "e-post"} för stopp {selected.stopId}.</p>
              <Label htmlFor="recovery-recipient">Bekräfta rätt mottagare</Label>
              <Input id="recovery-recipient" type={selected.channel === "email" ? "email" : "tel"} value={recipient} onChange={e => setRecipient(e.target.value)} required maxLength={254} disabled={recover.isPending} />
              <p className="text-xs text-muted-foreground">Gäller bara detta kundutskick. Stoppets kontaktuppgifter ändras inte. Aktuella sparade mallar används. Skicka bara om händelsen fortfarande är relevant.</p>
              <Button type="submit" size="sm" disabled={recover.isPending || !recipient.trim()}>Bekräfta och skicka</Button>
              <Button type="button" variant="ghost" size="sm" disabled={recover.isPending} onClick={() => setSelected(null)}>Avbryt</Button>
            </form>
          )}
          {attempts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-attempts-empty">Inga utskicksförsök ännu.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1.5 pr-3 font-medium">Tid</th>
                    <th className="py-1.5 pr-3 font-medium">Händelse</th>
                    <th className="py-1.5 pr-3 font-medium">Kanal</th>
                    <th className="py-1.5 pr-3 font-medium">Stopp</th>
                    <th className="py-1.5 font-medium">Status</th>
                    <th className="py-1.5 font-medium">Återhantering</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map(a => {
                    const st = STATUS_LABEL[a.status] ?? { text: a.status, tone: "text-muted-foreground" };
                    return (
                      <tr key={a.id} className="border-t border-border/60" data-testid={`row-attempt-${a.id}`}>
                        <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{formatDate(a.createdAt)}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{EVENT_LABEL[a.event] ?? a.event}</td>
                        <td className="py-1.5 pr-3">{a.channel === "email" ? "E-post" : "SMS"}</td>
                        <td className="py-1.5 pr-3 font-mono">{String(a.stopId)}</td>
                        <td className={cn("py-1.5", st.tone)}>{st.text}</td>
                        <td className="py-1.5">
                          {["missing_recipient", "rejected"].includes(a.status)
                            ? <Button variant="outline" size="sm" disabled={recover.isPending} onClick={() => { setSelected(a); setRecipient(""); }}>Återhantera</Button>
                            : <span className="text-muted-foreground">Spärrat för återförsök</span>}
                          {a.revision > 0 && <p className="text-muted-foreground">Återhanterat {a.revision} gång(er). Senast {formatDate(a.updatedAt)}</p>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function renderPreview(text: string) {
  return FIELDS.reduce((acc, f) => acc.split(f.token).join(f.example), text);
}

export function CustomerNotificationSettings() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["/api/org-settings", organizationId];
  const url = `${API_BASE}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`;

  const { data, isLoading, isError, refetch } = useQuery<{ customerNotifications?: unknown; notificationAttempts?: NotificationAttempt[] }>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Kunde inte hämta inställningar");
      return res.json();
    },
    enabled: !!organizationId,
    refetchInterval: 15_000,
  });

  const lastFocused = useRef<{ event: EventKey; field: FieldName; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [form, setForm] = useState<CustomerNotifications>(DEFAULTS);
  const [dirty, setDirty] = useState(false);
  const [hydratedOrg, setHydratedOrg] = useState<number | string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const hydrated = !!organizationId && hydratedOrg === organizationId;

  // Org switch: drop previous tenant form immediately, before new data arrives.
  useEffect(() => {
    setForm(DEFAULTS);
    setDirty(false);
    dirtyRef.current = false;
    setHydratedOrg(null);
    lastFocused.current = null;
    setFocusLabel(null);
  }, [organizationId]);

  useEffect(() => {
    if (!data || !organizationId) return;
    if (dirtyRef.current) return;
    setForm(normalize(data.customerNotifications));
    setHydratedOrg(organizationId);
  }, [data, organizationId]);


  const save = useMutation({
    onMutate: () => organizationId,
    mutationFn: async (payload: CustomerNotifications) => {
      const res = await fetch(url, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerNotifications: payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || body?.message || `Sparandet misslyckades (${res.status})`);
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: (_r, _v, ctx) => {
      if (ctx !== organizationId) return;
      setDirty(false);
      dirtyRef.current = false;
      queryClient.resetQueries({ queryKey: ["/api/org-settings", organizationId] });
      toast({ title: "Kundaviseringar sparade", description: "Inga meddelanden skickades." });
    },
    onError: (e: Error) => toast({ title: "Kunde inte spara", description: e.message, variant: "destructive" }),
  });

  const updateEvent = (k: EventKey, patch: Partial<EventConfig>) => {
    setDirty(true);
    setForm(p => ({ ...p, events: { ...p.events, [k]: { ...p.events[k], ...patch } } }));
  };

  const insertToken = (token: string) => {
    const target = lastFocused.current;
    if (!target) {
      toast({ title: "Välj ett textfält först", description: "Klicka i ett SMS-, ämnes- eller e-postfält." });
      return;
    }
    const { event, field, el } = target;
    const current = form.events[event][field];
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = (current.slice(0, start) + token + current.slice(end)).slice(0, LIMITS[field]);
    updateEvent(event, { [field]: next });
    requestAnimationFrame(() => {
      el.focus();
      const pos = Math.min(start + token.length, next.length);
      el.setSelectionRange(pos, pos);
    });
  };

  const track = (event: EventKey, field: FieldName, label: string) => (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    lastFocused.current = { event, field, el: e.currentTarget };
    setFocusLabel(label);
  };

  const showSms = form.channel !== "email";
  const showEmail = form.channel !== "sms";
  const activeCount = useMemo(() => Object.values(form.events).filter(e => e.enabled).length, [form.events]);

  if (isLoading || (!isError && !hydrated)) {
    return (
      <div className="space-y-4" data-testid="status-notifications-loading">
        <div className="h-8 w-64 rounded bg-muted animate-pulse" />
        {[0, 1, 2].map(i => <div key={i} className="h-40 rounded-xl bg-muted/60 animate-pulse" />)}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 space-y-3">
        <p className="font-medium">Kunde inte hämta aviseringsinställningar.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry-notifications">Försök igen</Button>
      </div>
    );
  }

  const textareaCls = "w-full min-h-[96px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Kundaviseringar</h1>
        <p className="text-muted-foreground mt-1">
          Automatiska meddelanden till dina kunder. {activeCount} av 3 händelser aktiva.
        </p>
      </div>

      <div className="flex gap-2 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm" data-testid="text-notifications-migration">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
        <p>
          De tidigare globala aviseringsvalen och den gemensamma mallen är ersatta av tre separata mallar nedan.
          Varje händelse måste aktiveras uttryckligen, allt är avstängt från början.
          Kunden får inget meddelande när ett stopp misslyckas eller hoppas över.
        </p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="notif-channel">Kanal</Label>
          <select
            id="notif-channel"
            data-testid="select-notification-channel"
            value={form.channel}
            onChange={e => { setDirty(true); setForm(p => ({ ...p, channel: e.target.value as Channel })); }}
            className="h-10 w-full md:w-72 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="sms">SMS</option>
            <option value="email">E-post</option>
            <option value="both">SMS och e-post</option>
          </select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div className={cn("flex items-center gap-2 rounded-lg border border-border p-3", !showSms && "opacity-50")}>
            <MessageSquare className="h-4 w-4 text-primary" />
            <span>SMS via <span className="font-medium">LINK Mobility</span></span>
          </div>
          <div className={cn("flex items-center gap-2 rounded-lg border border-border p-3", !showEmail && "opacity-50")}>
            <Mail className="h-4 w-4 text-primary" />
            <span>E-post via <span className="font-medium">Resend</span> från <span className="font-mono text-xs">noreply@traivo.se</span></span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Att spara skickar aldrig några meddelanden.</p>
      </div>

      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur rounded-xl border border-border p-4 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-medium">Infoga fält</p>
          <p className="text-xs text-muted-foreground" data-testid="text-insert-target">
            {focusLabel ? `Infogas i: ${focusLabel}` : "Klicka i ett textfält först"}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FIELDS.map(f => (
            <button
              key={f.token}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => insertToken(f.token)}
              data-testid={`button-insert-${f.token.replace(/[{}]/g, "")}`}
              className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-mono text-primary hover:bg-primary/15 transition-colors"
              title={f.label}
            >
              {f.token}
            </button>
          ))}
        </div>
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          Fält utan uppgift lämnas tomma. {"{{tracking_url}}"} fylls bara i om en säker spårningslänk redan finns för stoppet, annars blir den tom.
        </p>
      </div>

      {EVENTS.map(ev => {
        const cfg = form.events[ev.key];
        const smsPreview = renderPreview(cfg.sms);
        return (
          <section key={ev.key} className="bg-card rounded-xl border border-border p-6 space-y-4" data-testid={`section-event-${ev.key}`}>
            <div className="flex items-start gap-3">
              <Checkbox
                id={`enable-${ev.key}`}
                checked={cfg.enabled}
                onCheckedChange={v => updateEvent(ev.key, { enabled: v === true })}
                data-testid={`checkbox-enable-${ev.key}`}
              />
              <div className="flex-1">
                <Label htmlFor={`enable-${ev.key}`} className="flex items-center gap-2 text-base font-semibold">
                  <ev.icon className="h-4 w-4 text-primary" />
                  {ev.title}
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium",
                    cfg.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground")}>
                    {cfg.enabled ? "Aktiv" : "Av"}
                  </span>
                </Label>
                <p className="text-xs text-muted-foreground mt-1">{ev.trigger}</p>
              </div>
            </div>

            {showSms && (
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <Label htmlFor={`sms-${ev.key}`} className="text-xs">SMS-text</Label>
                  <span className={cn("text-xs tabular-nums", cfg.sms.length >= LIMITS.sms ? "text-destructive" : "text-muted-foreground")} data-testid={`text-sms-count-${ev.key}`}>
                    {cfg.sms.length}/{LIMITS.sms}
                  </span>
                </div>
                <textarea
                  id={`sms-${ev.key}`}
                  data-testid={`input-sms-${ev.key}`}
                  className={textareaCls}
                  maxLength={LIMITS.sms}
                  value={cfg.sms}
                  onFocus={track(ev.key, "sms", `${ev.title} – SMS`)}
                  onChange={e => updateEvent(ev.key, { sms: e.target.value })}
                  placeholder="Hej {{customer_name}}, ..."
                />
              </div>
            )}

            {showEmail && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex justify-between">
                    <Label htmlFor={`subject-${ev.key}`} className="text-xs">E-postämne</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">{cfg.subject.length}/{LIMITS.subject}</span>
                  </div>
                  <Input
                    id={`subject-${ev.key}`}
                    data-testid={`input-subject-${ev.key}`}
                    maxLength={LIMITS.subject}
                    value={cfg.subject}
                    onFocus={track(ev.key, "subject", `${ev.title} – ämne`)}
                    onChange={e => updateEvent(ev.key, { subject: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between">
                    <Label htmlFor={`email-${ev.key}`} className="text-xs">E-posttext</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">{cfg.email.length}/{LIMITS.email}</span>
                  </div>
                  <textarea
                    id={`email-${ev.key}`}
                    data-testid={`input-email-${ev.key}`}
                    className={cn(textareaCls, "min-h-[140px]")}
                    maxLength={LIMITS.email}
                    value={cfg.email}
                    onFocus={track(ev.key, "email", `${ev.title} – e-post`)}
                    onChange={e => updateEvent(ev.key, { email: e.target.value })}
                  />
                </div>
              </div>
            )}

            {(cfg.sms || cfg.subject || cfg.email) && (
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 space-y-2" data-testid={`preview-${ev.key}`}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Förhandsvisning med påhittade exempeldata, ingen riktig länk
                </p>
                {showSms && cfg.sms && (
                  <div className="text-sm whitespace-pre-wrap">
                    <span className="text-xs text-muted-foreground block mb-0.5">SMS · {smsPreview.length} tecken</span>
                    {smsPreview}
                  </div>
                )}
                {showEmail && (cfg.subject || cfg.email) && (
                  <div className="text-sm whitespace-pre-wrap">
                    <span className="text-xs text-muted-foreground block mb-0.5">E-post</span>
                    {cfg.subject && <p className="font-medium">{renderPreview(cfg.subject)}</p>}
                    {renderPreview(cfg.email)}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      <AttemptsTable key={organizationId} organizationId={organizationId} attempts={Array.isArray(data?.notificationAttempts) ? data!.notificationAttempts.slice(0, 20) : []} />

      <div className="flex items-center justify-end gap-3">
        {dirty && <span className="text-xs text-muted-foreground" data-testid="status-unsaved">Osparade ändringar</span>}
        <Button
          onClick={() => save.mutate(form)}
          disabled={save.isPending || !dirty || !hydrated}
          data-testid="button-save-customer-notifications"
        >
          {save.isPending ? "Sparar..." : "Spara"}
        </Button>
      </div>
    </div>
  );
}
