import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PlatformOrganization, SupportSummary as Summary } from "@workspace/api-client-react";

const endpoint = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/platform/support-access`;
export function SupportSummary({ organization, onExit }: { organization: PlatformOrganization; onExit: () => void }) {
  const token = useRef<string | null>(null);
  const [reason, setReason] = useState("");
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function read() {
    const response = await fetch(`${endpoint}/current`, { credentials: "include", headers: { "X-Support-Access": token.current! } });
    const body = await response.json();
    if (!response.ok) { setData(null); throw new Error(body.error ?? "Supportåtkomsten kunde inte hämtas."); }
    setData(body);
  }
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (token.current) void read().catch(e => setError(e.message));
    }, 15_000);
    return () => {
      window.clearInterval(interval);
      if (token.current) void fetch(`${endpoint}/current`, { method: "DELETE", credentials: "include", keepalive: true, headers: { "X-Support-Access": token.current } });
    };
  }, []);
  async function enter() {
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: organization.id, reason }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Supportåtkomsten kunde inte öppnas.");
      token.current = body.token;
      await read();
    } catch (e) { setError(e instanceof Error ? e.message : "Supportfel"); }
    finally { setBusy(false); }
  }
  async function exit() {
    if (token.current) {
      const response = await fetch(`${endpoint}/current`, { method: "DELETE", credentials: "include", headers: { "X-Support-Access": token.current } });
      if (!response.ok && response.status !== 403) { setError("Kunde inte avsluta supportåtkomsten. Försök igen."); return; }
      token.current = null;
    }
    onExit();
  }
  return <section className="p-6 space-y-5">
    <div className="border border-amber-500 bg-amber-500/10 rounded-lg p-4">
      <h2 className="font-bold">Supportläge – {organization.name}</h2>
      <p>Endast läsning av organisationsöversikt. Inga kunduppdrag, exporter eller ändringar. All åtkomst loggas.</p>
      <Button variant="outline" className="mt-3" disabled={busy} onClick={() => void exit().catch(() => setError("Kunde inte avsluta supportåtkomsten."))}>Avsluta supportläge</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!data ? <form onSubmit={e => { e.preventDefault(); void enter(); }} className="space-y-3">
      <label htmlFor="support-reason">Supportärende / anledning</label>
      <Input id="support-reason" value={reason} onChange={e => setReason(e.target.value)} minLength={5} maxLength={500} required />
      <Button disabled={busy}>Öppna läsåtkomst i 15 minuter</Button>
    </form> : <div className="space-y-3">
      <h3 className="text-xl font-semibold">{data.organization.name}</h3>
      <p>Verksamhet: {data.organization.operatingMode}</p>
      <p>Användarkonton: {data.userCount}</p>
      <p>Ärende: {data.reason}</p>
      <p>Åtkomst upphör: {new Date(data.expiresAt).toLocaleTimeString("sv-SE")}</p>
    </div>}
  </section>;
}