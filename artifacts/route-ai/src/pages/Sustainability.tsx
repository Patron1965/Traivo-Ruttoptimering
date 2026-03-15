import { AppLayout } from "@/components/layout/AppLayout";
import { useSustainabilityStats } from "@/hooks/use-sustainability";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { Leaf, TreePine, TrendingDown, Zap, Fuel, Car, Target, Clock, CheckCircle2, AlertTriangle, BatteryCharging, DollarSign } from "lucide-react";
import { useMemo, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
  Area,
  AreaChart,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

export default function Sustainability() {
  const { data: stats, isLoading, error } = useSustainabilityStats();
  const { t, i18n } = useTranslation();

  const dailyTrend = useMemo(() => {
    if (!stats) return [];
    const byDay = new Map<string, { fossil: number; ev: number; hybrid: number }>();
    stats.routeBreakdown.forEach((r) => {
      const day = new Date(r.date).toLocaleDateString("en-CA");
      const prev = byDay.get(day) || { fossil: 0, ev: 0, hybrid: 0 };
      if (r.vehicleType === "electric") {
        prev.ev += r.co2Kg;
      } else if (r.vehicleType === "hybrid") {
        prev.hybrid += r.co2Kg;
      } else {
        prev.fossil += r.co2Kg;
      }
      byDay.set(day, prev);
    });
    return Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, vals]) => ({
        date: new Date(day).toLocaleDateString(i18n.language === "sv" ? "sv-SE" : "en-US", { month: "short", day: "numeric" }),
        fossil: Math.round(vals.fossil * 100) / 100,
        ev: Math.round(vals.ev * 100) / 100,
        hybrid: Math.round(vals.hybrid * 100) / 100,
        total: Math.round((vals.fossil + vals.ev + vals.hybrid) * 100) / 100,
      }));
  }, [stats, i18n.language]);

  if (isLoading) return <AppLayout><LoadingState message={t("sustainability.loadingSustainability")} /></AppLayout>;
  if (error || !stats) return <AppLayout><ErrorState error={error} /></AppLayout>;

  const hybridCo2Kg = stats.hybridCo2Kg ?? 0;
  const etaMetrics = (stats as Record<string, unknown>).etaMetrics as {
    avgTimeWindowSlackMin: number;
    stopsWithTimeWindows: number;
    stopsOnTime: number;
    stopsLate: number;
    avgDurationMin: number;
    totalRoutes: number;
  } | undefined;

  const pieData = [
    { name: t("sustainability.fossilCo2"), value: stats.fossilCo2Kg, color: "#F59E0B" },
    { name: t("sustainability.evCo2"), value: stats.evCo2Kg, color: "#10B981" },
    { name: t("sustainability.hybridCo2"), value: hybridCo2Kg, color: "#8B5CF6" },
  ].filter(d => d.value > 0);

  const barData = stats.routeBreakdown.map((r) => ({
    name: r.routeName.length > 20 ? r.routeName.slice(0, 20) + "…" : r.routeName,
    co2: r.co2Kg,
    distance: r.distanceKm,
    type: r.vehicleType,
  }));

  const treeCount = Math.max(1, Math.round(stats.treesEquivalent));
  const treesArr = Array.from({ length: Math.min(treeCount, 50) }, (_, i) => i);

  return (
    <AppLayout>
      <div className="p-6 md:p-8 lg:p-10 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground flex items-center gap-3">
            <Leaf className="h-8 w-8 text-emerald-500" /> {t("sustainability.title")}
          </h1>
          <p className="text-muted-foreground mt-2 text-lg">{t("sustainability.subtitle")}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          <KpiCard title={t("sustainability.totalCo2")} value={`${stats.totalCo2Kg.toFixed(1)} kg`} icon={<Leaf className="h-5 w-5 text-emerald-500" />} />
          <KpiCard title={t("sustainability.co2Saved")} value={`${stats.co2SavedKg.toFixed(1)} kg`} icon={<TrendingDown className="h-5 w-5 text-primary" />} />
          <KpiCard title={t("sustainability.fossilEmissions")} value={`${stats.fossilCo2Kg.toFixed(1)} kg`} icon={<Fuel className="h-5 w-5 text-amber-500" />} />
          <KpiCard title={t("sustainability.evEmissions")} value={`${stats.evCo2Kg.toFixed(1)} kg`} icon={<Zap className="h-5 w-5 text-emerald-400" />} />
          {hybridCo2Kg > 0 && (
            <KpiCard title={t("sustainability.hybridEmissions")} value={`${hybridCo2Kg.toFixed(1)} kg`} icon={<Car className="h-5 w-5 text-violet-500" />} />
          )}
        </div>

        <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
          <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" /> {t("sustainability.optimizationMetrics")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
              <p className="text-xs text-muted-foreground mb-1">{t("sustainability.optimizerUsed")}</p>
              <p className="text-lg font-bold">ALNS</p>
              <p className="text-xs text-muted-foreground mt-1">Adaptive Large Neighborhood Search</p>
            </div>
            <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
              <p className="text-xs text-muted-foreground mb-1">{t("sustainability.co2Saved")}</p>
              <p className="text-lg font-bold text-emerald-500">{stats.co2SavedKg.toFixed(1)} kg</p>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.totalCo2Kg > 0 ? `${((stats.co2SavedKg / (stats.co2SavedKg + stats.totalCo2Kg)) * 100).toFixed(0)}% reduction vs all-fossil` : "—"}
              </p>
            </div>
            <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
              <p className="text-xs text-muted-foreground mb-1">{t("sustainability.totalCo2")}</p>
              <p className="text-lg font-bold">{stats.totalCo2Kg.toFixed(1)} kg</p>
              <p className="text-xs text-muted-foreground mt-1">
                {stats.routeBreakdown.length} {t("common.route").toLowerCase()}(s) tracked
              </p>
            </div>
          </div>
        </div>

        <EnergyPriceSection />

        {etaMetrics && (
          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
            <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Clock className="h-5 w-5 text-blue-500" /> ETA Precision & Time-Window Performance
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
                <p className="text-xs text-muted-foreground mb-1">Avg Time-Window Slack</p>
                <p className="text-lg font-bold">{etaMetrics.avgTimeWindowSlackMin.toFixed(1)} min</p>
                <p className="text-xs text-muted-foreground mt-1">Buffer per stop</p>
              </div>
              <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
                <p className="text-xs text-muted-foreground mb-1">On-Time Deliveries</p>
                <p className="text-lg font-bold text-emerald-500 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> {etaMetrics.stopsOnTime}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {etaMetrics.stopsWithTimeWindows > 0
                    ? `${Math.round((etaMetrics.stopsOnTime / etaMetrics.stopsWithTimeWindows) * 100)}% of windowed stops`
                    : "No windowed stops yet"}
                </p>
              </div>
              <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
                <p className="text-xs text-muted-foreground mb-1">Late Deliveries</p>
                <p className={`text-lg font-bold flex items-center gap-1 ${etaMetrics.stopsLate > 0 ? "text-amber-500" : "text-emerald-500"}`}>
                  <AlertTriangle className="h-4 w-4" /> {etaMetrics.stopsLate}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {etaMetrics.stopsWithTimeWindows} stops with time windows
                </p>
              </div>
              <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
                <p className="text-xs text-muted-foreground mb-1">Avg Route Duration</p>
                <p className="text-lg font-bold">{etaMetrics.avgDurationMin.toFixed(0)} min</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Across {etaMetrics.totalRoutes} route(s)
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
          <h2 className="text-lg font-bold mb-1">{t("sustainability.treesEquivalent")}</h2>
          <p className="text-sm text-muted-foreground mb-4" dangerouslySetInnerHTML={{
            __html: t("sustainability.treesDescription", { saved: stats.co2SavedKg.toFixed(1), trees: stats.treesEquivalent })
          }} />
          <div className="flex flex-wrap gap-2 items-end">
            {treesArr.map((i) => (
              <TreePine
                key={i}
                className="text-emerald-500 animate-in fade-in duration-300"
                style={{ animationDelay: `${i * 50}ms`, height: 24 + Math.random() * 12, width: 24 + Math.random() * 12 }}
              />
            ))}
            {treeCount > 50 && (
              <span className="text-emerald-500 font-bold text-lg ml-2">+{treeCount - 50} {t("common.more")}</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
            <h2 className="text-lg font-bold mb-4">{t("sustainability.fossilVsEv")}</h2>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value.toFixed(1)}kg`}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Legend />
                  <Tooltip formatter={(value: number) => `${value.toFixed(2)} kg`} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12 italic">{t("sustainability.noRouteDataYet")}</p>
            )}
          </div>

          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
            <h2 className="text-lg font-bold mb-4">{t("sustainability.co2ByRoute")}</h2>
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={barData} margin={{ top: 5, right: 20, bottom: 40, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="name"
                    angle={-30}
                    textAnchor="end"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "12px",
                    }}
                    formatter={(value: number) => `${value.toFixed(2)} kg`}
                  />
                  <Bar dataKey="co2" fill="#10B981" radius={[4, 4, 0, 0]} name="CO₂ (kg)" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-muted-foreground text-center py-12 italic">{t("sustainability.noRouteDataYet")}</p>
            )}
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
          <h2 className="text-lg font-bold mb-4">{t("sustainability.dailyEmissionsTrend")}</h2>
          {dailyTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={dailyTrend} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <defs>
                  <linearGradient id="fossilGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#F59E0B" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="evGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "12px",
                  }}
                  formatter={(value: number) => `${value.toFixed(2)} kg`}
                />
                <Legend />
                <Area type="monotone" dataKey="fossil" stroke="#F59E0B" fill="url(#fossilGrad)" name={`${t("sustainability.fossilCo2")} (kg)`} />
                <Area type="monotone" dataKey="ev" stroke="#10B981" fill="url(#evGrad)" name={`${t("sustainability.evCo2")} (kg)`} />
                <Area type="monotone" dataKey="hybrid" stroke="#8B5CF6" fill="#8B5CF620" name={`${t("sustainability.hybridCo2")} (kg)`} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-muted-foreground text-center py-12 italic">{t("sustainability.noDailyDataYet")}</p>
          )}
        </div>

        <div className="bg-card rounded-2xl border border-card-border shadow-xl shadow-black/5 overflow-hidden">
          <div className="p-6 border-b border-border">
            <h2 className="text-lg font-bold">{t("sustainability.routeEmissionsBreakdown")}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("common.route")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("common.vehicle")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("common.type")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("common.distance")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("common.co2")}</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">{t("common.date")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.routeBreakdown.map((r) => (
                  <tr key={r.routeId} className="hover:bg-muted/30 transition-colors">
                    <td className="p-4 font-medium">{r.routeName}</td>
                    <td className="p-4 text-muted-foreground">{r.vehicleName}</td>
                    <td className="p-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        r.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' :
                        r.vehicleType === 'hybrid' ? 'bg-violet-500/10 text-violet-500' :
                        'bg-amber-500/10 text-amber-500'
                      }`}>
                        {r.vehicleType === 'electric' ? <Zap className="h-3 w-3" /> : r.vehicleType === 'hybrid' ? <Car className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                        {r.vehicleType === 'electric' ? t("common.ev") : r.vehicleType === 'hybrid' ? t("common.hybrid") : t("common.fossil")}
                      </span>
                    </td>
                    <td className="p-4 text-muted-foreground">{r.distanceKm.toFixed(1)} km</td>
                    <td className="p-4 font-medium">{r.co2Kg.toFixed(2)} kg</td>
                    <td className="p-4 text-muted-foreground text-sm">{new Date(r.date).toLocaleDateString(i18n.language === "sv" ? "sv-SE" : "en-US")}</td>
                  </tr>
                ))}
                {stats.routeBreakdown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">{t("sustainability.noRoutesYet")}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

interface EnergyPricePoint {
  timestamp: string;
  priceEurMwh: number;
  priceSekKwh: number;
}

interface ChargingWindow {
  start: string;
  end: string;
  avgPriceEurMwh: number;
  avgPriceSekKwh: number;
  savingsPercent: number;
}

function EnergyPriceSection() {
  const { t } = useTranslation();
  const [prices, setPrices] = useState<EnergyPricePoint[]>([]);
  const [optimalWindow, setOptimalWindow] = useState<ChargingWindow | null>(null);
  const [area, setArea] = useState("SE3");

  useEffect(() => {
    const apiBase = import.meta.env.VITE_API_URL || "/api";

    fetch(`${apiBase}/energy/prices?area=${area}&hours=24`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setPrices(data); })
      .catch(() => {});

    fetch(`${apiBase}/energy/optimal-window?area=${area}&duration=120`)
      .then((r) => r.json())
      .then((data) => { if (data && data.start) setOptimalWindow(data); })
      .catch(() => {});
  }, [area]);

  const avgPrice = useMemo(() => {
    if (prices.length === 0) return 0;
    return prices.reduce((s, p) => s + p.priceSekKwh, 0) / prices.length;
  }, [prices]);

  const minPrice = useMemo(() => {
    if (prices.length === 0) return 0;
    return Math.min(...prices.map((p) => p.priceSekKwh));
  }, [prices]);

  const maxPrice = useMemo(() => {
    if (prices.length === 0) return 0;
    return Math.max(...prices.map((p) => p.priceSekKwh));
  }, [prices]);

  const chartData = useMemo(() => {
    return prices.map((p) => {
      const d = new Date(p.timestamp);
      return {
        hour: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        price: p.priceSekKwh,
        priceEur: p.priceEurMwh,
      };
    });
  }, [prices]);

  if (prices.length === 0) return null;

  const windowStartTime = optimalWindow
    ? new Date(optimalWindow.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const windowEndTime = optimalWindow
    ? new Date(optimalWindow.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <BatteryCharging className="h-5 w-5 text-yellow-500" /> {t("energy.title")}
        </h2>
        <select
          value={area}
          onChange={(e) => setArea(e.target.value)}
          className="bg-muted border border-border rounded-lg px-3 py-1.5 text-sm font-medium"
        >
          <option value="SE1">SE1</option>
          <option value="SE2">SE2</option>
          <option value="SE3">SE3</option>
          <option value="SE4">SE4</option>
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
          <p className="text-xs text-muted-foreground mb-1">{t("energy.avgPrice")}</p>
          <p className="text-lg font-bold">{avgPrice.toFixed(2)} SEK/kWh</p>
        </div>
        <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
          <p className="text-xs text-muted-foreground mb-1">{t("energy.lowestPrice")}</p>
          <p className="text-lg font-bold text-emerald-500">{minPrice.toFixed(2)} SEK/kWh</p>
        </div>
        <div className="rounded-xl bg-muted/30 p-4 border border-border/50">
          <p className="text-xs text-muted-foreground mb-1">{t("energy.highestPrice")}</p>
          <p className="text-lg font-bold text-red-500">{maxPrice.toFixed(2)} SEK/kWh</p>
        </div>
        {optimalWindow && (
          <div className="rounded-xl bg-emerald-500/10 p-4 border border-emerald-500/30">
            <p className="text-xs text-muted-foreground mb-1">{t("energy.savings")}</p>
            <p className="text-lg font-bold text-emerald-500">{optimalWindow.savingsPercent}%</p>
            <p className="text-[10px] text-muted-foreground mt-1">{t("energy.vsAvgCharging")}</p>
          </div>
        )}
      </div>

      <div className="h-64 mb-6">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#eab308" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" />
            <YAxis tick={{ fontSize: 10 }} stroke="var(--color-muted-foreground)" unit=" SEK" />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                borderColor: "var(--color-border)",
                borderRadius: 12,
                fontSize: 12,
              }}
              formatter={(value: number) => [`${value.toFixed(2)} SEK/kWh`, t("energy.price")]}
            />
            <ReferenceLine y={avgPrice} stroke="#f97316" strokeDasharray="5 5" label={{ value: t("energy.avg"), position: "right", fontSize: 10 }} />
            <Area
              type="monotone"
              dataKey="price"
              stroke="#eab308"
              fill="url(#priceGradient)"
              strokeWidth={2}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {optimalWindow && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-4 flex items-start gap-3">
          <BatteryCharging className="h-5 w-5 text-emerald-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-bold text-sm text-emerald-500">{t("energy.recommendation")}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("energy.chargeVehiclesBetween", {
                start: windowStartTime,
                end: windowEndTime,
              })}{" "}
              ({optimalWindow.avgPriceSekKwh.toFixed(2)} SEK/kWh — {optimalWindow.savingsPercent}% {t("energy.cheaper")})
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl p-6 border border-card-border shadow-md shadow-black/5 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className="p-2 bg-muted rounded-lg">{icon}</div>
      </div>
      <div className="mt-4">
        <p className="text-3xl font-bold">{value}</p>
      </div>
    </div>
  );
}
