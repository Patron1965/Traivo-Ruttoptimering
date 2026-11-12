import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { cn } from "@/lib/utils";
import { Plug, Webhook, ShoppingBag, CreditCard, Check, Copy, Info, Settings as SettingsIcon, Cpu, Bell, Download, FileJson, FileArchive, DatabaseZap, FileText, Truck, PenTool, ShieldAlert, Calendar, ListFilter, Leaf, Palette, Tags } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/lib/auth-context";
import { WebhooksContent } from "@/pages/Webhooks";
import { ShopifyContent } from "@/pages/ShopifyIntegration";
import { BillingContent } from "@/pages/Billing";
import { BrandingSettings } from "@/components/settings/BrandingSettings";
import { ReportCategorySettings } from "@/components/settings/ReportCategorySettings";
import { CustomerNotificationSettings } from "@/components/settings/CustomerNotificationSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useDirectStopMove } from "@/hooks/use-direct-stop-move";
import { Link } from "wouter";
import { useVerifyOrganizationDepot, type DepotVerificationInput } from "@workspace/api-client-react";
import { localizeError } from "@/lib/localize-error";
import { invalidateRouteQueries } from "@/lib/route-query-cache";
import { optimizationSettingsPayload } from "@/lib/optimization-settings";

const API_BASE = import.meta.env.VITE_API_URL || "";

type SettingsTab = "general" | "branding" | "api" | "webhooks" | "shopify" | "billing" | "optimization" | "notifications" | "dataRetention" | "dataExport" | "reportCategories";

type OrgSettings = {
  operatingMode: "transport" | "field_service" | "mixed";
  autoBalance: boolean;
  snapToRoad: boolean;
  defaultRouteType: string;
  maxDriverOvertimeMin: number;
  allowLateStopsMin: number;
  defaultServiceDurationMin: number;
  customerSupportType: string;
  notifyOrderCreated: boolean;
  notifyDriverEnRoute: boolean;
  notifyDelivered: boolean;
  notifyFailed: boolean;
  notificationSenderType: string;
  notificationTemplate: string | null;
  stopRetentionEnabled: boolean;
  stopRetentionDays: number;
  depotStartAddress: string | null;
  depotStartPostalCode: string | null;
  depotStartCity: string | null;
  depotStartCountryCode: string | null;
  depotStartLatitude: number | null;
  depotStartLongitude: number | null;
  depotStartVerifiedAt: string | null;
  depotEndAddress: string | null;
  depotEndPostalCode: string | null;
  depotEndCity: string | null;
  depotEndCountryCode: string | null;
  depotEndLatitude: number | null;
  depotEndLongitude: number | null;
  depotEndVerifiedAt: string | null;
};

function useOrgSettings() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useQuery<OrgSettings>({
    queryKey: ["/api/org-settings", organizationId],
    queryFn: () => fetch(`${API_BASE}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`).then(r => r.json()),
    enabled: !!organizationId,
  });
}

export default function Settings() {
  const { t } = useTranslation();
  const { hasRole } = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet(null), 2000);
  }, []);

  const allTabs: { key: SettingsTab; labelKey: string; icon: typeof Plug; adminOnly?: boolean }[] = [
    { key: "general", labelKey: "settings.tabs.general", icon: SettingsIcon as any },
    { key: "branding", labelKey: "Kundanpassning", icon: Palette as any, adminOnly: true },
    { key: "optimization", labelKey: "settings.tabs.optimization", icon: Cpu as any },
    { key: "notifications", labelKey: "settings.tabs.notifications", icon: Bell },
    { key: "reportCategories", labelKey: "Avvikelsekategorier", icon: Tags, adminOnly: true },
    { key: "dataRetention", labelKey: "settings.tabs.dataRetention", icon: DatabaseZap },
    { key: "api", labelKey: "settings.tabs.api", icon: Plug },
    { key: "webhooks", labelKey: "settings.tabs.webhooks", icon: Webhook },
    { key: "shopify", labelKey: "settings.tabs.shopify", icon: ShoppingBag },
    { key: "billing", labelKey: "settings.tabs.billing", icon: CreditCard, adminOnly: true },
    { key: "dataExport", labelKey: "settings.tabs.dataExport", icon: Download, adminOnly: true },
  ];

  const tabs = allTabs.filter(t => !t.adminOnly || hasRole("admin"));

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-3.5rem)] flex-col md:flex-row overflow-hidden">
        <div className="w-full md:w-56 border-b md:border-b-0 md:border-r border-border bg-card/50 p-2 md:p-4 space-x-2 md:space-x-0 md:space-y-1 shrink-0 flex flex-row md:flex-col overflow-x-auto md:overflow-y-auto">
          <div className="hidden md:flex items-center gap-2 px-3 py-2 mb-3">
            <SettingsIcon className="h-5 w-5 text-primary" />
            <h2 className="font-semibold text-sm">{t("settings.title")}</h2>
          </div>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all text-left whitespace-nowrap shrink-0 md:shrink md:w-full",
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

        <div className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
          <div className="max-w-4xl mx-auto">
            {activeTab === "general" && <GeneralSettings />}
            {activeTab === "branding" && <BrandingSettings />}
            {activeTab === "optimization" && <OptimizationSettings />}
            {activeTab === "notifications" && <CustomerNotificationSettings />}
            {activeTab === "dataRetention" && <DataRetentionSettings />}
            {activeTab === "reportCategories" && <ReportCategorySettings />}
            {activeTab === "api" && (
              <ApiDocumentation copiedSnippet={copiedSnippet} onCopy={copyToClipboard} />
            )}
            {activeTab === "webhooks" && <WebhooksContent />}
            {activeTab === "shopify" && <ShopifyContent />}
            {activeTab === "billing" && <BillingContent />}
            {activeTab === "dataExport" && <DataExportSettings />}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function GeneralSettings() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { enabled: directStopMoveEnabled, setEnabled: setDirectStopMoveEnabled } = useDirectStopMove();
  const { t } = useTranslation();
  const { data: settings, isLoading } = useOrgSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Partial<OrgSettings>>({});

  const verifyDepot = useVerifyOrganizationDepot();

  useEffect(() => { if (settings) setForm(settings); }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: Partial<OrgSettings>) =>
      fetch(`${API_BASE}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-settings"] });
      void invalidateRouteQueries(queryClient);
      toast({ title: t("settings.saved", "Settings saved successfully") });
    },
  });

  if (isLoading) return <div className="text-muted-foreground text-sm">{t("common.loading", "Loading...")}</div>;

  const update = (key: keyof OrgSettings, value: any) => setForm(prev => ({ ...prev, [key]: value }));

  const updateStartDepot = (key: keyof OrgSettings, value: any) => {
    update(key, value);
    if (key === "depotStartAddress" || key === "depotStartPostalCode" || key === "depotStartCity") {
      update("depotStartVerifiedAt", null);
      update("depotStartLatitude", null);
      update("depotStartLongitude", null);
    }
  };

  const updateEndDepot = (key: keyof OrgSettings, value: any) => {
    update(key, value);
    if (key === "depotEndAddress" || key === "depotEndPostalCode" || key === "depotEndCity") {
      update("depotEndVerifiedAt", null);
      update("depotEndLatitude", null);
      update("depotEndLongitude", null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("settings.general.title", "General Settings")}</h1>
        <p className="text-muted-foreground mt-1">{t("settings.general.subtitle", "Manage basic organization preferences.")}</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-3">
        <div className="flex items-start gap-3">
          <Checkbox
            id="direct-stop-move"
            data-testid="checkbox-direct-stop-move"
            checked={directStopMoveEnabled}
            disabled={!user?.id || !organizationId}
            aria-describedby="direct-stop-move-description"
            onCheckedChange={(checked) => {
              if (!setDirectStopMoveEnabled(checked === true)) {
                toast({
                  title: "Inställningen kunde inte sparas",
                  description: "Webbläsarens lokala lagring är inte tillgänglig. Direktflytt är avstängd.",
                  variant: "destructive",
                });
              }
            }}
          />
          <div className="space-y-2">
            <Label htmlFor="direct-stop-move">Flytta stopp direkt vid dra och släpp</Label>
            <p id="direct-stop-move-description" className="text-xs text-muted-foreground">
              Giltiga flyttar sparas direkt. Konflikter måste alltid granskas innan flytten sparas.
              {" "}Inställningen sparas direkt i den här webbläsaren för din användare och den aktuella organisationen.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <div className="space-y-2">
          <Label>{t("settings.general.operatingMode", "Operating Mode")}</Label>
          <Select value={form.operatingMode || "transport"} onValueChange={v => update("operatingMode", v)}>
            <SelectTrigger data-testid="select-operating-mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="transport">{t("settings.general.modeTransport", "Transport (Default)")}</SelectItem>
              <SelectItem value="field_service">{t("settings.general.modeFieldService", "Field Service")}</SelectItem>
              <SelectItem value="mixed">{t("settings.general.modeMixed", "Mixed (Both)")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-2">
            {t("settings.general.operatingModeDesc", "Transport mode focuses on pick-up and delivery. Field Service focuses on on-site jobs (skills, duration, requirements). Mixed mode shows both workflows.")}
          </p>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <h2 className="text-lg font-bold">Depåer</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <Label>Startdepå</Label>
              <p className="text-xs text-muted-foreground mb-2">Används som standardplats där rutter påbörjas.</p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Gatuadress</Label>
              <Input
                value={form.depotStartAddress || ""}
                onChange={e => updateStartDepot("depotStartAddress", e.target.value)}
                placeholder="Ex. Storgatan 1"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label className="text-xs">Postnummer</Label>
                <Input
                  value={form.depotStartPostalCode || ""}
                  onChange={e => updateStartDepot("depotStartPostalCode", e.target.value)}
                  placeholder="123 45"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Ort</Label>
                <Input
                  value={form.depotStartCity || ""}
                  onChange={e => updateStartDepot("depotStartCity", e.target.value)}
                  placeholder="Stockholm"
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              disabled={verifyDepot.isPending || !form.depotStartAddress || !organizationId}
              onClick={async () => {
                if (!organizationId || !form.depotStartAddress) return;
                try {
                  const res = await verifyDepot.mutateAsync({
                    id: organizationId,
                    endpoint: "start",
                    data: {
                      address: form.depotStartAddress,
                      postalCode: form.depotStartPostalCode || undefined,
                      city: form.depotStartCity || undefined,
                    }
                  });
                  update("depotStartAddress", res.address);
                  update("depotStartLatitude", res.latitude);
                  update("depotStartLongitude", res.longitude);
                  update("depotStartVerifiedAt", res.verifiedAt);
                  toast({ title: "Startdepå verifierad", description: `Hittade koordinater för: ${res.address}` });
                  queryClient.invalidateQueries({ queryKey: ["/api/org-settings"] });
                } catch (e: any) {
                  toast({ title: t("common.error"), description: localizeError(e, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
                }
              }}
            >
              {verifyDepot.isPending ? "Verifierar..." : "Verifiera startdepå"}
            </Button>
            {form.depotStartVerifiedAt && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 mt-2 bg-emerald-500/10 p-2 rounded-md border border-emerald-500/20">
                <Check className="h-3.5 w-3.5" />
                <span>Verifierad och sparad</span>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <Label>Slutdepå</Label>
              <p className="text-xs text-muted-foreground mb-2">Används som standardplats där rutter avslutas.</p>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Gatuadress</Label>
              <Input
                value={form.depotEndAddress || ""}
                onChange={e => updateEndDepot("depotEndAddress", e.target.value)}
                placeholder="Ex. Storgatan 1"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label className="text-xs">Postnummer</Label>
                <Input
                  value={form.depotEndPostalCode || ""}
                  onChange={e => updateEndDepot("depotEndPostalCode", e.target.value)}
                  placeholder="123 45"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Ort</Label>
                <Input
                  value={form.depotEndCity || ""}
                  onChange={e => updateEndDepot("depotEndCity", e.target.value)}
                  placeholder="Stockholm"
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              disabled={verifyDepot.isPending || !form.depotEndAddress || !organizationId}
              onClick={async () => {
                if (!organizationId || !form.depotEndAddress) return;
                try {
                  const res = await verifyDepot.mutateAsync({
                    id: organizationId,
                    endpoint: "end",
                    data: {
                      address: form.depotEndAddress,
                      postalCode: form.depotEndPostalCode || undefined,
                      city: form.depotEndCity || undefined,
                    }
                  });
                  update("depotEndAddress", res.address);
                  update("depotEndLatitude", res.latitude);
                  update("depotEndLongitude", res.longitude);
                  update("depotEndVerifiedAt", res.verifiedAt);
                  toast({ title: "Slutdepå verifierad", description: `Hittade koordinater för: ${res.address}` });
                  queryClient.invalidateQueries({ queryKey: ["/api/org-settings"] });
                } catch (e: any) {
                  toast({ title: t("common.error"), description: localizeError(e, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
                }
              }}
            >
              {verifyDepot.isPending ? "Verifierar..." : "Verifiera slutdepå"}
            </Button>
            {form.depotEndVerifiedAt && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 mt-2 bg-emerald-500/10 p-2 rounded-md border border-emerald-500/20">
                <Check className="h-3.5 w-3.5" />
                <span>Verifierad och sparad</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending} data-testid="button-save-general">
          {saveMutation.isPending ? t("common.saving", "Saving...") : t("settings.save", "Save Changes")}
        </Button>
      </div>
    </div>
  );
}

function OptimizationSettings() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { t } = useTranslation();
  const { data: settings, isLoading } = useOrgSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Partial<OrgSettings>>({});
  const [integerErrors, setIntegerErrors] = useState<Partial<Record<"maxDriverOvertimeMin" | "allowLateStopsMin", string>>>({});
  const [allowanceText, setAllowanceText] = useState({ maxDriverOvertimeMin: "0", allowLateStopsMin: "0" });

  useEffect(() => {
    if (!settings) return;
    setForm(settings);
    setAllowanceText({
      maxDriverOvertimeMin: String(settings.maxDriverOvertimeMin ?? 0),
      allowLateStopsMin: String(settings.allowLateStopsMin ?? 0),
    });
    setIntegerErrors({});
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<OrgSettings>) => {
      const response = await fetch(`${API_BASE}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(optimizationSettingsPayload(data)),
      });
      if (!response.ok) {
        const error = new Error("Could not save optimization settings");
        Object.assign(error, {
          status: response.status,
          data: await response.json().catch(() => ({})),
        });
        throw error;
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-settings"] });
      void invalidateRouteQueries(queryClient);
      toast({ title: t("settings.saved") });
    },
    onError: (error) => toast({
      title: t("settings.optimization.saveError", "Kunde inte spara optimeringsinställningarna"),
      description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }),
      variant: "destructive",
    }),
  });

  if (isLoading) return <div className="text-muted-foreground text-sm">{t("common.loading")}</div>;

  const update = (key: keyof OrgSettings, value: any) => setForm(prev => ({ ...prev, [key]: value }));
  const updateNonNegativeInteger = (
    key: "maxDriverOvertimeMin" | "allowLateStopsMin",
    rawValue: string,
  ) => {
    // Preserve incomplete/invalid edits rather than restoring the last number
    // while the user types, which can concatenate digits into a different limit.
    setAllowanceText((current) => ({ ...current, [key]: rawValue }));
    const value = Number(rawValue);
    if (!/^\d+$/.test(rawValue) || !Number.isInteger(value) || value < 0 || value > 1440) {
      setIntegerErrors((current) => ({
        ...current,
        [key]: t(
          "settings.optimization.integerRangeError",
          "Ange ett heltal mellan 0 och 1440.",
        ),
      }));
      return;
    }
    setIntegerErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    update(key, value);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("settings.optimization.title")}</h1>
        <p className="text-muted-foreground mt-1">{t("settings.optimization.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
        <div>
          <p className="font-medium">{t("settings.optimization.controlCenterTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("settings.optimization.controlCenterDesc")}</p>
        </div>
        <Link
          href="/planner"
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Cpu className="h-4 w-4" />
          {t("settings.optimization.openControlCenter")}
        </Link>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <div className="grid grid-cols-2 gap-6">
          <div className="flex items-center justify-between p-3 rounded-lg border border-border">
            <div>
              <Label className="font-medium">{t("settings.optimization.autoBalance")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.optimization.autoBalanceDesc")}</p>
            </div>
            <Checkbox checked={form.autoBalance ?? false} onCheckedChange={v => update("autoBalance", v)} />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border">
            <div>
              <Label className="font-medium">{t("settings.optimization.snapToRoad")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.optimization.snapToRoadDesc")}</p>
            </div>
            <Checkbox checked={form.snapToRoad ?? false} onCheckedChange={v => update("snapToRoad", v)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label>{t("settings.optimization.defaultRouteType")}</Label>
            <Select value={form.defaultRouteType || "delivery"} onValueChange={v => update("defaultRouteType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="delivery">{t("settings.optimization.typeDelivery")}</SelectItem>
                <SelectItem value="pickup">{t("settings.optimization.typePickup")}</SelectItem>
                <SelectItem value="service">{t("settings.optimization.typeService")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("settings.optimization.defaultServiceDuration")}</Label>
            <Input type="number" min={0} value={form.defaultServiceDurationMin ?? 5} onChange={e => update("defaultServiceDurationMin", parseInt(e.target.value) || 0)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="max-driver-overtime">{t("settings.optimization.maxOvertime")}</Label>
             <Input
               id="max-driver-overtime"
               type="text"
               inputMode="numeric"
               value={allowanceText.maxDriverOvertimeMin}
               onChange={e => updateNonNegativeInteger("maxDriverOvertimeMin", e.target.value)}
               aria-invalid={Boolean(integerErrors.maxDriverOvertimeMin)}
             />
             {integerErrors.maxDriverOvertimeMin && (
               <p className="text-xs text-destructive">{integerErrors.maxDriverOvertimeMin}</p>
             )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="allow-late-stops">{t("settings.optimization.allowLateStops")}</Label>
             <Input
               id="allow-late-stops"
               type="text"
               inputMode="numeric"
               value={allowanceText.allowLateStopsMin}
               onChange={e => updateNonNegativeInteger("allowLateStopsMin", e.target.value)}
               aria-invalid={Boolean(integerErrors.allowLateStopsMin)}
             />
             {integerErrors.allowLateStopsMin && (
               <p className="text-xs text-destructive">{integerErrors.allowLateStopsMin}</p>
             )}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={() => saveMutation.mutate(form)}
          disabled={saveMutation.isPending || Object.keys(integerErrors).length > 0}
        >
          {saveMutation.isPending ? t("common.saving") : t("settings.save")}
        </Button>
      </div>
    </div>
  );
}

function DataRetentionSettings() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { t } = useTranslation();
  const { data: settings, isLoading } = useOrgSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<Partial<OrgSettings>>({});

  useEffect(() => { if (settings) setForm(settings); }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<OrgSettings>) => {
      const response = await fetch(`${API_BASE}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
       if (!response.ok) {
         const error = new Error("Could not save stop retention settings");
         Object.assign(error, { status: response.status });
         throw error;
       }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-settings"] });
      void invalidateRouteQueries(queryClient);
      toast({ title: t("settings.saved") });
    },
    onError: (error) => toast({
      title: t("settings.dataRetention.error"),
      description: localizeError(error, t, { fallbackKey: "settings.dataRetention.error" }),
      variant: "destructive",
    }),
  });

  if (isLoading) return <div className="text-muted-foreground text-sm">{t("common.loading")}</div>;

  const enabled = form.stopRetentionEnabled ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("settings.dataRetention.title")}</h1>
        <p className="text-muted-foreground mt-1">{t("settings.dataRetention.subtitle")}</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-6 space-y-5">
        <div className="flex items-start justify-between gap-6 p-4 rounded-lg border border-border">
          <div>
            <Label className="font-medium">{t("settings.dataRetention.enable")}</Label>
            <p className="text-xs text-muted-foreground mt-1">{t("settings.dataRetention.enableDesc")}</p>
          </div>
          <Checkbox
            checked={enabled}
            onCheckedChange={(value) => setForm((current) => ({ ...current, stopRetentionEnabled: value === true }))}
            aria-label={t("settings.dataRetention.enable")}
          />
        </div>

        <div className="space-y-2 max-w-sm">
          <Label>{t("settings.dataRetention.period")}</Label>
          <Select
            value={String(form.stopRetentionDays ?? 30)}
            onValueChange={(value) => setForm((current) => ({ ...current, stopRetentionDays: Number(value) }))}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">{t("settings.dataRetention.days", { count: 7 })}</SelectItem>
              <SelectItem value="30">{t("settings.dataRetention.days", { count: 30 })}</SelectItem>
              <SelectItem value="90">{t("settings.dataRetention.days", { count: 90 })}</SelectItem>
              <SelectItem value="180">{t("settings.dataRetention.days", { count: 180 })}</SelectItem>
              <SelectItem value="365">{t("settings.dataRetention.days", { count: 365 })}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-muted-foreground">
          {t("settings.dataRetention.warning")}
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? t("common.saving") : t("settings.save")}
        </Button>
      </div>
    </div>
  );
}

type ExportEndpoint = "full" | "specific" | "audit";
type DownloadFormat = "json" | "csv" | "pdf";
type StopExportStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

function DataExportSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { data: settings } = useOrgSettings();
  const operatingMode = settings?.operatingMode || "transport";
  const [pending, setPending] = useState<string | null>(null);

  const download = useCallback(async (
    endpointType: ExportEndpoint,
    format: DownloadFormat,
    typeParam?: string,
    params?: { from?: string; to?: string; statuses?: StopExportStatus[] },
  ) => {
    const downloadId = endpointType === "specific" ? typeParam! : `${endpointType}-${format}`;
    setPending(downloadId);

    const query = new URLSearchParams({ format });
    if (endpointType === "specific" && typeParam) query.set("type", typeParam);
    if (params?.from) query.set("from", params.from);
    if (params?.to) query.set("to", params.to);
    if (params?.statuses?.length) query.set("status", params.statuses.join(","));

    const path = endpointType === "audit" ? "audit-logs/export" : "export";
    try {
      const response = await fetch(`${API_BASE}/api/${path}?${query.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        if (response.status === 403) {
          toast({ title: t("settings.dataExport.error403"), variant: "destructive" });
          return;
        }
        const data = await response.json().catch(() => ({}));
        const error = new Error("Export failed");
        Object.assign(error, { status: response.status, data });
        toast({
          title: t("settings.dataExport.error"),
          description: localizeError(error, t, { fallbackKey: "settings.dataExport.error" }),
          variant: "destructive",
        });
        return;
      }

      const blob = await response.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const defaultExtension = typeParam === "proofs" || (endpointType === "full" && format === "csv")
        ? "zip"
        : format;
      const fallbackName = endpointType === "audit"
        ? `traivo-audit-${stamp}.${defaultExtension}`
        : `traivo-${typeParam || "export"}-${stamp}.${defaultExtension}`;
      const responseName = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = responseName || fallbackName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      toast({
        title: t("settings.dataExport.error"),
        description: localizeError(error, t, { fallbackKey: "settings.dataExport.error" }),
        variant: "destructive",
      });
    } finally {
      setPending(null);
    }
  }, [t, toast]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("settings.dataExport.title")}</h1>
        <p className="text-muted-foreground mt-1">{t("settings.dataExport.subtitle")}</p>
      </div>

      <div className="p-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5">
        <div className="flex items-start gap-3">
          <Info className="h-5 w-5 text-indigo-500 mt-0.5 shrink-0" />
          <p className="text-sm text-indigo-700/80 dark:text-indigo-300/90">
            {t("settings.dataExport.description")}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ExportCard title={t("settings.dataExport.stopsTitle")} description={t("settings.dataExport.stopsDesc")}
          icon={FileText} type="stops" hasDateRange hasStatusFilter onExport={download} pending={pending} />
        <ExportCard title={t("settings.dataExport.routesTitle")} description={t("settings.dataExport.routesDesc")}
          icon={Truck} type="routes" hasDateRange onExport={download} pending={pending} />
        <ExportCard title={t("settings.dataExport.environmentTitle")} description={t("settings.dataExport.environmentDesc")}
          icon={Leaf} type="environment" hasDateRange format="pdf" onExport={download} pending={pending} />
        <ExportCard title={t("settings.dataExport.proofsTitle")} description={t("settings.dataExport.proofsDesc")}
          icon={PenTool} type="proofs" hasDateRange hasStatusFilter onExport={download} pending={pending} />
        {(operatingMode === "field_service" || operatingMode === "mixed") && (
          <ExportCard title={t("settings.dataExport.billingTitle")} description={t("settings.dataExport.billingDesc")}
            icon={CreditCard} type="billing" hasDateRange onExport={download} pending={pending} />
        )}
        <ExportCard title={t("settings.dataExport.auditTitle")} description={t("settings.dataExport.auditDesc")}
          icon={ShieldAlert} endpointType="audit" hasDateRange onExport={download} pending={pending} />
      </div>

      <div className="pt-6 border-t border-border">
        <h2 className="text-lg font-semibold mb-4">{t("settings.dataExport.fullBackupTitle")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <FullExportCard icon={FileJson} title="JSON" format="json" pending={pending} onExport={download} />
          <FullExportCard icon={FileArchive} title="CSV" format="csv" pending={pending} onExport={download} />
        </div>
      </div>
    </div>
  );
}

function FullExportCard({
  icon: Icon,
  title,
  format,
  pending,
  onExport,
}: {
  icon: typeof FileJson;
  title: string;
  format: DownloadFormat;
  pending: string | null;
  onExport: (endpoint: ExportEndpoint, format: DownloadFormat) => void;
}) {
  const { t } = useTranslation();
  const isPending = pending === `full-${format}`;
  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between hover:border-primary/50 transition-colors">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Icon className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-sm">{t("settings.dataExport.fullBackupTitle")} ({title})</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.dataExport.fullBackupDesc")}</p>
      </div>
      <Button variant="outline" className="mt-4 gap-2 w-full" disabled={pending !== null}
        onClick={() => onExport("full", format)} data-testid={`export-full-${format}`}>
        <Download className="h-4 w-4" />
        {isPending ? t("settings.dataExport.exporting") : format === "json"
          ? t("settings.dataExport.downloadJson")
          : t("settings.dataExport.downloadCsv")}
      </Button>
    </div>
  );
}

function ExportCard({
  title,
  description,
  icon: Icon,
  type,
  endpointType = "specific",
  hasDateRange,
  hasStatusFilter,
  format = "csv",
  onExport,
  pending,
}: {
  title: string;
  description: string;
  icon: typeof FileText;
  type?: string;
  endpointType?: "specific" | "audit";
  hasDateRange?: boolean;
  hasStatusFilter?: boolean;
  format?: DownloadFormat;
  onExport: (
    endpoint: ExportEndpoint,
    format: DownloadFormat,
    typeParam?: string,
    params?: { from?: string; to?: string; statuses?: StopExportStatus[] },
  ) => void;
  pending: string | null;
}) {
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<StopExportStatus[]>([]);
  const statusLabels: Record<StopExportStatus, string> = {
    pending: "pending",
    in_progress: "inProgress",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
  };
  const isPending = pending === (type || `${endpointType}-${format}`);

  const toggleStatus = (status: StopExportStatus) => {
    setStatuses((selected) => selected.includes(status)
      ? selected.filter((item) => item !== status)
      : [...selected, status]);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between hover:border-indigo-500/30 transition-colors shadow-sm">
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="bg-indigo-500/10 p-2 rounded-lg text-indigo-600 dark:text-indigo-400">
            <Icon className="h-4 w-4" />
          </div>
          <h3 className="font-semibold">{title}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4 min-h-[40px]">{description}</p>

        <div className="space-y-3 mb-4">
          {hasDateRange && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)}
                  aria-label={t("settings.dataExport.dateFrom")} className="pl-8 text-xs h-9"
                  data-testid={`input-date-from-${type || endpointType}`} />
                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              </div>
              <span className="text-muted-foreground text-xs">—</span>
              <div className="relative flex-1">
                <Input type="date" value={to} onChange={(event) => setTo(event.target.value)}
                  aria-label={t("settings.dataExport.dateTo")} className="pl-8 text-xs h-9"
                  data-testid={`input-date-to-${type || endpointType}`} />
                <Calendar className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              </div>
            </div>
          )}

          {hasStatusFilter && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="w-full justify-start h-9 text-xs font-normal"
                  data-testid={`button-filter-status-${type || endpointType}`}>
                  <ListFilter className="mr-2 h-4 w-4 text-muted-foreground" />
                  {statuses.length === 0
                    ? t("settings.dataExport.allStatuses")
                    : t("settings.dataExport.selectedStatuses", { count: statuses.length })}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-3" align="start">
                <div className="space-y-3">
                  <h4 className="font-medium text-xs text-muted-foreground">{t("settings.dataExport.filterStatus")}</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {(Object.keys(statusLabels) as StopExportStatus[]).map((status) => (
                      <div key={status} className="flex items-center space-x-2">
                        <Checkbox id={`${type}-status-${status}`} checked={statuses.includes(status)}
                          onCheckedChange={() => toggleStatus(status)}
                          data-testid={`checkbox-status-${type}-${status}`} />
                        <label htmlFor={`${type}-status-${status}`} className="text-xs font-medium leading-none">
                          {t(`stopStatus.${statusLabels[status]}`)}
                        </label>
                      </div>
                    ))}
                  </div>
                  {statuses.length > 0 && (
                    <Button variant="ghost" size="sm" className="w-full text-xs mt-2 h-7" onClick={() => setStatuses([])}>
                      {t("common.clear")}
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      <Button className="w-full gap-2 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={pending !== null}
        onClick={() => onExport(endpointType, format, type, { from, to, statuses })}
        data-testid={`export-btn-${type || endpointType}`}>
        <Download className="h-4 w-4" />
        {isPending ? t("settings.dataExport.exporting") : type === "proofs"
          ? t("settings.dataExport.downloadZip")
          : format === "pdf"
            ? t("settings.dataExport.downloadPdf")
            : t("settings.dataExport.downloadCsv")}
      </Button>
    </div>
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
  const { user } = useAuth();
  const organizationId = user?.organizationId ?? "<organization-id>";

  const importExample = `POST /api/stops/import
Content-Type: application/json

{
  "organizationId": "${organizationId}",
  "expectedRowCount": 1,
  "stops": [
    {
      "address": "Storgatan 12, Stockholm",
      "latitude": 59.3293,
      "longitude": 18.0686,
      "timeWindowStart": "2026-04-10T08:00:00Z",
      "timeWindowEnd": "2026-04-10T12:00:00Z",
      "serviceDurationMin": 5,
      "weightKg": 25.5,
      "notes": "Portkod 1234"
    }
  ]
}`;

  const webhookExample = `POST /api/webhooks
Content-Type: application/json

{
  "organizationId": "${organizationId}",
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

  const listStopsExample = `GET /api/stops?organizationId=${organizationId}&status=completed

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
