import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { ORG_ID } from "@/lib/constants";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  SkipForward,
  Clock,
  MapPin,
  Route as RouteIcon,
  TrendingUp,
  TrendingDown,
  Minus,
  Gauge,
} from "lucide-react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

interface ComparisonData {
  route: {
    id: string;
    name: string;
    status: string;
    date: string;
    vehicleName: string | null;
  };
  planned: {
    totalStops: number;
    distanceKm: number;
    durationMin: number;
    co2Kg: number;
    coordinates: Array<{ lat: number; lng: number; address: string; status: string }>;
  };
  actual: {
    completedStops: number;
    failedStops: number;
    skippedStops: number;
    pendingStops: number;
    distanceKm: number;
    serviceDurationMin: number;
    completionRate: number;
    coordinates: Array<{ lat: number; lng: number; address: string }>;
  };
  stops: Array<{
    id: string;
    address: string;
    status: string;
    sequenceOrder: number;
    latitude: number;
    longitude: number;
    serviceDurationMin: number;
  }>;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#10b981",
  failed: "#ef4444",
  skipped: "#f59e0b",
  pending: "#6b7280",
  in_progress: "#3b82f6",
};

const STATUS_ICONS: Record<string, typeof CheckCircle2> = {
  completed: CheckCircle2,
  failed: XCircle,
  skipped: SkipForward,
  pending: Clock,
  in_progress: Clock,
};

function DeltaIndicator({ planned, actual, unit, invert }: { planned: number; actual: number; unit: string; invert?: boolean }) {
  const diff = actual - planned;
  const isPositive = invert ? diff < 0 : diff > 0;
  const isNeutral = diff === 0;

  return (
    <div className="flex items-center gap-1 text-sm">
      {isNeutral ? (
        <Minus className="h-3 w-3 text-muted-foreground" />
      ) : isPositive ? (
        <TrendingUp className="h-3 w-3 text-emerald-500" />
      ) : (
        <TrendingDown className="h-3 w-3 text-red-500" />
      )}
      <span className={isNeutral ? "text-muted-foreground" : isPositive ? "text-emerald-500" : "text-red-500"}>
        {diff > 0 ? "+" : ""}{Math.round(diff * 10) / 10} {unit}
      </span>
    </div>
  );
}

export default function RouteComparison({ id }: { id: string }) {
  const { t } = useTranslation();
  const [, navigate] = useLocation();

  const { data, isLoading, isError } = useQuery<ComparisonData>({
    queryKey: ["/api/routes", id, "comparison"],
    queryFn: async () => {
      const res = await fetch(`/api/routes/${id}/comparison?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Failed to load comparison");
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

  if (isError || !data) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
          <p className="text-destructive">{t("routeComparison.noData")}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate(`/routes/${id}`)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("routeComparison.backToRoute")}
          </Button>
        </div>
      </AppLayout>
    );
  }

  const { route, planned, actual, stops } = data;

  const pieData = [
    { name: t("routeComparison.completed"), value: actual.completedStops, color: STATUS_COLORS.completed },
    { name: t("routeComparison.failed"), value: actual.failedStops, color: STATUS_COLORS.failed },
    { name: t("routeComparison.skipped"), value: actual.skippedStops, color: STATUS_COLORS.skipped },
    { name: t("routeComparison.pending"), value: actual.pendingStops, color: STATUS_COLORS.pending },
  ].filter((d) => d.value > 0);

  const allCoords = planned.coordinates;
  const center = allCoords.length > 0
    ? { lat: allCoords.reduce((s, c) => s + c.lat, 0) / allCoords.length, lng: allCoords.reduce((s, c) => s + c.lng, 0) / allCoords.length }
    : { lat: 59.33, lng: 18.07 };

  const plannedPolyline = allCoords.map((c) => [c.lat, c.lng] as [number, number]);
  const actualPolyline = actual.coordinates.map((c) => [c.lat, c.lng] as [number, number]);

  return (
    <AppLayout>
      <div className="p-6 max-w-[1400px] mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/routes/${id}`)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Gauge className="h-6 w-6 text-primary" />
              {t("routeComparison.title")}
            </h1>
            <p className="text-muted-foreground text-sm">{route.name} — {t("routeComparison.subtitle")}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ComparisonCard
            label={t("routeComparison.stops")}
            icon={<MapPin className="h-4 w-4 text-primary" />}
            planned={`${planned.totalStops}`}
            actual={`${actual.completedStops}`}
          >
            <DeltaIndicator planned={planned.totalStops} actual={actual.completedStops} unit={t("routeComparison.stops").toLowerCase()} />
          </ComparisonCard>

          <ComparisonCard
            label={t("routeComparison.distance")}
            icon={<RouteIcon className="h-4 w-4 text-primary" />}
            planned={`${planned.distanceKm} km`}
            actual={`${actual.distanceKm} km`}
          >
            <DeltaIndicator planned={planned.distanceKm} actual={actual.distanceKm} unit="km" invert />
          </ComparisonCard>

          <ComparisonCard
            label={t("routeComparison.completionRate")}
            icon={<CheckCircle2 className="h-4 w-4 text-primary" />}
            planned="100%"
            actual={`${actual.completionRate}%`}
          >
            <DeltaIndicator planned={100} actual={actual.completionRate} unit="%" />
          </ComparisonCard>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-card rounded-2xl border border-card-border p-4">
            <div className="flex items-center gap-4 mb-3">
              <div className="flex items-center gap-2">
                <div className="w-4 h-1 bg-blue-500 rounded" />
                <span className="text-xs text-muted-foreground">{t("routeComparison.plannedRoute")}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-4 h-1 bg-emerald-500 rounded" />
                <span className="text-xs text-muted-foreground">{t("routeComparison.actualRoute")}</span>
              </div>
            </div>
            <div className="h-[400px] rounded-xl overflow-hidden">
              <MapContainer
                center={[center.lat, center.lng]}
                zoom={12}
                className="h-full w-full"
                scrollWheelZoom
              >
                <TileLayer
                  url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
                />
                {plannedPolyline.length > 1 && (
                  <Polyline positions={plannedPolyline} color="#3b82f6" weight={4} opacity={0.6} dashArray="8,8" />
                )}
                {actualPolyline.length > 1 && (
                  <Polyline positions={actualPolyline} color="#10b981" weight={4} opacity={0.9} />
                )}
                {allCoords.map((coord, idx) => {
                  const color = STATUS_COLORS[coord.status] || "#6b7280";
                  return (
                    <CircleMarker
                      key={idx}
                      center={[coord.lat, coord.lng]}
                      radius={8}
                      fillColor={color}
                      color="#fff"
                      weight={2}
                      fillOpacity={0.9}
                    >
                      <Popup>
                        <div className="text-sm">
                          <p className="font-bold">{idx + 1}. {coord.address}</p>
                          <p style={{ color }}>{coord.status}</p>
                        </div>
                      </Popup>
                    </CircleMarker>
                  );
                })}
              </MapContainer>
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-card-border p-5">
            <h3 className="font-semibold mb-4">{t("routeComparison.stopBreakdown")}</h3>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={3}>
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2 mt-4">
              {pieData.map((entry) => (
                <div key={entry.name} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                    <span className="text-muted-foreground">{entry.name}</span>
                  </div>
                  <span className="font-bold">{entry.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-card-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 text-muted-foreground">
                <th className="p-3 text-left">#</th>
                <th className="p-3 text-left">{t("routeComparison.stops")}</th>
                <th className="p-3 text-left">Status</th>
                <th className="p-3 text-right">{t("routeComparison.duration")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {stops.map((stop) => {
                const Icon = STATUS_ICONS[stop.status] || Clock;
                const color = STATUS_COLORS[stop.status] || "#6b7280";
                return (
                  <tr key={stop.id} className="hover:bg-muted/20 transition-colors">
                    <td className="p-3 font-mono text-muted-foreground">{stop.sequenceOrder}</td>
                    <td className="p-3">{stop.address}</td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full" style={{ backgroundColor: `${color}20`, color }}>
                        <Icon className="h-3 w-3" />
                        {stop.status}
                      </span>
                    </td>
                    <td className="p-3 text-right text-muted-foreground">{stop.serviceDurationMin} min</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}

function ComparisonCard({ label, icon, planned, actual, children }: {
  label: string;
  icon: React.ReactNode;
  planned: string;
  actual: string;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-card rounded-2xl border border-card-border p-5">
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t("routeComparison.planned")}</p>
          <p className="text-lg font-bold text-blue-400">{planned}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t("routeComparison.actual")}</p>
          <p className="text-lg font-bold text-emerald-400">{actual}</p>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-border">
        {children}
      </div>
    </div>
  );
}
