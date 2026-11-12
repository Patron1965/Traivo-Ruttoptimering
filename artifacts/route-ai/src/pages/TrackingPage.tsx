import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Package, MapPin, Clock } from "lucide-react";
import { MapContainer, TileLayer, Marker, ZoomControl, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { destinationCoordinates, publicTrackingPolicy, type PublicDelivery } from "@/lib/customer-links";

export const destinationIcon = L.divIcon({
  className: "",
  html: '<div style="width:24px;height:24px;background:#0891b2;border:3px solid white;border-radius:50%;box-shadow:0 2px 6px #0004"></div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});
export const vehicleIcon = L.divIcon({
  className: "",
  html: '<div data-testid="marker-delivery-vehicle" style="width:32px;height:32px;background:#1e3a8a;border:3px solid white;border-radius:8px;box-shadow:0 2px 6px #0004;display:grid;place-items:center;color:white;font-size:22px">●</div>',
  iconSize: [32, 32], iconAnchor: [16, 16],
});
export function FitDeliveryMap({ destination, vehicle }: { destination: [number, number]; vehicle: [number, number] | null }) {
  const map = useMap();
  const [lat, lng] = destination;
  const vehicleLat = vehicle?.[0], vehicleLng = vehicle?.[1];
  useEffect(() => {
    if (vehicleLat !== undefined && vehicleLng !== undefined) map.fitBounds([[lat, lng], [vehicleLat, vehicleLng]], { padding: [40, 40], maxZoom: 15, animate: false });
    else map.setView([lat, lng], 14, { animate: false });
  }, [map, lat, lng, vehicleLat, vehicleLng]);
  return null;
}

export default function TrackingPage({ code }: { code: string }) {
  return <Delivery key={code} code={code} />;
}

function Delivery({ code }: { code: string }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<PublicDelivery | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [online, setOnline] = useState(() => navigator.onLine);
  const tracking = publicTrackingPolicy(data, now, online);
  useEffect(() => {
    const refreshClock = () => setNow(Date.now());
    const wentOffline = () => { setOnline(false); setData(null); setState("error"); refreshClock(); };
    const wentOnline = () => { setOnline(true); setAttempt(value => value + 1); refreshClock(); };
    window.addEventListener("offline", wentOffline);
    window.addEventListener("online", wentOnline);
    window.addEventListener("focus", refreshClock);
    document.addEventListener("visibilitychange", refreshClock);
    return () => {
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("focus", refreshClock);
      document.removeEventListener("visibilitychange", refreshClock);
    };
  }, []);
  useEffect(() => {
    if (tracking.deadline === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, tracking.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [tracking.deadline, now]);
  useEffect(() => {
    let controller = new AbortController();
    let alive = true;
    let requestVersion = 0;
    async function load() {
      const version = ++requestVersion;
      controller.abort();
      controller = new AbortController();
      if (!navigator.onLine) { setData(null); setState("error"); return; }
      try {
        const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/track/${encodeURIComponent(code)}`, {
          credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
        });
        if (!response.ok) {
          if (alive && version === requestVersion) { setData(null); setState([400, 401, 403, 404, 410].includes(response.status) ? "invalid" : "error"); }
          return;
        }
        const delivery: PublicDelivery = await response.json();
        if (alive && version === requestVersion && navigator.onLine) { setNow(Date.now()); setData(delivery); setState("ready"); }
      } catch {
        if (alive && version === requestVersion) { setData(null); setState("error"); }
      }
    }
    setData(null);
    setState("loading");
    void load();
    const timer = setInterval(() => void load(), 30_000);
    const abortOffline = () => { ++requestVersion; controller.abort(); };
    window.addEventListener("offline", abortOffline);
    return () => { alive = false; controller.abort(); clearInterval(timer); window.removeEventListener("offline", abortOffline); };
  }, [code, attempt]);
  const formatTime = (value: string | null) => {
    if (!value || !Number.isFinite(Date.parse(value))) return "—";
    return new Date(value).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Stockholm" });
  };
  const destination = data ? destinationCoordinates(data.latitude, data.longitude) : null;
  // Fixed neutral palette: never inherit a signed-in organization's private theme.
  return <main className="min-h-screen bg-slate-50 text-slate-900 px-5 py-12">
    <div className="mx-auto max-w-lg">
      <header className="mb-8 flex items-center gap-3"><div className="rounded-xl bg-cyan-600 p-3 text-white"><Package className="h-6 w-6" /></div><h1 className="text-xl font-semibold">{t("customerLinks.deliveryTitle")}</h1></header>
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-live="polite">
        {state === "loading" && <p role="status">{t("customerLinks.loading")}</p>}
        {state === "invalid" && <p data-testid="status-tracking-invalid">{t("customerLinks.invalid")}</p>}
        {state === "error" && <div><p role="alert" data-testid="status-tracking-error">{t(online ? "customerLinks.publicError" : "customerLinks.tracking_offline")}</p><button className="mt-4 min-h-11 rounded-lg bg-cyan-700 px-4 py-2 text-white" data-testid="button-tracking-retry" onClick={() => setAttempt(value => value + 1)}>{t("customerLinks.retry")}</button></div>}
        {state === "ready" && data && <div className="space-y-6">
          <p className="text-lg font-semibold" data-testid="status-delivery">{t(`customerLinks.delivery_${data.status}`)}</p>
          <div className="flex gap-3"><MapPin className="h-5 w-5 shrink-0 text-cyan-700" /><p data-testid="text-delivery-address">{data.address}</p></div>
          <div className="space-y-2">
            <p data-testid="status-delivery-tracking">{t(`customerLinks.tracking_${tracking.state}`)}</p>
            <p className="text-sm text-slate-600" data-testid="text-position-updated">{t("customerLinks.positionUpdated")}: {tracking.lastUpdatedAt ? formatTime(tracking.lastUpdatedAt) : t("customerLinks.noPositionTime")}</p>
          </div>
          {destination && <div className="h-64 overflow-hidden rounded-xl border border-slate-200" data-testid="map-delivery-destination">
            <MapContainer key={destination.join(",")} center={destination} zoom={14} zoomControl={false} scrollWheelZoom={false} style={{ height: "100%", width: "100%" }}>
              <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" referrerPolicy="strict-origin" />
              <Marker position={destination} icon={destinationIcon} />
              {tracking.position && <Marker position={tracking.position} icon={vehicleIcon} title={t("customerLinks.vehiclePosition")} />}
              <FitDeliveryMap destination={destination} vehicle={tracking.position} />
              <ZoomControl position="bottomright" />
            </MapContainer>
          </div>}
          {destination && <p className="text-xs text-slate-600" data-testid="text-map-legend">{t("customerLinks.mapLegend")}</p>}
          <div className="space-y-3">
            <div><p className="text-sm text-slate-500">{t("customerLinks.plannedArrival")}</p><p data-testid="text-planned-arrival">{data.arrival?.plannedAt ? formatTime(data.arrival.plannedAt) : t("customerLinks.noPlannedArrival")}</p></div>
            <div><p className="text-sm text-slate-500">{t("customerLinks.roadArrival")}</p><p data-testid="text-road-arrival">{tracking.estimatedAt ? formatTime(tracking.estimatedAt) : t("customerLinks.noRoadArrival")}</p><p className="mt-1 text-xs text-slate-500">{t("customerLinks.roadDisclaimer")}</p></div>
            <p className="text-xs text-slate-500">{t("customerLinks.stockholmTime")}</p>
          </div>
          <div className="flex gap-3"><Clock className="h-5 w-5 shrink-0 text-cyan-700" /><div><p className="text-sm text-slate-500">{t("customerLinks.window")}</p><p data-testid="text-delivery-window">{data.timeWindowStart || data.timeWindowEnd ? `${formatTime(data.timeWindowStart)} – ${formatTime(data.timeWindowEnd)}` : t("customerLinks.noWindow")}</p></div></div>
        </div>}
      </section>
      <p className="mt-6 text-center text-xs text-slate-500">Traivo</p>
    </div>
  </main>;
}