import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { useRoutes } from "@/hooks/use-routes";
import { useVehiclePositions } from "@/hooks/use-tracking";
import { useAuth } from "@/lib/auth-context";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MapPin, Navigation, Clock, Package, CheckCircle2, XCircle, SkipForward, Truck, Phone, Smile, Settings, Save, FileCheck, ChevronDown } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";
import { ProofOfDelivery } from "@/components/pod/ProofOfDelivery";
import { fetchRouteGeometry } from "@/lib/osrm";
import { MapRouteLine } from "@/components/map/MapRouteLine";
import { getRouteColor, sortStopsBySequence, getValidCoordinates, isValidCoordinate } from "@/lib/map-utils";
import { buildDriverExecutionRequest, type DriverExecutionStatus } from "@/lib/driver-execution-request";
import { useToast } from "@/hooks/use-toast";
import { localizeError } from "@/lib/localize-error";

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
  notes?: string | null;
  serviceInstructions?: string | null;
}

type DriverPlanningObjective = "balanced" | "shortest" | "geographic" | "areas_worktime" | "minimize_vehicles";

interface DriverPlanningSummary {
  complete?: boolean;
  objective?: DriverPlanningObjective;
  travelReservePercent?: number;
  stopReserveMin?: number;
  mandatoryUnplannedStopIds?: string[];
}

interface DriverRouteSurface {
  customerReference?: string | null;
  sharedInstructions?: string | null;
  planningSummary?: DriverPlanningSummary | null;
  optimizationPlanningSnapshot?: {
    objective?: DriverPlanningObjective;
    travelReservePercent?: number;
    stopReserveMin?: number;
  } | null;
  workdaySummary?: unknown;
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

function DriverPlanningCard({ route, isSv }: { route: DriverRouteSurface; isSv: boolean }) {
  const summary = route.planningSummary;
  const snapshot = route.optimizationPlanningSnapshot;
  const workdaySummary = route.workdaySummary as {
    travelReserveMin?: number | null;
    stopReserveMin?: number | null;
  } | null | undefined;
  const travelReserveMin = workdaySummary?.travelReserveMin;
  const totalStopReserveMin = workdaySummary?.stopReserveMin;
  const hasTravelReserveMinutes = typeof travelReserveMin === "number";
  const hasStopReserveMinutes = typeof totalStopReserveMin === "number";
  const hasReserveSummary = Boolean(summary || snapshot || hasTravelReserveMinutes || hasStopReserveMinutes);
  const hasReference = Boolean(route.customerReference?.trim());
  const hasInstructions = Boolean(route.sharedInstructions?.trim());

  if (!hasReference && !hasInstructions && !hasReserveSummary) {
    return null;
  }

  const objective = summary?.objective ?? snapshot?.objective;
  const objectiveLabel = objective
    ? ({
        balanced: isSv ? "Balanserad arbetstid" : "Balanced working time",
        shortest: isSv ? "Kortast körsträcka" : "Shortest driving distance",
        geographic: isSv ? "Geografisk sammanhållning" : "Geographic cohesion",
        areas_worktime: isSv ? "Sammanhållna områden och arbetstid" : "Cohesive areas and working time",
        minimize_vehicles: isSv ? "Färre fordon" : "Fewer vehicles",
      } as const)[objective]
    : null;
  const travelReservePercent = summary?.travelReservePercent ?? snapshot?.travelReservePercent;
  const stopReserveMin = summary?.stopReserveMin ?? snapshot?.stopReserveMin;
  const mandatoryUnplannedCount = summary?.mandatoryUnplannedStopIds?.length ?? 0;

  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3" data-testid="driver-planning-details">
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold">{isSv ? "Planeringsunderlag" : "Planning details"}</h3>
      </div>

      {hasReference && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{isSv ? "Kundreferens" : "Customer reference"}</p>
          <p className="text-sm font-semibold">{route.customerReference}</p>
        </div>
      )}

      {hasInstructions && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="text-xs font-semibold text-primary">
            {isSv ? "Gemensamma chaufförsinstruktioner" : "Shared driver instructions"}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{route.sharedInstructions}</p>
        </div>
      )}

      {hasReserveSummary && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">
            {isSv ? "Reservtid och mål" : "Planning reserve and objective"}
          </p>
          {objectiveLabel && (
            <p className="text-sm">
              <span className="font-medium">{isSv ? "Mål: " : "Objective: "}</span>
              {objectiveLabel}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {typeof travelReservePercent === "number" && (
              <div className="rounded-lg border border-border bg-background p-2">
                <p className="text-xs text-muted-foreground">{isSv ? "Körreserv" : "Travel reserve"}</p>
                <p className="text-sm font-semibold">+{travelReservePercent}%</p>
                {hasTravelReserveMinutes && (
                  <p className="text-xs text-muted-foreground">
                    {travelReserveMin} {isSv ? "min totalt" : "min total"}
                  </p>
                )}
              </div>
            )}
            {typeof stopReserveMin === "number" && (
              <div className="rounded-lg border border-border bg-background p-2">
                <p className="text-xs text-muted-foreground">{isSv ? "Stoppreserv" : "Stop reserve"}</p>
                <p className="text-sm font-semibold">
                  +{stopReserveMin} {isSv ? "min/stopp" : "min/stop"}
                </p>
                {hasStopReserveMinutes && (
                  <p className="text-xs text-muted-foreground">
                    {totalStopReserveMin} {isSv ? "min totalt" : "min total"}
                  </p>
                )}
              </div>
            )}
          </div>
          {mandatoryUnplannedCount > 0 && (
            <p className="text-xs font-semibold text-destructive">
              {isSv
                ? `${mandatoryUnplannedCount} obligatoriskt stopp kunde inte planeras.`
                : `${mandatoryUnplannedCount} mandatory stop${mandatoryUnplannedCount === 1 ? "" : "s"} could not be planned.`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default function DriverView() {
  const { t, i18n } = useTranslation();
  const isSv = i18n.language.startsWith("sv");
  const { toast } = useToast();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { data: routes, refetch: refetchRoutes } = useRoutes();
  const { data: positions } = useVehiclePositions();
  const queryClient = useQueryClient();
  const [updatingStop, setUpdatingStop] = useState<string | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefsForm, setPrefsForm] = useState<Partial<DriverPreferences>>({});
  const [podStopId, setPodStopId] = useState<string | null>(null);
  const [skipStopId, setSkipStopId] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState("CUSTOMER_UNAVAILABLE");
  const [skipComment, setSkipComment] = useState("");
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [routeStops, setRouteStops] = useState<Stop[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<[number, number][]>([]);
  const [isFallbackGeometry, setIsFallbackGeometry] = useState(false);
  const [showRouteSelector, setShowRouteSelector] = useState(false);
  const [routeActionBusy, setRouteActionBusy] = useState(false);

  const driverId = user?.driverProfileId;

  const { data: vehicles } = useQuery<Vehicle[]>({
    queryKey: ["vehicles", organizationId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/vehicles?organizationId=${organizationId}`);
       if (!res.ok) {
         const error = new Error("Failed");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    enabled: !!organizationId,
  });

  const { data: prefs } = useQuery<DriverPreferences>({
    queryKey: ["/api/drivers", organizationId, driverId, "preferences"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/drivers/${driverId}/preferences?organizationId=${organizationId}`);
       if (!res.ok) {
         const error = new Error("Failed");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    enabled: !!driverId && !!organizationId,
  });

  const savePrefsMutation = useMutation({
    mutationFn: async (data: Partial<DriverPreferences>) => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const res = await fetch(`${API_BASE}/api/drivers/${driverId}/preferences?organizationId=${organizationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
       if (!res.ok) {
         const error = new Error("Failed");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/drivers", organizationId, driverId, "preferences"] });
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
  const canReport = currentRoute?.handoffStatus === "accepted" && currentRoute.handoffVersion != null;
  const currentVehicle = currentRoute ? vehicleMap.get(currentRoute.vehicleId || "") : null;

  const fetchStops = useCallback(async (routeId: string) => {
    try {
      if (!organizationId) return;
      const res = await fetch(`${API_BASE}/api/routes/${routeId}/stops?organizationId=${organizationId}`);
      if (!res.ok) throw new Error("Kunde inte läsa stopp");
      const data = await res.json();
      setRouteStops(data);
    } catch {}
  }, [organizationId]);

  useEffect(() => {
    if (selectedRouteId) {
      setRouteStops([]);
      setRouteGeometry([]);
      fetchStops(selectedRouteId);
    }
  }, [selectedRouteId, currentRoute?.planRevision, fetchStops]);

  useEffect(() => {
    if (!selectedRouteId) return;
    const timer = setInterval(() => void fetchStops(selectedRouteId), 15000);
    return () => clearInterval(timer);
  }, [selectedRouteId, fetchStops]);

  useEffect(() => {
    setRouteGeometry([]);
    setIsFallbackGeometry(false);
    if (routeStops.length < 2) {
      return;
    }

    const validCoords = getValidCoordinates(routeStops);
    if (validCoords.length < 2) return;

    let cancelled = false;
    fetchRouteGeometry(validCoords).then(res => {
      if (!cancelled) {
        setRouteGeometry(res.coordinates);
        setIsFallbackGeometry(res.isFallback);
      }
    });
    return () => { cancelled = true; };
  }, [routeStops]);

  const sortedStops = sortStopsBySequence(routeStops);
  const validMapStops = sortedStops.filter((stop) => isValidCoordinate(stop.latitude, stop.longitude));
  const activeStopId = currentRoute?.executionProjection?.activeStopId;
  const nextStop = sortedStops.find(s => s.id === activeStopId && (s.status === "pending" || s.status === "in_progress"))
    ?? sortedStops.find((s) => s.status === "pending" || s.status === "in_progress");
  const completedCount = sortedStops.filter((s) => s.status === "completed").length;
  const totalCount = sortedStops.length;

  const currentPosition = positions?.find((p: any) => p.routeId === currentRoute?.id);

  async function postDriverAction(path: string, body: object) {
    const response = await fetch(`${API_BASE}/api${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.error || "Åtgärden kunde inte utföras"), { status: response.status, code: payload.code });
    }
  }

  async function routeAction(stopId?: string) {
    if (!currentRoute || routeActionBusy) return;
    setRouteActionBusy(true);
    try {
      if (stopId) {
        await postDriverAction(`/stops/${encodeURIComponent(stopId)}/execution-events`, {
          type: "select_next", planVersion: currentRoute.handoffVersion,
          expectedSelectionRevision: currentRoute.executionProjection?.selectionRevision,
          clientEventId: crypto.randomUUID(), occurredAt: new Date().toISOString(),
        });
      } else {
        const stages = ["sent", "received", "opened", "accepted"] as const;
        const stage = stages.indexOf(currentRoute.handoffStatus as typeof stages[number]);
        if (stage < 0) throw new Error("Rutten måste skickas på nytt av trafikledningen");
        for (const status of stages.slice(stage + 1)) {
          await postDriverAction(`/routes/${currentRoute.id}/handoff`, {
            status, version: currentRoute.handoffVersion,
          });
        }
      }
    } catch (error) {
      toast({ title: t("common.error"), description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
    } finally {
      // A lost response must be reconciled, never automatically replayed.
      await Promise.all([refetchRoutes(), fetchStops(currentRoute.id)]);
      setRouteActionBusy(false);
    }
  }

  async function updateStopStatus(
    stopId: string,
    status: DriverExecutionStatus,
    details: { skipReason?: string; comment?: string } = {},
  ) {
    setUpdatingStop(stopId);
    try {
      if (!organizationId || !currentRoute || !canReport) {
        throw new Error("Aktiv rutt saknas");
      }
      const executionResponse = await fetch(`${API_BASE}/api/routes/${currentRoute.id}/execution`, { credentials: "include" });
      if (!executionResponse.ok) throw Object.assign(new Error("Kunde inte kontrollera rutten"), { status: executionResponse.status });
      const execution = await executionResponse.json();
      if (execution?.status !== "active") {
        await postDriverAction(`/routes/${currentRoute.id}/execution/start`, {
          clientEventId: `work-start:${currentRoute.id}:${currentRoute.handoffVersion}`,
        });
      }
      const request = buildDriverExecutionRequest({
        apiBase: API_BASE,
        stopId,
        status,
        planVersion: currentRoute.handoffVersion!,
        clientEventId: `${stopId}_web_${status}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        occurredAt: new Date().toISOString(),
        details,
      });
      const response = await fetch(request.url, request.init);
       if (!response.ok) {
         const body = await response.text();
         const error = new Error(body || "Failed");
         Object.assign(error, { status: response.status });
         throw error;
       }
      await fetchStops(currentRoute.id);
      await queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }),
        variant: "destructive",
      });
    } finally {
      setUpdatingStop(null);
    }
  }

  const mapCenter = nextStop && isValidCoordinate(nextStop.latitude, nextStop.longitude)
    ? [nextStop.latitude, nextStop.longitude] as [number, number]
    : validMapStops.length > 0
      ? [validMapStops[0].latitude, validMapStops[0].longitude] as [number, number]
    : [59.3293, 18.0686] as [number, number];

  return (
    <AppLayout>
      <div className="flex flex-col h-full max-w-lg mx-auto lg:max-w-none lg:flex-row">
        {/* Keep Leaflet panes and route controls below the app's navigation tooltips. */}
        <div className="h-48 lg:h-full lg:flex-1 relative isolate z-0">
          <MapContainer
            center={mapCenter}
            zoom={13}
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {validMapStops.map((stop, idx) => (
              <Marker
                key={stop.id}
                position={[stop.latitude, stop.longitude]}
                icon={createStopIcon(stop.sequenceOrder ?? idx + 1, stop.status)}
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
              <MapRouteLine
                positions={routeGeometry}
                color={getRouteColor(currentRoute?.status)}
                weight={5}
                isFallback={isFallbackGeometry}
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
              <DriverPlanningCard route={currentRoute} isSv={isSv} />
              {!canReport && <div className="rounded-xl border border-border p-3 space-y-2">
                <p>{isSv ? "Kvittera den utskickade rutten innan du rapporterar. Godkännande hos trafikledaren är inte samma sak som utskick." : "Accept the dispatched route before reporting. Planner approval is not dispatch."}</p>
                {currentRoute.handoffVersion != null && ["sent", "received", "opened"].includes(currentRoute.handoffStatus) &&
                  <Button disabled={routeActionBusy} onClick={() => void routeAction()}>
                    {isSv ? "Kvittera rutt" : "Accept route"}
                  </Button>}
              </div>}
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

                  <fieldset disabled={!canReport || routeActionBusy || !!updatingStop} className="grid grid-cols-4 gap-2 disabled:opacity-50">
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
                      onClick={() => {
                        setSkipStopId(nextStop.id);
                        setSkipReason("CUSTOMER_UNAVAILABLE");
                        setSkipComment("");
                      }}
                      disabled={updatingStop === nextStop.id}
                      className="flex flex-col items-center gap-1 py-3 px-2 rounded-xl bg-amber-500 text-white font-bold text-xs active:scale-95 transition-transform disabled:opacity-50"
                    >
                      <SkipForward className="h-6 w-6" />
                      {t("driverView.skip")}
                    </button>
                  </fieldset>

                  {skipStopId === nextStop.id && (
                    <div className="mt-3 space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                      <label className="block text-xs font-semibold">
                        Orsak
                        <select
                          value={skipReason}
                          onChange={(event) => setSkipReason(event.target.value)}
                          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        >
                          <option value="CUSTOMER_UNAVAILABLE">Kunden ej tillgänglig</option>
                          <option value="ACCESS_BLOCKED">Åtkomst blockerad</option>
                          <option value="ADDRESS_NOT_FOUND">Adressen hittades inte</option>
                          <option value="VEHICLE_OR_SAFETY">Fordon eller säkerhet</option>
                          <option value="OTHER">Annan orsak</option>
                        </select>
                      </label>
                      <label className="block text-xs font-semibold">
                        Kommentar (valfri)
                        <textarea
                          value={skipComment}
                          onChange={(event) => setSkipComment(event.target.value)}
                          className="mt-1 min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        />
                      </label>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setSkipStopId(null)}
                          className="rounded-lg border border-border px-3 py-2 text-sm"
                        >
                          Avbryt
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await updateStopStatus(nextStop.id, "skipped", {
                              skipReason,
                              comment: skipComment.trim() || undefined,
                            });
                            setSkipStopId(null);
                          }}
                          className="rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white"
                        >
                          Hoppa över
                        </button>
                      </div>
                    </div>
                  )}

                  {podStopId === nextStop.id && (
                    <div className="mt-3">
                      <ProofOfDelivery
                        stopId={nextStop.id}
                        planVersion={currentRoute?.handoffVersion ?? 0}
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
                        {stop.notes && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-semibold">
                              {isSv ? "Stoppnotis: " : "Stop note: "}
                            </span>
                            {stop.notes}
                          </p>
                        )}
                        {stop.serviceInstructions && stop.serviceInstructions !== stop.notes && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <span className="font-semibold">
                              {isSv ? "Stoppspecifik instruktion: " : "Stop-specific instruction: "}
                            </span>
                            {stop.serviceInstructions}
                          </p>
                        )}
                      </div>
                      {isNext && <MapPin className="h-4 w-4 text-primary animate-bounce shrink-0" />}
                      {!isNext && stop.status === "pending" && <Button size="sm" variant="outline"
                        disabled={!canReport || routeActionBusy || !!updatingStop || !currentRoute.executionProjection?.selectionRevision}
                        onClick={() => void routeAction(stop.id)}>
                        {isSv ? "Ta detta stopp nu" : "Take this stop now"}
                      </Button>}
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
