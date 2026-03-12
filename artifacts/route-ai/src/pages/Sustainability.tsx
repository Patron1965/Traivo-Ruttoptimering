import { AppLayout } from "@/components/layout/AppLayout";
import { useSustainabilityStats } from "@/hooks/use-sustainability";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { Leaf, TreePine, TrendingDown, Zap, Fuel } from "lucide-react";
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
} from "recharts";

export default function Sustainability() {
  const { data: stats, isLoading, error } = useSustainabilityStats();

  if (isLoading) return <AppLayout><LoadingState message="Loading sustainability data..." /></AppLayout>;
  if (error || !stats) return <AppLayout><ErrorState error={error} /></AppLayout>;

  const pieData = [
    { name: "Fossil CO₂", value: stats.fossilCo2Kg, color: "#F59E0B" },
    { name: "EV CO₂", value: stats.evCo2Kg, color: "#10B981" },
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
            <Leaf className="h-8 w-8 text-emerald-500" /> Sustainability
          </h1>
          <p className="text-muted-foreground mt-2 text-lg">CO₂ emissions tracking and environmental impact</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          <KpiCard title="Total CO₂" value={`${stats.totalCo2Kg.toFixed(1)} kg`} icon={<Leaf className="h-5 w-5 text-emerald-500" />} />
          <KpiCard title="CO₂ Saved" value={`${stats.co2SavedKg.toFixed(1)} kg`} icon={<TrendingDown className="h-5 w-5 text-primary" />} />
          <KpiCard title="Fossil Emissions" value={`${stats.fossilCo2Kg.toFixed(1)} kg`} icon={<Fuel className="h-5 w-5 text-amber-500" />} />
          <KpiCard title="EV Emissions" value={`${stats.evCo2Kg.toFixed(1)} kg`} icon={<Zap className="h-5 w-5 text-violet-500" />} />
        </div>

        <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
          <h2 className="text-lg font-bold mb-1">Trees Equivalent</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Your EV fleet has saved <span className="text-emerald-500 font-semibold">{stats.co2SavedKg.toFixed(1)} kg</span> of CO₂ — equivalent to planting <span className="text-emerald-500 font-semibold">{stats.treesEquivalent}</span> trees per year.
          </p>
          <div className="flex flex-wrap gap-2 items-end">
            {treesArr.map((i) => (
              <TreePine
                key={i}
                className="text-emerald-500 animate-in fade-in duration-300"
                style={{ animationDelay: `${i * 50}ms`, height: 24 + Math.random() * 12, width: 24 + Math.random() * 12 }}
              />
            ))}
            {treeCount > 50 && (
              <span className="text-emerald-500 font-bold text-lg ml-2">+{treeCount - 50} more</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
            <h2 className="text-lg font-bold mb-4">Fossil vs EV Emissions</h2>
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
              <p className="text-muted-foreground text-center py-12 italic">No route data yet</p>
            )}
          </div>

          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-xl shadow-black/5">
            <h2 className="text-lg font-bold mb-4">CO₂ by Route</h2>
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
              <p className="text-muted-foreground text-center py-12 italic">No route data yet</p>
            )}
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-card-border shadow-xl shadow-black/5 overflow-hidden">
          <div className="p-6 border-b border-border">
            <h2 className="text-lg font-bold">Route Emissions Breakdown</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Route</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Vehicle</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Type</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Distance</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">CO₂</th>
                  <th className="p-4 font-semibold text-muted-foreground text-sm">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.routeBreakdown.map((r) => (
                  <tr key={r.routeId} className="hover:bg-muted/30 transition-colors">
                    <td className="p-4 font-medium">{r.routeName}</td>
                    <td className="p-4 text-muted-foreground">{r.vehicleName}</td>
                    <td className="p-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${r.vehicleType === 'electric' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-500'}`}>
                        {r.vehicleType === 'electric' ? <Zap className="h-3 w-3" /> : <Fuel className="h-3 w-3" />}
                        {r.vehicleType === 'electric' ? 'EV' : 'Fossil'}
                      </span>
                    </td>
                    <td className="p-4 text-muted-foreground">{r.distanceKm.toFixed(1)} km</td>
                    <td className="p-4 font-medium">{r.co2Kg.toFixed(2)} kg</td>
                    <td className="p-4 text-muted-foreground text-sm">{new Date(r.date).toLocaleDateString()}</td>
                  </tr>
                ))}
                {stats.routeBreakdown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-muted-foreground">No routes yet</td>
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
