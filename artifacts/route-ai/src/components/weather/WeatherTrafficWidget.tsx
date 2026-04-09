import { useQuery } from "@tanstack/react-query";
import { Cloud, CloudRain, CloudSnow, Sun, Wind, AlertTriangle, Car, Thermometer } from "lucide-react";
import { useTranslation } from "react-i18next";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface WeatherData {
  temperature: number;
  windSpeedMs: number;
  precipitationMm: number;
  weatherCode: number;
  description: string;
  drivingImpact: number;
  evRangeMultiplier: number;
  severity: "clear" | "mild" | "moderate" | "severe";
}

interface TrafficOverview {
  overall: "free" | "light" | "moderate" | "heavy" | "severe";
  corridors: { name: string; multiplier: number; level: string }[];
  incidents: { lat: number; lng: number; type: string; description: string; delayMinutes: number }[];
}

function WeatherIcon({ code, className }: { code: number; className?: string }) {
  if (code >= 95) return <CloudRain className={className} />;
  if (code >= 71) return <CloudSnow className={className} />;
  if (code >= 51) return <CloudRain className={className} />;
  if (code >= 45) return <Cloud className={className} />;
  if (code >= 3) return <Cloud className={className} />;
  return <Sun className={className} />;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "severe": return "text-red-500";
    case "moderate": return "text-amber-500";
    case "mild": return "text-yellow-400";
    default: return "text-emerald-500";
  }
}

function trafficColor(level: string): string {
  switch (level) {
    case "severe": return "bg-red-500";
    case "heavy": return "bg-orange-500";
    case "moderate": return "bg-amber-500";
    case "light": return "bg-yellow-400";
    default: return "bg-emerald-500";
  }
}

function trafficLabel(level: string): string {
  switch (level) {
    case "severe": return "Mycket trångt";
    case "heavy": return "Trångt";
    case "moderate": return "Måttlig trafik";
    case "light": return "Lätt trafik";
    default: return "Fritt flöde";
  }
}

export function WeatherTrafficWidget() {
  const { t } = useTranslation();

  const { data: weather } = useQuery<WeatherData>({
    queryKey: ["/api/weather/current"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/weather/current`);
      if (!res.ok) throw new Error("Failed to fetch weather");
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
  });

  const { data: traffic } = useQuery<TrafficOverview>({
    queryKey: ["/api/traffic/overview"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/traffic/overview`);
      if (!res.ok) throw new Error("Failed to fetch traffic");
      return res.json();
    },
    refetchInterval: 2 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  if (!weather && !traffic) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
      {weather && (
        <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 relative overflow-hidden group">
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-sky-500/10 rounded-full blur-3xl group-hover:bg-sky-500/20 transition-colors" />
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Väder — Stockholm</h3>
            <WeatherIcon code={weather.weatherCode} className={`h-8 w-8 ${severityColor(weather.severity)}`} />
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm flex items-center gap-2">
                <Thermometer className="h-4 w-4" /> Temperatur
              </span>
              <span className="font-semibold">{weather.temperature}°C</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm flex items-center gap-2">
                <Cloud className="h-4 w-4" /> Väder
              </span>
              <span className="font-medium">{weather.description}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm flex items-center gap-2">
                <Wind className="h-4 w-4" /> Vind
              </span>
              <span className="font-semibold">{weather.windSpeedMs} m/s</span>
            </div>
            {weather.drivingImpact > 1.05 && (
              <div className={`flex items-center gap-2 mt-2 p-2 rounded-lg ${
                weather.severity === "severe" ? "bg-red-500/10" :
                weather.severity === "moderate" ? "bg-amber-500/10" : "bg-yellow-400/10"
              }`}>
                <AlertTriangle className={`h-4 w-4 ${severityColor(weather.severity)}`} />
                <span className={`text-sm font-medium ${severityColor(weather.severity)}`}>
                  Körpåverkan: +{Math.round((weather.drivingImpact - 1) * 100)}% restid
                </span>
              </div>
            )}
            {weather.evRangeMultiplier < 0.85 && (
              <div className="flex items-center gap-2 p-2 rounded-lg bg-blue-500/10">
                <AlertTriangle className="h-4 w-4 text-blue-400" />
                <span className="text-sm font-medium text-blue-400">
                  EV-räckvidd: {Math.round(weather.evRangeMultiplier * 100)}% av normalt
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {traffic && (
        <div className="bg-card rounded-2xl p-6 border border-card-border shadow-lg shadow-black/5 relative overflow-hidden group">
          <div className="absolute -right-6 -top-6 w-32 h-32 bg-amber-500/10 rounded-full blur-3xl group-hover:bg-amber-500/20 transition-colors" />
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Trafik — Stockholm</h3>
            <Car className={`h-8 w-8 ${
              traffic.overall === "free" ? "text-emerald-500" :
              traffic.overall === "light" ? "text-yellow-400" :
              traffic.overall === "moderate" ? "text-amber-500" :
              "text-red-500"
            }`} />
          </div>
          <div className="flex items-center gap-3 mb-4">
            <div className={`h-3 w-3 rounded-full ${trafficColor(traffic.overall)}`} />
            <span className="font-semibold">{trafficLabel(traffic.overall)}</span>
          </div>
          <div className="space-y-2 max-h-32 overflow-y-auto">
            {traffic.corridors
              .filter(c => c.level !== "free")
              .sort((a, b) => b.multiplier - a.multiplier)
              .slice(0, 5)
              .map((c, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground truncate mr-2">{c.name}</span>
                  <div className="flex items-center gap-2">
                    <div className={`h-2 w-2 rounded-full ${trafficColor(c.level)}`} />
                    <span className="font-medium text-foreground">+{Math.round((c.multiplier - 1) * 100)}%</span>
                  </div>
                </div>
              ))}
            {traffic.corridors.filter(c => c.level !== "free").length === 0 && (
              <p className="text-sm text-muted-foreground">Alla vägar flyter fritt</p>
            )}
          </div>
          {traffic.incidents.length > 0 && (
            <div className="mt-3 pt-3 border-t border-card-border">
              <p className="text-sm font-medium text-red-400 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                {traffic.incidents.length} aktiv{traffic.incidents.length > 1 ? "a" : ""} incident{traffic.incidents.length > 1 ? "er" : ""}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
