import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { ORG_ID } from "@/lib/constants";
import {
  ArrowLeft,
  User,
  CheckCircle2,
  XCircle,
  Clock,
  MapPin,
  Gauge,
  TrendingUp,
  Route as RouteIcon,
  Truck,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

interface DriverStats {
  driver: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    vehicleId: string | null;
    isActive: boolean;
  };
  totalDeliveries: number;
  completedDeliveries: number;
  failedDeliveries: number;
  skippedDeliveries: number;
  onTimeRate: number;
  avgServiceDurationMin: number;
  totalDistanceKm: number;
  totalRoutes: number;
  completedRoutes: number;
}

const CHART_COLORS = ["#10b981", "#ef4444", "#f59e0b", "#6b7280"];

export default function DriverPerformance({ id }: { id: string }) {
  const { t } = useTranslation();
  const [, navigate] = useLocation();

  const { data: stats, isLoading, isError } = useQuery<DriverStats>({
    queryKey: ["/api/drivers", id, "stats"],
    queryFn: async () => {
      const res = await fetch(`/api/drivers/${id}/stats?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    enabled: !!id,
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
          <Button variant="outline" className="mt-4" onClick={() => navigate("/drivers")}>{t("common.back")}</Button>
        </div>
      </AppLayout>
    );
  }

  if (!stats) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
          <p className="text-destructive">{t("common.notFound")}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/drivers")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("driverPerformance.backToDrivers")}
          </Button>
        </div>
      </AppLayout>
    );
  }

  const deliveryBreakdown = [
    { name: t("driverPerformance.completed"), value: stats.completedDeliveries, color: CHART_COLORS[0] },
    { name: t("driverPerformance.failed"), value: stats.failedDeliveries, color: CHART_COLORS[1] },
    { name: t("driverPerformance.skipped"), value: stats.skippedDeliveries, color: CHART_COLORS[2] },
    { name: t("driverPerformance.pending"), value: stats.totalDeliveries - stats.completedDeliveries - stats.failedDeliveries - stats.skippedDeliveries, color: CHART_COLORS[3] },
  ].filter((d) => d.value > 0);

  const performanceData = [
    { name: t("driverPerformance.onTimeRate"), value: stats.onTimeRate },
    { name: t("driverPerformance.completionRate"), value: stats.totalDeliveries > 0 ? Math.round((stats.completedDeliveries / stats.totalDeliveries) * 100) : 0 },
    { name: t("driverPerformance.routeCompletion"), value: stats.totalRoutes > 0 ? Math.round((stats.completedRoutes / stats.totalRoutes) * 100) : 0 },
  ];

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/drivers")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <User className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{stats.driver.name}</h1>
              <p className="text-sm text-muted-foreground">
                {stats.driver.phone || stats.driver.email || t("driverPerformance.noContact")}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={MapPin} label={t("driverPerformance.totalDeliveries")} value={stats.totalDeliveries.toString()} />
          <StatCard icon={CheckCircle2} label={t("driverPerformance.completed")} value={stats.completedDeliveries.toString()} color="text-emerald-400" />
          <StatCard icon={XCircle} label={t("driverPerformance.failed")} value={stats.failedDeliveries.toString()} color="text-destructive" />
          <StatCard icon={TrendingUp} label={t("driverPerformance.onTimeRate")} value={`${stats.onTimeRate}%`} color="text-primary" />
          <StatCard icon={Clock} label={t("driverPerformance.avgServiceTime")} value={`${stats.avgServiceDurationMin} min`} />
          <StatCard icon={Gauge} label={t("driverPerformance.totalDistance")} value={`${stats.totalDistanceKm} km`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4">{t("driverPerformance.deliveryBreakdown")}</h3>
            {deliveryBreakdown.length > 0 ? (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={deliveryBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
                      {deliveryBreakdown.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {deliveryBreakdown.map((item) => (
                    <div key={item.name} className="flex items-center gap-2 text-sm">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-muted-foreground">{item.name}:</span>
                      <span className="font-medium">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-8">{t("driverPerformance.noData")}</p>
            )}
          </div>

          <div className="p-6 rounded-xl border border-border bg-card">
            <h3 className="font-semibold mb-4">{t("driverPerformance.performanceMetrics")}</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={performanceData} layout="vertical">
                <XAxis type="number" domain={[0, 100]} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                <Tooltip
                  formatter={(value: number) => [`${value}%`, ""]}
                  contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                />
                <Bar dataKey="value" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="p-4 rounded-xl border border-border bg-card flex items-center gap-4">
            <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <RouteIcon className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("driverPerformance.routes")}</p>
              <p className="text-lg font-bold">{stats.completedRoutes}/{stats.totalRoutes}</p>
            </div>
          </div>
          <div className="p-4 rounded-xl border border-border bg-card flex items-center gap-4">
            <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Truck className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("driverPerformance.status")}</p>
              <p className="text-lg font-bold">{stats.driver.isActive ? t("driverPerformance.active") : t("driverPerformance.inactive")}</p>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: typeof MapPin; label: string; value: string; color?: string }) {
  return (
    <div className="p-3 rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={`font-semibold text-lg ${color || ""}`}>{value}</p>
    </div>
  );
}
