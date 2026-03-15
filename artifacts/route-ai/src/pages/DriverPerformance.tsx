import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { ORG_ID } from "@/lib/constants";
import { useState } from "react";
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
  FileDown,
  Smile,
  Settings,
  ChevronDown,
  ChevronUp,
  Save,
} from "lucide-react";
import { exportDriverPdf } from "@/lib/pdf-export";
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
  happinessScore: number;
}

interface DriverPreferences {
  id: string;
  driverId: string;
  preferredStartTime: string | null;
  preferredEndTime: string | null;
  maxDrivingHoursPerDay: number;
  breakFrequencyMinutes: number;
  preferredBreakDurationMin: number;
  avoidNightDriving: boolean;
  happinessScore: number;
}

const CHART_COLORS = ["#10b981", "#ef4444", "#f59e0b", "#6b7280"];

function HappinessGauge({ score }: { score: number }) {
  const { t } = useTranslation();
  const color = score >= 70 ? "#10b981" : score >= 40 ? "#f59e0b" : "#ef4444";
  const label = score >= 70 ? t("preferences.happinessHigh") : score >= 40 ? t("preferences.happinessMedium") : t("preferences.happinessLow");

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-24 h-24">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r="40" fill="none" stroke="hsl(var(--muted))" strokeWidth="8" />
          <circle
            cx="50"
            cy="50"
            r="40"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeDasharray={`${(score / 100) * 251.2} 251.2`}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-bold" style={{ color }}>{score}%</span>
        </div>
      </div>
      <span className="text-xs font-medium" style={{ color }}>{label}</span>
    </div>
  );
}

export default function DriverPerformance({ id }: { id: string }) {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [prefsOpen, setPrefsOpen] = useState(false);

  const { data: stats, isLoading, isError } = useQuery<DriverStats>({
    queryKey: ["/api/drivers", id, "stats"],
    queryFn: async () => {
      const res = await fetch(`/api/drivers/${id}/stats?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    enabled: !!id,
  });

  const { data: prefs } = useQuery<DriverPreferences>({
    queryKey: ["/api/drivers", id, "preferences"],
    queryFn: async () => {
      const res = await fetch(`/api/drivers/${id}/preferences?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Failed to load preferences");
      return res.json();
    },
    enabled: !!id,
  });

  const [formData, setFormData] = useState<Partial<DriverPreferences>>({});

  const currentPrefs = { ...prefs, ...formData };

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<DriverPreferences>) => {
      const res = await fetch(`/api/drivers/${id}/preferences?organizationId=${ORG_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drivers", id, "preferences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/drivers", id, "stats"] });
      setFormData({});
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

  if (isError || !stats) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
          <p className="text-destructive">{t("common.error")}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/drivers")}>{t("common.back")}</Button>
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
        <div className="flex items-center justify-between">
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
          <div className="flex items-center gap-3">
            <HappinessGauge score={stats.happinessScore} />
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() =>
                exportDriverPdf({
                  title: t("driverPerformance.title"),
                  driverName: stats.driver.name,
                  phone: stats.driver.phone,
                  totalDeliveries: stats.totalDeliveries,
                  completedDeliveries: stats.completedDeliveries,
                  failedDeliveries: stats.failedDeliveries,
                  skippedDeliveries: stats.skippedDeliveries,
                  onTimeRate: stats.onTimeRate,
                  avgServiceDurationMin: stats.avgServiceDurationMin,
                  totalDistanceKm: stats.totalDistanceKm,
                  totalRoutes: stats.totalRoutes,
                  completedRoutes: stats.completedRoutes,
                })
              }
            >
              <FileDown className="h-4 w-4" />
              PDF
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3">
          <StatCard icon={MapPin} label={t("driverPerformance.totalDeliveries")} value={stats.totalDeliveries.toString()} />
          <StatCard icon={CheckCircle2} label={t("driverPerformance.completed")} value={stats.completedDeliveries.toString()} color="text-emerald-400" />
          <StatCard icon={XCircle} label={t("driverPerformance.failed")} value={stats.failedDeliveries.toString()} color="text-destructive" />
          <StatCard icon={TrendingUp} label={t("driverPerformance.onTimeRate")} value={`${stats.onTimeRate}%`} color="text-primary" />
          <StatCard icon={Clock} label={t("driverPerformance.avgServiceTime")} value={`${stats.avgServiceDurationMin} min`} />
          <StatCard icon={Gauge} label={t("driverPerformance.totalDistance")} value={`${stats.totalDistanceKm} km`} />
          <StatCard icon={Smile} label={t("preferences.happinessScore")} value={`${stats.happinessScore}%`} color={stats.happinessScore >= 70 ? "text-emerald-400" : stats.happinessScore >= 40 ? "text-amber-400" : "text-destructive"} />
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <button
            onClick={() => setPrefsOpen(!prefsOpen)}
            className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-muted-foreground" />
              <span className="font-semibold">{t("preferences.title")}</span>
            </div>
            {prefsOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>

          {prefsOpen && prefs && (
            <div className="p-4 pt-0 border-t border-border space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-4">
                <div>
                  <label className="text-sm font-medium text-muted-foreground">{t("preferences.preferredStartTime")}</label>
                  <input
                    type="time"
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground"
                    value={(currentPrefs.preferredStartTime ?? "07:00").substring(0, 5)}
                    onChange={(e) => setFormData({ ...formData, preferredStartTime: e.target.value + ":00" })}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">{t("preferences.preferredEndTime")}</label>
                  <input
                    type="time"
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground"
                    value={(currentPrefs.preferredEndTime ?? "16:00").substring(0, 5)}
                    onChange={(e) => setFormData({ ...formData, preferredEndTime: e.target.value + ":00" })}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">{t("preferences.maxDrivingHours")}</label>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    step={0.5}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground"
                    value={currentPrefs.maxDrivingHoursPerDay ?? 8}
                    onChange={(e) => setFormData({ ...formData, maxDrivingHoursPerDay: parseFloat(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">{t("preferences.breakFrequency")}</label>
                  <input
                    type="number"
                    min={30}
                    max={480}
                    step={15}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground"
                    value={currentPrefs.breakFrequencyMinutes ?? 120}
                    onChange={(e) => setFormData({ ...formData, breakFrequencyMinutes: parseInt(e.target.value) })}
                  />
                  <span className="text-xs text-muted-foreground">{t("common.mins")}</span>
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">{t("preferences.breakDuration")}</label>
                  <input
                    type="number"
                    min={5}
                    max={60}
                    step={5}
                    className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-background text-foreground"
                    value={currentPrefs.preferredBreakDurationMin ?? 15}
                    onChange={(e) => setFormData({ ...formData, preferredBreakDurationMin: parseInt(e.target.value) })}
                  />
                  <span className="text-xs text-muted-foreground">{t("common.mins")}</span>
                </div>
                <div className="flex items-center gap-3 pt-6">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={currentPrefs.avoidNightDriving ?? false}
                      onChange={(e) => setFormData({ ...formData, avoidNightDriving: e.target.checked })}
                    />
                    <div className="w-11 h-6 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                    <span className="ms-3 text-sm font-medium text-muted-foreground">{t("preferences.avoidNightDriving")}</span>
                  </label>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="gap-2"
                  disabled={Object.keys(formData).length === 0 || saveMutation.isPending}
                  onClick={() => {
                    const payload: Record<string, unknown> = {};
                    if (formData.preferredStartTime !== undefined) payload.preferredStartTime = formData.preferredStartTime;
                    if (formData.preferredEndTime !== undefined) payload.preferredEndTime = formData.preferredEndTime;
                    if (formData.maxDrivingHoursPerDay !== undefined) payload.maxDrivingHoursPerDay = formData.maxDrivingHoursPerDay;
                    if (formData.breakFrequencyMinutes !== undefined) payload.breakFrequencyMinutes = formData.breakFrequencyMinutes;
                    if (formData.preferredBreakDurationMin !== undefined) payload.preferredBreakDurationMin = formData.preferredBreakDurationMin;
                    if (formData.avoidNightDriving !== undefined) payload.avoidNightDriving = formData.avoidNightDriving;
                    saveMutation.mutate(payload as Partial<DriverPreferences>);
                  }}
                >
                  <Save className="h-4 w-4" />
                  {saveMutation.isPending ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          )}
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
