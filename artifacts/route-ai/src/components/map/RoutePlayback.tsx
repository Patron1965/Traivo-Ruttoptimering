import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, ZoomControl, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play, Pause, SkipBack, FastForward, Clock, Gauge, MapPin, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEPOT_LOCATION } from "@/lib/constants";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { MapRouteLine } from "./MapRouteLine";
import { isValidCoordinate } from "@/lib/map-utils";

interface GpsPoint {
  latitude: number;
  longitude: number;
  heading: number | null;
  speedKmh: number | null;
  recordedAt: string;
  routeId?: string | null;
}

interface RoutePlaybackProps {
  routeId: string;
  routeColor?: string;
  height?: number;
}

const SPEEDS = [1, 2, 5, 10, 25, 50] as const;
type Speed = typeof SPEEDS[number];

function createVehicleIcon(heading: number | null, color: string) {
  const rot = heading ?? 0;
  return L.divIcon({
    className: "",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    html: `<div style="transform: rotate(${rot}deg); width:32px; height:32px; display:flex; align-items:center; justify-content:center;">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="${color}" stroke="white" stroke-width="1.5">
        <path d="M12 2 L20 20 L12 16 L4 20 Z"/>
      </svg>
    </div>`,
  });
}

function FitBoundsOnce({ points, resetKey }: { points: GpsPoint[]; resetKey: string }) {
  const map = useMap();
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (points.length < 2) return;
    if (lastKey.current === resetKey) return;
    const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40] });
    lastKey.current = resetKey;
  }, [points, map, resetKey]);
  return null;
}

export function RoutePlayback({ routeId, routeColor = "#3b82f6", height = 480 }: RoutePlaybackProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(5);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, isError } = useQuery<{ points: GpsPoint[] }>({
    queryKey: ["/api/tracking/history/route", organizationId, routeId],
    queryFn: async () => {
      const params = new URLSearchParams({ organizationId: organizationId! });
      const res = await fetch(`/api/tracking/history/route/${routeId}?${params}`);
      if (!res.ok) throw new Error("Failed to load GPS history");
      const body = await res.json();
      return { points: Array.isArray(body) ? body : body.points ?? [] };
    },
    enabled: !!organizationId && !!routeId,
  });

  const points: GpsPoint[] = data?.points ?? [];
  const hasPoints = points.length > 0;
  const safeIndex = hasPoints ? Math.min(Math.max(0, index), points.length - 1) : 0;

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [routeId, points.length]);

  useEffect(() => {
    if (!playing || !hasPoints) return;
    timerRef.current = setInterval(() => {
      setIndex((i) => {
        if (i >= points.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, Math.max(50, 1000 / speed));
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, speed, hasPoints, points.length]);

  const current = hasPoints ? points[safeIndex] : null;
  const validCurrent = current && isValidCoordinate(current.latitude, current.longitude)
    ? current
    : null;
  const validMapPoints = useMemo(
    () => points.filter((point) => isValidCoordinate(point.latitude, point.longitude)),
    [points],
  );

  const trail = useMemo(
    () =>
      hasPoints
        ? points
            .slice(0, safeIndex + 1)
            .filter((point) => isValidCoordinate(point.latitude, point.longitude))
            .map((p) => [p.latitude, p.longitude] as [number, number])
        : [],
    [points, safeIndex, hasPoints],
  );

  const stats = useMemo(() => {
    if (!hasPoints) return { totalKm: 0, durationMin: 0, avgSpeed: 0, coveredKm: 0 };
    const totalKm = haversineLengthKm(points);
    const coveredKm = haversineLengthKm(points.slice(0, safeIndex + 1));
    const first = new Date(points[0].recordedAt).getTime();
    const last = new Date(points[points.length - 1].recordedAt).getTime();
    const durationMin = Math.max(0, (last - first) / 60_000);
    const avgSpeed = durationMin > 0 ? (totalKm / durationMin) * 60 : 0;
    return { totalKm, durationMin, avgSpeed, coveredKm };
  }, [points, safeIndex, hasPoints]);

  const progressPct = hasPoints ? ((safeIndex + 1) / points.length) * 100 : 0;

  const center: [number, number] = validCurrent
    ? [validCurrent.latitude, validCurrent.longitude]
    : validMapPoints.length > 0
      ? [validMapPoints[0].latitude, validMapPoints[0].longitude]
      : [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng];

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="p-4 flex items-center justify-between gap-2 flex-wrap border-b border-border">
        <div className="flex items-center gap-2">
          <Radio className={cn("h-4 w-4", playing ? "text-emerald-400 animate-pulse" : "text-muted-foreground")} />
          <h3 className="font-semibold">{t("playback.title", "Ruttuppspelning")}</h3>
          {hasPoints && (
            <span className="text-xs text-muted-foreground">
              · {points.length} {t("playback.pings", "signaler")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setIndex(0); setPlaying(false); }}
            disabled={!hasPoints}
            title={t("playback.restart", "Börja om")}
          >
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant={playing ? "secondary" : "default"}
            onClick={() => {
              if (!hasPoints) return;
              if (safeIndex >= points.length - 1) setIndex(0);
              setPlaying((p) => !p);
            }}
            disabled={!hasPoints}
            className="gap-1.5"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {playing ? t("playback.pause", "Pausa") : t("playback.play", "Spela")}
          </Button>
          <div className="flex items-center gap-0.5 ml-2 bg-background/60 border border-border rounded-lg p-0.5">
            <FastForward className="h-3.5 w-3.5 text-muted-foreground mx-1" />
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={cn(
                  "text-xs px-2 py-1 rounded-md transition-colors",
                  speed === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ height }}>
        {isLoading ? (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            {t("common.loading", "Laddar...")}
          </div>
        ) : isError ? (
          <div className="w-full h-full flex items-center justify-center text-destructive">
            {t("common.error", "Fel")}
          </div>
        ) : !hasPoints ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
            <MapPin className="h-8 w-8 opacity-30" />
            <p className="text-sm">{t("playback.noData", "Ingen GPS-historik tillgänglig för denna rutt")}</p>
          </div>
        ) : (
          <MapContainer center={center} zoom={13} className="w-full h-full z-0" zoomControl={false}>
            <ZoomControl position="bottomright" />
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            />
            <FitBoundsOnce points={validMapPoints} resetKey={routeId} />
            <MapRouteLine
              positions={validMapPoints.map((p) => [p.latitude, p.longitude] as [number, number])}
              color={routeColor}
              weight={4}
              isDimmed={true}
              isActual={true}
            />
            {trail.length > 1 && (
              <MapRouteLine
                positions={trail}
                color={routeColor}
                weight={5}
                isActual={true}
              />
            )}
            {validCurrent && (
              <Marker
                position={[validCurrent.latitude, validCurrent.longitude]}
                icon={createVehicleIcon(validCurrent.heading, routeColor)}
              />
            )}
          </MapContainer>
        )}
      </div>

      {hasPoints && (
        <div className="p-4 space-y-3 border-t border-border">
          <input
            type="range"
            min={0}
            max={points.length - 1}
            value={safeIndex}
            onChange={(e) => { setIndex(Number(e.target.value)); setPlaying(false); }}
            className="w-full accent-primary"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatTime(points[0].recordedAt)}</span>
            <span className="font-medium text-foreground">
              {Math.min(100, progressPct).toFixed(0)}% · {formatTime(current?.recordedAt ?? points[0].recordedAt)}
            </span>
            <span>{formatTime(points[points.length - 1].recordedAt)}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
            <Stat icon={Clock} label={t("playback.duration", "Duration")} value={`${stats.durationMin.toFixed(0)} min`} />
            <Stat icon={MapPin} label={t("playback.totalDistance", "Total")} value={`${stats.totalKm.toFixed(1)} km`} />
            <Stat icon={Gauge} label={t("playback.avgSpeed", "Snitt")} value={`${stats.avgSpeed.toFixed(0)} km/h`} />
            <Stat
              icon={Radio}
              label={t("playback.currentSpeed", "Nu")}
              value={current?.speedKmh != null ? `${Math.round(current.speedKmh)} km/h` : "—"}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="p-2.5 rounded-lg bg-background/60 border border-border">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="font-semibold text-sm mt-0.5">{value}</div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function haversineLengthKm(pts: GpsPoint[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    km += haversine(pts[i - 1], pts[i]);
  }
  return km;
}

function haversine(a: GpsPoint, b: GpsPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const la1 = toRad(a.latitude);
  const la2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
