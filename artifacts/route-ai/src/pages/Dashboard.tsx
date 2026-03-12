import { AppLayout } from "@/components/layout/AppLayout";
import { useDashboardStats } from "@/hooks/use-dashboard";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { InsightsPanel } from "@/components/insights/InsightsPanel";
import { Truck, MapPin, Route, Clock, Leaf, Gauge } from "lucide-react";
import { formatDistance, formatDuration } from "@/lib/utils";

export default function Dashboard() {
  const { data: stats, isLoading, error, dataUpdatedAt } = useDashboardStats();

  if (isLoading) return <AppLayout><LoadingState message="Loading telemetry..." /></AppLayout>;
  if (error || !stats) return <AppLayout><ErrorState error={error} /></AppLayout>;

  return (
    <AppLayout>
      <div className="p-6 md:p-8 lg:p-10 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">Fleet Overview</h1>
          <p className="text-muted-foreground mt-2 text-lg">Real-time metrics and routing performance</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          <StatCard 
            title="Active Routes" 
            value={stats.totalRoutes} 
            icon={<Route className="h-5 w-5 text-primary" />} 
          />
          <StatCard 
            title="Total Stops" 
            value={stats.totalStops} 
            icon={<MapPin className="h-5 w-5 text-emerald-500" />} 
          />
          <StatCard 
            title="Total Distance" 
            value={formatDistance(stats.totalDistanceKm)} 
            icon={<Gauge className="h-5 w-5 text-amber-500" />} 
          />
          <StatCard 
            title="Estimated Time" 
            value={formatDuration(stats.totalDurationMin)} 
            icon={<Clock className="h-5 w-5 text-violet-500" />} 
          />
        </div>

        <InsightsPanel dashboardUpdatedAt={dataUpdatedAt} />

        <h2 className="text-2xl font-bold tracking-tight mt-12 mb-6">Fleet & Sustainability</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 hover:-translate-y-1 transition-transform duration-300 relative overflow-hidden group">
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/10 rounded-full blur-3xl group-hover:bg-primary/20 transition-colors" />
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <Truck className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Active Vehicles</p>
                <p className="text-3xl font-bold text-foreground mt-1">{stats.activeVehicles}</p>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 hover:-translate-y-1 transition-transform duration-300 relative overflow-hidden group">
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl group-hover:bg-amber-500/20 transition-colors" />
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <MapPin className="h-6 w-6 text-amber-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Pending Stops</p>
                <p className="text-3xl font-bold text-amber-500 mt-1">{stats.pendingStops}</p>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 hover:-translate-y-1 transition-transform duration-300 relative overflow-hidden group">
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl group-hover:bg-emerald-500/20 transition-colors" />
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <Leaf className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">CO₂ Emissions</p>
                <p className="text-3xl font-bold text-foreground mt-1">{stats.co2EmissionsKg.toFixed(1)} kg</p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </AppLayout>
  );
}

function StatCard({ title, value, icon }: { title: string, value: string | number, icon: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl p-6 border border-card-border shadow-md shadow-black/5 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className="p-2 bg-muted rounded-lg">{icon}</div>
      </div>
      <div className="mt-4">
        <p className="text-4xl font-bold">{value}</p>
      </div>
    </div>
  );
}
