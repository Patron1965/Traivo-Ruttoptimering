import { AppLayout } from "@/components/layout/AppLayout";
import { useRoutes } from "@/hooks/use-routes";
import { useVehiclePositions } from "@/hooks/use-tracking";
import { useAuth } from "@/lib/auth-context";
import { ORG_ID } from "@/lib/constants";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MapPin, Navigation, Clock, Package, CheckCircle2, XCircle, SkipForward, Truck, Phone } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.VITE_API_URL || "";

function createStopIcon(index: number, status: string) {
  const color = status === "completed" ? "#22c55e" : status === "failed" ? "#ef4444" : status === "in_progress" ? "#3b82f6" : "#6b7280";
  return L.divIcon({
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<div style="width:28px;height:28px;border-radius:50%;background:${color};color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)">${index}</div>`,
  });
}

interface Stop {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  status: string;
  sequenceOrder: number | null;
  customerName?: string | null;
  serviceDurationMin?: number | null;
  timeWindowStart?: string | null;
  timeWindowEnd?: string | null;
}

export default function DriverView() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: routes } = useRoutes();
  const { data: positions } = useVehiclePositions();
  const queryClient = useQueryClient();
  const [updatingStop, setUpdatingStop] = useState<string | null>(null);

  const activeRoutes = (routes || []).filter(
    (r) => r.status === "in_progress" || r.status === "optimized"
  );

  const currentRoute = activeRoutes[0];
  const [routeStops, setRouteStops] = useState<Stop[]>([]);

  const fetchStops = async (routeId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/routes/${routeId}/stops?organizationId=${ORG_ID}`);
      const data = await res.json();
      setRouteStops(data);
    } catch {}
  };

  if (currentRoute && routeStops.length === 0) {
    fetchStops(currentRoute.id);
  }

  const sortedStops = [...routeStops].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
  const nextStop = sortedStops.find((s) => s.status === "pending" || s.status === "in_progress");
  const completedCount = sortedStops.filter((s) => s.status === "completed").length;
  const totalCount = sortedStops.length;

  const currentPosition = positions?.find((p: any) => p.routeId === currentRoute?.id);

  async function updateStopStatus(stopId: string, status: string) {
    setUpdatingStop(stopId);
    try {
      await fetch(`${API_BASE}/api/stops/${stopId}?organizationId=${ORG_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (currentRoute) {
        await fetchStops(currentRoute.id);
      }
      queryClient.invalidateQueries({ queryKey: ["getRoutes"] });
    } catch {}
    setUpdatingStop(null);
  }

  const mapCenter = nextStop
    ? [nextStop.latitude, nextStop.longitude] as [number, number]
    : [59.3293, 18.0686] as [number, number];

  return (
    <AppLayout>
      <div className="flex flex-col h-full max-w-lg mx-auto lg:max-w-none lg:flex-row">
        <div className="h-48 lg:h-full lg:flex-1 relative">
          <MapContainer
            center={mapCenter}
            zoom={13}
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://carto.com">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            />
            {sortedStops.map((stop, idx) => (
              <Marker
                key={stop.id}
                position={[stop.latitude, stop.longitude]}
                icon={createStopIcon(idx + 1, stop.status)}
              >
                <Popup>
                  <div className="text-sm">
                    <p className="font-bold">{stop.address}</p>
                    <p className="text-gray-500">{stop.status}</p>
                  </div>
                </Popup>
              </Marker>
            ))}
            {sortedStops.length > 1 && (
              <Polyline
                positions={sortedStops.map((s) => [s.latitude, s.longitude] as [number, number])}
                color="#3b82f6"
                weight={3}
                opacity={0.6}
              />
            )}
          </MapContainer>

          {currentRoute && (
            <div className="absolute top-3 left-3 right-3 z-[1000] bg-background/90 backdrop-blur-md rounded-xl p-3 border border-border shadow-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 text-primary" />
                  <span className="font-bold text-sm">{currentRoute.name}</span>
                </div>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                  {completedCount}/{totalCount}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 lg:w-96 lg:flex-none overflow-y-auto bg-background">
          {!currentRoute ? (
            <div className="flex items-center justify-center h-full p-8 text-center">
              <div>
                <Truck className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
                <h2 className="font-bold text-lg mb-1">Ingen aktiv rutt</h2>
                <p className="text-sm text-muted-foreground">Du har inga tilldelade rutter just nu.</p>
              </div>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {nextStop && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Navigation className="h-5 w-5 text-primary" />
                    <span className="text-xs font-bold uppercase tracking-wider text-primary">
                      {t("common.stop")} {sortedStops.indexOf(nextStop) + 1} av {totalCount}
                    </span>
                  </div>
                  <p className="font-bold text-lg mb-1">{nextStop.address}</p>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                    {nextStop.serviceDurationMin && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {nextStop.serviceDurationMin} min
                      </span>
                    )}
                    {nextStop.timeWindowStart && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {new Date(nextStop.timeWindowStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => updateStopStatus(nextStop.id, "completed")}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-emerald-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-6 w-6" />
                      Levererad
                    </button>
                    <button
                      onClick={() => updateStopStatus(nextStop.id, "failed")}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-red-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <XCircle className="h-6 w-6" />
                      Misslyckad
                    </button>
                    <button
                      onClick={() => updateStopStatus(nextStop.id, "skipped")}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-amber-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <SkipForward className="h-6 w-6" />
                      Hoppa
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {sortedStops.map((stop, idx) => {
                  const isNext = stop.id === nextStop?.id;
                  const isDone = stop.status === "completed";
                  const isFailed = stop.status === "failed";
                  const isSkipped = stop.status === "skipped";

                  return (
                    <div
                      key={stop.id}
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-xl border transition-colors",
                        isNext ? "border-primary/30 bg-primary/5" :
                        isDone ? "border-emerald-500/20 bg-emerald-500/5" :
                        isFailed ? "border-red-500/20 bg-red-500/5" :
                        isSkipped ? "border-amber-500/20 bg-amber-500/5" :
                        "border-border bg-card"
                      )}
                    >
                      <div className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0",
                        isDone ? "bg-emerald-500 text-white" :
                        isFailed ? "bg-red-500 text-white" :
                        isSkipped ? "bg-amber-500 text-white" :
                        isNext ? "bg-primary text-white" :
                        "bg-muted text-muted-foreground"
                      )}>
                        {isDone ? <CheckCircle2 className="h-4 w-4" /> :
                         isFailed ? <XCircle className="h-4 w-4" /> :
                         idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm font-medium truncate", (isDone || isSkipped) && "line-through opacity-60")}>
                          {stop.address}
                        </p>
                        {stop.timeWindowStart && (
                          <p className="text-xs text-muted-foreground">
                            {new Date(stop.timeWindowStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            {stop.timeWindowEnd && ` - ${new Date(stop.timeWindowEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                          </p>
                        )}
                      </div>
                      {isNext && <MapPin className="h-4 w-4 text-primary animate-bounce shrink-0" />}
                    </div>
                  );
                })}
              </div>

              {completedCount === totalCount && totalCount > 0 && (
                <div className="text-center p-6 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-3 text-emerald-500" />
                  <h3 className="font-bold text-lg">Rutt slutförd!</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Alla {totalCount} leveranser är klara.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
