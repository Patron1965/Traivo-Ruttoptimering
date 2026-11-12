import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import {
  Activity,
  Camera,
  CheckCircle2,
  Gauge,
  Leaf,
  MapPin,
  Radio,
  Route as RouteIcon,
  Truck,
  Users,
  XCircle,
} from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface KpiOverview {
  period: { from: string; to: string };
  routes: { total: number; completed: number; completionRate: number };
  stops: {
    total: number;
    completed: number;
    failed: number;
    onTimeRate: number;
    failureRate: number;
    byStatus: Record<string, number>;
  };
  fleet: { vehicles: number; drivers: number };
  sustainability: { totalDistanceKm: number; totalCo2Kg: number };
  pod: { captured: number; captureRate: number };
  telemetry: { gpsPings: number };
}

interface KpiTimeseries {
  period: { from: string; to: string };
  series: Array<{
    date: string;
    routes: number;
    completedRoutes: number;
    distanceKm: number;
    co2Kg: number;
  }>;
}

type Range = "7d" | "30d" | "90d";

export default function Operations() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>("30d");

  const { from, to } = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (range === "7d" ? 7 : range === "30d" ? 30 : 90));
    return { from: from.toISOString(), to: to.toISOString() };
  }, [range]);

  const overview = useQuery<KpiOverview>({
    queryKey: ["/api/kpi/overview", organizationId, range],
    queryFn: async () => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const params = new URLSearchParams({ organizationId, from, to });
      const res = await fetch(`/api/kpi/overview?${params}`);
       if (!res.ok) {
         const error = new Error("Failed to load KPIs");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    refetchInterval: 30_000,
    enabled: !!organizationId,
  });

  const timeseries = useQuery<KpiTimeseries>({
    queryKey: ["/api/kpi/timeseries", organizationId, range],
    queryFn: async () => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const params = new URLSearchParams({ organizationId, from, to });
      const res = await fetch(`/api/kpi/timeseries?${params}`);
       if (!res.ok) {
         const error = new Error("Failed to load timeseries");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    enabled: !!organizationId,
  });

  if (overview.isLoading) {
    return (
      <AppLayout>
        <div className="p-8">
          <LoadingState message={t("common.loading")} />
        </div>
      </AppLayout>
    );
  }

  if (overview.isError || !overview.data) {
    return (
      <AppLayout>
        <div className="p-8"><ErrorState error={overview.error} /></div>
      </AppLayout>
    );
  }

  const d = overview.data;
  const series = (timeseries.data?.series ?? []).map((p) => ({
    ...p,
    dateLabel: new Date(p.date).toISOString().slice(5, 10),
  }));

  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Activity className="h-6 w-6 text-primary" />
              {t("operations.title", "Operations KPI")}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("operations.subtitle", "Driftsöversikt: leveranser, flotta, telemetri och hållbarhet")}
            </p>
          </div>
          <div className="flex gap-1 bg-card border border-border rounded-xl p-1">
            {(["7d", "30d", "90d"] as const).map((r) => (
              <Button
                key={r}
                variant={range === r ? "default" : "ghost"}
                size="sm"
                className="text-xs"
                onClick={() => setRange(r)}
              >
                {r === "7d" ? t("analytics.range_7d", "7 days") : r === "30d" ? t("analytics.range_30d", "30 days") : t("analytics.range_90d", "90 days")}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            icon={RouteIcon}
            label={t("operations.routes", "Rutter")}
            value={d.routes.total}
            sub={`${d.routes.completed} ${t("operations.completed", "slutförda")} (${pct(d.routes.completionRate)})`}
          />
          <KpiCard
            icon={MapPin}
            label={t("operations.stops", "Stopp")}
            value={d.stops.total}
            sub={`${d.stops.completed} ✓  ${d.stops.failed} ✗`}
          />
          <KpiCard
            icon={CheckCircle2}
            label={t("operations.onTimeRate", "Genomförandegrad")}
            value={pct(d.stops.onTimeRate)}
            tone={d.stops.onTimeRate >= 0.9 ? "good" : d.stops.onTimeRate >= 0.7 ? "warn" : "bad"}
          />
          <KpiCard
            icon={XCircle}
            label={t("operations.failureRate", "Misslyckade")}
            value={pct(d.stops.failureRate)}
            tone={d.stops.failureRate < 0.05 ? "good" : d.stops.failureRate < 0.1 ? "warn" : "bad"}
          />
          <KpiCard
            icon={Camera}
            label={t("operations.podRate", "PoD-täckning")}
            value={pct(d.pod.captureRate)}
            sub={`${d.pod.captured} ${t("operations.podCaptured", "bevis inlämnade")}`}
            tone={d.pod.captureRate >= 0.9 ? "good" : d.pod.captureRate >= 0.6 ? "warn" : "bad"}
          />
          <KpiCard
            icon={Radio}
            label={t("operations.gpsPings", "GPS-signaler")}
            value={d.telemetry.gpsPings.toLocaleString()}
            sub={t("operations.fromFleet", "från flottan")}
          />
          <KpiCard
            icon={Truck}
            label={t("operations.fleet", "Flotta")}
            value={d.fleet.vehicles}
            sub={`${d.fleet.drivers} ${t("operations.drivers", "förare")}`}
          />
          <KpiCard
            icon={Leaf}
            label={t("operations.co2", "CO₂-utsläpp")}
            value={`${d.sustainability.totalCo2Kg.toLocaleString()} kg`}
            sub={`${d.sustainability.totalDistanceKm.toLocaleString()} km`}
            tone="warn"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <RouteIcon className="h-4 w-4 text-primary" />
              {t("operations.routesPerDay", "Rutter per dag")}
            </h3>
            {series.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={series}>
                  <defs>
                    <linearGradient id="gRoutes" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="dateLabel" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Area type="monotone" dataKey="routes" name={t("operations.routes", "Rutter")} stroke="hsl(var(--primary))" fill="url(#gRoutes)" strokeWidth={2} />
                  <Area type="monotone" dataKey="completedRoutes" name={t("operations.completed", "Slutförda")} stroke="#10b981" fill="none" strokeWidth={2} strokeDasharray="4 4" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12">{t("operations.noData", "Ingen data")}</p>
            )}
          </div>

          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Gauge className="h-4 w-4 text-blue-400" />
              {t("operations.distanceCo2", "Distans & CO₂")}
            </h3>
            {series.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={series}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="dateLabel" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis yAxisId="km" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis yAxisId="co2" orientation="right" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Line yAxisId="km" type="monotone" dataKey="distanceKm" name="km" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  <Line yAxisId="co2" type="monotone" dataKey="co2Kg" name="CO₂ kg" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12">{t("operations.noData", "Ingen data")}</p>
            )}
          </div>
        </div>

        <div className="p-6 rounded-xl border border-border bg-card">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            {t("operations.stopStatusBreakdown", "Stoppstatus")}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {(["pending", "in_progress", "completed", "failed", "skipped"] as const).map((status) => {
              const count = d.stops.byStatus[status] ?? 0;
              const pctShare = d.stops.total > 0 ? (count / d.stops.total) * 100 : 0;
              const colors: Record<string, string> = {
                pending: "text-slate-400",
                in_progress: "text-blue-400",
                completed: "text-emerald-400",
                failed: "text-red-400",
                skipped: "text-amber-400",
              };
              return (
                <div key={status} className="p-3 rounded-lg bg-background/50 border border-border">
                  <div className={`text-xs uppercase tracking-wider ${colors[status]}`}>{status.replace("_", " ")}</div>
                  <div className="text-xl font-bold mt-1">{count}</div>
                  <div className="text-[10px] text-muted-foreground">{pctShare.toFixed(1)}%</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof MapPin;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "good" | "warn" | "bad";
}) {
  const toneColor =
    tone === "good" ? "text-emerald-400" : tone === "warn" ? "text-amber-400" : tone === "bad" ? "text-red-400" : "";
  return (
    <div className="p-4 rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={`font-bold text-xl ${toneColor}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
