import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { CreditCard, Zap, Users, MapPin, Truck, CheckCircle, AlertTriangle, Crown } from "lucide-react";

const API = `${import.meta.env.BASE_URL}api`;
const ORG_ID = "63e7175d-af1d-4dc3-be62-842a8b3dc9f8";

type PlanData = {
  id: string;
  tier: string;
  name: string;
  description: string;
  monthlyPriceOre: number;
  monthlyPriceSek: number;
  maxVehicles: number | null;
  maxStopsPerMonth: number | null;
  maxDrivers: number | null;
  features: string[];
};

type SubscriptionData = {
  subscription: {
    id: string;
    status: string;
    trialStartDate: string | null;
    trialEndDate: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    plan: PlanData;
  } | null;
  usage: {
    vehicles: number;
    drivers: number;
    stopsThisMonth: number;
  };
};

const FEATURE_LABELS: Record<string, { en: string; sv: string }> = {
  route_optimization: { en: "Route Optimization", sv: "Ruttoptimering" },
  live_map: { en: "Live Map", sv: "Livekarta" },
  co2_tracking: { en: "CO₂ Tracking", sv: "CO₂-spårning" },
  basic_analytics: { en: "Basic Analytics", sv: "Grundläggande analys" },
  advanced_analytics: { en: "Advanced Analytics", sv: "Avancerad analys" },
  dispatch: { en: "Dispatch View", sv: "Dispatch-vy" },
  driver_preferences: { en: "Driver Preferences", sv: "Förarpreferenser" },
  webhooks: { en: "Webhooks", sv: "Webhooks" },
  shopify: { en: "Shopify Integration", sv: "Shopify-integration" },
  ai_assistant: { en: "AI Assistant", sv: "AI-assistent" },
  proof_of_delivery: { en: "Proof of Delivery", sv: "Leveransbevis" },
  customer_notifications: { en: "Customer Notifications", sv: "Kundnotifikationer" },
  voice_commands: { en: "Voice Commands", sv: "Röstkommandon" },
  api_access: { en: "Full API Access", sv: "Fullständig API-åtkomst" },
  sso: { en: "SSO / SAML", sv: "SSO / SAML" },
  priority_support: { en: "Priority Support", sv: "Prioriterad support" },
  custom_integrations: { en: "Custom Integrations", sv: "Skräddarsydda integrationer" },
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const map: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    active: { variant: "default", label: t("billing.statusActive") },
    trialing: { variant: "secondary", label: t("billing.statusTrial") },
    past_due: { variant: "destructive", label: t("billing.statusPastDue") },
    canceled: { variant: "outline", label: t("billing.statusCanceled") },
    paused: { variant: "outline", label: t("billing.statusPaused") },
  };
  const info = map[status] || { variant: "outline" as const, label: status };
  return <Badge variant={info.variant}>{info.label}</Badge>;
}

function UsageMeter({ label, used, max, icon: Icon }: { label: string; used: number; max: number | null; icon: typeof Truck }) {
  const percent = max ? Math.min((used / max) * 100, 100) : 0;
  const isNearLimit = max && percent > 80;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{label}</span>
        </div>
        <span className="text-sm text-muted-foreground">
          {used} / {max ?? "∞"}
        </span>
      </div>
      {max ? (
        <Progress value={percent} className={isNearLimit ? "[&>div]:bg-orange-500" : ""} />
      ) : (
        <Progress value={5} className="[&>div]:bg-emerald-500" />
      )}
      {isNearLimit && (
        <p className="text-xs text-orange-500 flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          {percent >= 100 ? "Limit reached" : "Approaching limit"}
        </p>
      )}
    </div>
  );
}

export default function Billing() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const lang = i18n.language === "sv" ? "sv" : "en";

  const { data: subData, isLoading } = useQuery<SubscriptionData>({
    queryKey: ["subscription", ORG_ID],
    queryFn: () => fetch(`${API}/subscription?organizationId=${ORG_ID}`).then(r => r.json()),
  });

  const { data: plans } = useQuery<PlanData[]>({
    queryKey: ["plans"],
    queryFn: () => fetch(`${API}/plans`).then(r => r.json()),
  });

  const upgradeMutation = useMutation({
    mutationFn: (planTier: string) =>
      fetch(`${API}/subscription/upgrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID, planTier }),
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription"] });
      toast({ title: t("billing.upgraded"), description: t("billing.upgradedDesc") });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      fetch(`${API}/subscription/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID }),
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription"] });
      toast({ title: t("billing.cancelScheduled"), description: t("billing.cancelScheduledDesc") });
    },
  });

  const sub = subData?.subscription;
  const usage = subData?.usage;

  return (
    <AppLayout>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold">{t("billing.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("billing.subtitle")}</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Crown className="h-5 w-5 text-primary" />
                        {sub?.plan.name || "No Plan"}
                      </CardTitle>
                      <CardDescription>{sub?.plan.description}</CardDescription>
                    </div>
                    {sub && <StatusBadge status={sub.status} />}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {sub && (
                    <>
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-bold">
                          {sub.plan.monthlyPriceSek > 0
                            ? `${Math.round(sub.plan.monthlyPriceSek).toLocaleString()} kr`
                            : sub.plan.tier === "enterprise"
                            ? t("billing.contactUs")
                            : t("billing.free")}
                        </span>
                        {sub.plan.monthlyPriceSek > 0 && (
                          <span className="text-muted-foreground">/ {t("billing.month")}</span>
                        )}
                      </div>

                      {sub.status === "trialing" && sub.trialEndDate && (
                        <p className="text-sm text-amber-500 flex items-center gap-1">
                          <AlertTriangle className="h-4 w-4" />
                          {t("billing.trialEnds", { date: new Date(sub.trialEndDate).toLocaleDateString(lang === "sv" ? "sv-SE" : "en-US") })}
                        </p>
                      )}

                      {sub.currentPeriodEnd && (
                        <p className="text-sm text-muted-foreground">
                          {t("billing.periodEnds", { date: new Date(sub.currentPeriodEnd).toLocaleDateString(lang === "sv" ? "sv-SE" : "en-US") })}
                        </p>
                      )}

                      {sub.cancelAtPeriodEnd && (
                        <p className="text-sm text-destructive flex items-center gap-1">
                          <AlertTriangle className="h-4 w-4" />
                          {t("billing.cancelPending")}
                        </p>
                      )}

                      <div className="flex gap-2 pt-2">
                        {sub.plan.tier !== "enterprise" && (
                          <Button
                            onClick={() => upgradeMutation.mutate(sub.plan.tier === "starter" ? "pro" : "enterprise")}
                            disabled={upgradeMutation.isPending}
                          >
                            <Zap className="h-4 w-4 mr-2" />
                            {t("billing.upgrade")}
                          </Button>
                        )}
                        {sub.plan.tier !== "starter" && !sub.cancelAtPeriodEnd && (
                          <Button variant="outline" onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending}>
                            {t("billing.cancelPlan")}
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t("billing.usage")}</CardTitle>
                  <CardDescription>{t("billing.usageDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {usage && sub && (
                    <>
                      <UsageMeter label={t("billing.vehicles")} used={usage.vehicles} max={sub.plan.maxVehicles} icon={Truck} />
                      <UsageMeter label={t("billing.drivers")} used={usage.drivers} max={sub.plan.maxDrivers} icon={Users} />
                      <UsageMeter label={t("billing.stopsMonth")} used={usage.stopsThisMonth} max={sub.plan.maxStopsPerMonth} icon={MapPin} />
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>{t("billing.allPlans")}</CardTitle>
                <CardDescription>{t("billing.allPlansDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {plans?.map((plan) => {
                    const isCurrent = sub?.plan.id === plan.id;
                    return (
                      <div
                        key={plan.id}
                        className={`rounded-xl border p-6 space-y-4 ${
                          isCurrent ? "border-primary ring-2 ring-primary/20" : "border-border"
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <h3 className="text-xl font-bold">{plan.name}</h3>
                            {isCurrent && <Badge variant="secondary">{t("billing.current")}</Badge>}
                          </div>
                          <p className="text-sm text-muted-foreground">{plan.description}</p>
                        </div>

                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-bold">
                            {plan.monthlyPriceSek > 0
                              ? `${Math.round(plan.monthlyPriceSek).toLocaleString()} kr`
                              : plan.tier === "enterprise"
                              ? t("billing.custom")
                              : t("billing.free")}
                          </span>
                          {plan.monthlyPriceSek > 0 && (
                            <span className="text-muted-foreground text-sm">/ {t("billing.month")}</span>
                          )}
                        </div>

                        <div className="text-sm space-y-1 text-muted-foreground">
                          <p>{plan.maxVehicles ? `${plan.maxVehicles} ${t("billing.vehicles").toLowerCase()}` : t("billing.unlimited")}</p>
                          <p>{plan.maxStopsPerMonth ? `${plan.maxStopsPerMonth.toLocaleString()} ${t("billing.stopsMonth").toLowerCase()}` : t("billing.unlimited")}</p>
                          <p>{plan.maxDrivers ? `${plan.maxDrivers} ${t("billing.drivers").toLowerCase()}` : t("billing.unlimited")}</p>
                        </div>

                        <ul className="space-y-1.5">
                          {plan.features.map((f: string) => (
                            <li key={f} className="flex items-center gap-2 text-sm">
                              <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                              {FEATURE_LABELS[f]?.[lang] || f}
                            </li>
                          ))}
                        </ul>

                        {!isCurrent && plan.tier !== "enterprise" && (
                          <Button
                            className="w-full"
                            variant={plan.tier === "pro" ? "default" : "outline"}
                            onClick={() => upgradeMutation.mutate(plan.tier)}
                            disabled={upgradeMutation.isPending}
                          >
                            {t("billing.switchTo", { plan: plan.name })}
                          </Button>
                        )}
                        {!isCurrent && plan.tier === "enterprise" && (
                          <Button className="w-full" variant="outline" disabled>
                            {t("billing.contactSales")}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
}
