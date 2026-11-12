import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarDays, Check, ChevronLeft, ChevronRight, CircleHelp, Clock3, Database, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Cost = number | null;
type Settings = { warnStops: number | null; blockStops: number | null; warnMonthlyRuns: number | null; blockMonthlyRuns: number | null; revenueOre: Cost };
type Rate = { provider: string; operation: string; effectiveFrom: string; unitCostOre: number };
type Usage = {
  month: string;
  summary: { runs: number; largeRuns: number; plannedStops: number; estimatedCostOre: Cost; revenueOre: Cost; marginOre: Cost; unknownCost: boolean };
  breakdown: { provider: string; operation: string; category: string; outcome: string; cacheStatus: string; retry: boolean; units: number; calls: number; estimatedCostOre: Cost }[];
  jobs: { jobId: string; status: string; stopCount: number; engine: string; sizeClass: string; durationMs: number; occurredAt: string }[];
  settings: Settings;
  rates: Rate[];
};

const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const api = (path: string) => `${base}/api/platform${path}`;
const number = new Intl.NumberFormat("sv-SE");
const money = (ore: Cost) => ore === null ? "Okänt" : `${new Intl.NumberFormat("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ore / 100)} kr`;
const outcomeLabel = (outcome: string) => ({
  started: "Startat", complete: "Klart", success: "Lyckades",
  error: "Fel", failure: "Misslyckades", blocked: "Blockerat",
} as Record<string, string>)[outcome] ?? outcome;
const monthLabel = (month: string) => new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
const dateTime = (date: string) => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf()) ? date : new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "short" }).format(parsed);
};
const shiftMonth = (month: string, delta: number) => {
  const [year, mm] = month.split("-").map(Number);
  const d = new Date(Date.UTC(year, mm - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(path), {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.error === "string" ? body.error : `Kunde inte slutföra begäran (${res.status}).`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function Feedback({ message, error }: { message: string | null; error?: boolean }) {
  return message ? <p role="status" className={`text-xs font-medium ${error ? "text-destructive" : "text-emerald-500"}`}>{message}</p> : null;
}

function Stat({ label, value, note, tone = "normal" }: { label: string; value: string; note: string; tone?: "normal" | "cyan" | "amber" }) {
  return <div className={`min-w-0 border-l-2 pl-3 py-1 ${tone === "cyan" ? "border-primary" : tone === "amber" ? "border-amber-500" : "border-border"}`}>
    <p className="text-[10px] font-bold tracking-[0.15em] uppercase text-muted-foreground">{label}</p>
    <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-foreground" data-testid={`value-${label.toLowerCase().replaceAll(" ", "-")}`}>{value}</p>
    <p className="text-[11px] text-muted-foreground mt-0.5">{note}</p>
  </div>;
}

function SettingsPanel({ organizationId, month, settings }: { organizationId: string; month: string; settings: Settings }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Settings>(settings);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { setDraft(settings); setFeedback(null); }, [settings, organizationId, month]);
  const mutation = useMutation({
    mutationFn: (payload: Settings) => request<unknown>(`/organizations/${encodeURIComponent(organizationId)}/usage/settings?month=${encodeURIComponent(month)}`, { method: "PUT", body: JSON.stringify(payload) }),
    onSuccess: () => { setError(false); setFeedback("Månadens inställningar sparades."); client.invalidateQueries({ queryKey: ["platform-usage", organizationId, month] }); },
    onError: (err: Error) => { setError(true); setFeedback(err.message); },
  });
  const setInteger = (key: keyof Pick<Settings, "warnStops" | "blockStops" | "warnMonthlyRuns" | "blockMonthlyRuns">, raw: string) =>
    setDraft(current => ({ ...current, [key]: raw === "" ? null : Number(raw) }));
  const valid = [draft.warnStops, draft.blockStops, draft.warnMonthlyRuns, draft.blockMonthlyRuns].every(x => x === null || (Number.isSafeInteger(x) && x >= 0))
    && (draft.warnStops === null || draft.blockStops === null || draft.warnStops < draft.blockStops)
    && (draft.warnMonthlyRuns === null || draft.blockMonthlyRuns === null || draft.warnMonthlyRuns < draft.blockMonthlyRuns)
    && (draft.revenueOre === null || (Number.isSafeInteger(draft.revenueOre) && draft.revenueOre >= 0));
  const save = (e: FormEvent) => { e.preventDefault(); setFeedback(null); if (valid) mutation.mutate(draft); };
  const field = (key: keyof Pick<Settings, "warnStops" | "blockStops" | "warnMonthlyRuns" | "blockMonthlyRuns">, title: string, hint: string) =>
    <div className="space-y-1.5">
      <Label htmlFor={`usage-${key}`} className="text-xs">{title}</Label>
      <Input id={`usage-${key}`} data-testid={`input-${key}`} type="number" min="0" step="1" value={draft[key] ?? ""} onChange={e => setInteger(key, e.target.value)} className="h-9 tabular-nums" />
      <p className="text-[11px] text-muted-foreground">{hint} · Lämna tomt för ingen gräns</p>
    </div>;
  return <section className="rounded-xl border border-border bg-card overflow-hidden">
    <div className="px-4 py-3 border-b border-border flex items-start gap-2">
      <SlidersHorizontal className="w-4 h-4 mt-0.5 text-primary shrink-0" />
      <div><h4 className="text-sm font-semibold">Gränser & planerad intäkt</h4><p className="text-xs text-muted-foreground mt-0.5">Gäller vald organisation och månad. Värdena är styrning, inte en faktura.</p></div>
    </div>
    <form onSubmit={save} className="p-4 space-y-5">
      <div><p className="text-xs font-semibold mb-3">Stopp per planering</p><div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{field("warnStops", "Varna vid", "Antal stopp")}{field("blockStops", "Blockera vid", "Antal stopp")}</div></div>
      <div><p className="text-xs font-semibold mb-3">Körningar per månad</p><div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{field("warnMonthlyRuns", "Varna vid", "Antal körningar")}{field("blockMonthlyRuns", "Blockera vid", "Antal körningar")}</div></div>
      <div className="space-y-1.5">
        <Label htmlFor="usage-revenue" className="text-xs">Planerad månadsintäkt (kr)</Label>
        <Input id="usage-revenue" data-testid="input-usage-revenue" type="number" min="0" step="0.01" placeholder="Ej angiven" value={draft.revenueOre === null || Number.isNaN(draft.revenueOre) ? "" : (draft.revenueOre / 100).toFixed(2)} onChange={e => setDraft(s => ({ ...s, revenueOre: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) }))} className="h-9 tabular-nums" />
        <p className="text-[11px] text-muted-foreground">Tomt fält betyder okänd intäkt, inte 0 kr.</p>
      </div>
      {!valid && <p className="text-xs text-amber-500">Ange giltiga heltal; när båda gränserna används måste varningsnivån vara lägre än blockeringsnivån.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1"><Feedback message={feedback} error={error} /><Button type="submit" size="sm" disabled={!valid || mutation.isPending} className="ml-auto gap-2" data-testid="button-save-usage-settings"><Save className="h-3.5 w-3.5" />{mutation.isPending ? "Sparar…" : "Spara inställningar"}</Button></div>
    </form>
  </section>;
}

function RatesPanel({ usageRates }: { usageRates: Rate[] }) {
  const client = useQueryClient();
  const ratesQuery = useQuery<Rate[]>({ queryKey: ["platform-usage-rates"], queryFn: async () => (await request<{ rates: Rate[] }>("/usage/rates")).rates });
  const [provider, setProvider] = useState("");
  const [operation, setOperation] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [unitCost, setUnitCost] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const mutation = useMutation({
    mutationFn: (rate: Rate) => request<unknown>("/usage/rates", { method: "PUT", body: JSON.stringify(rate) }),
    onSuccess: () => {
      setError(false); setFeedback("Kostnadsunderlaget sparades.");
      client.invalidateQueries({ queryKey: ["platform-usage-rates"] });
      client.invalidateQueries({ queryKey: ["platform-usage"] });
    },
    onError: (err: Error) => { setError(true); setFeedback(err.message); },
  });
  const valid = provider.trim() && operation.trim() && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) && unitCost !== "" && Number.isFinite(Number(unitCost)) && Number(unitCost) >= 0 && Number.isSafeInteger(Math.round(Number(unitCost) * 100));
  const save = (e: FormEvent) => {
    e.preventDefault(); setFeedback(null);
    if (valid) mutation.mutate({ provider: provider.trim(), operation: operation.trim(), effectiveFrom: `${effectiveFrom}T00:00:00.000Z`, unitCostOre: Math.round(Number(unitCost) * 100) });
  };
  return <section className="rounded-xl border border-border bg-card overflow-hidden">
    <div className="px-4 py-3 border-b border-border flex items-start gap-2">
      <Database className="h-4 w-4 mt-0.5 text-primary shrink-0" />
      <div><h4 className="text-sm font-semibold">Daterade kostnadsunderlag</h4><p className="text-xs text-muted-foreground mt-0.5">Plattformsövergripande styckpriser. Påverkar uppskattningar, inte uppmätt användning.</p></div>
    </div>
    <div className="p-4 space-y-4">
      {ratesQuery.isLoading ? <div className="space-y-2 animate-pulse"><div className="h-8 bg-muted rounded" /><div className="h-8 bg-muted rounded" /></div>
        : ratesQuery.isError ? <div role="alert" className="text-xs text-destructive flex items-center gap-2">Kunde inte hämta prisunderlag. <Button variant="outline" size="sm" onClick={() => ratesQuery.refetch()}>Försök igen</Button></div>
        : ratesQuery.data?.length ? <div className="overflow-x-auto"><table className="w-full text-xs text-left min-w-[440px]"><thead><tr className="text-muted-foreground border-b border-border"><th className="pb-2 font-medium">Leverantör / åtgärd</th><th className="pb-2 font-medium">Från</th><th className="pb-2 font-medium text-right">Kr / enhet</th><th className="pb-2 w-12" /></tr></thead><tbody className="divide-y divide-border">{ratesQuery.data.map((rate, index) => <tr key={`${rate.provider}-${rate.operation}-${rate.effectiveFrom}-${index}`}><td className="py-2.5"><span className="font-medium">{rate.provider}</span><span className="text-muted-foreground"> / {rate.operation}</span></td><td className="py-2.5 tabular-nums text-muted-foreground">{rate.effectiveFrom.slice(0, 10)}</td><td className="py-2.5 text-right tabular-nums">{money(rate.unitCostOre)}</td><td className="py-2.5 text-right"><button type="button" data-testid={`button-edit-rate-${index}`} className="text-primary hover:underline" onClick={() => { setProvider(rate.provider); setOperation(rate.operation); setEffectiveFrom(rate.effectiveFrom.slice(0, 10)); setUnitCost((rate.unitCostOre / 100).toFixed(2)); setFeedback(null); }}>Välj</button></td></tr>)}</tbody></table></div>
        : <p className="text-xs text-muted-foreground">Inga daterade priser finns registrerade. Kostnader kan vara okända tills underlag finns.</p>}
      {usageRates.length > 0 && <p className="text-[11px] text-muted-foreground">Vald månad har {number.format(usageRates.length)} tillämpliga prisrader.</p>}
      <form onSubmit={save} className="border-t border-border pt-4 space-y-3">
        <p className="text-xs font-semibold">Lägg till eller uppdatera prisrad</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="rate-provider" className="text-xs">Leverantör</Label><Input id="rate-provider" data-testid="input-rate-provider" required value={provider} onChange={e => setProvider(e.target.value)} className="h-9" placeholder="Leverantör" /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-operation" className="text-xs">Åtgärd</Label><Input id="rate-operation" data-testid="input-rate-operation" required value={operation} onChange={e => setOperation(e.target.value)} className="h-9" placeholder="Åtgärd" /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-date" className="text-xs">Gäller från</Label><Input id="rate-date" data-testid="input-rate-date" required type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className="h-9" /></div>
          <div className="space-y-1.5"><Label htmlFor="rate-cost" className="text-xs">Kr per enhet</Label><Input id="rate-cost" data-testid="input-rate-cost" required min="0" step="0.01" type="number" value={unitCost} onChange={e => setUnitCost(e.target.value)} className="h-9" placeholder="0,00" /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3"><Feedback message={feedback} error={error} /><Button type="submit" size="sm" disabled={!valid || mutation.isPending} className="ml-auto gap-2" data-testid="button-save-usage-rate"><Save className="h-3.5 w-3.5" />{mutation.isPending ? "Sparar…" : "Spara prisrad"}</Button></div>
      </form>
    </div>
  </section>;
}

export function OrganizationUsage({ organizationId }: { organizationId: string }) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const [section, setSection] = useState<"activity" | "settings" | "rates">("activity");
  const query = useQuery<Usage>({
    queryKey: ["platform-usage", organizationId, month],
    queryFn: () => request<Usage>(`/organizations/${encodeURIComponent(organizationId)}/usage?month=${encodeURIComponent(month)}`),
  });
  const data = query.data;
  return <div className="space-y-5 pb-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-primary font-bold"><span className="w-1.5 h-1.5 rounded-full bg-primary" /> Planeringsekonomi</div><h3 className="text-xl font-semibold tracking-tight mt-1">Användning per månad</h3><p className="text-xs text-muted-foreground mt-1">Uppmätta händelser och uppskattade kostnader hålls isär.</p></div>
      <div className="flex items-center rounded-lg border border-border bg-card p-1 gap-1" aria-label="Välj månad">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="Föregående månad" data-testid="button-previous-month"><ChevronLeft className="h-4 w-4" /></Button>
        <label className="relative flex items-center gap-2 px-1 text-xs font-medium min-w-[128px] justify-center">
          <CalendarDays className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="capitalize">{monthLabel(month)}</span>
          <input type="month" value={month} max={currentMonth} onChange={e => e.target.value && setMonth(e.target.value)} aria-label="Välj månad" data-testid="input-usage-month" className="absolute inset-0 opacity-0 cursor-pointer w-full" />
        </label>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setMonth(m => shiftMonth(m, 1))} disabled={month >= currentMonth} aria-label="Nästa månad" data-testid="button-next-month"><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
    {query.isLoading ? <div className="space-y-4 animate-pulse" role="status" aria-label="Laddar användning"><div className="h-24 rounded-xl bg-muted" /><div className="h-36 rounded-xl bg-muted" /><div className="h-40 rounded-xl bg-muted" /></div>
      : query.isError ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 flex flex-col items-start gap-3"><AlertTriangle className="h-5 w-5 text-destructive" /><div><p className="font-semibold">Användning kunde inte hämtas</p><p className="text-xs text-muted-foreground mt-1">{query.error instanceof Error ? query.error.message : "Försök igen om en stund."}</p></div><Button variant="outline" size="sm" onClick={() => query.refetch()} className="gap-2" data-testid="button-retry-usage"><RefreshCw className="h-3.5 w-3.5" /> Försök igen</Button></div>
      : data && <>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 rounded-xl border border-border bg-card p-4">
          <Stat label="Körningar" value={number.format(data.summary.runs)} note={`${number.format(data.summary.largeRuns)} stora körningar`} tone="cyan" />
          <Stat label="Planerade stopp" value={number.format(data.summary.plannedStops)} note="Uppmätt antal" />
          <Stat label="Kostnad, estimat" value={money(data.summary.estimatedCostOre)} note={data.summary.unknownCost ? "Ofullständigt underlag" : "Ej fakturerat"} tone={data.summary.unknownCost ? "amber" : "normal"} />
        </div>
        <div className={`rounded-lg border px-4 py-3 flex items-start gap-3 text-xs ${data.summary.unknownCost ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-muted/20"}`}>
          {data.summary.unknownCost ? <CircleHelp className="h-4 w-4 text-amber-500 shrink-0" /> : <Check className="h-4 w-4 text-primary shrink-0" />}
          <p className="text-muted-foreground leading-relaxed">{data.summary.unknownCost ? "Vissa kostnader saknar prisunderlag. Visat estimat kan vara ofullständigt; okänt är inte noll." : "Kostnader är uppskattningar från registrerade prisunderlag, inte debiterade belopp."} Ingen faktura skapas här.</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-xl bg-muted/30 border border-border p-3 flex items-center gap-3"><ArrowDownRight className="h-4 w-4 text-muted-foreground" /><div><p className="text-[10px] uppercase tracking-widest text-muted-foreground">Planerad intäkt</p><p className="font-semibold tabular-nums text-sm mt-1">{money(data.summary.revenueOre)}</p></div></div>
          <div className="rounded-xl bg-muted/30 border border-border p-3 flex items-center gap-3"><ArrowUpRight className="h-4 w-4 text-muted-foreground" /><div><p className="text-[10px] uppercase tracking-widest text-muted-foreground">Beräknad marginal</p><p className="font-semibold tabular-nums text-sm mt-1">{data.summary.unknownCost ? "Okänd" : money(data.summary.marginOre)}</p></div></div>
        </div>
        <div className="flex border-b border-border gap-4 overflow-x-auto">
          {([["activity", "Händelser"], ["settings", "Gränser & intäkt"], ["rates", "Prisunderlag"]] as const).map(([key, label]) => <button key={key} type="button" data-testid={`button-usage-${key}`} onClick={() => setSection(key)} className={`shrink-0 pb-2 text-xs font-semibold border-b-2 transition-colors ${section === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
        </div>
        {section === "activity" && <div className="space-y-5">
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between"><h4 className="text-sm font-semibold">Leverantörsfördelning</h4><span className="text-[11px] text-muted-foreground">{number.format(data.breakdown.length)} rader</span></div>
            {!data.breakdown.length ? <p className="p-5 text-xs text-muted-foreground">Ingen leverantörsanvändning registrerad för månaden.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[630px] text-left text-xs"><thead><tr className="bg-muted/30 text-muted-foreground"><th className="px-4 py-2 font-medium">Leverantör / åtgärd</th><th className="py-2 font-medium">Typ / utfall</th><th className="py-2 font-medium text-right">Anrop</th><th className="py-2 font-medium text-right">Enheter</th><th className="px-4 py-2 font-medium text-right">Estimat</th></tr></thead><tbody className="divide-y divide-border">{data.breakdown.map((row, index) => <tr key={`${row.provider}-${row.operation}-${row.category}-${row.outcome}-${row.cacheStatus}-${row.retry}-${index}`} data-testid={`row-usage-breakdown-${index}`}><td className="px-4 py-2.5"><span className="font-semibold">{row.provider}</span><span className="block text-muted-foreground">{row.operation}</span></td><td className="py-2.5"><span>{row.category} · {outcomeLabel(row.outcome)}</span><span className="block text-[10px] text-muted-foreground">{row.cacheStatus}{row.retry ? " · omförsök" : ""}</span></td><td className="py-2.5 text-right tabular-nums">{number.format(row.calls)}</td><td className="py-2.5 text-right tabular-nums">{row.units == null ? "Okänt" : number.format(row.units)}</td><td className={`px-4 py-2.5 text-right tabular-nums ${row.estimatedCostOre === null ? "text-amber-500" : ""}`}>{money(row.estimatedCostOre)}</td></tr>)}</tbody></table></div>}
          </section>
          <section className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between"><h4 className="text-sm font-semibold">Planeringsjobb</h4><span className="text-[11px] text-muted-foreground">{number.format(data.jobs.length)} jobb</span></div>
            {!data.jobs.length ? <p className="p-5 text-xs text-muted-foreground">Inga planeringsjobb registrerade för månaden.</p> : <div className="divide-y divide-border max-h-80 overflow-y-auto">{data.jobs.map(job => <div key={job.jobId} data-testid={`row-usage-job-${job.jobId}`} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs"><div className="min-w-0"><p className="font-medium truncate">{job.engine || "Okänd motor"} <span className="text-muted-foreground font-normal">· {job.sizeClass || "storlek okänd"}</span></p><p className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate" title={job.jobId}>{job.jobId}</p></div><div className="text-right shrink-0"><p className="font-medium">{outcomeLabel(job.status)} <span className="text-muted-foreground font-normal">· {job.stopCount == null ? "okänt antal" : number.format(job.stopCount)} stopp</span></p><p className="text-[11px] text-muted-foreground mt-0.5 flex items-center justify-end gap-1"><Clock3 className="h-3 w-3" />{dateTime(job.occurredAt)} · {job.durationMs == null ? "tid okänd" : `${new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 }).format(job.durationMs / 1000)} s`}</p></div></div>)}</div>}
          </section>
        </div>}
        {section === "settings" && <SettingsPanel key={`${organizationId}-${month}`} organizationId={organizationId} month={month} settings={data.settings} />}
        {section === "rates" && <RatesPanel usageRates={data.rates} />}
      </>}
  </div>;
}