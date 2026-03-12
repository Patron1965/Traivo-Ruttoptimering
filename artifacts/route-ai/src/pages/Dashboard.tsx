import { AppLayout } from "@/components/layout/AppLayout";
import { useDashboardStats } from "@/hooks/use-dashboard";
import { LoadingState, ErrorState } from "@/components/ui/LoadingState";
import { Truck, MapPin, Route, Clock, Leaf, AlertCircle, CheckCircle2 } from "lucide-react";
import { formatDistance, formatDuration } from "@/lib/utils";

export default function Dashboard() {
  const { data: stats, isLoading, error } = useDashboardStats();

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
            title="Active Vehicles" 
            value={stats.activeVehicles} 
            icon={<Truck className="h-5 w-5 text-primary" />} 
            trend="+2 from yesterday"
          />
          <StatCard 
            title="Total Routes" 
            value={stats.totalRoutes} 
            icon={<Route className="h-5 w-5 text-emerald-500" />} 
          />
          <StatCard 
            title="Pending Stops" 
            value={stats.pendingStops} 
            icon={<AlertCircle className="h-5 w-5 text-amber-500" />} 
            valueClassName="text-amber-500"
          />
          <StatCard 
            title="Completed Stops" 
            value={stats.totalStops - stats.pendingStops} 
            icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />} 
          />
        </div>

        <h2 className="text-2xl font-bold tracking-tight mt-12 mb-6">Efficiency Metrics</h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
          <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 hover:-translate-y-1 transition-transform duration-300 relative overflow-hidden group">
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-primary/10 rounded-full blur-3xl group-hover:bg-primary/20 transition-colors" />
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <MapPin className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total Distance</p>
                <p className="text-3xl font-bold text-foreground mt-1">{formatDistance(stats.totalDistanceKm)}</p>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 hover:-translate-y-1 transition-transform duration-300 relative overflow-hidden group">
            <div className="absolute -right-6 -top-6 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl group-hover:bg-amber-500/20 transition-colors" />
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <Clock className="h-6 w-6 text-amber-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Est. Duration</p>
                <p className="text-3xl font-bold text-foreground mt-1">{formatDuration(stats.totalDurationMin)}</p>
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

function StatCard({ title, value, icon, trend, valueClassName = "" }: { title: string, value: string | number, icon: React.ReactNode, trend?: string, valueClassName?: string }) {
  return (
    <div className="bg-card rounded-2xl p-6 border border-card-border shadow-md shadow-black/5 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <div className="p-2 bg-muted rounded-lg">{icon}</div>
      </div>
      <div className="mt-4">
        <p className={`text-4xl font-display font-bold ${valueClassName}`}>{value}</p>
        {trend && <p className="text-xs text-muted-foreground mt-2">{trend}</p>}
      </div>
    </div>
  );
}
