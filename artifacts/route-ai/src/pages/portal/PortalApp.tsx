import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { QueryCache, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Router as WouterRouter, Route, Switch, Link } from "wouter";
import { MapContainer, TileLayer, Marker, ZoomControl } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { ArrowLeft, Clock, LogOut, MapPin, Phone, RefreshCw, WifiOff, CalendarDays, KeyRound, CheckCircle2 } from "lucide-react";
import {
  usePortalLogin, usePortalLogout, usePortalRecover, usePortalReset,
  useGetPortalIdentity, useGetPortalOrders, useGetPortalOrder,
  getPortalLoginUrl, getPortalLogoutUrl, getPortalRecoverUrl, getPortalResetUrl,
  getPortalAccessUrl,
  getGetPortalIdentityUrl, getGetPortalIdentityQueryKey,
  getGetPortalOrdersUrl, getGetPortalOrdersQueryKey,
  getGetPortalOrderUrl, getGetPortalOrderQueryKey,
  type PortalIdentity, type PortalOrder, type PortalOrderDetail, type PortalOrderPage, type GetPortalOrdersParams,
  useGetPortalActiveOrders, getGetPortalActiveOrdersUrl, getGetPortalActiveOrdersQueryKey,
} from "@workspace/api-client-react";
import { untaggedFetch } from "@/lib/workspace-context";
import { destinationCoordinates, publicTrackingPolicy } from "@/lib/customer-links";
import { destinationIcon, vehicleIcon, FitDeliveryMap } from "@/pages/TrackingPage";
import {
  formatPortalDate, formatPortalDateTime, formatPortalTime, formatWindow, isPortalAuthStatus,
  passwordProblem, portalStatus, portalDeliveryStage, TERMINAL_STATUSES, telHref, tokenFromFragment, trackingText, type StatusTone,
} from "@/lib/portal-format";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 20_000;
const AUTH_LOST = "traivo-portal-auth-lost";

export function isPortalPath(pathname: string) {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return rest === "/portal" || rest.startsWith("/portal/");
}

export class PortalHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** Portal requests: customer cookie only, never staff workspace headers, abortable with timeout. */
async function portalFetch<T>(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort);
  try {
    const response = await untaggedFetch(`${BASE}${url}`, {
      method: init.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: init.body !== undefined ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) throw new PortalHttpError(response.status);
    if (response.status === 202 || response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}
const statusOf = (error: unknown) => (error instanceof PortalHttpError ? error.status : undefined);

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

export default function PortalApp() {
  const [client] = useState(() => new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => { if (isPortalAuthStatus(statusOf(error))) window.dispatchEvent(new Event(AUTH_LOST)); },
    }),
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true, staleTime: 0, gcTime: 60_000 } },
  }));
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <WouterRouter base={BASE}>
        <Shell>
          <Switch>
            <Route path="/portal/access" component={AccessView} />
            <Route path="/portal/reset" component={ResetView} />
            <Route component={PortalHome} />
          </Switch>
        </Shell>
      </WouterRouter>
    </QueryClientProvider>
  );
}

/* ---------- Shell: fixed neutral palette, never inherits an organization theme ---------- */

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="portal-root min-h-[100dvh] bg-[#f3efe6] text-[#1f2a33] antialiased" style={{ fontFamily: "'Instrument Sans', 'DM Sans', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,560&family=Instrument+Sans:wght@400;500;600&display=swap');
        .portal-serif{font-family:'Fraunces',Georgia,serif;font-optical-sizing:auto}
        @keyframes portal-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        .portal-rise{animation:portal-rise .5s cubic-bezier(.2,.7,.2,1) both}
        @keyframes portal-pulse{0%,100%{opacity:.35}50%{opacity:.8}}
        .portal-skel{background:#e6e0d3;border-radius:10px;animation:portal-pulse 1.6s ease-in-out infinite}
        @media (prefers-reduced-motion: reduce){.portal-rise,.portal-skel{animation:none}}`}</style>
      {children}
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-8 w-8 place-items-center rounded-full bg-[#24505a] text-[13px] font-semibold text-[#f3efe6]">T</div>
      <div className="leading-tight">
        <p className="text-[13px] font-semibold tracking-wide">Traivo</p>
        <p className="text-[11px] uppercase tracking-[0.14em] text-[#6b746f]">Mina leveranser</p>
      </div>
    </div>
  );
}

const fieldClass = "mt-1.5 block w-full rounded-xl border border-[#d6cfbf] bg-[#fbf9f4] px-4 py-3 text-[15px] outline-none transition focus:border-[#24505a] focus:ring-2 focus:ring-[#24505a]/20";
const primaryBtn = "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#24505a] px-5 py-3 text-[15px] font-semibold text-[#f6f2ea] transition hover:bg-[#1c3f47] disabled:opacity-60";
const quietBtn = "inline-flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-[#24505a] underline-offset-4 hover:underline";

function AuthFrame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-md flex-col px-6 py-10">
      <Brand />
      <div className="portal-rise my-auto pt-12">
        <h1 className="portal-serif text-[34px] leading-[1.1] text-[#1f2a33]">{title}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-[#56615c]">{lead}</p>
        <div className="mt-8">{children}</div>
      </div>
      <p className="pt-10 text-xs text-[#8a8f86]">Kundportal för leveransmottagare. Alla tider anges i svensk tid.</p>
    </main>
  );
}

function Notice({ tone, children }: { tone: "error" | "ok" | "info"; children: ReactNode }) {
  const cls = tone === "error" ? "border-[#e1b4a6] bg-[#f8e9e3] text-[#7a2e1d]" : tone === "ok" ? "border-[#b9d3c4] bg-[#e8f1ea] text-[#24503a]" : "border-[#d6cfbf] bg-[#fbf9f4] text-[#3f4a45]";
  return <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm leading-relaxed ${cls}`}>{children}</div>;
}

/* ---------- Home: identity gate ---------- */

function PortalHome() {
  const qc = useQueryClient();
  const online = useOnline();
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    const lost = () => { void qc.cancelQueries(); qc.clear(); setSignedOut(true); };
    window.addEventListener(AUTH_LOST, lost);
    return () => window.removeEventListener(AUTH_LOST, lost);
  }, [qc]);

  useEffect(() => {
    if (!online) { void qc.cancelQueries(); qc.removeQueries({ predicate: q => String(q.queryKey[0]).startsWith("/api/portal/orders") }); }
  }, [online, qc]);

  const identity = useGetPortalIdentity({
    query: {
      queryKey: getGetPortalIdentityQueryKey(),
      queryFn: ({ signal }) => portalFetch<PortalIdentity>(getGetPortalIdentityUrl(), { signal }),
      enabled: online && !signedOut,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const signedIn = (who: PortalIdentity) => {
    qc.clear();
    qc.setQueryData(getGetPortalIdentityQueryKey(), who);
    setSignedOut(false);
  };
  const signOut = () => { void qc.cancelQueries(); qc.clear(); setSignedOut(true); };

  if (!online) {
    return (
      <AuthFrame title="Ingen anslutning" lead="Du verkar vara offline. Vi visar ingen gammal information. Sidan uppdateras automatiskt när anslutningen kommer tillbaka.">
        <div className="flex items-center gap-3 text-sm text-[#56615c]"><WifiOff className="h-5 w-5" /> Väntar på nätverk…</div>
      </AuthFrame>
    );
  }
  if (signedOut || isPortalAuthStatus(statusOf(identity.error))) return <LoginView onSignedIn={signedIn} />;
  if (identity.isPending) return <HomeSkeleton />;
  if (identity.isError || !identity.data) {
    return (
      <AuthFrame title="Något gick fel" lead="Vi kunde inte nå leveranstjänsten just nu. Försök igen om en stund.">
        <button className={primaryBtn} onClick={() => void identity.refetch()}><RefreshCw className="h-4 w-4" /> Försök igen</button>
      </AuthFrame>
    );
  }
  return <Deliveries key={identity.data.id} me={identity.data} onSignedOut={signOut} online={online} />;
}

function HomeSkeleton() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-8" aria-busy="true" aria-label="Laddar">
      <Brand />
      <div className="mt-10 grid gap-6 md:grid-cols-[340px_1fr]">
        <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="portal-skel h-24" />)}</div>
        <div className="portal-skel h-[420px]" />
      </div>
    </main>
  );
}

/* ---------- Login / recover ---------- */

function LoginView({ onSignedIn }: { onSignedIn: (who: PortalIdentity) => void }) {
  const [mode, setMode] = useState<"login" | "recover">("recover");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recoverSent, setRecoverSent] = useState(false);

  const login = usePortalLogin({
    mutation: {
      mutationFn: ({ data }) => portalFetch<PortalIdentity>(getPortalLoginUrl(), { method: "POST", body: data }),
      onSuccess: (who) => { setPassword(""); onSignedIn(who); },
      onError: (e) => {
        const s = statusOf(e);
        setError(s === 401 || s === 403 || s === 400 ? "E-post eller lösenord stämmer inte, eller så är kontot inte aktivt."
          : s === 429 ? "För många försök. Vänta en stund och försök igen." : "Inloggningen kunde inte genomföras. Kontrollera anslutningen och försök igen.");
      },
    },
  });
  const recover = usePortalRecover({
    mutation: {
      mutationFn: ({ data }) => portalFetch<void>(getPortalRecoverUrl(), { method: "POST", body: data }),
      onSuccess: () => setRecoverSent(true),
      onError: (e) => setError(statusOf(e) === 429 ? "För många försök. Vänta en stund och försök igen." : "Begäran kunde inte skickas. Försök igen."),
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault(); setError(null);
    const clean = email.trim();
    if (!clean) { setError("Fyll i din e-postadress."); return; }
    if (mode === "login") {
      if (!password) { setError("Fyll i ditt lösenord."); return; }
      login.mutate({ data: { email: clean, password } });
    } else recover.mutate({ data: { email: clean } });
  };

  if (mode === "recover") {
    return (
      <AuthFrame title="Öppna kundportalen" lead="Ange e-postadressen du fått inbjudan till. Finns ett aktivt konto skickar vi en personlig länk som öppnar portalen utan lösenord.">
        {recoverSent ? (
          <div className="space-y-5">
            <Notice tone="ok">Om adressen hör till ett aktivt konto har ett e-postmeddelande skickats. Länken går bara att använda en gång.</Notice>
            <button className={quietBtn} onClick={() => { setMode("login"); setRecoverSent(false); }}><ArrowLeft className="h-4 w-4" /> Tillbaka till inloggning</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5" noValidate>
            <label className="block text-sm font-medium">E-post
              <input className={fieldClass} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} data-testid="input-portal-recover-email" />
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <button className={primaryBtn} disabled={recover.isPending} data-testid="button-portal-recover">{recover.isPending ? "Skickar…" : "Skicka länk"}</button>
            <button type="button" className={quietBtn} onClick={() => { setMode("login"); setError(null); }}><ArrowLeft className="h-4 w-4" /> Tillbaka</button>
          </form>
        )}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Var är min leverans?" lead="Logga in för att se dina leveranser, när de väntas komma och hur du når föraren.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <label className="block text-sm font-medium">E-post
          <input className={fieldClass} type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} data-testid="input-portal-email" />
        </label>
        <label className="block text-sm font-medium">Lösenord
          <input className={fieldClass} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} maxLength={256} data-testid="input-portal-password" />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <button className={primaryBtn} disabled={login.isPending} data-testid="button-portal-login">{login.isPending ? "Loggar in…" : "Logga in"}</button>
        <button type="button" className={quietBtn} onClick={() => { setMode("recover"); setError(null); }} data-testid="link-portal-recover">Skicka inloggningslänk via mejl</button>
      </form>
    </AuthFrame>
  );
}

/* ---------- Reset (token in fragment) ---------- */

let capturedToken: string | null | undefined;
function takeFragmentToken(): string | null {
  if (capturedToken === undefined) {
    capturedToken = tokenFromFragment(window.location.hash);
    // Remove the credential from the address bar and history immediately.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return capturedToken;
}

function AccessView() {
  const [token] = useState(takeFragmentToken);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    capturedToken = null;
    if (!token) { setError("Länken saknas eller har redan använts. Begär en ny länk."); return; }
    // One exchange, including under StrictMode. Never persist bearer links or
    // automatically replay a token after an uncertain network result.
    void portalFetch<PortalIdentity>(getPortalAccessUrl(), { method: "POST", body: { token } })
      .then(() => {
        client.clear();
        window.location.replace(`${BASE}/portal`);
      }).catch((err) => {
        setError(statusOf(err) === 401
          ? "Länken är använd, ogiltig eller har gått ut. Begär en ny länk."
          : "Kundportalen kunde inte öppnas. Kontrollera anslutningen och begär en ny länk.");
      });
  }, [token, client]);
  return <AuthFrame title={error ? "Länken kunde inte öppnas" : "Öppnar kundportalen…"}
    lead="Din personliga länk används för att öppna dina leveranser utan lösenord.">
    {error ? <><Notice tone="error">{error}</Notice><Link href="/portal" className={quietBtn}>Begär en ny länk</Link></>
      : <p role="status">Verifierar länken…</p>}
  </AuthFrame>;
}

function ResetView() {
  const [token] = useState(takeFragmentToken);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reset = usePortalReset({
    mutation: {
      mutationFn: ({ data }) => portalFetch<void>(getPortalResetUrl(), { method: "POST", body: data }),
      onSuccess: () => { capturedToken = null; setPassword(""); setConfirm(""); },
      onError: (e) => {
        const s = statusOf(e);
        setError(s === 400 || s === 404 || s === 410 || s === 401 || s === 403 ? "Länken är ogiltig, redan använd eller har gått ut. Begär en ny länk från inloggningssidan." : "Lösenordet kunde inte sparas. Försök igen.");
      },
    },
  });

  if (reset.isSuccess) {
    return (
      <AuthFrame title="Klart." lead="Ditt nya lösenord är sparat. Du kan nu logga in.">
        <Link href="/portal" className={primaryBtn}><CheckCircle2 className="h-4 w-4" /> Till inloggningen</Link>
      </AuthFrame>
    );
  }
  if (!token) {
    return (
      <AuthFrame title="Länken saknas" lead="Den här sidan behöver en giltig länk från e-postmeddelandet. Öppna länken igen, eller begär en ny.">
        <Link href="/portal" className={primaryBtn}>Till inloggningen</Link>
      </AuthFrame>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password, confirm);
    setError(problem);
    if (!problem) reset.mutate({ data: { token, password } });
  };
  return (
    <AuthFrame title="Välj ett lösenord" lead="Minst 12 tecken. En fras med flera ord är både lätt att minnas och svår att gissa.">
      <form onSubmit={submit} className="space-y-5" noValidate>
        <label className="block text-sm font-medium">Nytt lösenord
          <input className={fieldClass} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} data-testid="input-portal-new-password" />
        </label>
        <label className="block text-sm font-medium">Upprepa lösenordet
          <input className={fieldClass} type="password" autoComplete="new-password" minLength={12} maxLength={256} value={confirm} onChange={e => setConfirm(e.target.value)} data-testid="input-portal-confirm-password" />
        </label>
        <p className="text-xs text-[#6b746f]">{password.length < 12 ? `${12 - password.length} tecken kvar till minimum` : "Längden räcker"}</p>
        {error && <Notice tone="error">{error}</Notice>}
        <button className={primaryBtn} disabled={reset.isPending} data-testid="button-portal-reset"><KeyRound className="h-4 w-4" />{reset.isPending ? "Sparar…" : "Spara lösenord"}</button>
      </form>
    </AuthFrame>
  );
}

/* ---------- Deliveries ---------- */

const toneDot: Record<StatusTone, string> = {
  calm: "bg-[#7c9aa0]", moving: "bg-[#d0893a]", done: "bg-[#4f8a63]", problem: "bg-[#b4553b]", muted: "bg-[#a49e90]",
};
const toneChip: Record<StatusTone, string> = {
  calm: "bg-[#e3ebe9] text-[#2c4d53]", moving: "bg-[#f6e3cc] text-[#7a4613]", done: "bg-[#e0ecdf] text-[#2f5a3c]", problem: "bg-[#f4dcd3] text-[#7a2e1d]", muted: "bg-[#ebe6da] text-[#5b584f]",
};

function StatusChip({ status }: { status: string }) {
  const s = portalStatus(status);
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${toneChip[s.tone]}`}><span className={`h-1.5 w-1.5 rounded-full ${toneDot[s.tone]}`} />{s.label}</span>;
}

function Deliveries({ me, onSignedOut, online }: { me: PortalIdentity; onSignedOut: () => void; online: boolean }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [filters, setFilters] = useState<GetPortalOrdersParams>({});
  const [draft, setDraft] = useState<GetPortalOrdersParams>({});
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [asOf, setAsOf] = useState<string | undefined>();
  const [activeCursors, setActiveCursors] = useState<(string | undefined)[]>([undefined]);
  const params = { ...filters, cursor: cursors.at(-1), asOf, limit: 25 };
  const activeParams = { cursor: activeCursors.at(-1), limit: 10 };
  const running = useGetPortalActiveOrders(activeParams, {
    query: {
      queryKey: getGetPortalActiveOrdersQueryKey(activeParams),
      queryFn: ({ signal }) => portalFetch<PortalOrderPage>(getGetPortalActiveOrdersUrl(activeParams), { signal }),
      enabled: online, refetchInterval: 30_000,
    },
  });
  const orders = useGetPortalOrders(params, {
    query: {
      queryKey: getGetPortalOrdersQueryKey(params),
      queryFn: ({ signal }) => portalFetch<PortalOrderPage>(getGetPortalOrdersUrl(params), { signal }),
      enabled: online,
      refetchInterval: 30_000,
    },
  });
  const logout = usePortalLogout({
    mutation: {
      mutationFn: () => portalFetch<void>(getPortalLogoutUrl(), { method: "POST" }),
      onSuccess: onSignedOut,
      onError: (e) => { if (isPortalAuthStatus(statusOf(e))) onSignedOut(); else setLogoutError("Utloggningen kunde inte bekräftas. Försök igen."); },
    },
  });

  const list = orders.data?.items ?? [];
  // A page/filter change must not close a delivery detail. Its own request
  // rechecks authorization, including revocations and customer reassignment.
  // Abort stale detail requests on selection change.
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const old = prev.current;
    if (old && old !== selected) {
      void qc.cancelQueries({ queryKey: getGetPortalOrderQueryKey(old) });
      qc.removeQueries({ queryKey: getGetPortalOrderQueryKey(old) });
    }
    prev.current = selected;
  }, [selected, qc]);

  const firstName = me.name.split(" ")[0] || me.name;

  return (
    <main className="mx-auto max-w-6xl px-5 pb-16 pt-6 md:px-8">
      <header className="flex items-center justify-between gap-4 border-b border-[#ddd5c4] pb-5">
        <Brand />
        <div className="flex items-center gap-2">
          <span className="hidden text-sm text-[#56615c] sm:inline">{me.name}</span>
          <button className={quietBtn} onClick={() => { setLogoutError(null); logout.mutate(); }} disabled={logout.isPending} data-testid="button-portal-logout">
            <LogOut className="h-4 w-4" />{logout.isPending ? "Loggar ut…" : "Logga ut"}
          </button>
        </div>
      </header>
      {logoutError && <div className="mt-4"><Notice tone="error">{logoutError}</Notice></div>}

      <div className="mt-8 grid gap-8 md:grid-cols-[340px_1fr]">
        <section className={selected ? "hidden md:block" : ""} aria-label="Dina leveranser">
          <h1 className="portal-serif text-[30px] leading-tight">Hej {firstName}.</h1>
          <p className="mt-1 text-sm text-[#56615c]">
            Dina pågående leveranser och din orderhistorik.
          </p>
          <div className="mt-6 space-y-2.5">
            <h2 className="font-semibold">Pågående leveranser{running.data ? ` (${running.data.total})` : ""}</h2>
            {running.isPending && <p className="text-sm">Hämtar pågående leveranser…</p>}
            {running.isError && <Notice tone="error">Pågående leveranser kunde inte hämtas. <button className={quietBtn} onClick={() => void running.refetch()}>Försök igen</button></Notice>}
            {running.isSuccess && running.data.total === 0 && <p className="text-sm text-[#56615c]">Ingen leverans har startat just nu.</p>}
            {!running.isError && running.data?.items.map(o => <OrderRow key={`active-${o.id}`} order={o} selected={o.id === selected} onSelect={setSelected} />)}
            {running.data && <div className="flex justify-between">
              <button className={quietBtn} disabled={activeCursors.length === 1 || running.isFetching} onClick={() => setActiveCursors(c => c.slice(0, -1))}>Föregående pågående</button>
              <button className={quietBtn} disabled={!running.data.nextCursor || running.isFetching} onClick={() => setActiveCursors(c => [...c, running.data!.nextCursor!])}>Fler pågående</button>
            </div>}
            <h2 className="pt-5 font-semibold">Orderhistorik</h2>
            <form className="space-y-3" onSubmit={e => { e.preventDefault(); setFilters(draft); setCursors([undefined]); setAsOf(undefined); }}>
              <label className="block text-sm">Orderreferens eller adress
                <input className={fieldClass} type="search" maxLength={200} value={draft.search ?? ""} onChange={e => setDraft(d => ({ ...d, search: e.target.value || undefined }))} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">Från datum<input className={fieldClass} type="date" value={draft.from ?? ""} max={draft.to} onChange={e => setDraft(d => ({ ...d, from: e.target.value || undefined }))} /></label>
                <label className="text-sm">Till datum<input className={fieldClass} type="date" value={draft.to ?? ""} min={draft.from} onChange={e => setDraft(d => ({ ...d, to: e.target.value || undefined }))} /></label>
              </div>
              <label className="block text-sm">Status
                <select className={fieldClass} value={draft.status ?? ""} onChange={e => setDraft(d => ({ ...d, status: (e.target.value || undefined) as GetPortalOrdersParams["status"] }))}>
                  <option value="">Alla statusar</option>
                  {(["scheduled", "started", "paused", "completed", "failed", "skipped", "cancelled", "unavailable"] as const).map(status => <option key={status} value={status}>{portalStatus(status).label}</option>)}
                </select>
              </label>
              <div className="flex gap-2">
                <button className={quietBtn} type="submit">Sök</button>
                <button className={quietBtn} type="button" onClick={() => { setDraft({}); setFilters({}); setCursors([undefined]); setAsOf(undefined); }}>Rensa filter</button>
              </div>
            </form>
            {orders.isPending && [0, 1, 2].map(i => <div key={i} className="portal-skel h-[88px]" />)}
            {orders.isError && !isPortalAuthStatus(statusOf(orders.error)) && (
              <div className="space-y-3"><Notice tone="error">Leveranserna kunde inte hämtas.</Notice><button className={quietBtn} onClick={() => void orders.refetch()}><RefreshCw className="h-4 w-4" /> Försök igen</button></div>
            )}
            {orders.isSuccess && list.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#cfc6b3] px-5 py-8 text-sm leading-relaxed text-[#56615c]">
                Inga order matchar ditt urval.
              </div>
            )}
            {!orders.isError && list.map(o => <OrderRow key={o.id} order={o} selected={o.id === selected} onSelect={setSelected} />)}
            {orders.isSuccess && <nav aria-label="Sidor i orderhistoriken">
              <p className="text-sm">{orders.data.total} order · Sida {cursors.length}</p>
              <div className="flex justify-between">
                <button className={quietBtn} disabled={cursors.length === 1 || orders.isFetching} onClick={() => setCursors(c => c.slice(0, -1))}>Föregående</button>
                <button className={quietBtn} disabled={!orders.data.nextCursor || orders.isFetching} onClick={() => { setAsOf(orders.data.asOf); setCursors(c => [...c, orders.data.nextCursor!]); }}>Nästa</button>
              </div>
              <button className={quietBtn} onClick={() => { setCursors([undefined]); setAsOf(undefined); void orders.refetch(); }}>Läs in nya order</button>
            </nav>}
          </div>
          {orders.isSuccess && <p className="mt-6 text-xs text-[#8a8f86]">Uppdateras automatiskt var 30:e sekund{orders.isFetching ? " · hämtar…" : ""}</p>}
        </section>

        <section className={selected ? "" : "hidden md:block"} aria-live="polite">
          {selected ? <OrderDetail key={selected} id={selected} online={online} onBack={() => setSelected(null)} />
            : <div className="grid h-full min-h-[360px] place-items-center rounded-3xl border border-[#ddd5c4] bg-[#f8f5ee] p-10 text-center">
                <div><MapPin className="mx-auto h-7 w-7 text-[#9aa49e]" /><p className="portal-serif mt-4 text-xl">Välj en leverans</p><p className="mt-1 text-sm text-[#6b746f]">Status, karta och kontakt visas här.</p></div>
              </div>}
        </section>
      </div>
    </main>
  );
}

function OrderRow({ order, selected, onSelect }: { order: PortalOrder; selected: boolean; onSelect: (id: string) => void }) {
  const win = formatWindow(order.timeWindowStart, order.timeWindowEnd);
  return (
    <button onClick={() => onSelect(order.id)} data-testid={`row-portal-order-${order.id}`}
      className={`portal-rise block w-full rounded-2xl border px-4 py-3.5 text-left transition ${selected ? "border-[#24505a] bg-[#fbf9f4] shadow-[0_1px_0_#24505a]" : "border-[#ddd5c4] bg-[#f8f5ee] hover:border-[#b9b09c]"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-medium leading-snug">{order.address}</p>
        <StatusChip status={order.status} />
      </div>
      <p className="mt-1.5 text-[13px] text-[#6b746f]">
        {formatPortalDate(order.date) ?? "Datum ej bestämt"}{win ? ` · ${win}` : ""}{order.reference ? ` · ${order.reference}` : ""}
      </p>
    </button>
  );
}

function OrderDetail({ id, online, onBack }: { id: string; online: boolean; onBack: () => void }) {
  const detail = useGetPortalOrder(id, {
    query: {
      queryKey: getGetPortalOrderQueryKey(id),
      queryFn: ({ signal }) => portalFetch<PortalOrderDetail>(getGetPortalOrderUrl(id), { signal }),
      enabled: online,
      refetchInterval: 15_000,
    },
  });
  const [now, setNow] = useState(Date.now);
  const data = detail.data;
  useEffect(() => { setNow(Date.now()); }, [detail.dataUpdatedAt]);
  const tracking = publicTrackingPolicy(data?.delivery ?? null, now, online);
  // Expire marker/ETA at freshUntil even if the poll hangs.
  useEffect(() => {
    if (tracking.deadline === null) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, tracking.deadline - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [tracking.deadline, now]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(t); }, []);

  if (detail.isPending) return <div className="space-y-4" aria-busy="true"><div className="portal-skel h-28" /><div className="portal-skel h-72" /><div className="portal-skel h-24" /></div>;
  if (detail.isError || !data) {
    const s = statusOf(detail.error);
    return (
      <div className="space-y-4">
        <button className={`${quietBtn} md:hidden`} onClick={onBack}><ArrowLeft className="h-4 w-4" /> Alla leveranser</button>
        <Notice tone="error">{s === 404 ? "Leveransen finns inte längre eller är inte kopplad till ditt konto." : "Leveransen kunde inte hämtas just nu."}</Notice>
        {s !== 404 && <button className={quietBtn} onClick={() => void detail.refetch()}><RefreshCw className="h-4 w-4" /> Försök igen</button>}
      </div>
    );
  }
  const { order, contact, delivery } = data;
  const st = portalStatus(order.status);
  const terminal = TERMINAL_STATUSES.has(order.status);
  const completedAt = order.status === "completed" ? formatPortalDateTime(data.completedAt) : null;
  const stage = portalDeliveryStage(order.status);
  const destination = destinationCoordinates(delivery.latitude, delivery.longitude);
  const planned = formatPortalTime(delivery.arrival?.plannedAt);
  const estimated = formatPortalTime(tracking.estimatedAt);
  const win = formatWindow(order.timeWindowStart ?? delivery.timeWindowStart, order.timeWindowEnd ?? delivery.timeWindowEnd);
  const tel = contact ? telHref(contact.phone) : null;

  return (
    <article className="portal-rise space-y-5">
      <button className={`${quietBtn} -ml-3 md:hidden`} onClick={onBack}><ArrowLeft className="h-4 w-4" /> Alla leveranser</button>
      <div className="rounded-3xl bg-[#24505a] px-6 py-7 text-[#f3efe6] md:px-8">
        <div className="flex flex-wrap items-center gap-3 text-[12px] uppercase tracking-[0.14em] text-[#bcd0cf]">
          <span className={`h-2 w-2 rounded-full ${toneDot[st.tone]}`} />{st.label}
          {order.reference && <span className="normal-case tracking-normal text-[#bcd0cf]">Referens {order.reference}</span>}
        </div>
        <h2 className="portal-serif mt-3 text-[30px] leading-[1.15] md:text-[38px]" data-testid="text-portal-status">{st.sentence}</h2>
        {stage !== null && <ol aria-label="Leveransens steg" className="mt-5 flex flex-wrap gap-2 text-xs">
          {["Planerad", "På väg till dig", "Levererad"].map((label, index) => (
            <li key={label} aria-current={stage === index ? "step" : undefined}
              className={`rounded-full border px-3 py-1.5 ${stage === index ? "border-[#f3efe6] bg-[#f3efe6] font-semibold text-[#24505a]" : "border-[#789b9e] text-[#c9d8d6]"}`}>
              {index + 1}. {label}
            </li>
          ))}
        </ol>}
        {terminal ? <div className="mt-5" data-testid="portal-delivery-outcome">
          {order.status === "completed"
            ? <Fact label="Levererad" value={completedAt} empty="Leveransen är registrerad som genomförd, men leveranstid saknas." strong />
            : <p className="text-sm text-[#c9d8d6]">Ingen ankomstprognos visas för denna avslutade leverans.</p>}
        </div> : <div className="mt-6 grid gap-5 sm:grid-cols-3">
          <Fact label="Beräknad ankomst" value={estimated} empty="Ingen beräkning just nu" strong />
          <Fact label="Planerad ankomst" value={planned} empty="Ej planerad" />
          <Fact label="Tidsfönster" value={win} empty="Inget tidsfönster" />
        </div>}
        <p className="mt-4 text-xs text-[#c9d8d6]" role="status">
          {online ? `Senast hämtad ${formatPortalTime(new Date(detail.dataUpdatedAt).toISOString())} · svensk tid`
            : "Offline – visar senast hämtade leveransuppgifter."}
          {detail.isRefetchError && " Uppdateringen misslyckades. Visar tidigare uppgifter."}
        </p>
      </div>

      <div className="grid min-w-0 gap-4">
        <div className="overflow-hidden rounded-3xl border border-[#ddd5c4] bg-[#f8f5ee]">
          {destination ? (
            <div className="h-[clamp(320px,48svh,440px)] md:h-[clamp(420px,55vh,600px)]" data-testid="map-portal-delivery">
              <MapContainer key={destination.join(",")} center={destination} zoom={14} zoomControl={false} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }}>
                <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" referrerPolicy="strict-origin" />
                <Marker position={destination} icon={destinationIcon} />
                {tracking.position && <Marker position={tracking.position} icon={vehicleIcon} title="Fordonets position" />}
                <FitDeliveryMap destination={destination} vehicle={tracking.position} />
                <ZoomControl position="bottomright" />
              </MapContainer>
            </div>
          ) : <div className="grid h-48 place-items-center px-6 text-center text-sm text-[#6b746f]">Adressen saknar kartposition, så ingen karta kan visas.</div>}
          <div className="space-y-1.5 border-t border-[#ddd5c4] px-5 py-4 text-sm">
            <p className="flex gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#24505a]" />{order.address}</p>
            <p className="text-[#3f4a45]" data-testid="text-portal-tracking">{trackingText(tracking.state)}</p>
            <p className="text-xs text-[#8a8f86]">Senaste position: {formatPortalDateTime(tracking.lastUpdatedAt) ?? "saknas"}{destination ? " · Rund markör är din adress, fyrkantig är fordonet." : ""}</p>
          </div>
        </div>

        <aside className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-3xl border border-[#ddd5c4] bg-[#fbf9f4] p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a8f86]">Kontakt för leveransen</p>
            {contact ? (
              <>
                <p className="portal-serif mt-3 text-xl">{contact.name}</p>
                {tel ? <a href={tel} className={`${primaryBtn} mt-4`} data-testid="link-portal-contact-phone"><Phone className="h-4 w-4" />{contact.phone}</a>
                  : <p className="mt-2 text-sm">{contact.phone}</p>}
                <p className="mt-3 text-xs leading-relaxed text-[#6b746f]">Ett arbetsnummer godkänt av transportören. Ring om leveransen gäller dig.</p>
              </>
            ) : <p className="mt-3 text-sm leading-relaxed text-[#56615c]">Ingen kontakt är godkänd för den här leveransen ännu.</p>}
          </div>
          <div className="space-y-3 rounded-3xl border border-[#ddd5c4] bg-[#f8f5ee] p-5 text-sm">
            <p className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-[#24505a]" />{formatPortalDate(order.date) ?? "Datum ej bestämt"}</p>
            <p className="flex items-center gap-2"><Clock className="h-4 w-4 text-[#24505a]" />{win ?? "Inget tidsfönster"}</p>
            <p className="text-xs text-[#8a8f86]">Alla tider i svensk tid. Uppdateras var 15:e sekund{detail.isFetching ? " · hämtar…" : ""}.</p>
            {detail.isRefetchError && <p className="text-xs text-[#7a2e1d]">Senaste uppdateringen misslyckades. Vi försöker igen.</p>}
          </div>
        </aside>
      </div>
    </article>
  );
}

function Fact({ label, value, empty, strong }: { label: string; value: string | null; empty: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.14em] text-[#9fbab9]">{label}</p>
      {value ? <p className={`mt-1 tabular-nums ${strong ? "portal-serif text-[28px]" : "text-lg"}`}>{value}</p>
        : <p className="mt-1.5 text-sm text-[#c9d8d6]">{empty}</p>}
    </div>
  );
}
