import { AppLayout } from "@/components/layout/AppLayout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ORG_ID } from "@/lib/constants";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShoppingBag, Link2, Unlink, Download, CheckCircle2, AlertCircle, Clock, Package, Loader2, ExternalLink } from "lucide-react";

interface ImportLog {
  id: string;
  ordersFound: number;
  ordersImported: number;
  ordersSkipped: number;
  errors: string[];
  importedAt: string;
}

interface ShopifyStatus {
  connected: boolean;
  shopDomain?: string;
  lastSyncAt?: string;
  totalOrdersImported?: number;
  createdAt?: string;
  importHistory?: ImportLog[];
}

function ShopifyPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showConnectForm, setShowConnectForm] = useState(false);

  const { data: status, isLoading } = useQuery<ShopifyStatus>({
    queryKey: ["shopify-status"],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/integrations/shopify/status/${ORG_ID}`);
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/integrations/shopify/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID, shopDomain, accessToken }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Connection failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shopify-status"] });
      setShowConnectForm(false);
      setShopDomain("");
      setAccessToken("");
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/integrations/shopify/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Import failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shopify-status"] });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/integrations/shopify/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID }),
      });
      if (!res.ok) throw new Error("Disconnect failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["shopify-status"] });
    },
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
            <ShoppingBag className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">{t("shopify.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("shopify.subtitle")}</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t("shopify.connectionStatus")}</h2>
            {status?.connected ? (
              <span className="flex items-center gap-1.5 text-sm text-emerald-500 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                {t("shopify.connected")}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <AlertCircle className="h-4 w-4" />
                {t("shopify.notConnected")}
              </span>
            )}
          </div>

          {status?.connected ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("shopify.store")}</p>
                  <p className="font-medium flex items-center gap-1.5">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {status.shopDomain}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("shopify.totalImported")}</p>
                  <p className="text-2xl font-bold text-primary">{status.totalOrdersImported ?? 0}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs text-muted-foreground mb-1">{t("shopify.lastSync")}</p>
                  <p className="font-medium">
                    {status.lastSyncAt
                      ? new Date(status.lastSyncAt).toLocaleString()
                      : t("shopify.never")}
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <Button
                  onClick={() => importMutation.mutate()}
                  disabled={importMutation.isPending}
                  className="flex items-center gap-2"
                >
                  {importMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t("shopify.importOrders")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  className="flex items-center gap-2 text-destructive hover:text-destructive"
                >
                  <Unlink className="h-4 w-4" />
                  {t("shopify.disconnect")}
                </Button>
              </div>

              {importMutation.isSuccess && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
                  <p className="font-medium text-emerald-600 dark:text-emerald-400 mb-1">{t("shopify.importComplete")}</p>
                  <p className="text-muted-foreground">
                    {t("shopify.importResult", {
                      found: importMutation.data.ordersFound,
                      imported: importMutation.data.ordersImported,
                      skipped: importMutation.data.ordersSkipped,
                    })}
                  </p>
                  {importMutation.data.errors?.length > 0 && (
                    <div className="mt-2 text-xs text-destructive">
                      {importMutation.data.errors.map((e: string, i: number) => (
                        <p key={i}>{e}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {importMutation.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                  {(importMutation.error as Error).message}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("shopify.connectDescription")}</p>
              {!showConnectForm ? (
                <Button onClick={() => setShowConnectForm(true)} className="flex items-center gap-2">
                  <Link2 className="h-4 w-4" />
                  {t("shopify.connectStore")}
                </Button>
              ) : (
                <div className="space-y-3 max-w-md">
                  <div>
                    <label className="text-sm font-medium block mb-1">{t("shopify.shopDomain")}</label>
                    <input
                      type="text"
                      value={shopDomain}
                      onChange={e => setShopDomain(e.target.value)}
                      placeholder="my-store.myshopify.com"
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium block mb-1">{t("shopify.accessToken")}</label>
                    <input
                      type="password"
                      value={accessToken}
                      onChange={e => setAccessToken(e.target.value)}
                      placeholder="shpat_..."
                      className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <p className="text-xs text-muted-foreground mt-1">{t("shopify.tokenHelp")}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => connectMutation.mutate()}
                      disabled={connectMutation.isPending || !shopDomain || !accessToken}
                    >
                      {connectMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : null}
                      {t("shopify.connect")}
                    </Button>
                    <Button variant="ghost" onClick={() => setShowConnectForm(false)}>
                      {t("shopify.cancel")}
                    </Button>
                  </div>
                  {connectMutation.isError && (
                    <p className="text-sm text-destructive">{(connectMutation.error as Error).message}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {status?.connected && status.importHistory && status.importHistory.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-lg font-semibold mb-4">{t("shopify.importHistory")}</h2>
            <div className="space-y-2">
              {status.importHistory.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {new Date(log.importedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1">
                      <Package className="h-3.5 w-3.5 text-muted-foreground" />
                      {log.ordersFound} {t("shopify.found")}
                    </span>
                    <span className="text-emerald-500 font-medium">
                      +{log.ordersImported} {t("shopify.imported")}
                    </span>
                    {log.ordersSkipped > 0 && (
                      <span className="text-amber-500">
                        {log.ordersSkipped} {t("shopify.skipped")}
                      </span>
                    )}
                    {log.errors.length > 0 && (
                      <span className="text-destructive">
                        {log.errors.length} {t("shopify.errors")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

export default ShopifyPage;
