import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { localizeError } from "@/lib/localize-error";
import {
  Webhook,
  Plus,
  Trash2,
  TestTube2,
  Copy,
  Eye,
  EyeOff,
  Zap,
  Globe,
  Check,
  X,
} from "lucide-react";

interface WebhookData {
  id: string;
  organizationId: string;
  url: string;
  name: string;
  secret: string | null;
  events: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const EVENT_GROUPS = [
  { label: "Routes", events: ["route.created", "route.optimized", "route.started", "route.completed", "route.cancelled"] },
  { label: "Stops", events: ["stop.completed", "stop.failed", "stop.skipped"] },
  { label: "Other", events: ["vehicle.position", "notification.sent"] },
];

function CreateWebhookForm({ onClose, onCreated, organizationId }: { onClose: () => void; onCreated: () => void; organizationId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [allEvents, setAllEvents] = useState(true);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          name,
          url,
          events: allEvents ? "*" : selectedEvents.join(","),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to create webhook");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: t("webhooks.created") });
      onCreated();
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: localizeError(err, t, { fallbackKey: "webhooks.testFailed" }), variant: "destructive" });
    },
  });

  const toggleEvent = (event: string) => {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
  };

  return (
    <div className="p-6 rounded-xl border border-primary/30 bg-card space-y-4">
      <h3 className="font-bold text-lg">{t("webhooks.createNew")}</h3>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-muted-foreground">{t("webhooks.name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Zapier, My CRM, Slack"
            className="w-full mt-1 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground">{t("webhooks.url")}</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.zapier.com/..."
            className="w-full mt-1 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-muted-foreground">{t("webhooks.events")}</label>
        <div className="mt-2 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allEvents}
              onChange={(e) => setAllEvents(e.target.checked)}
              className="rounded border-border"
            />
            <span className="text-sm font-medium">{t("webhooks.allEvents")}</span>
          </label>

          {!allEvents && EVENT_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{group.label}</p>
              <div className="flex flex-wrap gap-2">
                {group.events.map((event) => (
                  <button
                    key={event}
                    onClick={() => toggleEvent(event)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
                      selectedEvents.includes(event)
                        ? "bg-primary/20 border-primary text-primary"
                        : "bg-muted border-border text-muted-foreground hover:border-primary/50"
                    )}
                  >
                    {event}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!name || !url || createMutation.isPending}
          className="gap-2"
        >
          <Plus className="h-4 w-4" />
          {t("webhooks.create")}
        </Button>
        <Button variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

function WebhookCard({ hook, onRefresh, organizationId }: { hook: WebhookData; onRefresh: () => void; organizationId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [showSecret, setShowSecret] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/webhooks/${hook.id}?organizationId=${organizationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !hook.active }),
      });
       if (!res.ok) {
         const error = new Error("Failed");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    onSuccess: () => {
      onRefresh();
    },
    onError: (error) => {
      toast({ title: t("common.error"), description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/webhooks/${hook.id}?organizationId=${organizationId}`, {
        method: "DELETE",
      });
       if (!res.ok) {
         const error = new Error("Failed");
         Object.assign(error, { status: res.status });
         throw error;
       }
    },
    onSuccess: () => {
      toast({ title: t("webhooks.deleted") });
      onRefresh();
    },
    onError: (error) => {
      toast({ title: t("common.error"), description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/webhooks/${hook.id}/test?organizationId=${organizationId}`, {
        method: "POST",
      });
       if (!res.ok) {
         const error = new Error("Failed");
         Object.assign(error, { status: res.status });
         throw error;
       }
    },
    onSuccess: () => {
      toast({ title: t("webhooks.testSent") });
    },
    onError: (error) => {
      toast({ title: t("webhooks.testFailed"), description: localizeError(error, t, { fallbackKey: "webhooks.testFailed" }), variant: "destructive" });
    },
  });

  const events = hook.events === "*" ? [t("webhooks.allEvents")] : hook.events.split(",").map((e) => e.trim());

  return (
    <div className={cn(
      "p-4 rounded-xl border bg-card transition-colors",
      hook.active ? "border-border" : "border-border/50 opacity-60"
    )}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center",
            hook.active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
          )}>
            <Globe className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{hook.name}</h3>
              <span className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-medium uppercase",
                hook.active ? "bg-emerald-500/20 text-emerald-400" : "bg-muted text-muted-foreground"
              )}>
                {hook.active ? t("webhooks.active") : t("webhooks.inactive")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate max-w-md">{hook.url}</p>
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="w-11 h-11 px-0 text-primary"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
            title={t("webhooks.test")}
            aria-label={t("webhooks.test")}
          >
            <TestTube2 className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="w-11 h-11 px-0"
            onClick={() => toggleMutation.mutate()}
            title={hook.active ? t("webhooks.disable") : t("webhooks.enable")}
            aria-label={hook.active ? t("webhooks.disable") : t("webhooks.enable")}
          >
            {hook.active ? <X className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="w-11 h-11 px-0 text-destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            title={t("webhooks.delete")}
            aria-label={t("webhooks.delete")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {events.map((event, i) => (
          <span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
            {event}
          </span>
        ))}
      </div>

      {hook.secret && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("webhooks.secret")}:</span>
          <code className="text-xs bg-muted px-2 py-0.5 rounded font-mono">
            {showSecret ? hook.secret : "••••••••••••••••"}
          </code>
          <button
            onClick={() => setShowSecret(!showSecret)}
            className="text-muted-foreground hover:text-foreground w-11 h-11 flex items-center justify-center -my-3 -mx-2"
            aria-label={showSecret ? t("webhooks.hideSecret", { defaultValue: "Dölj hemlighet" }) : t("webhooks.showSecret", { defaultValue: "Visa hemlighet" })}
            title={showSecret ? t("webhooks.hideSecret", { defaultValue: "Dölj hemlighet" }) : t("webhooks.showSecret", { defaultValue: "Visa hemlighet" })}
          >
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(hook.secret || "");
              toast({ title: t("webhooks.secretCopied") });
            }}
            className="text-muted-foreground hover:text-foreground w-11 h-11 flex items-center justify-center -my-3 -mx-2"
            aria-label={t("webhooks.copySecret", { defaultValue: "Kopiera hemlighet" })}
            title={t("webhooks.copySecret", { defaultValue: "Kopiera hemlighet" })}
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

export function WebhooksContent() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data: hooks, isLoading } = useQuery<WebhookData[]>({
    queryKey: ["webhooks", organizationId],
    queryFn: async () => {
      const res = await fetch(`/api/webhooks?organizationId=${organizationId}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!organizationId,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["webhooks", organizationId] });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
            <Webhook className="h-7 w-7 text-primary" />
            {t("webhooks.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t("webhooks.subtitle")}</p>
        </div>
        {!showCreate && (
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            {t("webhooks.addWebhook")}
          </Button>
        )}
      </div>

      <div className="p-4 rounded-xl border border-border bg-card/50">
        <div className="flex items-start gap-3">
          <Zap className="h-5 w-5 text-amber-400 mt-0.5" />
          <div>
            <h3 className="font-semibold text-sm">{t("webhooks.zapierTitle")}</h3>
            <p className="text-xs text-muted-foreground mt-1">{t("webhooks.zapierDesc")}</p>
            <div className="mt-2 text-xs text-muted-foreground space-y-1">
              <p>1. {t("webhooks.zapierStep1")}</p>
              <p>2. {t("webhooks.zapierStep2")}</p>
              <p>3. {t("webhooks.zapierStep3")}</p>
            </div>
          </div>
        </div>
      </div>

      {showCreate && organizationId && (
        <CreateWebhookForm organizationId={organizationId} onClose={() => setShowCreate(false)} onCreated={refresh} />
      )}

      {isLoading ? (
        <LoadingState message={t("common.loading")} />
      ) : hooks && hooks.length > 0 ? (
        <div className="space-y-3">
          {hooks.map((hook) => (
            organizationId && <WebhookCard key={hook.id} hook={hook} organizationId={organizationId} onRefresh={refresh} />
          ))}
        </div>
      ) : !showCreate ? (
        <div className="text-center py-16">
          <Globe className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
          <h3 className="font-semibold text-lg">{t("webhooks.empty")}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t("webhooks.emptyDesc")}</p>
        </div>
      ) : null}
    </div>
  );
}

export default function WebhooksPage() {
  return (
    <AppLayout>
      <div className="p-6">
        <WebhooksContent />
      </div>
    </AppLayout>
  );
}
