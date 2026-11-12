import { AppLayout } from "@/components/layout/AppLayout";
import { CustomerLinkControls } from "@/components/CustomerLinkControls";
import {
  useOrganizationStops,
  useCreateStop,
  useUpdateStop,
  useBulkArchiveStops,
  useBulkDeleteStops,
  type ArchiveState,
  StopArchiveRequestError,
} from "@/hooks/use-stops";
import { useRoutes } from "@/hooks/use-routes";
import { useVehicles } from "@/hooks/use-vehicles";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { Plus, Archive, Edit2, MapPin, FileSpreadsheet, CheckCircle2, AlertTriangle, Route as RouteIcon, Inbox, FileCheck2 } from "lucide-react";
import { useMemo, useState, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useAuth } from "@/lib/auth-context";
import { type Stop, useCreateRoutePlanStop } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { renderToString } from "react-dom/server";
import { Wrench, Briefcase, CalendarClock, ShieldAlert, ChevronLeft, ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidateRouteQueries } from "@/lib/route-query-cache";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { localizeError } from "@/lib/localize-error";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { ProofDisplay } from "@/components/pod/ProofDisplay";
import {
  assertArchiveSnapshotUnchanged,
  createArchiveSnapshot,
  isArchivedStop,
} from "@/lib/stop-archive";

const API_BASE = import.meta.env.VITE_API_URL || "";

const optionalNumber = z.preprocess(
  (val) => (val === "" || val === null || val === undefined ? null : Number(val)),
  z.number().nullable().optional()
);

const optionalString = z.preprocess(
  (val) => (val === "" ? null : val),
  z.string().nullable().optional()
);

const optionalCoordinate = (min: number, max: number) => z.preprocess(
  (value) => value === "" || value === null || value === undefined ? undefined : Number(value),
  z.number().min(min).max(max).optional(),
);

const createStopSchema = (t: (key: string) => string) => z.object({
  address: z.string().min(1, t("stops.addressRequired")),
  notes: z.string().optional(),
  latitude: optionalCoordinate(-90, 90),
  longitude: optionalCoordinate(-180, 180),
  serviceDurationMin: z.coerce.number().min(1),
  weightKg: optionalNumber,
  volumeM3: optionalNumber,
  timeWindowStart: optionalString,
  timeWindowEnd: optionalString,
  pickupAddress: optionalString,
  pickupLatitude: optionalNumber,
  pickupLongitude: optionalNumber,
  jobType: z.enum(["delivery", "pickup_delivery", "field_service"]).optional(),
  priority: z.preprocess(
    (value) => value === "" || value === undefined || value === null ? null : Number(value),
    z.number().int().min(1).max(10).optional().nullable(),
  ),
  slaDeadline: optionalString,
  serviceCategory: optionalString,
  serviceInstructions: optionalString,
  requiredSkills: z.string().optional(),
  requiredCertifications: z.string().optional(),
  requiredEquipment: z.string().optional(),
});

type StopFormValues = z.infer<ReturnType<typeof createStopSchema>>;

function makeIcon(selected: boolean, assigned: boolean) {
  return L.divIcon({
    className: "",
    html: renderToString(
      <div className={cn(
        "flex items-center justify-center h-7 w-7 rounded-full border-2 shadow-lg",
        selected ? "bg-primary border-primary/60 text-white scale-125" :
          assigned ? "bg-emerald-500 border-emerald-400 text-white" :
            "bg-amber-500 border-amber-400 text-white"
      )}>
        <MapPin className="h-3.5 w-3.5" />
      </div>
    ),
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function InvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function FlyToStop({ stop }: { stop: { latitude: number; longitude: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (!stop) return;
    map.flyTo([stop.latitude, stop.longitude], 15, { duration: 0.4 });
  }, [stop, map]);
  return null;
}

type OrderTypeFilter = "all" | "single_stop" | "pickup_delivery";
type WorkStatusFilter = "current" | "terminal" | "all";
type QualityFilter = "all" | "ready" | "issues" | "geocode_error";
type PlanningFilter = "all" | "unplanned" | "planned";
type TimeWindowFilter = "all" | "set" | "unset";
type VehicleFilter = "all" | "assigned" | "unassigned" | `route:${string}`;

type StopColumnFilters = {
  address: string;
  timeWindow: TimeWindowFilter;
  requirements: string;
  vehicle: VehicleFilter;
  tracking: string;
  status: "all" | Stop["status"];
};

type DateField = "planned_delivery" | "imported_created";

function stockholmDateStart(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const partsFor = (instant: Date) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  };
  const [year, month, day] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const offsetAt = (instant: Date) => {
    const parts = partsFor(instant);
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant.getTime();
  };
  let instant = new Date(utcMidnight - offsetAt(new Date(utcMidnight)));
  instant = new Date(utcMidnight - offsetAt(instant));
  return instant.toISOString();
}

function followingDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

function stockholmDateTime(value: string | Date | null | undefined): string {
  if (!value) return "–";
  return new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Stockholm",
  }).format(new Date(value));
}

const defaultColumnFilters: StopColumnFilters = {
  address: "",
  timeWindow: "all",
  requirements: "",
  vehicle: "all",
  tracking: "",
  status: "all",
};

const stopStatusTranslationKeys: Record<string, string> = {
  pending: "stops.statusPending",
  in_progress: "stops.statusInProgress",
  completed: "stops.statusCompleted",
  failed: "stops.statusFailed",
  skipped: "stops.statusSkipped",
};

function hasValidCoordinates(latitude: number | null | undefined, longitude: number | null | undefined) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude ?? 0) <= 90 && Math.abs(longitude ?? 0) <= 180;
}

function getOrderQuality(stop: Stop): "ready" | "geocode_error" | "issues" {
  if (!stop.address?.trim() || !hasValidCoordinates(stop.latitude, stop.longitude)) return "geocode_error";
  if (stop.pickupAddress && !hasValidCoordinates(stop.pickupLatitude, stop.pickupLongitude)) return "geocode_error";
  if (!stop.timeWindowStart && !stop.timeWindowEnd) return "issues";
  return "ready";
}

export default function Stops() {
  const [, navigate] = useLocation();
  const { user, hasRole } = useAuth();
  const organizationId = user?.organizationId;
  const { data: routes } = useRoutes();
  const { data: vehicles } = useVehicles();
  const createForPlanId = new URLSearchParams(window.location.search).get("planId");
  const [isCreateOpen, setIsCreateOpen] = useState(
    Boolean(createForPlanId && new URLSearchParams(window.location.search).get("create") === "1"),
  );
  const returnToPlan = () => {
    if (createForPlanId) navigate(`/dispatch?${new URLSearchParams({ planId: createForPlanId })}`);
  };
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const [historyStop, setHistoryStop] = useState<Stop | null>(null);
  const { t } = useTranslation();

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const initialOrderType = new URLSearchParams(window.location.search).get("orderType");
  const [orderTypeFilter, setOrderTypeFilter] = useState<OrderTypeFilter>(
    initialOrderType === "pickup_delivery" ? "pickup_delivery" : "all",
  );
  const [archiveStateFilter, setArchiveStateFilter] = useState<ArchiveState>("active");
  const [workStatusFilter, setWorkStatusFilter] = useState<WorkStatusFilter>("current");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [planningFilter, setPlanningFilter] = useState<PlanningFilter>("all");
  const [columnFilters, setColumnFilters] = useState<StopColumnFilters>(defaultColumnFilters);
  const [dateField, setDateField] = useState<DateField>("planned_delivery");
  const [dateFrom, setDateFrom] = useState("");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [dateTo, setDateTo] = useState("");
  const [includeWithoutPlannedDate, setIncludeWithoutPlannedDate] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const serverFilters = useMemo(() => ({
    search: columnFilters.address.trim() || undefined,
    status: columnFilters.status === "all" ? undefined : columnFilters.status,
    workStatus: workStatusFilter === "all" ? undefined : workStatusFilter,
    assignment: columnFilters.vehicle === "assigned" || columnFilters.vehicle === "unassigned"
      ? columnFilters.vehicle
      : undefined,
    routeId: columnFilters.vehicle.startsWith("route:") ? columnFilters.vehicle.slice(6) : undefined,
    orderType: orderTypeFilter === "all" ? undefined : orderTypeFilter,
    quality: qualityFilter === "all" ? undefined : qualityFilter,
    planning: planningFilter === "all" ? undefined : planningFilter,
    timeWindow: columnFilters.timeWindow === "all" ? undefined : columnFilters.timeWindow,
    requirements: columnFilters.requirements.trim() || undefined,
    tracking: columnFilters.tracking.trim() || undefined,
    dateField,
    dateFrom: stockholmDateStart(dateFrom),
    dateToExclusive: dateTo ? stockholmDateStart(followingDate(dateTo)) : undefined,
    includeWithoutPlannedDate: dateField === "planned_delivery" && includeWithoutPlannedDate ? true : undefined,
    archiveState: archiveStateFilter,
    page,
    pageSize,
  }), [columnFilters, orderTypeFilter, archiveStateFilter, workStatusFilter, qualityFilter, planningFilter, dateField, dateFrom, dateTo, includeWithoutPlannedDate, page]);
  const { data: stopsPage, isLoading } = useOrganizationStops(serverFilters);
  const stops = stopsPage?.items;
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [archiveSnapshot, setArchiveSnapshot] = useState<string[]>([]);
  const [deleteSnapshot, setDeleteSnapshot] = useState<string[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteMutation = useBulkDeleteStops();
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [isPreparingArchive, setIsPreparingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [activeRoutesRequireConfirmation, setActiveRoutesRequireConfirmation] = useState(false);
  const [confirmActiveRoutes, setConfirmActiveRoutes] = useState(false);
  const [affectedRouteIds, setAffectedRouteIds] = useState<string[]>([]);
  const archiveMutation = useBulkArchiveStops();
  const { toast } = useToast();
  const { data: archivedProofs = [], isLoading: isLoadingArchivedProofs, error: archivedProofsError } = useQuery<Array<{
    id: string;
    proofType: string;
    fileUrl: string | null;
    data: string | null;
    notes?: string | null;
    capturedAt: string;
  }>>({
    queryKey: ["stop-proofs", organizationId, historyStop?.id],
    enabled: !!organizationId && !!historyStop?.id,
    queryFn: async () => {
      const response = await fetch(`${API_BASE}/api/stops/${historyStop!.id}/proofs?organizationId=${organizationId}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(t("stops.archiveProofsError"));
      return response.json();
    },
  });

  const vehicleByRouteId = useMemo(() => {
    const map = new Map<string, string>();
    if (routes && vehicles) {
      const vMap = new Map(vehicles.map(v => [v.id, v.name]));
      routes.forEach(r => {
        if (r.vehicleId) map.set(r.id, vMap.get(r.vehicleId) || t("common.unknown"));
      });
    }
    return map;
  }, [routes, vehicles, t]);

  const filteredStops = useMemo(() => {
    return stops ?? [];
  }, [stops]);

  const selectedStop = stops?.find((s) => s.id === selectedStopId) || null;
  const archivableVisibleStops = filteredStops.filter((stop) => !isArchivedStop(stop));
  const allVisibleSelected = archivableVisibleStops.length > 0 && archivableVisibleStops.every((stop) => selectedStopIds.has(stop.id));
  const someVisibleSelected = archivableVisibleStops.some((stop) => selectedStopIds.has(stop.id));
  const totalPages = stopsPage ? Math.max(1, Math.ceil(stopsPage.total / pageSize)) : null;
  const hasActiveColumnFilters = Object.values(columnFilters).some((value) => value !== "all" && value !== "")
    || orderTypeFilter !== "all" || archiveStateFilter !== "active" || workStatusFilter !== "current"
    || qualityFilter !== "all" || planningFilter !== "all"
    || dateFrom !== "" || dateTo !== "" || includeWithoutPlannedDate;

  useEffect(() => {
    if (!stops) return;
    const currentStopIds = new Set(stops.filter((stop) => !isArchivedStop(stop)).map((stop) => stop.id));
    setSelectedStopIds((selected) => {
      const next = new Set([...selected].filter((stopId) => currentStopIds.has(stopId)));
      return next.size === selected.size ? selected : next;
    });
  }, [stops]);

  useEffect(() => {
    setSelectedStopIds(new Set());
    setArchiveSnapshot([]);
    setDeleteSnapshot([]);
    setDeleteError(null);
    setIsArchiveOpen(false);
    setArchiveError(null);
    setActiveRoutesRequireConfirmation(false);
    setConfirmActiveRoutes(false);
    setAffectedRouteIds([]);
  }, [organizationId, columnFilters, archiveStateFilter, dateField, dateFrom, dateTo, includeWithoutPlannedDate, orderTypeFilter, workStatusFilter, qualityFilter, planningFilter]);

  useEffect(() => {
    setPage(1);
  }, [columnFilters, orderTypeFilter, archiveStateFilter, workStatusFilter, qualityFilter, planningFilter, dateField, dateFrom, dateTo, includeWithoutPlannedDate]);

  useEffect(() => {
    // A page change uses a new query key, so data is briefly undefined while
    // the next server page loads. Only clamp after that specific response
    // arrives; otherwise clicking “next” is immediately reset to page one.
    if (stopsPage && totalPages !== null && stopsPage.page === page && page > totalPages) {
      setPage(totalPages);
    }
  }, [page, stopsPage, totalPages]);

  const clearAllFilters = () => {
    setColumnFilters(defaultColumnFilters);
    setOrderTypeFilter("all");
    setArchiveStateFilter("active");
    setWorkStatusFilter("current");
    setQualityFilter("all");
    setPlanningFilter("all");
    setDateFrom("");
    setDateTo("");
    setIncludeWithoutPlannedDate(false);
    setPage(1);
  };

  const toggleStopSelection = (stopId: string, checked: boolean) => {
    setSelectedStopIds((current) => {
      const next = new Set(current);
      if (checked) next.add(stopId);
      else next.delete(stopId);
      return next;
    });
  };

  const toggleVisibleStopSelection = (checked: boolean) => {
    setSelectedStopIds((current) => {
      const next = new Set(current);
      archivableVisibleStops.forEach((stop) => checked ? next.add(stop.id) : next.delete(stop.id));
      return next;
    });
  };

  const openArchiveConfirmation = (stopIds: readonly string[]) => {
    setArchiveSnapshot(createArchiveSnapshot(stopIds));
    setArchiveError(null);
    setActiveRoutesRequireConfirmation(false);
    setConfirmActiveRoutes(false);
    setAffectedRouteIds([]);
    setIsArchiveOpen(true);
  };

  const confirmDeletion = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const existing = await Promise.all(deleteSnapshot.map(async (id) => {
        const response = await fetch(`${API_BASE}/api/stops/${id}?organizationId=${organizationId}`, { credentials: "include", cache: "no-store" });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(t("stops.archiveRefreshError"));
        const stop = await response.json();
        if (stop.id !== id || stop.archivedAt || stop.status !== "pending") {
          throw new Error(t("stops.bulkDeleteBlocked"));
        }
        return id;
      }));
      const ids = existing.filter((id): id is string => id !== null);
      if (ids.length) await deleteMutation.mutateAsync(ids);
      setSelectedStopIds(new Set());
      setDeleteSnapshot([]);
      setPage(1);
      if (selectedStopId && deleteSnapshot.includes(selectedStopId)) setSelectedStopId(null);
      toast({ title: t("stops.bulkDeleted", { count: ids.length }) });
    } catch (error) {
      setDeleteError(localizeError(error, t, { fallbackKey: "stops.bulkDeleteBlocked" }));
    } finally {
      setDeleting(false);
    }
  };

  const confirmBulkArchive = async () => {
    setArchiveError(null);
    setIsPreparingArchive(true);
    try {
      // Re-read every ID in the fixed snapshot. A missing, newly archived, or
      // otherwise changed row is a visible conflict; never silently shrink or
      // expand the request while confirmation is open.
      const refreshed = await Promise.all(archiveSnapshot.map(async (stopId) => {
        const response = await fetch(`${API_BASE}/api/stops/${stopId}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(t("stops.archiveRefreshError"));
        }
        return { id: stopId, stop: await response.json() as { id?: string; archivedAt?: string | null } };
      }));
      assertArchiveSnapshotUnchanged(
        archiveSnapshot,
        refreshed.map(({ stop }) => stop.id ?? ""),
      );
      if (refreshed.some(({ stop }) => isArchivedStop(stop))) {
        throw new Error(t("stops.archiveSelectionChanged"));
      }

      const result = await archiveMutation.mutateAsync({
        data: {
          stopIds: [...archiveSnapshot],
          ...(confirmActiveRoutes ? { confirmActiveRoutes: true } : {}),
        },
      });
      setSelectedStopIds(new Set());
      setArchiveSnapshot([]);
      setIsArchiveOpen(false);
      setActiveRoutesRequireConfirmation(false);
      setConfirmActiveRoutes(false);
      setAffectedRouteIds([]);
      if (selectedStopId && result.archivedStopIds.includes(selectedStopId)) setSelectedStopId(null);
      toast({ title: t("stops.archiveSuccess", { count: result.archivedCount }) });
    } catch (error) {
      if (error instanceof StopArchiveRequestError && error.code === "STOP_ARCHIVE_CONFIRMATION_REQUIRED") {
        setActiveRoutesRequireConfirmation(true);
        setAffectedRouteIds(error.affectedRouteIds);
        setArchiveError(t("stops.archiveConfirmationRequired"));
        return;
      }
      const message = localizeError(error, t, { fallbackKey: "stops.archiveError" });
      setArchiveError(message);
      toast({
        title: t("stops.archiveError"),
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsPreparingArchive(false);
    }
  };

  if (isLoading) return <AppLayout><LoadingState message={t("stops.loadingStops")} /></AppLayout>;
  if (!hasRole("admin", "dispatcher")) {
    return (
      <AppLayout>
        <div className="flex h-full min-h-[calc(100vh-3.5rem)] items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-semibold">{t("stops.accessDenied")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("stops.accessDeniedDescription")}</p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <ResizablePanelGroup direction="horizontal" className="h-[calc(100vh-3.5rem)]">
        <ResizablePanel defaultSize={60} minSize={30} maxSize={80}>
        <div className="h-full overflow-y-auto">
          <div className="p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <Inbox className="h-6 w-6 text-primary" />
                    <h1 className="text-2xl font-bold text-foreground">{t("stops.title")}</h1>
                </div>
                <p className="text-muted-foreground text-sm mt-0.5">{t("stops.subtitle")}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs shrink-0"
                  onClick={() => navigate("/import")}
                  data-testid="orders-import-workflow"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" /> {t("import.importButton")}
                </Button>
                <Dialog open={isCreateOpen} onOpenChange={(open) => {
                  setIsCreateOpen(open);
                  if (!open) returnToPlan();
                }}>
                  <DialogTrigger asChild>
                    <Button size="sm" className="gap-1.5 text-xs shrink-0">
                      <Plus className="h-3.5 w-3.5" /> {t("stops.addStop")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                      <DialogTitle>{createForPlanId ? t("stops.addStopToPlan") : t("stops.addNewStop")}</DialogTitle>
                      {createForPlanId && <DialogDescription>{t("stops.addStopToPlanDescription")}</DialogDescription>}
                    </DialogHeader>
                    {organizationId && (!createForPlanId || routes?.some((route) => route.planId === createForPlanId)) && <StopForm
                      organizationId={organizationId}
                      plan={createForPlanId ? {
                        id: createForPlanId,
                        routes: (routes ?? []).filter((route) => route.planId === createForPlanId)
                          .map((route) => ({ routeId: route.id, planRevision: route.planRevision })),
                      } : undefined}
                      onSuccess={() => { setIsCreateOpen(false); returnToPlan(); }}
                    />}
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-3 gap-y-2 rounded-lg border border-border bg-card p-2 mb-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="stops-compact-filters">
              <div className={moreFiltersOpen ? "order-6 space-y-1" : "hidden"}>
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.archiveFilter")}</Label>
                <Select value={archiveStateFilter} onValueChange={(value: ArchiveState) => setArchiveStateFilter(value)}>
                  <SelectTrigger className="h-9 text-xs" data-testid="filter-archive-state"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">{t("stops.archiveActive")}</SelectItem>
                    <SelectItem value="archived">{t("stops.archiveArchived")}</SelectItem>
                    <SelectItem value="all">{t("stops.archiveAll")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="order-1 space-y-1">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.workStatusFilter")}</Label>
                <Select value={workStatusFilter} onValueChange={(value: WorkStatusFilter) => setWorkStatusFilter(value)}>
                  <SelectTrigger className="h-9 text-xs" data-testid="filter-work-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current">{t("stops.workStatusCurrent")}</SelectItem>
                    <SelectItem value="terminal">{t("stops.workStatusTerminal")}</SelectItem>
                    <SelectItem value="all">{t("stops.workStatusAll")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className={moreFiltersOpen ? "order-6 space-y-1" : "hidden"}>
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.orderType")}</Label>
                <Select value={orderTypeFilter} onValueChange={(value: OrderTypeFilter) => setOrderTypeFilter(value)}>
                  <SelectTrigger className="h-9 text-xs" data-testid="filter-order-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stops.allOrderTypes")}</SelectItem>
                    <SelectItem value="single_stop">{t("stops.singleStop")}</SelectItem>
                    <SelectItem value="pickup_delivery">{t("stops.typePD")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className={moreFiltersOpen ? "order-6 space-y-1" : "hidden"}>
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.dataQuality")}</Label>
                <Select value={qualityFilter} onValueChange={(value: QualityFilter) => setQualityFilter(value)}>
                  <SelectTrigger className="h-9 text-xs" data-testid="filter-data-quality"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stops.allQuality")}</SelectItem>
                    <SelectItem value="ready">{t("stops.qualityReady")}</SelectItem>
                    <SelectItem value="issues">{t("stops.qualityIssues")}</SelectItem>
                    <SelectItem value="geocode_error">{t("stops.geocodeError")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="order-2 space-y-1">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.planningStatus")}</Label>
                <Select value={planningFilter} onValueChange={(value: PlanningFilter) => setPlanningFilter(value)}>
                  <SelectTrigger className="h-9 text-xs" data-testid="filter-planning-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("stops.allPlanningStatuses")}</SelectItem>
                    <SelectItem value="unplanned">{t("stops.unplanned")}</SelectItem>
                    <SelectItem value="planned">{t("stops.planned")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className={moreFiltersOpen ? "order-6 space-y-1" : "hidden"}>
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.dateMeaning")}</Label>
                <Select value={dateField} onValueChange={(value: DateField) => setDateField(value)}>
                  <SelectTrigger className="h-9 text-xs" data-testid="filter-date-field"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="planned_delivery">{t("stops.plannedDeliveryDate")}</SelectItem>
                    <SelectItem value="imported_created">{t("stops.importedCreatedDate")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="order-3 min-w-0 space-y-1">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.dateFrom")}</Label>
                <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="h-9 text-xs" data-testid="filter-date-from" />
              </div>
              <div className="order-4 min-w-0 space-y-1">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("stops.dateTo")}</Label>
                <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="h-9 text-xs" data-testid="filter-date-to" />
              </div>
              {dateField === "planned_delivery" && (
                <label className={moreFiltersOpen ? "order-6 col-span-full flex items-center gap-2 self-end min-h-8 text-xs text-muted-foreground cursor-pointer" : "hidden"}>
                  <Checkbox
                    checked={includeWithoutPlannedDate}
                    onCheckedChange={(checked) => setIncludeWithoutPlannedDate(checked === true)}
                    aria-label={t("stops.includeWithoutPlannedDate")}
                  />
                  {t("stops.includeWithoutPlannedDate")}
                </label>
              )}
              <div className="order-5 col-span-full flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  aria-expanded={moreFiltersOpen}
                  data-testid="toggle-more-stop-filters"
                  onClick={() => setMoreFiltersOpen((open) => !open)}
                  className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {moreFiltersOpen ? "▴" : "▾"} {t("stops.moreFilters")}
                  {[archiveStateFilter !== "active", orderTypeFilter !== "all", qualityFilter !== "all", dateField !== "planned_delivery", dateField === "planned_delivery" && includeWithoutPlannedDate].filter(Boolean).length > 0 && (
                    <span className="ml-1.5 rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                      {[archiveStateFilter !== "active", orderTypeFilter !== "all", qualityFilter !== "all", dateField !== "planned_delivery", dateField === "planned_delivery" && includeWithoutPlannedDate].filter(Boolean).length} {t("stops.activeFilters")}
                    </span>
                  )}
                </button>
                <span className="text-[11px] text-muted-foreground">
                  {t("stops.dateMeaning")}: {t(dateField === "planned_delivery" ? "stops.plannedDeliveryDate" : "stops.importedCreatedDate")}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-4 mb-3">
              <h2 className="text-sm font-medium" data-testid="all-assignments-heading">
                {t("stops.filterAll")}
              </h2>

            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <p className="text-xs text-muted-foreground">
                {t("stops.showingFiltered", { count: filteredStops.length, total: stopsPage?.total ?? 0 })}
              </p>
              <div className="flex items-center gap-2">
                {hasActiveColumnFilters && (
                  <Button variant="ghost" size="sm" className="text-xs" onClick={clearAllFilters}>
                    {t("stops.clearFilters")}
                  </Button>
                )}
                {selectedStopIds.size > 0 && (
                  <>
                    <span className="text-xs font-medium">{t("stops.selectedCount", { count: selectedStopIds.size })}</span>
                    <Button variant="destructive" size="sm" data-testid="delete-selected-stops" onClick={() => {
                      setDeleteError(null);
                      setDeleteSnapshot([...selectedStopIds]);
                    }}>
                      {t("stops.deleteSelected")}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => setSelectedStopIds(new Set())}>
                      {t("stops.clearSelection")}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-1.5 text-xs"
                      onClick={() => openArchiveConfirmation(Array.from(selectedStopIds))}
                    >
                      <Archive className="h-3.5 w-3.5" /> {t("stops.archiveSelected")}
                    </Button>
                  </>
                )}
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <DualHorizontalScroll label={t("stops.horizontalScroll")}>
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="p-3 w-10">
                          <Checkbox
                          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                          onCheckedChange={(checked) => toggleVisibleStopSelection(checked === true)}
                          aria-label={t("stops.selectAllVisible")}
                            disabled={archivableVisibleStops.length === 0}
                        />
                      </th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.customerAddress")}</th>
                       <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.stopDate")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.orderType")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.dataQuality")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.planningStatus")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.timeWindow")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.requirements")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.assignedVehicle")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.tracking")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs whitespace-nowrap">{t("stops.status")}</th>
                      <th className="p-3 font-semibold text-muted-foreground text-xs text-right sticky right-0 bg-muted z-10 shadow-[-1px_0_0_0_hsl(var(--border))]">{t("common.actions")}</th>
                    </tr>
                    <tr className="bg-muted/20 border-b border-border">
                      <th className="p-2" />
                      <th className="p-2 min-w-[200px]">
                        <Input
                          value={columnFilters.address}
                          onChange={(event) => setColumnFilters((current) => ({ ...current, address: event.target.value }))}
                          placeholder={t("stops.filterCustomerAddress")}
                          className="h-8 text-xs"
                        />
                      </th>
                       <th className="p-2" />
                       <th className="p-2" />
                       <th className="p-2" />
                       <th className="p-2" />
                       <th className="p-2 min-w-[130px]">
                        <Select value={columnFilters.timeWindow} onValueChange={(value: TimeWindowFilter) => setColumnFilters((current) => ({ ...current, timeWindow: value }))}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{t("stops.allTimeWindows")}</SelectItem>
                            <SelectItem value="set">{t("stops.withTimeWindow")}</SelectItem>
                            <SelectItem value="unset">{t("stops.withoutTimeWindow")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </th>
                      <th className="p-2 min-w-[150px]">
                        <Input
                          value={columnFilters.requirements}
                          onChange={(event) => setColumnFilters((current) => ({ ...current, requirements: event.target.value }))}
                          placeholder={t("stops.filterRequirements")}
                          className="h-8 text-xs"
                        />
                      </th>
                      <th className="p-2 min-w-[150px]">
                        <Select value={columnFilters.vehicle} onValueChange={(value: VehicleFilter) => setColumnFilters((current) => ({ ...current, vehicle: value }))}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{t("stops.allVehicles")}</SelectItem>
                            <SelectItem value="assigned">{t("common.assigned")}</SelectItem>
                            <SelectItem value="unassigned">{t("common.unassigned")}</SelectItem>
                            {(routes ?? []).filter((route) => route.vehicleId).map((route) => (
                              <SelectItem key={route.id} value={`route:${route.id}`}>
                                {vehicleByRouteId.get(route.id) || route.name || t("common.unknown")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </th>
                      <th className="p-2 min-w-[145px]">
                        <Input
                          value={columnFilters.tracking}
                          onChange={(event) => setColumnFilters((current) => ({ ...current, tracking: event.target.value }))}
                          placeholder={t("stops.filterTracking")}
                          className="h-8 text-xs"
                        />
                      </th>
                      <th className="p-2 min-w-[145px]">
                        <Select value={columnFilters.status} onValueChange={(value: StopColumnFilters["status"]) => setColumnFilters((current) => ({ ...current, status: value }))}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={t("stops.allStatuses")} /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{t("stops.allStatuses")}</SelectItem>
                            <SelectItem value="pending">{t("stops.statusPending")}</SelectItem>
                            <SelectItem value="in_progress">{t("stops.statusInProgress")}</SelectItem>
                            <SelectItem value="completed">{t("stops.statusCompleted")}</SelectItem>
                            <SelectItem value="failed">{t("stops.statusFailed")}</SelectItem>
                            <SelectItem value="skipped">{t("stops.statusSkipped")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </th>
                      <th className="p-2 sticky right-0 bg-muted/20 z-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                     {filteredStops.map((stop) => {
                       const quality = getOrderQuality(stop);
                        const archived = isArchivedStop(stop);
                       return (
                      <tr
                        key={stop.id}
                        className={cn(
                          "group transition-colors cursor-pointer",
                          selectedStopId === stop.id ? "bg-primary/5" : "hover:bg-muted/30"
                        )}
                        onClick={() => setSelectedStopId(selectedStopId === stop.id ? null : stop.id)}
                      >
                        <td className="p-3" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={selectedStopIds.has(stop.id)}
                            onCheckedChange={(checked) => toggleStopSelection(stop.id, checked === true)}
                            aria-label={t("stops.selectStop", { address: stop.address })}
                             disabled={archived}
                          />
                        </td>
                        <td className="p-3 min-w-[200px]">
                          <div className="flex gap-2">
                            {stop.jobType === "field_service" ? (
                              <Briefcase className="h-4 w-4 text-purple-500 mt-0.5 shrink-0" />
                            ) : (
                              <MapPin className="h-4 w-4 text-primary/70 mt-0.5 shrink-0" />
                            )}
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="font-bold text-sm text-foreground">{stop.notes || (stop.jobType === "field_service" ? t("stops.typeService") : t("common.deliveryStop"))}</p>
                                 {archived && (
                                   <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                                     <Archive className="h-3 w-3" /> {t("stops.archivedBadge")}
                                   </span>
                                 )}
                                {stop.jobType === "field_service" && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/10 text-purple-500">Service</span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5 max-w-[200px] truncate" title={stop.address}>{stop.address}</p>
                              {stop.pickupAddress && stop.status === "pending" && (
                                <span className="text-[10px] text-muted-foreground leading-none block mt-0.5">{t("pdStep.pickup", "Pickup step")}</span>
                              )}
                              {stop.pickupAddress && stop.status === "in_progress" && (
                                <span className="text-[10px] text-muted-foreground leading-none block mt-0.5">{t("pdStep.delivery", "Delivery step")}</span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="p-3 min-w-[180px] text-xs text-muted-foreground">
                          {dateField === "planned_delivery" && stop.timeWindowStart ? (
                            <div>
                              <p className="font-medium text-foreground">{t("stops.plannedDeliveryDate")}</p>
                              <p>{stockholmDateTime(stop.timeWindowStart)}</p>
                            </div>
                          ) : (
                            <div>
                              <p className="font-medium text-foreground">{t("stops.importedCreatedDate")}</p>
                              <p>{stockholmDateTime(stop.createdAt)}</p>
                            </div>
                          )}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", stop.pickupAddress ? "bg-blue-500/10 text-blue-500" : "bg-muted text-muted-foreground")}>
                            {stop.pickupAddress ? t("stops.typePD") : t("stops.singleStop")}
                          </span>
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", quality === "ready" ? "bg-emerald-500/10 text-emerald-600" : quality === "geocode_error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-600")}>
                            {quality === "ready" ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
                            {quality === "ready" ? t("stops.qualityReady") : quality === "geocode_error" ? t("stops.geocodeError") : t("stops.qualityIssues")}
                          </span>
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold", stop.routeId ? "bg-primary/10 text-primary" : "bg-amber-500/10 text-amber-600")}>
                            {stop.routeId ? <RouteIcon className="h-3 w-3" /> : <Inbox className="h-3 w-3" />}
                            {stop.routeId ? t("stops.planned") : t("stops.unplanned")}
                          </span>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                          {stop.timeWindowStart ? (
                            <span>{new Date(stop.timeWindowStart).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</span>
                          ) : <span>-</span>}
                          {stop.timeWindowEnd && (
                            <span> – {new Date(stop.timeWindowEnd).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                          <span>{stop.serviceDurationMin} {t("common.mins")}</span>
                          {stop.jobType === "field_service" ? (
                            <>
                              {stop.serviceCategory && <span className="ml-1 text-purple-400">· {stop.serviceCategory}</span>}
                              {stop.requiredSkills?.length ? <span className="ml-1">· Skills: {stop.requiredSkills.join(", ")}</span> : null}
                            </>
                          ) : (
                            (stop.weightKg || stop.volumeM3) ? (
                              <span className="ml-1">· {stop.weightKg || 0}kg / {stop.volumeM3 || 0}m³</span>
                            ) : null
                          )}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          {stop.routeId ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-primary/10 text-primary">
                              {vehicleByRouteId.get(stop.routeId) || t("common.assigned")}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-500 uppercase tracking-wider">
                              {t("common.unassigned")}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1 whitespace-nowrap">
                          <CustomerLinkControls stopId={stop.id} />
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            {t(stopStatusTranslationKeys[stop.status] ?? "stops.allStatuses")}
                          </span>
                          {archived && stop.archivedAt && (
                            <span className="mt-1 block text-[10px] text-muted-foreground">
                              {t("stops.archivedAt", { date: stockholmDateTime(stop.archivedAt) })}
                            </span>
                          )}
                        </td>
                        <td className={cn(
                          "px-3 py-1 text-right sticky right-0 z-10 shadow-[-1px_0_0_0_hsl(var(--border))]",
                          selectedStopId === stop.id
                            ? "bg-blue-50 dark:bg-slate-800"
                            : "bg-card group-hover:bg-muted"
                        )}>
                          <div className="flex items-center justify-end gap-1">
                             {!archived && (
                               <>
                                 <Button
                                   variant="ghost"
                                   size="icon"
                                   className="h-11 w-11 shrink-0 hover:text-primary hover:bg-primary/10"
                                   title={t("common.edit")}
                                   aria-label={t("common.edit")}
                                   onClick={(e) => { e.stopPropagation(); setEditingStop(stop); }}
                                 >
                                   <Edit2 className="h-5 w-5" />
                                 </Button>
                                 <Button
                                   variant="ghost"
                                   size="icon"
                                   className="h-11 w-11 shrink-0 hover:text-primary hover:bg-primary/10"
                                   title={t("stops.archiveAction")}
                                   aria-label={t("stops.archiveAction")}
                                   onClick={(e) => {
                                     e.stopPropagation();
                                     openArchiveConfirmation([stop.id]);
                                   }}
                                 >
                                   <Archive className="h-5 w-5" />
                                 </Button>
                               </>
                             )}
                             {archived && (
                               <Button
                                 variant="ghost"
                                 size="icon"
                                 className="h-11 w-11 shrink-0 hover:text-primary hover:bg-primary/10"
                                 title={t("stops.openArchiveDetails")}
                                 aria-label={t("stops.openArchiveDetails")}
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   setHistoryStop(stop);
                                 }}
                               >
                                 <FileCheck2 className="h-5 w-5" />
                               </Button>
                             )}
                          </div>
                        </td>
                       </tr>
                     )})}
                    {filteredStops.length === 0 && (
                      <tr>
                         <td colSpan={12} className="p-8 text-center text-muted-foreground">
                           {hasActiveColumnFilters ? t("pickupDelivery.noResults") : t("stops.noStops")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </DualHorizontalScroll>
            </div>
            {totalPages !== null && totalPages > 1 && (
              <div className="flex items-center justify-end gap-2 mt-3">
                <span className="text-xs text-muted-foreground">
                  {t("stops.pagination", { page, totalPages })}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  aria-label={t("stops.previousPage")}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  aria-label={t("stops.nextPage")}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            <AlertDialog open={deleteSnapshot.length > 0} onOpenChange={(open) => {
              if (!open && !deleting) setDeleteSnapshot([]);
            }}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("stops.deleteSelected")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("stops.bulkDeleteDescription", { count: deleteSnapshot.length })}</AlertDialogDescription>
                </AlertDialogHeader>
                {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={(event) => {
                    event.preventDefault();
                    void confirmDeletion();
                  }}>{deleting ? t("stops.bulkDeleting") : t("stops.deleteSelected")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={isArchiveOpen} onOpenChange={(open) => {
              if (isPreparingArchive || archiveMutation.isPending) return;
              setArchiveError(null);
              setIsArchiveOpen(open);
              if (!open) {
                setArchiveSnapshot([]);
                setActiveRoutesRequireConfirmation(false);
                setConfirmActiveRoutes(false);
                setAffectedRouteIds([]);
              }
            }}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("stops.archiveTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("stops.archiveDescription", { count: archiveSnapshot.length })}
                    <span className="mt-2 block">{t("stops.archiveHistoryNote")}</span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                {activeRoutesRequireConfirmation && (
                  <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                    <p className="font-medium text-amber-800 dark:text-amber-200">
                      {t("stops.archiveActiveRoutesWarning")}
                    </p>
                    {affectedRouteIds.length > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        {t("stops.archiveAffectedRoutes", { count: affectedRouteIds.length })}
                      </p>
                    )}
                    <label className="flex cursor-pointer items-start gap-2 text-xs text-amber-900 dark:text-amber-100">
                      <Checkbox
                        checked={confirmActiveRoutes}
                        onCheckedChange={(checked) => setConfirmActiveRoutes(checked === true)}
                        aria-label={t("stops.confirmArchiveActiveRoutes")}
                      />
                      <span>{t("stops.confirmArchiveActiveRoutes")}</span>
                    </label>
                  </div>
                )}
                {archiveError && (
                  <p role="alert" className="text-sm text-destructive">
                    {archiveError}
                  </p>
                )}
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isPreparingArchive || archiveMutation.isPending}>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={
                      isPreparingArchive
                      || archiveMutation.isPending
                      || archiveSnapshot.length === 0
                      || (activeRoutesRequireConfirmation && !confirmActiveRoutes)
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      void confirmBulkArchive();
                    }}
                  >
                    {isPreparingArchive || archiveMutation.isPending ? t("stops.archiving") : t("stops.archiveAction")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Dialog open={!!editingStop} onOpenChange={(open) => !open && setEditingStop(null)}>
              <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                  <DialogTitle>{t("stops.editStop")}</DialogTitle>
                  <DialogDescription className="sr-only">{t("stops.editStop")}</DialogDescription>
                </DialogHeader>
                {editingStop && organizationId && (
                  <StopForm
                    organizationId={organizationId}
                    initialData={editingStop}
                    onSuccess={() => setEditingStop(null)}
                  />
                )}
              </DialogContent>
            </Dialog>

            <Dialog open={!!historyStop} onOpenChange={(open) => !open && setHistoryStop(null)}>
              <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
                <DialogHeader>
                  <DialogTitle>{t("stops.archiveDetailTitle")}</DialogTitle>
                  <DialogDescription>
                    {historyStop?.address}
                  </DialogDescription>
                </DialogHeader>
                {historyStop && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-muted px-2 py-1 font-semibold">
                        {t("stops.archivedBadge")}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-1">
                        {t(stopStatusTranslationKeys[historyStop.status] ?? "stops.allStatuses")}
                      </span>
                      {historyStop.archivedAt && (
                        <span className="text-muted-foreground">
                          {t("stops.archivedAt", { date: stockholmDateTime(historyStop.archivedAt) })}
                        </span>
                      )}
                    </div>
                    {historyStop.executionComment && (
                      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                        <p className="font-medium">{t("stops.executionComment")}</p>
                        <p className="mt-1 text-muted-foreground">{historyStop.executionComment}</p>
                      </div>
                    )}
                    {archivedProofsError && (
                      <p role="alert" className="text-sm text-destructive">{t("stops.archiveProofsError")}</p>
                    )}
                    {isLoadingArchivedProofs ? (
                      <LoadingState message={t("stops.loadingArchiveProofs")} />
                    ) : archivedProofs.length > 0 ? (
                      <ProofDisplay proofs={archivedProofs} />
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("stops.archiveNoProofs")}</p>
                    )}
                  </div>
                )}
              </DialogContent>
            </Dialog>

          </div>
        </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={40} minSize={20}>
        <div className="h-full w-full relative">
          <MapContainer
            center={[59.33, 18.07]}
            zoom={11}
            className="h-full w-full"
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <InvalidateOnResize />
            <FlyToStop stop={selectedStop} />
            {filteredStops.filter((s) => s.latitude && s.longitude).map((stop) => (
              <Marker
                key={stop.id}
                position={[stop.latitude, stop.longitude]}
                icon={makeIcon(selectedStopId === stop.id, !!stop.routeId)}
                eventHandlers={{
                  click: () => setSelectedStopId(selectedStopId === stop.id ? null : stop.id),
                }}
              >
                <Popup className="dark-popup">
                  <div className="text-xs">
                    <p className="font-bold">{stop.notes || stop.address}</p>
                    <p className="text-muted-foreground">{stop.address}</p>
                    {stop.weightKg && <p>{stop.weightKg} kg</p>}
                    {stop.routeId ? (
                      <p className="text-primary">{vehicleByRouteId.get(stop.routeId) || t("common.assigned")}</p>
                    ) : (
                      <p className="text-amber-500">{t("common.unassigned")}</p>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </AppLayout>
  );
}

function isoToDatetimeLocal(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function StopForm({ initialData, onSuccess, onCancel, organizationId, plan }: {
  initialData?: Stop;
  onSuccess: () => void;
  onCancel?: () => void;
  organizationId: string;
  plan?: { id: string; routes: Array<{ routeId: string; planRevision: number }> };
}) {
  const createMutation = useCreateStop();
  const queryClient = useQueryClient();
  const createPlanMutation = useCreateRoutePlanStop({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
          invalidateRouteQueries(queryClient),
        ]);
      },
    },
  });
  const updateMutation = useUpdateStop();
  const { t } = useTranslation();
  const { toast } = useToast();

  const { data: orgSettings } = useQuery({
    queryKey: ["/api/org-settings", organizationId],
    queryFn: () => fetch(`${API_BASE}/api/organizations/${organizationId}/settings?organizationId=${organizationId}`).then(r => r.json()),
    enabled: !!organizationId,
  });

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<z.input<ReturnType<typeof createStopSchema>>, unknown, StopFormValues>({
    resolver: zodResolver(createStopSchema(t)),
    defaultValues: initialData ? {
      ...initialData,
      notes: initialData.notes || "",
      weightKg: initialData.weightKg || null,
      volumeM3: initialData.volumeM3 || null,
      jobType: initialData.jobType === "field_service"
        ? "field_service"
        : initialData.pickupAddress
          ? "pickup_delivery"
          : "delivery",
      timeWindowStart: isoToDatetimeLocal(initialData.timeWindowStart),
      timeWindowEnd: isoToDatetimeLocal(initialData.timeWindowEnd),
      slaDeadline: isoToDatetimeLocal(initialData.slaDeadline),
      requiredSkills: initialData.requiredSkills?.join(", ") || "",
      requiredCertifications: initialData.requiredCertifications?.join(", ") || "",
      requiredEquipment: initialData.requiredEquipment?.join(", ") || "",
    } : {
      serviceDurationMin: 5,
      latitude: plan ? undefined : 59.33258,
      longitude: plan ? undefined : 18.0649,
      jobType: "delivery"
    }
  });

  const currentJobType = watch("jobType");
  const isFieldService = currentJobType === "field_service";
  const opMode = orgSettings?.operatingMode || "transport";

  // Auto-set jobType if org is strictly one mode
  useEffect(() => {
    if (!initialData) {
      if (opMode === "field_service") setValue("jobType", "field_service");
      if (opMode === "transport") setValue("jobType", "delivery");
    }
  }, [opMode, initialData, setValue]);

  const isPending = createMutation.isPending || createPlanMutation.isPending || updateMutation.isPending;

  const onSubmit = (data: StopFormValues) => {
    const splitArr = (str?: string) => str ? str.split(",").map(s => s.trim()).filter(Boolean) : null;
    const datetimeToIso = (v?: string | null) => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d.toISOString();
    };

    let finalJobType = data.jobType as any;
    if (finalJobType !== "field_service" && data.pickupAddress?.trim()) {
      finalJobType = "pickup_delivery";
    } else if (finalJobType === "pickup_delivery" && !data.pickupAddress?.trim()) {
      finalJobType = "delivery";
    }

    const payload = {
      ...data,
      jobType: finalJobType,
      timeWindowStart: datetimeToIso(data.timeWindowStart),
      timeWindowEnd: datetimeToIso(data.timeWindowEnd),
      slaDeadline: datetimeToIso(data.slaDeadline),
      requiredSkills: splitArr(data.requiredSkills),
      requiredCertifications: splitArr(data.requiredCertifications),
      requiredEquipment: splitArr(data.requiredEquipment),
    };

    if (finalJobType === "field_service") {
      payload.weightKg = null;
      payload.volumeM3 = null;
      payload.pickupAddress = null;
      payload.pickupLatitude = null;
      payload.pickupLongitude = null;
    } else {
      payload.serviceCategory = null;
      payload.priority = null;
      payload.slaDeadline = null;
      payload.serviceInstructions = null;
      payload.requiredSkills = null;
      payload.requiredCertifications = null;
      payload.requiredEquipment = null;
    }

    if (initialData) {
      updateMutation.mutate({ id: initialData.id, data: payload }, { onSuccess });
    } else if (plan) {
      createPlanMutation.mutate({
        planId: plan.id,
        data: { stop: { ...payload, organizationId }, routes: plan.routes },
      }, {
        onSuccess,
        onError: (error) => toast({
          title: t("stops.planStopError"),
          description: (error as { status?: number }).status === 409
            ? t("stops.planStopConflict")
            : localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }),
          variant: "destructive",
        }),
      });
    } else {
      createMutation.mutate({ data: { ...payload, organizationId } }, { onSuccess });
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 pt-4 max-h-[80vh] overflow-y-auto px-1">
      {opMode === "mixed" && (
        <div className="space-y-2 pb-2 border-b border-border">
          <Label>{t("stops.jobType")}</Label>
          <Select value={currentJobType} onValueChange={(v) => setValue("jobType", v as any)}>
            <SelectTrigger data-testid="select-job-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="delivery" data-testid="option-job-delivery">{t("stops.typeDelivery")}</SelectItem>
              <SelectItem value="pickup_delivery" data-testid="option-job-pd">{t("stops.typePD")}</SelectItem>
              <SelectItem value="field_service" data-testid="option-job-service">{t("stops.typeService")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label>{t("stops.notes")}</Label>
        <Input {...register("notes")} placeholder={t("stops.notesPlaceholder")} />
      </div>

      <div className="space-y-2">
        <Label>{t("stops.address")}</Label>
        <Input {...register("address")} placeholder={t("stops.addressPlaceholder")} />
        {errors.address && <span className="text-xs text-destructive">{errors.address.message}</span>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("stops.latitude")}</Label>
          <Input type="number" step="any" {...register("latitude")} />
        </div>
        <div className="space-y-2">
          <Label>{t("stops.longitude")}</Label>
          <Input type="number" step="any" {...register("longitude")} />
        </div>
      </div>
      {plan && <p className="text-xs text-muted-foreground">{t("stops.planCoordinateHint")}</p>}

      <div className="space-y-2">
        <Label>{t("stops.serviceDuration")}</Label>
        <Input type="number" {...register("serviceDurationMin")} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>{t("stops.timeWindowStart")}</Label>
          <Input type="datetime-local" {...register("timeWindowStart")} />
        </div>
        <div className="space-y-2">
          <Label>{t("stops.timeWindowEnd")}</Label>
          <Input type="datetime-local" {...register("timeWindowEnd")} />
        </div>
      </div>

      {!isFieldService && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("stops.weightKg")}</Label>
              <Input type="number" step="any" {...register("weightKg")} placeholder={t("stops.weightPlaceholder")} />
            </div>
            <div className="space-y-2">
              <Label>{t("stops.volumeM3")}</Label>
              <Input type="number" step="any" {...register("volumeM3")} placeholder={t("stops.volumePlaceholder")} />
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t("pickupDelivery.pickupSection", "Pickup address (optional)")}
            </p>
            <div className="space-y-2">
              <Label>{t("pickupDelivery.pickupAddress")}</Label>
              <Input {...register("pickupAddress")} placeholder={t("pickupDelivery.pickupAddressPlaceholder", "Leave empty if no pickup required")} />
            </div>
            <div className="grid grid-cols-2 gap-4 mt-3">
              <div className="space-y-2">
                <Label>{t("stops.latitude")} ({t("pickupDelivery.pickupAddress")})</Label>
                <Input type="number" step="any" {...register("pickupLatitude")} placeholder={t("stops.optional", "optional")} />
              </div>
              <div className="space-y-2">
                <Label>{t("stops.longitude")} ({t("pickupDelivery.pickupAddress")})</Label>
                <Input type="number" step="any" {...register("pickupLongitude")} placeholder={t("stops.optional", "optional")} />
              </div>
            </div>
          </div>
        </>
      )}

      {isFieldService && (
        <div className="border-t border-border pt-4 space-y-4">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Briefcase className="h-3.5 w-3.5" /> {t("stops.serviceDetails")}
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("stops.serviceCategory")}</Label>
              <Input {...register("serviceCategory")} placeholder="e.g. HVAC, Plumbing" data-testid="input-service-category" />
            </div>
            <div className="space-y-2">
              <Label>{t("stops.priority")}</Label>
              <Input type="number" min={1} max={10} {...register("priority")} placeholder={t("stops.priorityPlaceholder")} data-testid="input-service-priority" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("stops.slaDeadline")}</Label>
            <Input type="datetime-local" {...register("slaDeadline")} data-testid="input-service-sla" />
          </div>

          <div className="space-y-2">
            <Label>{t("stops.serviceInstructions")}</Label>
            <Textarea {...register("serviceInstructions")} placeholder="Instructions for the technician..." className="resize-none" data-testid="input-service-instructions" />
          </div>

          <div className="space-y-2">
            <Label>{t("stops.requiredSkills")}</Label>
            <Input {...register("requiredSkills")} placeholder="Electrical, Level2" data-testid="input-service-skills" />
          </div>

          <div className="space-y-2">
            <Label>{t("stops.requiredCertifications")}</Label>
            <Input {...register("requiredCertifications")} placeholder="CERT-123, OSHA" data-testid="input-service-certs" />
          </div>

          <div className="space-y-2">
            <Label>{t("stops.requiredEquipment")}</Label>
            <Input {...register("requiredEquipment")} placeholder="Ladder, Drill" data-testid="input-service-equip" />
          </div>
        </div>
      )}

      <div className="pt-4 flex justify-end gap-2">
        {createMutation.isError && <p role="alert" className="text-sm text-destructive">{localizeError(createMutation.error, t, { fallbackKey: "stops.createError" })}</p>}
        <Button type="button" variant="outline" onClick={onCancel ?? onSuccess}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={isPending} className="bg-primary text-primary-foreground">
          {isPending ? t("common.saving") : t("stops.saveStop")}
        </Button>
      </div>
    </form>
  );
}
