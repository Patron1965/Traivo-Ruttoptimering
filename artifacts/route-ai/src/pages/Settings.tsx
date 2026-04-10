import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AppLayout } from "@/components/layout/AppLayout";
import { cn } from "@/lib/utils";
import { Plug, Webhook, ShoppingBag, CreditCard, Check, Copy, Info, Settings as SettingsIcon } from "lucide-react";
import { ORG_ID } from "@/lib/constants";
import { WebhooksContent } from "@/pages/Webhooks";
import { ShopifyContent } from "@/pages/ShopifyIntegration";
import { BillingContent } from "@/pages/Billing";

type SettingsTab = "api" | "webhooks" | "shopify" | "billing";

export default function Settings() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("api");
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  }, []);

  const tabs: { key: SettingsTab; labelKey: string; icon: typeof Plug }[] = [
    { key: "api", labelKey: "settings.tabs.api", icon: Plug },
    { key: "webhooks", labelKey: "settings.tabs.webhooks", icon: Webhook },
    { key: "shopify", labelKey: "settings.tabs.shopify", icon: ShoppingBag },
    { key: "billing", labelKey: "settings.tabs.billing", icon: CreditCard },
  ];

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        <div className="w-56 border-r border-border bg-card/50 p-4 space-y-1 shrink-0">
          <div className="flex items-center gap-2 px-3 py-2 mb-3">
            <SettingsIcon className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-sm">{t("settings.title")}</h2>
          </div>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm transition-all text-left",
                activeTab === tab.key
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <tab.icon className="h-4 w-4 shrink-0" />
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-6 md:p-8">
          <div className="max-w-4xl mx-auto">
            {activeTab === "api" && (
              <ApiDocumentation copiedSnippet={copiedSnippet} onCopy={copyToClipboard} />
            )}
            {activeTab === "webhooks" && <WebhooksContent />}
            {activeTab === "shopify" && <ShopifyContent />}
            {activeTab === "billing" && <BillingContent />}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function ApiDocumentation({
  copiedSnippet,
  onCopy,
}: {
  copiedSnippet: string | null;
  onCopy: (text: string, id: string) => void;
}) {
  const { t } = useTranslation();

  const importExample = `POST /api/stops/import
Content-Type: application/json

{
  "organizationId": "${ORG_ID}",
  "stops": [
    {
      "address": "Storgatan 12, Stockholm",
      "latitude": 59.3293,
      "longitude": 18.0686,
      "timeWindowStart": "2026-04-10T08:00:00Z",
      "timeWindowEnd": "2026-04-10T12:00:00Z",
      "serviceDurationMin": 15,
      "weightKg": 25.5,
      "notes": "Portkod 1234"
    }
  ]
}`;

  const webhookExample = `POST /api/webhooks
Content-Type: application/json

{
  "organizationId": "${ORG_ID}",
  "url": "https://ert-system.example.com/traivo-webhook",
  "events": [
    "route.optimized",
    "route.completed",
    "stop.completed",
    "stop.failed"
  ],
  "name": "ERP Webhook"
}`;

  const webhookPayload = `{
  "event": "stop.completed",
  "timestamp": "2026-04-10T14:32:00Z",
  "data": {
    "stopId": "abc-123",
    "routeId": "route-456",
    "address": "Storgatan 12, Stockholm",
    "status": "completed",
    "completedAt": "2026-04-10T14:30:00Z"
  }
}`;

  const exportExample = `GET /api/routes/{routeId}/export

Response: CSV file with all stops in the route`;

  const listStopsExample = `GET /api/stops?organizationId=${ORG_ID}&status=completed

Response: JSON array of stops with the given status`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("importPage.api.title")}</h1>
        <p className="text-muted-foreground mt-1">{t("importPage.api.subtitle")}</p>
      </div>

      <div className="grid gap-6">
        <ApiSection
          title={t("importPage.api.importTitle")}
          description={t("importPage.api.importDesc")}
          method="POST"
          endpoint="/api/stops/import"
          code={importExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="import"
        />

        <ApiSection
          title={t("importPage.api.webhookTitle")}
          description={t("importPage.api.webhookDesc")}
          method="POST"
          endpoint="/api/webhooks"
          code={webhookExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="webhook"
        />

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="p-4 border-b border-border">
            <h3 className="font-semibold text-sm">{t("importPage.api.webhookPayloadTitle")}</h3>
            <p className="text-xs text-muted-foreground mt-1">{t("importPage.api.webhookPayloadDesc")}</p>
          </div>
          <div className="relative">
            <pre className="p-4 text-xs font-mono overflow-auto bg-zinc-950 text-zinc-300 max-h-[300px]">{webhookPayload}</pre>
            <button
              onClick={() => onCopy(webhookPayload, "payload")}
              className="absolute top-3 right-3 p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
            >
              {copiedSnippet === "payload" ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="p-4 border-t border-border">
            <p className="text-xs text-muted-foreground">
              <strong>{t("importPage.api.events")}:</strong> route.optimized, route.started, route.completed, route.cancelled, stop.completed, stop.failed
            </p>
          </div>
        </div>

        <ApiSection
          title={t("importPage.api.exportTitle")}
          description={t("importPage.api.exportDesc")}
          method="GET"
          endpoint="/api/routes/{id}/export"
          code={exportExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="export"
        />

        <ApiSection
          title={t("importPage.api.listStopsTitle")}
          description={t("importPage.api.listStopsDesc")}
          method="GET"
          endpoint="/api/stops"
          code={listStopsExample}
          copiedSnippet={copiedSnippet}
          onCopy={onCopy}
          id="list"
        />
      </div>

      <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <h3 className="font-semibold text-sm">{t("importPage.api.flowTitle")}</h3>
            <div className="mt-2 space-y-2 text-sm text-muted-foreground">
              <p><strong>1.</strong> {t("importPage.api.flow1")}</p>
              <p><strong>2.</strong> {t("importPage.api.flow2")}</p>
              <p><strong>3.</strong> {t("importPage.api.flow3")}</p>
              <p><strong>4.</strong> {t("importPage.api.flow4")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ApiSection({
  title,
  description,
  method,
  endpoint,
  code,
  copiedSnippet,
  onCopy,
  id,
}: {
  title: string;
  description: string;
  method: string;
  endpoint: string;
  code: string;
  copiedSnippet: string | null;
  onCopy: (text: string, id: string) => void;
  id: string;
}) {
  const methodColor = method === "POST" ? "bg-green-500/10 text-green-500" : method === "GET" ? "bg-blue-500/10 text-blue-500" : "bg-amber-500/10 text-amber-500";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase", methodColor)}>{method}</span>
          <code className="text-xs font-mono text-muted-foreground">{endpoint}</code>
        </div>
        <h3 className="font-semibold text-sm mt-2">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      </div>
      <div className="relative">
        <pre className="p-4 text-xs font-mono overflow-auto bg-zinc-950 text-zinc-300 max-h-[300px]">{code}</pre>
        <button
          onClick={() => onCopy(code, id)}
          className="absolute top-3 right-3 p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 transition-colors"
        >
          {copiedSnippet === id ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
