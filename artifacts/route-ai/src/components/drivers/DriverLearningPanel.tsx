import { useQuery } from "@tanstack/react-query";
import { Brain, TrendingUp, TrendingDown, Minus, MapPin, Clock, Star, Zap } from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface LearningInsights {
  hasEnoughData: boolean;
  message?: string;
  profile?: {
    speedFactor: number;
    serviceDurationFactor: number;
    reliabilityScore: number;
    preferredAreas: { lat: number; lng: number; familiarity: number }[];
    avgBreakIntervalMin: number | null;
    peakPerformanceHour: number | null;
    dataPoints: number;
  };
  trends?: {
    reliabilityTrend: number;
    speedAccuracyTrend: number;
    improving: boolean;
  };
  strengths?: string[];
  improvements?: string[];
}

function TrendIcon({ value }: { value: number }) {
  if (value > 0.02) return <TrendingUp className="h-4 w-4 text-emerald-500" />;
  if (value < -0.02) return <TrendingDown className="h-4 w-4 text-red-400" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

function scoreColor(score: number): string {
  if (score >= 0.9) return "text-emerald-500";
  if (score >= 0.75) return "text-yellow-400";
  if (score >= 0.6) return "text-amber-500";
  return "text-red-400";
}

function progressBar(value: number, max: number = 1): string {
  return `${Math.min(100, Math.round((value / max) * 100))}%`;
}

export function DriverLearningPanel({ driverId }: { driverId: string }) {
  const { data: insights, isLoading } = useQuery<LearningInsights>({
    queryKey: [`/api/drivers/${driverId}/learning`],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/drivers/${driverId}/learning`);
      if (!res.ok) throw new Error("Failed to fetch learning insights");
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="bg-card rounded-2xl p-6 border border-card-border animate-pulse">
        <div className="h-6 w-48 bg-muted rounded" />
        <div className="h-4 w-64 bg-muted rounded mt-3" />
      </div>
    );
  }

  if (!insights || !insights.hasEnoughData) {
    return (
      <div className="bg-card rounded-2xl p-6 border border-card-border">
        <div className="flex items-center gap-3 mb-2">
          <Brain className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-semibold">AI-inlärning</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {insights?.message || "Samlar in data..."}
        </p>
      </div>
    );
  }

  const { profile, trends, strengths, improvements } = insights;

  return (
    <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Brain className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">AI-inlärning</h3>
            <p className="text-xs text-muted-foreground">{profile!.dataPoints} datapunkter</p>
          </div>
        </div>
        {trends && (
          <div className={`flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium ${
            trends.improving ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"
          }`}>
            {trends.improving ? <TrendingUp className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
            {trends.improving ? "Förbättras" : "Stabil"}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 mb-5">
        <div>
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Star className="h-3 w-3" /> Pålitlighet
          </p>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold ${scoreColor(profile!.reliabilityScore)}`}>
              {Math.round(profile!.reliabilityScore * 100)}%
            </span>
            {trends && <TrendIcon value={trends.reliabilityTrend} />}
          </div>
          <div className="h-1.5 bg-muted rounded-full mt-1.5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                profile!.reliabilityScore >= 0.9 ? "bg-emerald-500" :
                profile!.reliabilityScore >= 0.75 ? "bg-yellow-400" : "bg-red-400"
              }`}
              style={{ width: progressBar(profile!.reliabilityScore) }}
            />
          </div>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
            <Clock className="h-3 w-3" /> Tidsnoggrannhet
          </p>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold text-foreground">
              {profile!.speedFactor > 1
                ? `+${Math.round((profile!.speedFactor - 1) * 100)}%`
                : `${Math.round((1 - profile!.speedFactor) * 100)}%`}
            </span>
            {trends && <TrendIcon value={trends.speedAccuracyTrend} />}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {profile!.speedFactor > 1.05 ? "Tar längre tid än planerat" :
             profile!.speedFactor < 0.95 ? "Snabbare än planerat" : "Följer tidsplanen"}
          </p>
        </div>
      </div>

      {profile!.preferredAreas && profile!.preferredAreas.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
            <MapPin className="h-3 w-3" /> Områdeskännedom ({profile!.preferredAreas.length} områden)
          </p>
          <div className="flex gap-1.5 flex-wrap">
            {profile!.preferredAreas.slice(0, 5).map((area, i) => (
              <div
                key={i}
                className="px-2 py-1 bg-primary/10 rounded text-xs font-medium text-primary"
                title={`${area.lat.toFixed(2)}, ${area.lng.toFixed(2)}`}
              >
                Område {i + 1}: {Math.round(area.familiarity * 100)}%
              </div>
            ))}
          </div>
        </div>
      )}

      {profile!.peakPerformanceHour !== null && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-amber-500" />
          <span className="text-muted-foreground">Bäst prestanda kl</span>
          <span className="font-semibold">{profile!.peakPerformanceHour}:00</span>
        </div>
      )}

      {((strengths && strengths.length > 0) || (improvements && improvements.length > 0)) && (
        <div className="border-t border-card-border pt-4 space-y-2">
          {strengths?.map((s, i) => (
            <div key={`s-${i}`} className="flex items-center gap-2 text-sm">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span className="text-emerald-400">{s}</span>
            </div>
          ))}
          {improvements?.map((s, i) => (
            <div key={`i-${i}`} className="flex items-center gap-2 text-sm">
              <div className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              <span className="text-amber-400">{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
