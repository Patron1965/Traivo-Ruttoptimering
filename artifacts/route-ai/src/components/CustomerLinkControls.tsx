import { useState } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { requestCustomerLink, shareableUrl, type CustomerLinkAction } from "@/lib/customer-links";
import { Button } from "@/components/ui/button";
import { CustomerLinkSms } from "@/components/CustomerLinkSms";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function CustomerLinkControls({ stopId }: { stopId: string }) {
  const { user, hasRole } = useAuth();
  if (!user || !hasRole("admin", "dispatcher")) return null;
  return <CustomerLinkManager key={`${user.id}:${user.organizationId}:${stopId}`} stopId={stopId} scope={`${user.id}:${user.organizationId}`} />;
}

function CustomerLinkManager({ stopId, scope }: { stopId: string; scope: string }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<CustomerLinkAction | null>(null);
  const [feedback, setFeedback] = useState("");
  const key = ["customer-link", scope, stopId];
  const pendingMutations = useIsMutating({ mutationKey: key });
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => requestCustomerLink(import.meta.env.BASE_URL.replace(/\/$/, ""), stopId, undefined, signal),
    enabled: open, staleTime: 0, gcTime: 0, refetchInterval: open ? 30_000 : false,
    retry: false,
  });
  const mutation = useMutation({
    mutationKey: key,
    gcTime: 0,
    mutationFn: (action: CustomerLinkAction) => requestCustomerLink(import.meta.env.BASE_URL.replace(/\/$/, ""), stopId, action),
    onMutate: async () => { setFeedback(""); await client.cancelQueries({ queryKey: key }); },
    onSuccess: (data) => { client.setQueryData(key, data); setConfirm(null); },
    onSettled: () => { void client.invalidateQueries({ queryKey: key }); },
  });
  const url = !query.isError && !query.isFetching && !pendingMutations ? shareableUrl(query.data) : null;
  const busy = query.isFetching || pendingMutations > 0;
  const disabled = busy || query.isError;
  return <div onClick={(event) => event.stopPropagation()}>
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); setConfirm(null); setFeedback(""); mutation.reset(); }}>
      <DialogTrigger asChild><Button variant="outline" size="sm" data-testid={`button-customer-link-${stopId}`}><Link className="mr-2 h-3.5 w-3.5" />{t("customerLinks.title")}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("customerLinks.title")}</DialogTitle><DialogDescription>{t("customerLinks.description")}</DialogDescription></DialogHeader>
        <p className="text-xs text-muted-foreground">{t("customerLinks.legacy")}</p>
        {busy && <p role="status">{t("customerLinks.loading")}</p>}
        {(query.isError || mutation.isError) && <p role="alert" className="text-sm text-destructive">{t("customerLinks.error")}</p>}
        {query.isError && <Button onClick={() => void query.refetch()} data-testid="button-link-retry">{t("customerLinks.retry")}</Button>}
        {query.data && !query.isError && <>
          <p data-testid="status-customer-link" className="text-sm font-medium">{t(`customerLinks.${query.data.status}`)}</p>
          {query.data.expiresAt && <p className="text-xs text-muted-foreground">{t("customerLinks.expires", { date: new Date(query.data.expiresAt).toLocaleString(i18n.language, { timeZone: "Europe/Stockholm", timeZoneName: "short" }) })}</p>}
          {!query.data.configurationReady && <p role="status" className="text-sm">{t("customerLinks.configuration")}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!url} data-testid="button-link-copy" onClick={async () => {
              if (!url) return;
              try { await navigator.clipboard.writeText(url); setFeedback(t("customerLinks.copied")); }
              catch { setFeedback(t("customerLinks.copyError")); }
            }}>{t("customerLinks.copy")}</Button>
            {url && <Button asChild size="sm" variant="outline"><a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" data-testid="link-customer-preview">{t("customerLinks.preview")}</a></Button>}
            {(["create", "replace", "revoke"] as const).filter(action => action === "create" ? query.data.status === "none" : query.data.status !== "none" && (action !== "revoke" || query.data.status === "active")).map(action =>
              <Button key={action} size="sm" variant="outline" disabled={disabled || (action !== "revoke" && !query.data.configurationReady)} onClick={() => setConfirm(action)} data-testid={`button-link-${action}`}>{t(`customerLinks.${action}`)}</Button>
            )}
          </div>
        </>}
        {confirm && <div className="rounded-lg border p-3 space-y-3">
          <p className="text-sm">{t(`customerLinks.confirm_${confirm}`)}</p>
          <div className="flex gap-2"><Button disabled={disabled} onClick={() => mutation.mutate(confirm)} data-testid="button-link-confirm">{t("customerLinks.confirm")}</Button><Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)} data-testid="button-link-cancel">{t("customerLinks.cancel")}</Button></div>
        </div>}
        <CustomerLinkSms stopId={stopId} scope={scope} />
        {feedback && <p role="status" data-testid="status-link-feedback" className="text-sm">{feedback}</p>}
      </DialogContent>
    </Dialog>
  </div>;
}