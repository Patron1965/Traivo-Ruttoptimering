import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, ZoomControl } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { renderToString } from "react-dom/server";
import { MapPin, Package, Truck, Check, AlertTriangle, Clock, Zap, Fuel, Bell, Timer, Activity } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ProofDisplay } from "@/components/pod/ProofDisplay";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/";

interface TrackingProof {
  id: string;
  proofType: string;
  fileUrl: string | null;
  data: string | null;
  capturedAt: string;
}

interface TimelineEvent {
  id: string;
  type: "approaching" | "delivered" | "failed" | "delayed";
  message: string | null;
  sentAt: string;
}

interface TrackingInfo {
  trackingCode: string;
  status: "scheduled" | "on_the_way" | "arriving_soon" | "delivered" | "failed";
  address: string;
  latitude: number;
  longitude: number;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  vehicleType: string | null;
  vehicleName: string | null;
  estimatedArrival: string | null;
  stopsProgress: { completed: number; total: number } | null;
  timeline?: TimelineEvent[];
  proofs?: TrackingProof[];
}

const createDestinationIcon = () => {
  const html = renderToString(
    <div style={{ width: 36, height: 36 }} className="relative flex items-center justify-center">
      <div className="absolute inset-0 rounded-full bg-primary/20" style={{ transform: "scale(1.5)" }} />
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="#06B6D4" stroke="white" strokeWidth="2">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3" fill="white"/>
      </svg>
    </div>
  );
  return L.divIcon({ html, className: "custom-leaflet-icon", iconSize: [36, 36], iconAnchor: [18, 36] });
};

function useCountdown(targetIso: string | null) {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    if (!targetIso) { setRemaining(null); return; }
    const update = () => {
      const diff = new Date(targetIso).getTime() - Date.now();
      if (diff <= 0) { setRemaining(null); return; }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      if (mins >= 60) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        setRemaining(`${h}h ${m}m`);
      } else {
        setRemaining(`${mins}m ${secs.toString().padStart(2, "0")}s`);
      }
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [targetIso]);

  return remaining;
}

function TimelineIcon({ type }: { type: string }) {
  switch (type) {
    case "approaching": return <Truck className="h-4 w-4" />;
    case "delivered": return <Check className="h-4 w-4" />;
    case "failed": return <AlertTriangle className="h-4 w-4" />;
    case "delayed": return <Clock className="h-4 w-4" />;
    default: return <Bell className="h-4 w-4" />;
  }
}

function timelineColor(type: string) {
  switch (type) {
    case "approaching": return "bg-blue-500 text-white";
    case "delivered": return "bg-emerald-500 text-white";
    case "failed": return "bg-red-500 text-white";
    case "delayed": return "bg-amber-500 text-white";
    default: return "bg-muted text-muted-foreground";
  }
}

export default function TrackingPage({ code }: { code: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<TrackingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const countdown = useCountdown(data?.estimatedArrival ?? null);

  const STATUS_STEPS = [
    { key: "scheduled", label: t("tracking.scheduled"), icon: Clock },
    { key: "on_the_way", label: t("tracking.onTheWay"), icon: Truck },
    { key: "arriving_soon", label: t("tracking.arrivingSoon"), icon: Package },
    { key: "delivered", label: t("tracking.delivered"), icon: Check },
  ] as const;

  useEffect(() => {
    const fetchTracking = async () => {
      try {
        const res = await fetch(`${API_BASE}api/track/${code}`, { credentials: "same-origin" });
        if (!res.ok) {
          setError(res.status === 404 ? t("tracking.codeNotFound") : t("tracking.loadFailed"));
          return;
        }
        setData(await res.json());
      } catch {
        setError(t("tracking.loadFailed"));
      } finally {
        setLoading(false);
      }
    };
    fetchTracking();
    const interval = setInterval(fetchTracking, 15000);
    return () => clearInterval(interval);
  }, [code, t]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="h-12 w-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="mt-4 text-muted-foreground">{t("tracking.loading")}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <AlertTriangle className="h-16 w-16 text-amber-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t("tracking.notFound")}</h1>
          <p className="text-muted-foreground">{error || t("tracking.unableToFind")}</p>
          <p className="text-sm text-muted-foreground mt-4">{t("tracking.code")}: <span className="font-mono font-bold">{code}</span></p>
        </div>
      </div>
    );
  }

  const statusIdx = STATUS_STEPS.findIndex((s) => s.key === data.status);
  const isFailed = data.status === "failed";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-emerald-500 flex items-center justify-center">
              <Package className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-lg">Route<span className="text-primary">AI</span> Tracking</span>
          </div>
          <span className="font-mono text-sm bg-muted px-3 py-1 rounded-lg font-bold">{data.trackingCode}</span>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-4 space-y-6 mt-4">
        {countdown && !isFailed && (
          <div className="bg-gradient-to-r from-primary/10 to-emerald-500/10 rounded-2xl border border-primary/20 p-6 shadow-lg">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-full bg-primary/20 flex items-center justify-center">
                <Timer className="h-7 w-7 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground font-medium">{t("tracking.estimatedArrival")}</p>
                <p className="text-3xl font-bold text-primary tabular-nums">{countdown}</p>
                {data.stopsProgress && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("tracking.routeProgress", { completed: data.stopsProgress.completed, total: data.stopsProgress.total })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="bg-card rounded-2xl border border-card-border p-6 shadow-lg">
          <h2 className="text-xl font-bold mb-6">{t("tracking.deliveryStatus")}</h2>

          {isFailed ? (
            <div className="flex items-center gap-3 bg-destructive/10 text-destructive p-4 rounded-xl">
              <AlertTriangle className="h-6 w-6" />
              <div>
                <p className="font-bold">{t("tracking.deliveryFailed")}</p>
                <p className="text-sm opacity-80">{t("tracking.contactSupport")}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between relative">
              <div className="absolute top-5 left-0 right-0 h-1 bg-muted rounded-full">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-700"
                  style={{ width: `${(statusIdx / (STATUS_STEPS.length - 1)) * 100}%` }}
                />
              </div>
              {STATUS_STEPS.map((step, i) => {
                const isActive = i <= statusIdx;
                const isCurrent = i === statusIdx;
                return (
                  <div key={step.key} className="flex flex-col items-center relative z-10">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all ${
                      isCurrent
                        ? "bg-primary border-primary text-white scale-110 shadow-lg shadow-primary/30"
                        : isActive
                          ? "bg-primary/20 border-primary text-primary"
                          : "bg-muted border-border text-muted-foreground"
                    }`}>
                      <step.icon className="h-5 w-5" />
                    </div>
                    <span className={`text-xs mt-2 font-medium ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-lg space-y-4">
            <h3 className="font-bold text-lg flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              {t("tracking.deliveryDetails")}
            </h3>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">{t("tracking.address")}</p>
                <p className="font-medium mt-1">{data.address}</p>
              </div>
              {data.timeWindowStart && data.timeWindowEnd && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">{t("tracking.timeWindow")}</p>
                  <p className="font-medium mt-1">
                    {new Date(data.timeWindowStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" – "}
                    {new Date(data.timeWindowEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              )}
              {data.estimatedArrival && !isFailed && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">{t("tracking.eta")}</p>
                  <p className="font-medium mt-1">
                    {new Date(data.estimatedArrival).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              )}
              {data.vehicleName && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">{t("tracking.vehicle")}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {data.vehicleType === "electric" ? (
                      <Zap className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Fuel className="h-4 w-4 text-amber-500" />
                    )}
                    <p className="font-medium">{data.vehicleName}</p>
                    {data.vehicleType === "electric" && (
                      <span className="text-xs bg-emerald-500/10 text-emerald-500 px-2 py-0.5 rounded-full font-semibold">EV</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-card-border overflow-hidden shadow-lg h-[300px]">
            <MapContainer
              center={[data.latitude, data.longitude]}
              zoom={14}
              className="w-full h-full z-0"
              zoomControl={false}
              dragging={true}
              scrollWheelZoom={true}
            >
              <ZoomControl position="bottomright" />
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
              />
              <Marker position={[data.latitude, data.longitude]} icon={createDestinationIcon()} />
            </MapContainer>
          </div>
        </div>

        {data.timeline && data.timeline.length > 0 && (
          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-lg">
            <h3 className="font-bold text-lg flex items-center gap-2 mb-4">
              <Activity className="h-5 w-5 text-primary" />
              {t("tracking.timeline")}
            </h3>
            <div className="space-y-3">
              {data.timeline.map((event, i) => (
                <div key={event.id} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${timelineColor(event.type)}`}>
                      <TimelineIcon type={event.type} />
                    </div>
                    {i < data.timeline!.length - 1 && <div className="w-0.5 h-6 bg-border mt-1" />}
                  </div>
                  <div className="flex-1 pt-1">
                    <p className="font-medium text-sm">{t(`tracking.event.${event.type}`)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(event.sentAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.status === "delivered" && data.proofs && data.proofs.length > 0 && (
          <div className="bg-card rounded-2xl border border-card-border p-6 shadow-lg">
            <ProofDisplay proofs={data.proofs} />
          </div>
        )}

        <div className="text-center text-xs text-muted-foreground pb-8">
          {t("tracking.poweredBy")} &middot; {t("tracking.updatesAutomatically")}
        </div>
      </div>
    </div>
  );
}
