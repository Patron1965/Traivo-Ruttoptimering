import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { ORG_ID } from "@/lib/constants";
import {
  BarChart3,
  TrendingUp,
  MapPin,
  Leaf,
  Gauge,
  CheckCircle2,
  Route as RouteIcon,
  Calendar,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
} from "recharts";

interface AnalyticsData {
  summary: {
    totalRoutes: number;
    totalStops: number;
    completedStops: number;
    failedStops: number;
    onTimeRate: number;
    totalDistanceKm: number;
    totalCo2Kg: number;
    avgStopsPerRoute: number;
  };
  dailyVolume: Array<{ date: string; routes: number; stops: number; distanceKm: number; co2Kg: number }>;
  vehicleTypeBreakdown: Array<{ type: string; routes: number; distanceKm: number; co2Kg: number }>;
  statusBreakdown: Record<string, number>;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  optimized: "#3b82f6",
  in_progress: "#eab308",
  completed: "#10b981",
  cancelled: "#ef4444",
};

const VEHICLE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444"];

export default function Analytics() {
  const { t } = useTranslation();
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");

  const dateFrom = useMemo(() => {
    if (dateRange === "all") return undefined;
    const d = new Date();
    const days = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }, [dateRange]);

  const { data, isLoading, isError } = useQuery<AnalyticsData>({
    queryKey: ["/api/analytics", dateRange],
    queryFn: async () => {
      const params = new URLSearchParams({ organizationId: ORG_ID });
      if (dateFrom) params.set("from", dateFrom);
      const res = await fetch(`/api/analytics?${params}`);
      if (!res.ok) throw new Error("Failed to load analytics");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <AppLayout>
        <div className="p-8">
          <LoadingState message={t("common.loading")} />
        </div>
      </AppLayout>
    );
  }

  if (isError) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
          <p className="text-destructive">{t("common.error")}</p>
        </div>
      </AppLayout>
    );
  }

  const summary = data?.summary;
  const dailyVolume = data?.dailyVolume || [];
  const vehicleBreakdown = data?.vehicleTypeBreakdown || [];
  const statusBreakdown = data?.statusBreakdown || {};

  const statusData = Object.entries(statusBreakdown)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({
      name: t(`analytics.status_${status}`),
      value: count,
      color: STATUS_COLORS[status] || "#6b7280",
    }));

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-primary" />
              {t("analytics.title")}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">{t("analytics.subtitle")}</p>
          </div>
          <div className="flex gap-1 bg-card border border-border rounded-xl p-1">
            {(["7d", "30d", "90d", "all"] as const).map((range) => (
              <Button
                key={range}
                variant={dateRange === range ? "default" : "ghost"}
                size="sm"
                className="text-xs"
                onClick={() => setDateRange(range)}
              >
                {t(`analytics.range_${range}`)}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard icon={RouteIcon} label={t("analytics.totalRoutes")} value={summary?.totalRoutes ?? 0} />
          <KpiCard icon={MapPin} label={t("analytics.totalStops")} value={summary?.totalStops ?? 0} />
          <KpiCard icon={TrendingUp} label={t("analytics.onTimeRate")} value={`${summary?.onTimeRate ?? 0}%`} color="text-emerald-400" />
          <KpiCard icon={Gauge} label={t("analytics.totalDistance")} value={`${summary?.totalDistanceKm ?? 0} km`} />
          <KpiCard icon={CheckCircle2} label={t("analytics.completedStops")} value={summary?.completedStops ?? 0} color="text-emerald-400" />
          <KpiCard icon={Leaf} label={t("analytics.totalCo2")} value={`${summary?.totalCo2Kg ?? 0} kg`} color="text-orange-400" />
          <KpiCard icon={Calendar} label={t("analytics.avgStopsPerRoute")} value={summary?.avgStopsPerRoute ?? 0} />
          <KpiCard icon={MapPin} label={t("analytics.failedStops")} value={summary?.failedStops ?? 0} color="text-destructive" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4">{t("analytics.dailyVolume")}</h3>
            {dailyVolume.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={dailyVolume}>
                  <defs>
                    <linearGradient id="colorStops" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} />
                  <Area type="monotone" dataKey="stops" stroke="hsl(var(--primary))" fill="url(#colorStops)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12">{t("analytics.noData")}</p>
            )}
          </div>

          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4">{t("analytics.co2Trend")}</h3>
            {dailyVolume.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={dailyVolume}>
                  <defs>
                    <linearGradient id="colorCo2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} formatter={(v: number) => [`${Math.round(v * 10) / 10} kg`, "CO₂"]} />
                  <Area type="monotone" dataKey="co2Kg" stroke="#f59e0b" fill="url(#colorCo2)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12">{t("analytics.noData")}</p>
            )}
          </div>

          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4">{t("analytics.routeStatus")}</h3>
            {statusData.length > 0 ? (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
                      {statusData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {statusData.map((item) => (
                    <div key={item.name} className="flex items-center gap-2 text-sm">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-muted-foreground">{item.name}:</span>
                      <span className="font-medium">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-12">{t("analytics.noData")}</p>
            )}
          </div>

          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4">{t("analytics.vehicleTypeBreakdown")}</h3>
            {vehicleBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={vehicleBreakdown}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="type" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                  <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} />
                  <Bar dataKey="distanceKm" name={t("analytics.distanceKm")} fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="co2Kg" name="CO₂ (kg)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12">{t("analytics.noData")}</p>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function KpiCard({ icon: Icon, label, value, color }: { icon: typeof MapPin; label: string; value: string | number; color?: string }) {
  return (
    <div className="p-4 rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={`font-bold text-xl ${color || ""}`}>{value}</p>
    </div>
  );
}
