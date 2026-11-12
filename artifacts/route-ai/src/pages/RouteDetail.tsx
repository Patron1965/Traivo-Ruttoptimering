import { useEffect, useState, useMemo, useCallback } from "react";
import { useRoute, useRouteStops, useUpdateRoute } from "@/hooks/use-routes";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { useUpdateStop } from "@/hooks/use-stops";
import { AppLayout } from "@/components/layout/AppLayout";
import { Coffee, Zap, Navigation } from "lucide-react";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { sv, enUS } from "date-fns/locale";
import { ROUTE_COLORS, DEPOT_LOCATION } from "@/lib/constants";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { MapContainer, TileLayer, Marker, Popup, ZoomControl } from "react-leaflet";
import L from "leaflet";
import { renderToString } from "react-dom/server";
import { fetchRouteGeometry } from "@/lib/osrm";
import { getRouteColor, sortStopsBySequence, getValidCoordinates, isValidCoordinate } from "@/lib/map-utils";
import { MapRouteLine } from "@/components/map/MapRouteLine";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { useToast } from "@/hooks/use-toast";
import { localizeError } from "@/lib/localize-error";
import {
  ArrowLeft,
  MapPin,
  Clock,
  Gauge,
  Leaf,
  Truck,
  User,
  CheckCircle2,
  XCircle,
  SkipForward,
  Package,
  Warehouse,
  GripVertical,
  Save,
  BookTemplate,
  BarChart3,
  RotateCcw,
  FileCheck,
  Bell,
  Mail,
} from "lucide-react";
import { ProofDisplay } from "@/components/pod/ProofDisplay";
import { RoutePlayback } from "@/components/map/RoutePlayback";
import { LockedFirstStopControl } from "@/components/routes/LockedFirstStopControl";
import { RouteAppendImport } from "@/components/routes/RouteAppendImport";
import { RouteDriverAction } from "@/components/dispatch/RouteDriverAction";

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: "bg-muted/50", text: "text-muted-foreground", label: "routes.statusDraft" },
  optimized: { bg: "bg-primary/20", text: "text-primary", label: "routes.statusOptimized" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400", label: "routes.statusInProgress" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400", label: "routes.statusCompleted" },
  cancelled: { bg: "bg-destructive/20", text: "text-destructive", label: "routes.statusCancelled" },
};

const STOP_STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  pending: { bg: "bg-muted/50", text: "text-muted-foreground" },
  in_progress: { bg: "bg-yellow-500/20", text: "text-yellow-400" },
  completed: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  failed: { bg: "bg-destructive/20", text: "text-destructive" },
  skipped: { bg: "bg-orange-500/20", text: "text-orange-400" },
};

function createNumberedIcon(color: string, label: string) {
  const html = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 32, height: 32 }}>
      <div className="absolute inset-0 rounded-full opacity-20" style={{ backgroundColor: color, transform: "scale(1.5)" }} />
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill={color} stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3" fill="white"/>
      </svg>
      <span className="absolute top-[6px] font-bold text-[10px] text-gray-900">{label}</span>
    </div>
  );
  return L.divIcon({ html, className: "custom-leaflet-icon", iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32] });
}

function createDepotIcon() {
  const html = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 32, height: 32 }}>
      <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center border-2 border-primary shadow-lg shadow-primary/40">
        <Warehouse className="w-5 h-5 text-primary" />
      </div>
    </div>
  );
  return L.divIcon({ html, className: "custom-leaflet-icon", iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -32] });
}

interface NotificationEvent {
  id: string;
  type: string;
  message: string | null;
  sentAt: string;
  stopAddress?: string;
}

function NotificationSettingsPanel({ routeId, route, t, toast, queryClient, organizationId }: {
  routeId: string;
  route: { id: string; notifyApproaching?: boolean; notifyDelivered?: boolean; notifyFailed?: boolean };
  t: (key: string) => string;
  toast: (opts: { title: string; description?: string }) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  organizationId: string;
}) {
  const [approaching, setApproaching] = useState(route.notifyApproaching !== false);
  const [delivered, setDelivered] = useState(route.notifyDelivered !== false);
  const [saving, setSaving] = useState(false);

  const updateRoute = useUpdateRoute();

  const save = async (field: string, value: boolean) => {
    setSaving(true);
    try {
      await updateRoute.mutateAsync({ id: routeId, data: { [field]: value } as any });
      queryClient.invalidateQueries({ queryKey: ["/api/routes", routeId] });
      toast({ title: t("routeDetail.notificationsSaved") });
    } finally {
      setSaving(false);
    }
  };

  const { data: notificationHistory = [] } = useQuery<NotificationEvent[]>({
    queryKey: ["route-notifications", organizationId, routeId],
    queryFn: async () => {
      const res = await fetch(`/api/delivery-notifications?routeId=${routeId}&organizationId=${organizationId}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!organizationId,
  });

  const toggles = [
    { key: "notifyApproaching", label: t("routeDetail.notifyApproaching"), desc: t("routeDetail.notifyApproachingDesc"), value: approaching, set: setApproaching, color: "bg-blue-500" },
    { key: "notifyDelivered", label: t("routeDetail.notifyDelivered"), desc: t("routeDetail.notifyDeliveredDesc"), value: delivered, set: setDelivered, color: "bg-emerald-500" },
  ];

  const typeColors: Record<string, string> = {
    approaching: "bg-blue-500/20 text-blue-400",
    delivered: "bg-emerald-500/20 text-emerald-400",
    failed: "bg-red-500/20 text-red-400",
    delayed: "bg-amber-500/20 text-amber-400",
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="p-4 rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 mb-4">
          <Bell className="h-4 w-4 text-primary" />
          <h3 className="font-semibold text-sm">{t("routeDetail.notifications")}</h3>
        </div>
        <div className="space-y-3">
          {toggles.map((tog) => (
            <div key={tog.key} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={cn("w-2 h-2 rounded-full", tog.color)} />
                <div>
                  <p className="text-sm font-medium">{tog.label}</p>
                  <p className="text-xs text-muted-foreground">{tog.desc}</p>
                </div>
              </div>
              <button
                onClick={() => {
                  const newVal = !tog.value;
                  tog.set(newVal);
                  save(tog.key, newVal);
                }}
                disabled={saving}
                className={cn(
                  "relative w-10 h-5 rounded-full transition-colors",
                  tog.value ? "bg-primary" : "bg-muted"
                )}
              >
                <div className={cn(
                  "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform",
                  tog.value ? "translate-x-5" : "translate-x-0.5"
                )} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="p-4 rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="h-4 w-4 text-primary" />
          <h3 className="font-semibold text-sm">{t("routeDetail.notificationHistory")}</h3>
        </div>
        {notificationHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("routeDetail.noNotifications")}</p>
        ) : (
          <div className="space-y-2 max-h-[200px] overflow-y-auto">
            {notificationHistory.map((n) => (
              <div key={n.id} className="flex items-start gap-2 text-xs">
                <span className={cn("px-1.5 py-0.5 rounded font-medium uppercase", typeColors[n.type] || "bg-muted text-muted-foreground")}>
                  {t(`routeDetail.notificationType.${n.type}`)}
                </span>
                <span className="flex-1 text-muted-foreground truncate">{n.message}</span>
                <span className="text-muted-foreground whitespace-nowrap">
                  {new Date(n.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface RouteDetailProps {
  id: string;
}

export default function RouteDetail({ id }: RouteDetailProps) {
  const { t, i18n } = useTranslation();
  const { user, hasRole } = useAuth();
  const organizationId = user?.organizationId;
  const [, navigate] = useLocation();
  const dateLocale = i18n.language === "sv" ? sv : enUS;
  const queryClient = useQueryClient();

  const { data: route, isLoading: routeLoading } = useRoute(id);
  const { data: stops, isLoading: stopsLoading } = useRouteStops(id);
  const { data: vehicles } = useVehicles();
  const { data: drivers } = useDrivers();
  const updateStop = useUpdateStop();
  const updateRoute = useUpdateRoute();
  const { toast } = useToast();

  const reorderMutation = useMutation({
    mutationFn: async (stopIds: string[]) => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      if (!route) throw new Error("Route is not loaded");
      const res = await fetch(`/api/routes/${id}/reorder-stops?organizationId=${organizationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopIds, planRevision: route.planRevision }),
      });
       if (!res.ok) {
         const body = await res.json().catch(() => ({})) as { error?: string };
         const error = new Error(body.error || "Ruttändringen kunde inte sparas.");
         Object.assign(error, { status: res.status, data: body });
         throw error;
       }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/routes", id, "stops"] });
      queryClient.invalidateQueries({ queryKey: ["/api/routes", id] });
      toast({ title: "Ruttordningen är sparad", description: "Arbetsdagen har räknats om." });
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/routes", id, "stops"] });
       toast({ title: t("common.error"), description: localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }), variant: "destructive" });
    },
  });

  const saveTemplateMutation = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const res = await fetch(`/api/route-templates/from-route/${id}?organizationId=${organizationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: route?.name ? `${route.name} (mall)` : "Mall" }),
      });
       if (!res.ok) {
         const error = new Error("Failed to save template");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: t("routeDetail.templateSaved"), description: t("routeDetail.templateSavedDesc") });
    },
  });

  const rescheduleMutation = useMutation({
    mutationFn: async () => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const res = await fetch(`/api/routes/${id}/reschedule-failed?organizationId=${organizationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
       if (!res.ok) {
         const body = await res.json().catch(() => ({}));
         const error = new Error(body.error || "Failed to reschedule");
         Object.assign(error, { status: res.status, data: body });
         throw error;
       }
      return res.json();
    },
    onSuccess: (newRoute: { id: string }) => {
      toast({ title: t("reschedule.success"), description: t("reschedule.successDesc") });
      navigate(`/routes/${newRoute.id}`);
    },
    onError: (err: Error) => {
       const msg = /no failed stops/i.test(err.message)
         ? t("reschedule.noFailed")
         : localizeError(err, t, { fallbackKey: "common.errorRequestFailed" });
      toast({ title: t("common.error"), description: msg, variant: "destructive" });
    },
  });

  const sortedStops = useMemo(() => {
    if (!stops) return [];
    return sortStopsBySequence(stops);
  }, [stops]);
  const validMapStops = useMemo(
    () => sortedStops.filter((stop) => isValidCoordinate(stop.latitude, stop.longitude)),
    [sortedStops],
  );
  const depotStart: [number, number] = [
    route?.depotSnapshot?.start.latitude ?? DEPOT_LOCATION.lat,
    route?.depotSnapshot?.start.longitude ?? DEPOT_LOCATION.lng,
  ];
  const depotEnd: [number, number] = [
    route?.depotSnapshot?.end.latitude ?? DEPOT_LOCATION.lat,
    route?.depotSnapshot?.end.longitude ?? DEPOT_LOCATION.lng,
  ];

  const { data: allProofs = {} } = useQuery<Record<string, { id: string; proofType: string; fileUrl: string | null; data: string | null; notes?: string | null; capturedAt: string }[]>>({
    queryKey: ["route-proofs", organizationId, id],
    queryFn: async () => {
      if (!stops || stops.length === 0) return {};
      const results: Record<string, { id: string; proofType: string; fileUrl: string | null; data: string | null; notes?: string | null; capturedAt: string }[]> = {};
      await Promise.all(
        stops.map(async (stop) => {
          try {
            const res = await fetch(`/api/stops/${stop.id}/proofs?organizationId=${organizationId}`);
            if (res.ok) {
              const proofs = await res.json();
              if (proofs.length > 0) results[stop.id] = proofs;
            }
          } catch {}
        })
      );
      return results;
    },
    enabled: !!organizationId && !!stops && stops.length > 0,
  });

  const [localStops, setLocalStops] = useState(sortedStops);
  useEffect(() => { setLocalStops(sortedStops); }, [sortedStops]);
  const hasUnsavedStopOrder = useMemo(
    () => reorderMutation.isPending
      || localStops.some((stop, index) => stop.id !== sortedStops[index]?.id),
    [localStops, reorderMutation.isPending, sortedStops],
  );

  const handleDragEnd = useCallback((result: DropResult) => {
    if (!result.destination) return;
    const items = Array.from(localStops);
    const [moved] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, moved);
    setLocalStops(items);
    reorderMutation.mutate(items.map((s) => s.id));
  }, [localStops, reorderMutation]);

  const vehicle = useMemo(() => {
    if (!route?.vehicleId || !vehicles) return null;
    return vehicles.find((v) => v.id === route.vehicleId) || null;
  }, [route?.vehicleId, vehicles]);

  const driver = useMemo(() => {
    if (!vehicle || !drivers) return null;
    return drivers.find((d) => d.vehicleId === vehicle.id) || null;
  }, [vehicle, drivers]);

  const completedCount = sortedStops.filter((s) => s.status === "completed").length;
  const failedCount = sortedStops.filter((s) => s.status === "failed").length;
  const totalCount = sortedStops.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const [routeGeometry, setRouteGeometry] = useState<[number, number][]>([]);
  const [isFallbackGeometry, setIsFallbackGeometry] = useState(false);
  useEffect(() => {
    setRouteGeometry([]);
    setIsFallbackGeometry(false);
    if (sortedStops.length === 0) return;
    let cancelled = false;
    const validCoords = getValidCoordinates(sortedStops);
    if (validCoords.length === 0) return;
    const waypoints: [number, number][] = [
      depotStart,
      ...validCoords,
      depotEnd,
    ];
    fetchRouteGeometry(waypoints).then((result) => {
      if (!cancelled) {
        setRouteGeometry(result.coordinates);
        setIsFallbackGeometry(result.isFallback);
      }
    });
    return () => { cancelled = true; };
  }, [sortedStops, depotStart[0], depotStart[1], depotEnd[0], depotEnd[1]]);

  const handleStatusChange = (stopId: string, status: "completed" | "failed" | "skipped") => {
    updateStop.mutate(
      { id: stopId, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["/api/routes", id, "stops"] });
          queryClient.invalidateQueries({ queryKey: ["/api/routes"] });

          if (!route) return;

          const updatedStops = sortedStops.map((s) =>
            s.id === stopId ? { ...s, status } : s
          );
          const terminalStatuses = ["completed", "failed", "skipped"];
          const allTerminal = updatedStops.every((s) => terminalStatuses.includes(s.status));
          const anyNonPending = updatedStops.some((s) => s.status !== "pending");

          if (allTerminal) {
            const allCompleted = updatedStops.every((s) => s.status === "completed");
            if (allCompleted) {
              updateRoute.mutate({
                id: route.id,
                data: { status: "completed", planRevision: route.planRevision },
              });
            }
          } else if (anyNonPending && route.status !== "in_progress") {
            updateRoute.mutate({
              id: route.id,
              data: { status: "in_progress", planRevision: route.planRevision },
            });
          }
        },
      }
    );
  };

  if (routeLoading || stopsLoading) {
    return (
      <AppLayout>
        <div className="p-8">
          <LoadingState message={t("routeDetail.loading")} />
        </div>
      </AppLayout>
    );
  }

  if (!route) {
    return (
      <AppLayout>
        <div className="p-8 text-center">
          <p className="text-destructive">{t("routeDetail.notFound")}</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/routes")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {t("routeDetail.backToRoutes")}
          </Button>
        </div>
      </AppLayout>
    );
  }

  const routeStyle = STATUS_STYLES[route.status] || STATUS_STYLES.draft;
  const routeColor = getRouteColor(route.status, 0, false, vehicle?.routeColor);

  const fallbackPath: [number, number][] = validMapStops.length > 0
    ? [
        depotStart,
        ...getValidCoordinates(validMapStops),
        depotEnd,
      ]
    : [];
  const polylinePath = routeGeometry.length > 0 ? routeGeometry : fallbackPath;
  const isFallback = routeGeometry.length > 0 ? isFallbackGeometry : true;

  const mapCenter: [number, number] = validMapStops.length > 0
    ? [
        validMapStops.reduce((sum, s) => sum + s.latitude, 0) / validMapStops.length,
        validMapStops.reduce((sum, s) => sum + s.longitude, 0) / validMapStops.length,
      ]
    : depotStart;

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-center gap-4 flex-1">
            <Button variant="ghost" size="icon" className="min-h-[40px] min-w-[40px]" onClick={() => navigate("/routes")} aria-label={t("common.back", { defaultValue: "Back" })}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight truncate">{route.name}</h1>
                <span className={cn("px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wide whitespace-nowrap", routeStyle.bg, routeStyle.text)}>
                  {t(routeStyle.label)}
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-1 truncate">
                {route.date ? format(new Date(route.date), "PPP", { locale: dateLocale }) : t("common.noDate")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <RouteAppendImport route={route} />
            {hasRole("admin", "dispatcher") && <RouteDriverAction route={route} vehicles={vehicles ?? []} drivers={drivers ?? []} currentDriverName={driver?.name} />}
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => navigate(`/routes/${id}/compare`)}
            >
              <BarChart3 className="h-4 w-4" />
              {t("routeComparison.compare")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => saveTemplateMutation.mutate()}
              disabled={saveTemplateMutation.isPending}
            >
              <BookTemplate className="h-4 w-4" />
              {t("routeDetail.saveAsTemplate")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {vehicle && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Truck className="h-3.5 w-3.5" />
                Resurs
              </div>
              <p className="font-semibold text-sm">{vehicle.name}</p>
              <p className="text-xs text-muted-foreground">{vehicle.licensePlate}</p>
            </div>
          )}
          {driver && !vehicle && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <User className="h-3.5 w-3.5" />
                {t("routeDetail.driver")}
              </div>
              <p className="font-semibold text-sm">{driver.name}</p>
            </div>
          )}
          <div className="p-3 rounded-xl border border-border bg-card">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <MapPin className="h-3.5 w-3.5" />
              {t("common.stops")}
            </div>
            <p className="font-semibold text-sm">{route.totalStops}</p>
          </div>
          {route.totalDistanceKm != null && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Gauge className="h-3.5 w-3.5" />
                {t("common.distance")}
              </div>
              <p className="font-semibold text-sm">{route.totalDistanceKm} km</p>
            </div>
          )}
          {route.totalDurationMin != null && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Clock className="h-3.5 w-3.5" />
                {t("common.duration")}
              </div>
              <p className="font-semibold text-sm">{Math.floor(route.totalDurationMin / 60)}h {Math.round(route.totalDurationMin % 60)}m</p>
            </div>
          )}
          {route.co2EmissionsKg != null && (
            <div className="p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <Leaf className="h-3.5 w-3.5" />
                {t("common.co2")}
              </div>
              <p className="font-semibold text-sm">{route.co2EmissionsKg} kg</p>
            </div>
          )}
          {route.workdaySummary && (
            <div className="col-span-full xl:col-span-2 p-3 rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                <Clock className="h-3.5 w-3.5" />
                Arbetsdag
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Planerat pass</span>
                  <span className="font-semibold">{Math.round(route.workdaySummary.totalMin)}m / {Math.round(route.workdaySummary.shiftMin)}m</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Körning</span>
                  <span className="font-semibold">{route.workdaySummary.nonReturnDrivingMin}m</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Service</span>
                  <span className="font-semibold">{route.workdaySummary.serviceMin}m</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Väntan</span>
                  <span className="font-semibold">{route.workdaySummary.waitingMin}m</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Återresa</span>
                  <span className="font-semibold">{route.workdaySummary.returnMin}m</span>
                </div>
                {route.workdaySummary.breakMin > 0 && (
                  <div className="flex flex-col">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Rast</span>
                    <span className="font-semibold">{route.workdaySummary.breakMin}m</span>
                  </div>
                )}
                {route.workdaySummary.marginMin > 0 && (
                  <div className="flex flex-col text-emerald-600 dark:text-emerald-400">
                    <span className="text-[10px] uppercase tracking-wider opacity-80">Marginal</span>
                    <span className="font-semibold">{route.workdaySummary.marginMin}m</span>
                  </div>
                )}
                {route.workdaySummary.overtimeMin > 0 && (
                  <div className="flex flex-col text-destructive">
                    <span className="text-[10px] uppercase tracking-wider opacity-80">Övertid</span>
                    <span className="font-semibold">{route.workdaySummary.overtimeMin}m</span>
                  </div>
                )}
                <div className="flex flex-col ml-auto text-right">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Slut</span>
                  <span className="font-semibold">{new Date(route.workdaySummary.shiftEndAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {route.workdayTimeline && (
          <div className="p-4 rounded-xl border border-border bg-card">
            <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              Arbetspass (Tidslinje)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 text-sm">
              {route.workdayTimeline.map((item, idx) => {
                const start = new Date(item.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                if (item.type === "depot_start" || item.type === "depot_end") {
                  const addr = item.type === "depot_start" ? route.depotSnapshot?.start?.address : route.depotSnapshot?.end?.address;
                  return (
                    <div key={idx} className="flex items-center gap-2 text-muted-foreground bg-background border border-border/50 rounded-md p-2 shadow-sm">
                      <Warehouse className="h-4 w-4" />
                      <span className="w-10 text-xs opacity-70">{start}</span>
                      <span className="font-medium text-foreground">{item.type === "depot_start" ? "Startdepå" : "Slutdepå"}</span>
                      {addr && <span className="truncate text-xs opacity-70 ml-auto">{addr}</span>}
                    </div>
                  );
                }
                if (item.type === "break") {
                  return (
                    <div key={idx} className="flex items-center gap-2 text-orange-600 dark:text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-md p-2">
                      <Coffee className="h-4 w-4" />
                      <span className="w-10 text-xs opacity-70">{start}</span>
                      <span className="font-medium">Rast</span>
                      <span className="text-xs ml-auto">{Math.round(item.durationMin)}m</span>
                    </div>
                  );
                }
                if (item.type === "return") {
                  return (
                    <div key={idx} className="flex items-center gap-2 text-muted-foreground bg-muted/30 border border-border/50 rounded-md p-2">
                      <Navigation className="h-4 w-4" />
                      <span className="w-10 text-xs opacity-70">{start}</span>
                      <span className="font-medium">Återresa</span>
                      <span className="text-xs ml-auto">{Math.round(item.durationMin)}m, {item.distanceKm?.toFixed(1)}km</span>
                    </div>
                  );
                }
                if (item.type === "charging") {
                  return (
                    <div key={idx} className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-md p-2">
                      <Zap className="h-4 w-4" />
                      <span className="w-10 text-xs opacity-70">{start}</span>
                      <span className="font-medium">Laddning</span>
                      <span className="text-xs ml-auto">{Math.round(item.durationMin)}m</span>
                    </div>
                  );
                }
                if (item.type === "service") {
                  const stop = validMapStops.find(s => s.id === item.stopId);
                  return (
                    <div key={idx} className="flex items-center gap-2 text-foreground bg-background border border-border/50 rounded-md p-2 shadow-sm">
                      <MapPin className="h-4 w-4 text-primary" />
                      <span className="w-10 text-xs text-muted-foreground">{start}</span>
                      <span className="truncate flex-1 font-medium">{stop?.notes || stop?.address || "Stopp"}</span>
                      <span className="text-xs text-muted-foreground ml-auto">{Math.round(item.durationMin)}m</span>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        )}

        {totalCount > 0 && (
          <div className="p-4 rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">{t("routeDetail.progress")}</span>
              <div className="flex items-center gap-3 flex-wrap">
                {failedCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
                    onClick={() => rescheduleMutation.mutate()}
                    disabled={rescheduleMutation.isPending}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("reschedule.button")} ({failedCount})
                  </Button>
                )}
                <span className="text-sm text-muted-foreground">
                  {completedCount}/{totalCount} {t("routeDetail.delivered")}
                </span>
              </div>
            </div>
            <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  progressPercent === 100 ? "bg-emerald-500" : "bg-primary"
                )}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {organizationId && <NotificationSettingsPanel routeId={route.id} route={route} organizationId={organizationId} t={t} toast={toast} queryClient={queryClient} />}

        <RoutePlayback routeId={route.id} routeColor={routeColor} />


        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-border bg-card overflow-hidden z-0" style={{ height: 400 }}>
            {validMapStops.length > 0 ? (
              <MapContainer center={mapCenter} zoom={12} className="w-full h-full" zoomControl={false}>
                <ZoomControl position="bottomright" />
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                />
                <Marker position={depotStart} icon={createDepotIcon()}>
                  <Popup><div className="p-2 font-bold">Startdepå</div></Popup>
                </Marker>
                {(depotStart[0] !== depotEnd[0] || depotStart[1] !== depotEnd[1]) && (
                  <Marker position={depotEnd} icon={createDepotIcon()}>
                    <Popup><div className="p-2 font-bold">Slutdepå</div></Popup>
                  </Marker>
                )}
                {polylinePath.length > 0 && (
                  <MapRouteLine positions={polylinePath} color={routeColor} weight={4} isFallback={isFallback} />
                )}
                {validMapStops.map((stop, idx) => (
                  <Marker key={stop.id} position={[stop.latitude, stop.longitude]} icon={createNumberedIcon(routeColor, (stop.sequenceOrder ?? idx + 1).toString())}>
                    <Popup>
                      <div className="p-2 min-w-[180px]">
                        <h4 className="font-bold">{stop.notes || t("common.deliveryStop")}</h4>
                        <p className="text-sm text-muted-foreground mt-1">{stop.address}</p>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                <MapPin className="h-8 w-8 opacity-30" />
              </div>
            )}
          </div>

          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
            <h2 className="text-lg font-semibold mb-3 sticky top-0 bg-background py-1 z-10">{t("routeDetail.stopList")}</h2>
            <DragDropContext onDragEnd={handleDragEnd}>
              <Droppable droppableId="stop-list">
                {(provided) => (
                  <div ref={provided.innerRef} {...provided.droppableProps} className="space-y-2">
                    {localStops.map((stop, idx) => {
                      const stopStyle = STOP_STATUS_STYLES[stop.status] || STOP_STATUS_STYLES.pending;
                      const isTerminal = stop.status === "completed" || stop.status === "failed" || stop.status === "skipped";
                      return (
                        <Draggable key={stop.id} draggableId={stop.id} index={idx}>
                          {(dragProvided, snapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              className={cn(
                                "p-3 rounded-xl border border-border bg-card hover:bg-card/80 transition-colors",
                                snapshot.isDragging && "shadow-lg shadow-primary/20 border-primary/40"
                              )}
                            >
                              <div className="flex items-start gap-3">
                                <div {...dragProvided.dragHandleProps} className="flex-shrink-0 mt-0.5 p-1.5 -ml-1.5 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground" aria-label={t("common.dragToReorder", { defaultValue: "Drag to reorder" })}>
                                  <GripVertical className="h-5 w-5" />
                                </div>
                                <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold" style={{ backgroundColor: `${routeColor}20`, color: routeColor }}>
                                  {idx + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <p className="font-medium text-sm truncate">{stop.notes || stop.address}</p>
                                    <span className={cn("px-2 py-0.5 rounded-full text-[10px] font-medium uppercase", stopStyle.bg, stopStyle.text)}>
                                      {t(`routeDetail.stop_${stop.status}`)}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">{stop.address}</p>
                                  <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                    {stop.timeWindowStart && stop.timeWindowEnd && (
                                      <span className="flex items-center gap-1">
                                        <Clock className="h-3 w-3" />
                                        {format(new Date(stop.timeWindowStart), "HH:mm")} - {format(new Date(stop.timeWindowEnd), "HH:mm")}
                                      </span>
                                    )}
                                    {(stop.weightKg != null || stop.volumeM3 != null) && (
                                      <span className="flex items-center gap-1">
                                        <Package className="h-3 w-3" />
                                        {stop.weightKg != null && `${stop.weightKg}kg`}
                                        {stop.weightKg != null && stop.volumeM3 != null && " / "}
                                        {stop.volumeM3 != null && `${stop.volumeM3}m³`}
                                      </span>
                                    )}
                                    <span className="flex items-center gap-1">
                                      <Clock className="h-3 w-3" />
                                      {stop.serviceDurationMin} {t("common.mins")}
                                    </span>
                                    {allProofs[stop.id] && allProofs[stop.id].length > 0 && (
                                      <span className="flex items-center gap-1 text-primary">
                                        <FileCheck className="h-3 w-3" />
                                        {t("pod.title")} ({allProofs[stop.id].length})
                                      </span>
                                    )}
                                  </div>
                                  {allProofs[stop.id] && allProofs[stop.id].length > 0 && (
                                    <div className="mt-2">
                                      <ProofDisplay proofs={allProofs[stop.id]} />
                                    </div>
                                  )}
                                </div>
                                <LockedFirstStopControl
                                  routeId={route.id}
                                  planRevision={route.planRevision}
                                  routeStatus={route.status}
                                  lockedFirstStopId={route.lockedFirstStopId}
                                  stopId={stop.id}
                                  stopStatus={stop.status}
                                  stopRouteId={stop.routeId}
                                  hasUnsavedLocalChanges={hasUnsavedStopOrder}
                                  compact
                                />
                                {!isTerminal && (
                                  <div className="flex items-center gap-1 flex-shrink-0">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 px-2 text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                                      onClick={() => handleStatusChange(stop.id, "completed")}
                                      title={t("routeDetail.markDelivered")}
                                    >
                                      <CheckCircle2 className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={() => handleStatusChange(stop.id, "failed")}
                                      title={t("routeDetail.markFailed")}
                                    >
                                      <XCircle className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 px-2 text-orange-500 hover:text-orange-400 hover:bg-orange-500/10"
                                      onClick={() => handleStatusChange(stop.id, "skipped")}
                                      title={t("routeDetail.markSkipped")}
                                    >
                                      <SkipForward className="h-4 w-4" />
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </Draggable>
                      );
                    })}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </DragDropContext>
            {localStops.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>{t("routeDetail.noStops")}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
