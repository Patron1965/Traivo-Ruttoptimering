import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CustomerSmsPreview } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

const labels: Record<string, string> = {
  none: "Inget SMS har skickats.",
  sending: "Utskick pågår.",
  sent: "Accepterat av leverantör – leverans till telefonen är inte bekräftad.",
  rejected: "Misslyckat – leverantören har inte accepterat utskicket.",
  unknown: "Okänt resultat. SMS:et kan ha skickats. Ingen automatisk omsändning görs.",
  failed: "Okänt resultat. Ingen automatisk omsändning görs.",
  missing_recipient: "Mottagare saknades vid föregående försök.",
  channel_unavailable: "SMS var inte tillgängligt vid föregående försök.",
};

export function CustomerLinkSms({ stopId, scope }: { stopId: string; scope: string }) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<CustomerSmsPreview | null>(null);
  const [pending, setPending] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const key = ["customer-link-sms", scope, stopId];
  const endpoint = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/stops/${encodeURIComponent(stopId)}/customer-link/sms`;
  const query = useQuery<CustomerSmsPreview>({
    queryKey: key, gcTime: 0, staleTime: 0, retry: false, refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const response = await fetch(endpoint, { signal, credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("SMS-status kunde inte hämtas.");
      return response.json();
    },
  });
  async function send() {
    if (!confirm || locked.current) return;
    locked.current = true; setPending(true); setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: confirm.revision, confirmation: confirm.confirmation, resend: confirm.revision >= 0 }),
        signal: AbortSignal.timeout(25_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Resultatet är okänt. Uppdatera status.");
      client.setQueryData(key, result);
    } catch (err) {
      setError(err instanceof Error && err.name !== "TypeError" && err.name !== "TimeoutError"
        ? err.message : "Okänt resultat. SMS:et kan ha skickats. Uppdatera status; inget skickas automatiskt igen.");
    } finally {
      setConfirm(null); setPending(false); locked.current = false;
      void client.invalidateQueries({ queryKey: key });
    }
  }
  return <section className="space-y-2 border-t pt-3" aria-label="SMS med kundlänk">
    <p className="text-sm font-medium">Skicka via SMS</p>
    {query.isLoading && <p role="status">Hämtar SMS-status…</p>}
    {query.isError && <p role="alert">SMS-status kunde inte hämtas. Kopiering och förhandsgranskning av länken påverkas inte.</p>}
    {query.data && <>
      <p role="status" className="text-sm">{pending ? labels.sending : labels[query.data.status] ?? labels.unknown}</p>
      {query.data.blockedReason && <p className="text-sm">{query.data.blockedReason}</p>}
      <Button size="sm" variant="outline" disabled={pending || query.isError || query.isFetching || !!query.data.blockedReason || query.data.status === "sending"}
        onClick={() => { setError(""); setConfirm(query.data); }} data-testid="button-customer-sms">
        {query.data.revision >= 0 ? "Skicka igen…" : "Skicka via SMS…"}
      </Button>
    </>}
    <Button size="sm" variant="ghost" disabled={pending || query.isFetching} onClick={() => void query.refetch()}>Uppdatera SMS-status</Button>
    {confirm && <div className="space-y-3 rounded border p-3">
      <p className="text-sm">Mottagare: <strong>{confirm.recipient}</strong></p>
      <p className="break-all whitespace-pre-wrap text-sm">{confirm.message}</p>
      {confirm.revision >= 0 && <p className="text-sm text-amber-700">Detta är en avsiktlig omsändning som loggas. Mottagaren kan redan ha fått föregående SMS.</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => void send()} data-testid="button-confirm-customer-sms">{pending ? "Skickar…" : "Bekräfta och skicka SMS"}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>Avbryt</Button>
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
