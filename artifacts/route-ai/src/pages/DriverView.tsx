import { AppLayout } from "@/components/layout/AppLayout";
import { useRoutes } from "@/hooks/use-routes";
import { useVehiclePositions } from "@/hooks/use-tracking";
import { useAuth } from "@/lib/auth-context";
import { ORG_ID } from "@/lib/constants";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MapPin, Navigation, Clock, Package, CheckCircle2, XCircle, SkipForward, Truck, Phone, Smile, Settings, Save, FileCheck, ChevronDown } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";
import { ProofOfDelivery } from "@/components/pod/ProofOfDelivery";
import { fetchRouteGeometry } from "@/lib/osrm";

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

interface DriverPreferences {
  id: string;
  driverId: string;
  preferredStartTime: string | null;
  preferredEndTime: string | null;
  maxDrivingHoursPerDay: number;
  breakFrequencyMinutes: number;
  preferredBreakDurationMin: number;
  avoidNightDriving: boolean;
  happinessScore: number;
}

interface Vehicle {
  id: string;
  name: string;
  licensePlate: string;
  type: string;
}

export default function DriverView() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: routes } = useRoutes();
  const { data: positions } = useVehiclePositions();
  const queryClient = useQueryClient();
  const [updatingStop, setUpdatingStop] = useState<string | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefsForm, setPrefsForm] = useState<Partial<DriverPreferences>>({});
  const [podStopId, setPodStopId] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [routeStops, setRouteStops] = useState<Stop[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<[number, number][]>([]);
  const [showRouteSelector, setShowRouteSelector] = useState(false);

  const driverId = user?.driverId;

  const { data: vehicles } = useQuery<Vehicle[]>({
    queryKey: ["vehicles", ORG_ID],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/vehicles?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: prefs } = useQuery<DriverPreferences>({
    queryKey: ["/api/drivers", driverId, "preferences"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/drivers/${driverId}/preferences?organizationId=${ORG_ID}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!driverId,
  });

  const savePrefsMutation = useMutation({
    mutationFn: async (data: Partial<DriverPreferences>) => {
      const res = await fetch(`${API_BASE}/api/drivers/${driverId}/preferences?organizationId=${ORG_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drivers", driverId, "preferences"] });
      setPrefsForm({});
    },
  });

  const currentPrefs = { ...prefs, ...prefsForm };
  const happinessPercent = prefs ? Math.round(prefs.happinessScore * 100) : 50;
  const happinessColor = happinessPercent >= 70 ? "#10b981" : happinessPercent >= 40 ? "#f59e0b" : "#ef4444";

  const activeRoutes = (routes || []).filter(
    (r) => r.status === "in_progress" || r.status === "optimized"
  );

  const vehicleMap = new Map((vehicles || []).map(v => [v.id, v]));

  const routesWithVehicle = activeRoutes.map(r => ({
    ...r,
    vehicle: vehicleMap.get(r.vehicleId || "") || null,
  }));

  useEffect(() => {
    if (!selectedRouteId && activeRoutes.length > 0) {
      setSelectedRouteId(activeRoutes[0].id);
    }
  }, [activeRoutes, selectedRouteId]);

  const currentRoute = activeRoutes.find(r => r.id === selectedRouteId) || null;
  const currentVehicle = currentRoute ? vehicleMap.get(currentRoute.vehicleId || "") : null;

  const fetchStops = useCallback(async (routeId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/routes/${routeId}/stops?organizationId=${ORG_ID}`);
      const data = await res.json();
      setRouteStops(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (selectedRouteId) {
      setRouteStops([]);
      setRouteGeometry([]);
      fetchStops(selectedRouteId);
    }
  }, [selectedRouteId, fetchStops]);

  useEffect(() => {
    if (routeStops.length < 2) {
      setRouteGeometry([]);
      return;
    }

    const sorted = [...routeStops].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
    const waypoints: [number, number][] = sorted.map(s => [s.latitude, s.longitude]);

    fetchRouteGeometry(waypoints).then(setRouteGeometry);
  }, [routeStops]);

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
            {routeGeometry.length > 1 && (
              <Polyline
                positions={routeGeometry}
                color="#3b82f6"
                weight={4}
                opacity={0.7}
                smoothFactor={1}
              />
            )}
          </MapContainer>

          {currentRoute && (
            <div className="absolute top-3 left-3 right-3 z-[1000]">
              <div className="bg-background/90 backdrop-blur-md rounded-xl p-3 border border-border shadow-lg">
                <button
                  onClick={() => setShowRouteSelector(!showRouteSelector)}
                  className="w-full flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <Truck className="h-4 w-4 text-primary" />
                    <div className="text-left">
                      <span className="font-bold text-sm block">{currentRoute.name}</span>
                      {currentVehicle && (
                        <span className="text-xs text-muted-foreground">
                          {currentVehicle.name} • {currentVehicle.licensePlate}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {driverId && (
                      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: `${happinessColor}20`, color: happinessColor }}>
                        <Smile className="h-3 w-3" />
                        {happinessPercent}%
                      </div>
                    )}
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      {completedCount}/{totalCount}
                    </span>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", showRouteSelector && "rotate-180")} />
                  </div>
                </button>
              </div>

              {showRouteSelector && routesWithVehicle.length > 1 && (
                <div className="mt-1 bg-background/95 backdrop-blur-md rounded-xl border border-border shadow-lg overflow-hidden">
                  {routesWithVehicle.map(r => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setSelectedRouteId(r.id);
                        setShowRouteSelector(false);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors border-b border-border last:border-0",
                        r.id === selectedRouteId && "bg-primary/5"
                      )}
                    >
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                        r.id === selectedRouteId ? "bg-primary text-white" : "bg-muted text-muted-foreground"
                      )}>
                        <Truck className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{r.name}</p>
                        {r.vehicle && (
                          <p className="text-xs text-muted-foreground truncate">
                            {r.vehicle.name} • {r.vehicle.licensePlate}
                          </p>
                        )}
                      </div>
                      {r.id === selectedRouteId && (
                        <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 lg:w-96 lg:flex-none overflow-y-auto bg-background">
          {driverId && (
            <div className="p-4 pb-0">
              <button
                onClick={() => setShowPrefs(!showPrefs)}
                className="w-full flex items-center justify-between p-3 rounded-xl border border-border bg-card hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{t("preferences.title")}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 text-xs font-medium" style={{ color: happinessColor }}>
                    <Smile className="h-3.5 w-3.5" />
                    {happinessPercent}%
                  </div>
                </div>
              </button>

              {showPrefs && prefs && (
                <div className="mt-2 p-3 rounded-xl border border-border bg-card space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-muted-foreground">{t("preferences.preferredStartTime")}</label>
                      <input
                        type="time"
                        className="w-full mt-1 px-2 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm"
                        value={(currentPrefs.preferredStartTime ?? "07:00").substring(0, 5)}
                        onChange={(e) => setPrefsForm({ ...prefsForm, preferredStartTime: e.target.value + ":00" })}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground">{t("preferences.preferredEndTime")}</label>
                      <input
                        type="time"
                        className="w-full mt-1 px-2 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm"
                        value={(currentPrefs.preferredEndTime ?? "16:00").substring(0, 5)}
                        onChange={(e) => setPrefsForm({ ...prefsForm, preferredEndTime: e.target.value + ":00" })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">{t("preferences.maxDrivingHours")}</label>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      step={0.5}
                      className="w-full mt-1 px-2 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm"
                      value={currentPrefs.maxDrivingHoursPerDay ?? 8}
                      onChange={(e) => setPrefsForm({ ...prefsForm, maxDrivingHoursPerDay: parseFloat(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={currentPrefs.avoidNightDriving ?? false}
                      onChange={(e) => setPrefsForm({ ...prefsForm, avoidNightDriving: e.target.checked })}
                    />
                    <span className="text-sm text-muted-foreground">{t("preferences.avoidNightDriving")}</span>
                  </div>
                  <button
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                    disabled={Object.keys(prefsForm).length === 0 || savePrefsMutation.isPending}
                    onClick={() => savePrefsMutation.mutate(prefsForm as Partial<DriverPreferences>)}
                  >
                    <Save className="h-4 w-4" />
                    {savePrefsMutation.isPending ? t("common.saving") : t("common.save")}
                  </button>
                </div>
              )}
            </div>
          )}

          {!currentRoute ? (
            <div className="flex items-center justify-center h-full p-8 text-center">
              <div>
                <Truck className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
                <h2 className="font-bold text-lg mb-1">{t("driverView.noActiveRoute")}</h2>
                <p className="text-sm text-muted-foreground">{t("driverView.noRoutesAssigned")}</p>
              </div>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              {nextStop && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Navigation className="h-5 w-5 text-primary" />
                    <span className="text-xs font-bold uppercase tracking-wider text-primary">
                      {t("common.stop")} {sortedStops.indexOf(nextStop) + 1} {t("driverView.of")} {totalCount}
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

                  <div className="grid grid-cols-4 gap-2">
                    <button
                      onClick={() => setPodStopId(nextStop.id)}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-primary text-white font-bold text-xs active:scale-95 transition-transform"
                    >
                      <FileCheck className="h-6 w-6" />
                      {t("pod.title")}
                    </button>
                    <button
                      onClick={() => updateStopStatus(nextStop.id, "completed")}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-emerald-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-6 w-6" />
                      {t("driverView.delivered")}
                    </button>
                    <button
                      onClick={() => updateStopStatus(nextStop.id, "failed")}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-red-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <XCircle className="h-6 w-6" />
                      {t("driverView.failed")}
                    </button>
                    <button
                      onClick={() => updateStopStatus(nextStop.id, "skipped")}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-amber-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <SkipForward className="h-6 w-6" />
                      {t("driverView.skip")}
                    </button>
                  </div>

                  {podStopId === nextStop.id && (
                    <div className="mt-3">
                      <ProofOfDelivery
                        stopId={nextStop.id}
                        onClose={() => setPodStopId(null)}
                        onComplete={() => setPodStopId(null)}
                      />
                    </div>
                  )}
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
                  <h3 className="font-bold text-lg">{t("driverView.routeCompleted")}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("driverView.allDeliveriesDone", { count: totalCount })}
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
