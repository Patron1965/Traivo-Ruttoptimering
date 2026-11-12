import { AppLayout } from "@/components/layout/AppLayout";
import { RouteBuilderTabs } from "@/components/layout/WorkspaceTabs";
import { useVehicles } from "@/hooks/use-vehicles";
import { useDrivers } from "@/hooks/use-drivers";
import { useStops } from "@/hooks/use-stops";
import { useAdjustAssignedRoutes, useOptimizeRoutes, useRoutes } from "@/hooks/use-routes";
import { LoadingState } from "@/components/ui/LoadingState";
import { Button } from "@/components/ui/button";
import { useState, useMemo, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { DEPOT_LOCATION } from "@/lib/constants";
import { useAuth } from "@/lib/auth-context";
import { buildProfileByResourceId } from "@/lib/resources";
import { RouteMap } from "@/components/map/RouteMap";
import { formatDistance } from "@/lib/utils";
import type { DropResult } from "@hello-pangea/dnd";
import { useTranslation } from "react-i18next";
import { getErrorStatus, hasErrorCode, localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import { AlternativePlans } from "@/components/AlternativePlans";
import { LargeOptimizationProgressPanel } from "@/components/LargeOptimizationProgressPanel";
import { ContinuousOptimization } from "@/components/ContinuousOptimization";
import { PlanStatusChain } from "@/components/planning/PlanStatusChain";
import { routePlanSelectionStorageKey } from "@/lib/route-plan-export-selection";
import type { RoutePlanningObjective } from "@/lib/planning-objectives";
import {
  NO_VALUE, dispatchScopeHref, displayedPlanMismatch, optimizationDateFor, filterVisibleStops, isLateForWindow, pruneSelection, resolveScope,
  sourceSignature, stepAvailability, stopsInScope, type PlannerScope, type PlannerStep,
} from "@/lib/planner-workflow";
import { PlannerStepRail } from "@/components/planner/PlannerStepRail";
import { PlannerScopeBar } from "@/components/planner/PlannerScopeBar";
import { SourceJobList, JobRow } from "@/components/planner/SourceJobList";
import { ResourceList } from "@/components/planner/ResourceList";
import { OptimizerSettings } from "@/components/planner/OptimizerSettings";
import { StopDetailPanel } from "@/components/planner/StopDetailPanel";
import { OptimizationProgressPanel } from "@/components/planner/OptimizationProgressPanel";
import { PlannerResultStrip } from "@/components/planner/PlannerResultStrip";
import { RouteAssignments, serviceStartByStop } from "@/components/planner/RouteAssignments";
import { ReviewSummary } from "@/components/planner/ReviewSummary";
import { ResizableSidePanel } from "@/components/planner/ResizableSidePanel";
import type { OptimizationTiming, OptimizedRouteResult, OptimizedStopRef, SaveStatus } from "@/components/planner/types";
import {
  getGetImportRoutePlanApprovalQueryKey,
  type Driver,
  type Stop,
  type Vehicle,
  type Route,
  useApproveExecutionRedistribution,
  useGetImportRoutePlanApproval,
} from "@workspace/api-client-react";
import { AlertCircle, ArrowLeft, ArrowRight, ArrowUpRight, Cpu, History, Loader2, Thermometer } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type OptimizationProfile = RoutePlanningObjective;

export function mergeDeliveriesIntoItinerary(
  itinerary: OptimizedStopRef[],
  deliveries: OptimizedStopRef[],
): OptimizedStopRef[] {
  let deliveryIndex = 0;
  const merged = itinerary.flatMap((entry) => {
    if (entry.isChargingStop) return [entry];
    const replacement = deliveries[deliveryIndex++];
    return replacement ? [replacement] : [];
  });
  if (deliveryIndex < deliveries.length) {
    merged.push(...deliveries.slice(deliveryIndex));
  }
  return merged.map((entry, index) => ({ ...entry, sequenceOrder: index + 1 }));
}

function formatOptimizationDuration(milliseconds: number): string {
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`
    : `${milliseconds} ms`;
}

export default function Planner() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const [, navigate] = useLocation();
  const { data: vehicles, isLoading: loadingV } = useVehicles();
  const { data: drivers } = useDrivers();
  const { data: stops, isLoading: loadingS } = useStops();
  const optimizeMutation = useOptimizeRoutes();
  const adjustMutation = useAdjustAssignedRoutes();
  const { data: existingRoutes, refetch: refetchRoutes } = useRoutes();
  const approveExecutionRedistribution = useApproveExecutionRedistribution({
    mutation: { onSuccess: () => { void refetchRoutes(); } },
  });
  const pendingExecutionSuggestions = (existingRoutes ?? []).filter(
    (route) => (route as Route & { redistributionSuggestion?: { status?: string } }).redistributionSuggestion?.status === "pending_approval",
  );
  const { t } = useTranslation();

  // Internal profile lookup per resource (vehicle id). Never exposed as a pairing step.
  const driverByVehicleId = useMemo(() => buildProfileByResourceId(vehicles, drivers), [vehicles, drivers]);

  const [step, setStep] = useState<PlannerStep>(1);
  const [sourceTab, setSourceTab] = useState<"jobs" | "resources">("jobs");
  const [scope, setScope] = useState<PlannerScope>({ project: null, date: null, area: null, search: "" });
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const [builtSignature, setBuiltSignature] = useState<string | null>(null);
  /** Day of the routes currently displayed (from server/request), not the filter. */
  const [builtDay, setBuiltDay] = useState<string | null>(null);
  const [detailStopId, setDetailStopId] = useState<string | null>(null);
  const [selectedVehicleIds, setSelectedVehicleIds] = useState<Set<string>>(new Set());
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [dndRoutes, setDndRoutes] = useState<OptimizedRouteResult[] | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [showPredictions, setShowPredictions] = useState(false);
  const [optimizationProfile, setOptimizationProfile] = useState<OptimizationProfile>("balanced");
  const [balanceVehicles, setBalanceVehicles] = useState(false);
  const [optimizationStopCount, setOptimizationStopCount] = useState(0);
  const [usagePreview, setUsagePreview] = useState<{ warnings: string[]; blocked: string | null; estimatedCostOre: number | null } | null>(null);
  const [usagePreviewError, setUsagePreviewError] = useState(false);
  const [conflictPlanId, setConflictPlanId] = useState<string | null>(null);
  const isLargeOptimization = optimizationStopCount > 100;
  useEffect(() => {
    if (!organizationId || selectedStopIds.size === 0) {
      setUsagePreview(null);
      setUsagePreviewError(false);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/optimize/usage-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, stopCount: selectedStopIds.size }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Usage preview unavailable");
        setUsagePreview(await response.json());
        setUsagePreviewError(false);
      } catch {
        if (!controller.signal.aborted) {
          setUsagePreview(null);
          setUsagePreviewError(true);
        }
      }
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [organizationId, selectedStopIds.size]);
  const optimizationTiming = (
    optimizeMutation.data as (typeof optimizeMutation.data & { optimizationTiming?: OptimizationTiming }) | undefined
  )?.optimizationTiming;

  const liveStops = useMemo(() => stops?.filter((s) => !s.archivedAt) ?? [], [stops]);
  const unassignedStops = useMemo(() => liveStops.filter((s) => !s.routeId), [liveStops]);
  const activeVehicles = useMemo(() => vehicles?.filter(v => v.isActive) || [], [vehicles]);

  // Scope: one project and one day at a time, from real stop fields only.
  const resolvedScope = useMemo(() => resolveScope(liveStops, scope), [liveStops, scope]);
  const scopedUnassigned = useMemo(() => stopsInScope(unassignedStops, resolvedScope), [unassignedStops, resolvedScope]);
  const visibleStops = useMemo(
    () => filterVisibleStops(scopedUnassigned, scope.area, scope.search),
    [scopedUnassigned, scope.area, scope.search],
  );
  const hiddenSelected = useMemo(() => {
    const visible = new Set(visibleStops.map((s) => s.id));
    return [...selectedStopIds].filter((id) => !visible.has(id)).length;
  }, [visibleStops, selectedStopIds]);
  const projectLabel = useMemo(() => {
    const names = new Map<string, string>();
    existingRoutes?.forEach((r) => { if (r.planId && !names.has(r.planId)) names.set(r.planId, r.name); });
    return (value: string) => value === NO_VALUE ? "Utan projekt" : names.get(value) ?? `Projekt ${value.slice(0, 8)}`;
  }, [existingRoutes]);

  const changeScope = (next: PlannerScope) => {
    const nextResolved = resolveScope(liveStops, next);
    if (nextResolved.project !== resolvedScope.project || nextResolved.date !== resolvedScope.date) {
      const allowed = new Set(stopsInScope(unassignedStops, nextResolved).map((s) => s.id));
      const { next: kept, removed } = pruneSelection(selectedStopIds, allowed);
      setSelectedStopIds(kept);
      setScopeNotice(removed > 0 ? `${removed} valda jobb hörde till annat projekt eller annan dag och togs bort ur urvalet.` : null);
    }
    setScope(next);
  };

  const currentSignature = sourceSignature(resolvedScope.project, resolvedScope.date, selectedStopIds, selectedVehicleIds);
  const sourceDirty = Boolean(dndRoutes && builtSignature && builtSignature !== currentSignature);
  const optimizationDate = optimizationDateFor(resolvedScope.date);
  const todayDay = new Date().toISOString().slice(0, 10);

  const explicitSelectedPlanId = useMemo(() => {
    if (!organizationId || typeof window === "undefined") return null;
    return window.sessionStorage.getItem(routePlanSelectionStorageKey(organizationId));
  }, [organizationId, existingRoutes]);
  const resumablePlan = useMemo(() => {
    const availableRoutes = (existingRoutes ?? []).filter((candidate) => candidate.status !== "cancelled");
    const explicitlySelectedRoutes = explicitSelectedPlanId
      ? availableRoutes.filter((candidate) => candidate.planId === explicitSelectedPlanId)
      : [];
    const candidates = explicitlySelectedRoutes.length > 0 ? explicitlySelectedRoutes : availableRoutes;
    const route = [...candidates]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    if (!route) return null;
    const planRoutes = existingRoutes?.filter((candidate) => candidate.planId === route.planId) ?? [route];
    return {
      planId: route.planId,
      revision: Math.max(...planRoutes.map((candidate) => candidate.planRevision)),
      routes: planRoutes,
      stage: planRoutes.every((candidate) => !candidate.manualReviewRequired || candidate.manualReviewedAt)
        ? 4
        : planRoutes.some((candidate) => candidate.planRevision > 0)
          ? 3
          : 2,
      routeCount: planRoutes.length,
    };
  }, [existingRoutes, explicitSelectedPlanId]);
  const plannerPlanId = dndRoutes?.[0]?.planId ?? resumablePlan?.planId ?? "";
  const plannerApprovalQuery = useGetImportRoutePlanApproval(plannerPlanId, {
    query: {
      queryKey: getGetImportRoutePlanApprovalQueryKey(plannerPlanId),
      enabled: Boolean(plannerPlanId),
      staleTime: 0,
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    },
  });

  const stopsById = useMemo(() => {
    const map = new Map<string, Stop>();
    stops?.forEach(s => map.set(s.id, s));
    return map;
  }, [stops]);

  const vehiclesById = useMemo(() => {
    const map = new Map<string, Vehicle>();
    vehicles?.forEach(v => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const mapRoutes = useMemo(() => {
    const source = dndRoutes || (optimizeMutation.data?.routes as OptimizedRouteResult[] | undefined);
    if (!source) return undefined;
    return source.map((r) => {
      const vehicle = vehiclesById.get(r.vehicleId);
      const stopsList = [...r.stops]
        .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
        .map((ref) => stopsById.get(ref.stopId))
        .filter((s): s is Stop => !!s)
        .map((s, idx) => ({ ...s, sequenceOrder: idx + 1 }));
      return {
        id: r.routeId,
        planId: r.planId,
        name: vehicle?.name ? `${vehicle.name} ${t("common.route")}` : t("common.route"),
        status: "optimized" as const,
        manualReviewRequired: false,
        manualReviewedAt: null,
        planRevision: r.planRevision,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null,
        receivedAt: null,
        openedAt: null,
        acceptedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        organizationId: organizationId!,
        vehicleId: r.vehicleId,
        date: builtDay ? `${builtDay}T00:00:00Z` : new Date().toISOString(),
        totalDistanceKm: r.distanceKm,
        totalDurationMin: r.durationMin,
        co2EmissionsKg: r.co2EmissionsKg,
        totalStops: stopsList.length,
        routeColor: vehicle?.routeColor,
        geographicOverlapExplanation: r.geographicOverlapExplanation ?? null,
        depotSnapshot: r.depotSnapshot ?? null,
        workdayTimeline: r.workdayTimeline ?? null,
        workdaySummary: r.workdaySummary ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stopsList,
      } satisfies Route & { stopsList: Stop[]; routeColor?: string };
    });
  }, [dndRoutes, optimizeMutation.data, vehiclesById, stopsById, organizationId, t, builtDay]);

  const toggleVehicle = (id: string) => {
    const next = new Set(selectedVehicleIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedVehicleIds(next);
  };

  const toggleStop = (id: string) => {
    const next = new Set(selectedStopIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedStopIds(next);
  };

  const handleOptimize = () => {
    if (!organizationId || selectedVehicleIds.size === 0 || selectedStopIds.size === 0 || usagePreview?.blocked) return;
    setOptimizationStopCount(selectedStopIds.size);
    const signatureAtStart = currentSignature;
    const dayAtStart = optimizationDate ? resolvedScope.date : todayDay;

    optimizeMutation.mutate({
      data: {
        organizationId,
        vehicleIds: Array.from(selectedVehicleIds),
        stopIds: Array.from(selectedStopIds),
        depotLatitude: DEPOT_LOCATION.lat,
        depotLongitude: DEPOT_LOCATION.lng,
        ...(optimizationDate ? { date: optimizationDate } : {}),
        planningInputs: {
          version: 1,
          objective: optimizationProfile,
          travelReservePercent: 0,
          stopReserveMin: 0,
          stopPriorities: {},
          excludedPairValues: [],
          depotOverride: null,
          vehicleSelectionMode: balanceVehicles
            ? "use_all_selected_pairs"
            : "minimize_vehicles",
        },
      },
    }, {
      onSuccess: (data) => {
        setDndRoutes(data.routes as OptimizedRouteResult[]);
        setBuiltSignature(signatureAtStart);
        setBuiltDay(dayAtStart);
        setSaveStatus("idle");
        setSaveMessage(null);
        if (organizationId && data.planId) {
          sessionStorage.setItem(
            routePlanSelectionStorageKey(organizationId),
            data.planId,
          );
        }
      }
    });
  };

  const loadPersistedPlan = async (
    planId: string,
    routeSource: Route[] = existingRoutes ?? [],
  ): Promise<void> => {
    const planRoutes = routeSource.filter((route) => route.planId === planId);
    if (planRoutes.length === 0) {
      throw new TrustedLocalizedError(t("planner.savedPlanNotFound"));
    }
    const persistedEvidence = planRoutes
      .map((route) => route.planningSummary?.optimizationEvidence)
      .find((evidence) => evidence?.source === "planningInputs");
    if (persistedEvidence?.effectiveObjective === "balanced" ||
        persistedEvidence?.effectiveObjective === "shortest" ||
        persistedEvidence?.effectiveObjective === "geographic" ||
        persistedEvidence?.effectiveObjective === "areas_worktime") {
      setOptimizationProfile(persistedEvidence.effectiveObjective);
      setBalanceVehicles(
        persistedEvidence.vehicleSelectionMode === "use_all_selected_pairs",
      );
    }

    const loaded = await Promise.all(planRoutes.map(async (summary) => {
      const [routeResponse, stopsResponse] = await Promise.all([
        fetch(`/api/routes/${summary.id}`, { credentials: "include" }),
        fetch(`/api/routes/${summary.id}/stops`, { credentials: "include" }),
      ]);
      if (!routeResponse.ok || !stopsResponse.ok) {
        throw new TrustedLocalizedError(t("planner.serverVersionUnavailable"));
      }
      const route = await routeResponse.json() as Route;
      const routeStops = await stopsResponse.json() as Stop[];
      const persistedItinerary = route.plannerItinerary?.length
        ? route.plannerItinerary
        : [...routeStops]
            .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0))
            .map((stop, index) => ({
              stopId: stop.id,
              sequenceOrder: index + 1,
              estimatedArrival: new Date().toISOString(),
              distanceFromPreviousKm: 0,
            }));
      return {
        vehicleId: route.vehicleId!,
        routeId: route.id,
        planId: route.planId,
        planRevision: route.planRevision,
        stops: persistedItinerary,
        distanceKm: route.totalDistanceKm ?? 0,
        durationMin: route.totalDurationMin ?? 0,
        co2EmissionsKg: route.co2EmissionsKg ?? 0,
        geographicOverlapExplanation: route.geographicOverlapExplanation ?? undefined,
        workdaySummary: route.workdaySummary ?? undefined,
        workdayTimeline: route.workdayTimeline ?? undefined,
        depotSnapshot: route.depotSnapshot ?? undefined,
      } satisfies OptimizedRouteResult;
    }));
    setDndRoutes(loaded);
    setBuiltDay(planRoutes[0]?.date?.slice(0, 10) ?? null);
  };

  const restoreServerPlan = async (planId: string): Promise<void> => {
    const refreshed = await refetchRoutes();
    await loadPersistedPlan(planId, refreshed.data ?? []);
  };

  const getAdjustmentError = (error: unknown): { status?: number; error: unknown } => {
    if (error && typeof error === "object") {
      const status = (error as { status?: unknown }).status;
      return {
        status: typeof status === "number" ? status : undefined,
        error,
      };
    }
    return { error };
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination || !dndRoutes) return;

    const sourceDriverIdx = parseInt(result.source.droppableId.replace("driver-", ""));
    const destDriverIdx = parseInt(result.destination.droppableId.replace("driver-", ""));
    const sourceIdx = result.source.index;
    const destIdx = result.destination.index;

    const newRoutes = dndRoutes.map(r => ({
      ...r,
      stops: [...r.stops],
      geographicOverlapExplanation: undefined,
    }));

    const sourceItinerary = newRoutes[sourceDriverIdx].stops;
    const destinationItinerary = newRoutes[destDriverIdx].stops;
    const sourceDraggable = sourceItinerary.filter(s => !s.isChargingStop);
    const destDraggable = sourceDriverIdx === destDriverIdx
      ? sourceDraggable
      : destinationItinerary.filter(s => !s.isChargingStop);

    const [movedStop] = sourceDraggable.splice(sourceIdx, 1);
    destDraggable.splice(destIdx, 0, movedStop);

    newRoutes[sourceDriverIdx].stops = mergeDeliveriesIntoItinerary(
      sourceItinerary,
      sourceDraggable,
    );
    if (sourceDriverIdx !== destDriverIdx) {
      newRoutes[destDriverIdx].stops = mergeDeliveriesIntoItinerary(
        destinationItinerary,
        destDraggable,
      );
    }

    const previousRoutes = dndRoutes;
    const planId = newRoutes[0]?.planId;
    setDndRoutes(newRoutes);
    setSaveStatus("saving");
    setSaveMessage(null);

    try {
      if (!planId) throw new TrustedLocalizedError(t("planner.planIdMissing"));
      const adjustments = newRoutes.map((route) => {
        const driver = driverByVehicleId.get(route.vehicleId);
        if (!driver) {
          const name = vehiclesById.get(route.vehicleId)?.name ?? route.vehicleId;
          throw new TrustedLocalizedError(`Resursen ${name} saknar entydig driftprofil och behöver granskas under Resurser.`);
        }
        return {
          routeId: route.routeId,
          planRevision: route.planRevision,
          driverId: driver.id,
          stopIds: route.stops
            .filter((stop) => !stop.isChargingStop)
            .map((stop) => stop.stopId),
          plannerItinerary: route.stops,
        };
      });
      const result = await adjustMutation.mutateAsync({
        data: {
          planId,
          routes: adjustments,
          depotLatitude: DEPOT_LOCATION.lat,
          depotLongitude: DEPOT_LOCATION.lng,
        },
      });
      const savedById = new Map(result.routes.map((route) => [route.routeId, route]));
      setDndRoutes((current) => current?.map((route) => {
        const saved = savedById.get(route.routeId);
        return saved ? {
          ...route,
          planRevision: saved.planRevision,
          distanceKm: saved.totalDistanceKm,
          durationMin: saved.totalDurationMin,
          depotSnapshot: saved.depotSnapshot ?? route.depotSnapshot,
          workdayTimeline: saved.workdayTimeline ?? route.workdayTimeline,
          workdaySummary: saved.workdaySummary ?? route.workdaySummary,
        } : route;
      }) ?? null);
      setSaveStatus("saved");
      setSaveMessage(t("planner.changesSaved"));
    } catch (error) {
      const details = getAdjustmentError(error);
      const lockedFirstStopConflict = hasErrorCode(
        details.error,
        "LOCKED_FIRST_STOP_CONFLICT",
      );
      if (details.status !== 409) setDndRoutes(previousRoutes);
      setSaveStatus(details.status === 409 ? "conflict" : "error");
      setSaveMessage(
        lockedFirstStopConflict
          ? localizeError(details.error, t, { fallbackKey: "common.errorRequestFailed" })
          : details.status === 409
           ? t("planner.planChangedByOther")
          : localizeError(details.error, t, { fallbackKey: "common.errorRequestFailed" }),
      );
      if (details.status === 409 && planId) setConflictPlanId(planId);
    }
  };

  // ---- Derived workflow facts ------------------------------------------------
  const availability = stepAvailability({
    selectedStops: selectedStopIds.size,
    selectedVehicles: selectedVehicleIds.size,
    hasRoutes: Boolean(dndRoutes),
  });
  const goTo = (next: PlannerStep) => { if (availability[next].enabled) setStep(next); };
  const effectiveStep: PlannerStep = availability[step].enabled ? step : 1;

  const optimizeResult = optimizeMutation.data;
  const resultIsCurrent = Boolean(dndRoutes && optimizeResult && dndRoutes[0]?.planId === optimizeResult.planId);
  const unassignedAfterOptimize = resultIsCurrent ? optimizeResult?.unassignedStopIds.length ?? 0 : 0;
  const routeFacts = useMemo(() => {
    if (!dndRoutes) return { overtime: 0, late: 0 };
    let overtime = 0;
    let late = 0;
    for (const route of dndRoutes) {
      if ((route.workdaySummary?.overtimeMin ?? 0) > 0) overtime += 1;
      const starts = serviceStartByStop(route);
      for (const ref of route.stops) {
        if (!ref.isChargingStop && isLateForWindow(stopsById.get(ref.stopId)?.timeWindowEnd, starts.get(ref.stopId))) late += 1;
      }
    }
    return { overtime, late };
  }, [dndRoutes, stopsById]);

  const activePlanRoutes = useMemo(
    () => (dndRoutes?.[0]?.planId ? (existingRoutes ?? []).filter((r) => r.planId === dndRoutes[0].planId) : []),
    [dndRoutes, existingRoutes],
  );
  // Identity of the displayed plan comes from the plan itself, never the filter.
  const planDay = activePlanRoutes[0]?.date?.slice(0, 10) ?? builtDay;
  const displayedProject = (() => {
    const first = dndRoutes?.flatMap((r) => r.stops).find((ref) => !ref.isChargingStop);
    const stop = first ? stopsById.get(first.stopId) : undefined;
    return stop ? stop.planningPlanId || NO_VALUE : null;
  })();
  const planMismatch = Boolean(dndRoutes) && displayedPlanMismatch(
    { day: planDay, project: displayedProject },
    { date: resolvedScope.date, project: resolvedScope.project },
  );
  const dispatchHref = dndRoutes?.[0]?.planId ? dispatchScopeHref(dndRoutes[0].planId, planDay) : null;

  const resourceNames = {
    vehicles: Object.fromEntries((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle.name])),
    drivers: Object.fromEntries((drivers ?? []).map((driver) => [driver.id, driver.name])),
  };
  const approvalStateError = plannerApprovalQuery.error && getErrorStatus(plannerApprovalQuery.error) !== 404
    ? t("planner.statusLoadFailed")
    : null;

  const detailStop = detailStopId ? stopsById.get(detailStopId) ?? null : null;
  const selectedStopsList = useMemo(
    () => [...selectedStopIds].map((id) => stopsById.get(id)).filter((s): s is Stop => !!s),
    [selectedStopIds, stopsById],
  );
  const mapUnassigned = dndRoutes ? [] : effectiveStep === 1 ? visibleStops : selectedStopsList;

  const resetProposal = () => {
    setDndRoutes(null);
    setBuiltSignature(null);
    setBuiltDay(null);
    setSaveStatus("idle");
    setSaveMessage(null);
  };

  const scopePrompt = resolvedScope.needs === "project"
    ? "Välj projekt för att se jobben. Jobb från olika projekt blandas inte."
    : resolvedScope.needs === "date"
      ? "Projektet har jobb på flera dagar. Välj dag för att se jobben."
      : liveStops.length === 0 ? t("planner.noUnassignedStops")
        : scopedUnassigned.length === 0 ? "Alla jobb i valt projekt och dag är redan planerade."
          : t("common.noResults");

  if (loadingV || loadingS) return <AppLayout><LoadingState message={t("planner.loadingPlanner")} /></AppLayout>;

  const optimizeDisabled = selectedVehicleIds.size === 0 || selectedStopIds.size === 0 || optimizeMutation.isPending || !!usagePreview?.blocked;
  const usageNotice = selectedStopIds.size > 0 && (usagePreview?.blocked || usagePreview?.warnings.length || usagePreviewError) ? (
    <div className="space-y-0.5 rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5 text-[11px]" role="status">
      <p>Jobbstorlek: {selectedStopIds.size} stopp. {usagePreview?.estimatedCostOre == null ? "Uppskattad kostnad: okänd." : `Uppskattad kostnad: ${(usagePreview.estimatedCostOre / 100).toFixed(2)} kr.`}</p>
      {usagePreview?.blocked && <p className="font-semibold text-destructive">{usagePreview.blocked}</p>}
      {usagePreview?.warnings.map((warning, index) => <p key={index} className="text-amber-700 dark:text-amber-300">{warning}</p>)}
      {usagePreviewError && <p className="text-muted-foreground">Kunde inte hämta förbrukningsbedömningen. Servern kontrollerar gränser vid start.</p>}
    </div>
  ) : null;

  const settings = (
    <OptimizerSettings
      objective={optimizationProfile}
      onObjective={setOptimizationProfile}
      balanceVehicles={balanceVehicles}
      onBalanceVehicles={setBalanceVehicles}
      locked={Boolean(dndRoutes)}
      advanced={(
        <>
          {!dndRoutes && (
            <AlternativePlans
              organizationId={organizationId!}
              vehicleIds={Array.from(selectedVehicleIds)}
              stopIds={Array.from(selectedStopIds)}
              depotLatitude={DEPOT_LOCATION.lat}
              depotLongitude={DEPOT_LOCATION.lng}
              onSelectPlan={(plan) => {
                setOptimizationStopCount(selectedStopIds.size);
                const signatureAtStart = currentSignature;
                const dayAtStart = optimizationDate ? resolvedScope.date : todayDay;
                optimizeMutation.mutate({
                  data: {
                    organizationId: organizationId!,
                    vehicleIds: Array.from(selectedVehicleIds),
                    stopIds: Array.from(selectedStopIds),
                    depotLatitude: DEPOT_LOCATION.lat,
                    depotLongitude: DEPOT_LOCATION.lng,
                    optimizationWeights: plan.weights,
                    ...(optimizationDate ? { date: optimizationDate } : {}),
                  },
                }, {
                  onSuccess: (data) => {
                    setDndRoutes(data.routes as OptimizedRouteResult[]);
                    setBuiltSignature(signatureAtStart);
                    setBuiltDay(dayAtStart);
                  }
                });
              }}
              disabled={optimizeMutation.isPending}
            />
          )}
          <ContinuousOptimization />
        </>
      )}
    />
  );

  // ---- Panel bodies per step --------------------------------------------------
  const stepOne = (
    <>
      {!dndRoutes && resumablePlan && (
        <details className="group border-b border-border bg-card/60" data-testid="resumable-plan" data-plan-id={resumablePlan.planId}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              Sparad plan: <strong>{resumablePlan.routes[0]?.name ?? resumablePlan.planId.slice(0, 8)}</strong>
              <span className="text-muted-foreground"> · {resumablePlan.routeCount} rutter</span>
            </span>
            <Button
              size="sm" variant="outline" className="h-6 px-2 text-[11px]" data-testid="button-resume-plan"
              onClick={(e) => {
                e.preventDefault();
                setSaveMessage(null);
                void loadPersistedPlan(resumablePlan.planId)
                  .then(() => { setBuiltSignature(null); setStep(2); })
                  .catch((error) => {
                    setSaveStatus("error");
                    setSaveMessage(localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }));
                  });
              }}
            >
              Fortsätt
            </Button>
          </summary>
          <div className="px-3 pb-2">
            <PlanStatusChain
              compact
              routes={resumablePlan.routes}
              stage={resumablePlan.stage}
              planId={resumablePlan.planId}
              planName={resumablePlan.routes[0]?.name}
              date={resumablePlan.routes[0]?.date}
              orderCount={resumablePlan.routes.reduce((count, route) => count + route.totalStops, 0)}
              resourceCount={resumablePlan.routes.length}
              resourceNames={resourceNames}
              revision={resumablePlan.revision}
              approval={plannerApprovalQuery.data}
              stateLoading={Boolean(plannerPlanId) && plannerApprovalQuery.isLoading}
              stateError={approvalStateError}
              onRetry={() => void plannerApprovalQuery.refetch()}
            />
          </div>
        </details>
      )}
      {!dndRoutes && saveStatus === "error" && saveMessage && (
        <p role="alert" className="flex items-center gap-1.5 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />{saveMessage}
        </p>
      )}
      <div className="flex shrink-0 gap-0.5 border-b border-border px-2 pt-1.5" role="tablist">
        {([
          ["jobs", "Jobb", `${selectedStopIds.size}/${scopedUnassigned.length}`],
          ["resources", "Resurser", `${selectedVehicleIds.size}/${activeVehicles.length}`],
        ] as const).map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={sourceTab === key} data-testid={`tab-source-${key}`}
            onClick={() => setSourceTab(key)}
            className={`-mb-px flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              sourceTab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}>
            {label}
            <span className="rounded bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
          </button>
        ))}
      </div>
      {scopeNotice && (
        <p role="status" className="flex items-start gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-900 dark:text-amber-200" data-testid="status-scope-pruned">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /><span className="flex-1">{scopeNotice}</span>
          <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => setScopeNotice(null)}>OK</button>
        </p>
      )}
      {sourceTab === "jobs" ? (
        <SourceJobList
          stops={visibleStops}
          totalInScope={scopedUnassigned.length}
          selectedIds={selectedStopIds}
          hiddenSelected={hiddenSelected}
          activeId={detailStopId}
          onToggle={toggleStop}
          onSelectAll={() => setSelectedStopIds(new Set([...selectedStopIds, ...visibleStops.map((s) => s.id)]))}
          onClear={() => setSelectedStopIds(new Set())}
          onOpen={setDetailStopId}
          emptyMessage={scopePrompt}
        />
      ) : (
        <ResourceList
          vehicles={activeVehicles}
          driverByVehicleId={driverByVehicleId}
          selectedIds={selectedVehicleIds}
          onToggle={toggleVehicle}
          onSelectAll={() => setSelectedVehicleIds(new Set(activeVehicles.map(v => v.id)))}
          onClear={() => setSelectedVehicleIds(new Set())}
        />
      )}
    </>
  );

  const stepTwo = (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
      {settings}
      {dndRoutes ? (
        <>
          {isLargeOptimization && optimizeMutation.jobStatus?.status === "complete" && (
            <LargeOptimizationProgressPanel stopCount={optimizationStopCount} status={optimizeMutation.jobStatus} />
          )}
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("planner.routeAssignments")}</h2>
            <div className="flex items-center gap-1">
              {dispatchHref && (
                <Link href={dispatchHref} data-testid="link-dispatch-timeline"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/10">
                  Tidsaxel <ArrowUpRight className="h-3 w-3" />
                </Link>
              )}
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" data-testid="button-reset-proposal"
                disabled={saveStatus === "saving"} onClick={resetProposal}>
                {t("common.reset")}
              </Button>
            </div>
          </div>
          {sourceDirty && (
            <p className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200">
              Visat förslag bygger på tidigare urval. Återställ och optimera igen för att använda det nya urvalet; det sparade förslaget ändras inte automatiskt.
            </p>
          )}
          <RouteAssignments
            routes={dndRoutes}
            vehiclesById={vehiclesById}
            stopsById={stopsById}
            driverByVehicleId={driverByVehicleId}
            existingRoutes={existingRoutes}
            drivers={drivers ?? []}
            vehicles={vehicles ?? []}
            stops={stops ?? []}
            saveStatus={saveStatus}
            saveMessage={saveMessage}
            onDragEnd={handleDragEnd}
            activeStopId={detailStopId}
            onOpenStop={setDetailStopId}
            onReoptimizationSaved={async (planId) => {
              const refreshed = await refetchRoutes();
              await loadPersistedPlan(planId, refreshed.data ?? []);
              setSaveStatus("saved");
              setSaveMessage("Optimeringen sparades.");
            }}
          />
        </>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground" data-testid="text-build-source">
              <strong className="font-mono text-foreground">{selectedStopIds.size}</strong> jobb ·{" "}
              <strong className="font-mono text-foreground">{selectedVehicleIds.size}</strong> fordon
            </span>
            <button type="button" className="text-[11px] font-semibold text-primary hover:underline" onClick={() => setStep(1)} data-testid="button-change-source">
              Ändra urval
            </button>
          </div>
          <p data-testid="text-optimization-date" className={`rounded-md px-2.5 py-1.5 text-[11px] ${optimizationDate ? "bg-muted/60 text-muted-foreground" : "bg-amber-500/15 font-medium text-amber-900 dark:text-amber-200"}`}>
            {optimizationDate
              ? <>Rutterna planeras för <strong className="font-mono text-foreground">{resolvedScope.date}</strong> (jobbens planeringsdag).</>
              : <>Jobben saknar planeringsdag. Servern daterar rutterna till dagens datum ({todayDay}).</>}
          </p>
          {isLargeOptimization && optimizeMutation.isPending ? (
            <LargeOptimizationProgressPanel stopCount={optimizationStopCount} status={optimizeMutation.jobStatus} />
          ) : optimizeMutation.isPending ? (
            <OptimizationProgressPanel stopCount={selectedStopIds.size} t={t} />
          ) : null}
          {usageNotice}
          {optimizeMutation.isError && (
            <p className="flex items-center gap-1 text-xs text-destructive" role="alert">
              <AlertCircle className="h-3.5 w-3.5" /> {t("planner.optimizationFailed")}
            </p>
          )}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {selectedStopsList.slice(0, 200).map((stop) => (
              <JobRow key={stop.id} stop={stop} active={detailStopId === stop.id} onOpen={() => setDetailStopId(stop.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );

  const stepThree = dndRoutes ? (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <ReviewSummary
        routes={dndRoutes}
        vehiclesById={vehiclesById}
        driverByVehicleId={driverByVehicleId}
        stopsById={stopsById}
        unassignedCount={unassignedAfterOptimize}
        dispatchHref={dispatchHref}
        dirty={sourceDirty}
        planDay={planDay}
        statusChain={(
          <PlanStatusChain
            compact
            routes={activePlanRoutes.length ? activePlanRoutes : dndRoutes}
            stage={2}
            planId={dndRoutes[0]?.planId}
            date={planDay}
            orderCount={dndRoutes.reduce((count, route) => count + route.stops.filter((stop) => !stop.isChargingStop).length, 0)}
            resourceCount={dndRoutes.length}
            resourceNames={resourceNames}
            revision={Math.max(...dndRoutes.map((route) => route.planRevision))}
            approval={plannerApprovalQuery.data}
            stateLoading={Boolean(plannerPlanId) && plannerApprovalQuery.isLoading}
            stateError={approvalStateError}
            onRetry={() => void plannerApprovalQuery.refetch()}
            onNextAction={dispatchHref ? () => navigate(dispatchHref) : undefined}
          />
        )}
      />
    </div>
  ) : null;

  const footer = (
    <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card/80 p-2.5 backdrop-blur">
      {effectiveStep > 1 && (
        <Button variant="ghost" size="sm" className="h-9" data-testid="button-step-back"
          onClick={() => setStep((effectiveStep - 1) as PlannerStep)}>
          <ArrowLeft className="mr-1 h-4 w-4" />Tillbaka
        </Button>
      )}
      <div className="flex-1" />
      {effectiveStep === 1 && (
        <Button className="h-9 font-semibold" data-testid="button-build-proposal" disabled={!availability[2].enabled}
          title={availability[2].reason ?? undefined} onClick={() => goTo(2)}>
          Bygg ruttförslag<ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      )}
      {effectiveStep === 2 && !dndRoutes && (
        <Button data-testid="planner-generate-routes" className="h-9 font-semibold" onClick={handleOptimize} disabled={optimizeDisabled}>
          {optimizeMutation.isPending
            ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />{t("planner.optimizingRoutes")}</>
            : <><Cpu className="mr-1.5 h-4 w-4" />Optimera rutter</>}
        </Button>
      )}
      {effectiveStep === 2 && dndRoutes && (
        <Button className="h-9 font-semibold" data-testid="button-to-review" disabled={saveStatus === "saving"} onClick={() => goTo(3)}>
          Kontrollera och skicka<ArrowRight className="ml-1.5 h-4 w-4" />
        </Button>
      )}
    </div>
  );

  return (
    <AppLayout>
      <div className="flex h-full w-full flex-col">
        <RouteBuilderTabs />
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card/70 px-3 py-1.5" data-testid="planner-header">
          <PlannerStepRail
            current={effectiveStep}
            availability={availability}
            completed={{ 1: availability[2].enabled, 2: Boolean(dndRoutes), 3: false }}
            onSelect={goTo}
          />
          <PlannerScopeBar scope={scope} resolved={resolvedScope} projectLabel={projectLabel} onChange={changeScope} />
          {dndRoutes && (
            <span
              data-testid="text-displayed-plan"
              className={`ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                planMismatch ? "bg-amber-500/15 font-semibold text-amber-900 dark:text-amber-200" : "bg-muted text-muted-foreground"
              }`}
              title={planMismatch ? "Filtret visar inte samma projekt/dag som de visade rutterna." : undefined}
            >
              {planMismatch && <AlertCircle className="h-3 w-3" />}
              Visade rutter: {displayedProject ? projectLabel(displayedProject) : "okänt projekt"} · {planDay ?? "okänd dag"}
              {planMismatch && " (skiljer sig från filtret)"}
            </span>
          )}
        </header>
        {pendingExecutionSuggestions.map((route) => {
          const suggestion = (route as Route & {
            redistributionSuggestion: { warning?: string };
            executionProjection?: { expectedFinishAt?: string; depotReturnAt?: string; overtimeMin?: number };
          }).redistributionSuggestion;
          const projection = (route as Route & {
            executionProjection?: { expectedFinishAt?: string; depotReturnAt?: string; overtimeMin?: number };
          }).executionProjection;
          return (
            <div key={route.id} className="flex shrink-0 items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs" data-testid={`execution-suggestion-${route.id}`}>
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
              <div className="min-w-0 flex-1">
                <span className="font-semibold text-amber-900 dark:text-amber-200">{route.name}: omfördelningsförslag kräver godkännande.</span>{" "}
                <span className="text-muted-foreground">{suggestion.warning}</span>{" "}
                <span className="text-muted-foreground">
                  Förväntat slut {projection?.expectedFinishAt ? new Date(projection.expectedFinishAt).toLocaleTimeString() : "–"},
                  depå {projection?.depotReturnAt ? new Date(projection.depotReturnAt).toLocaleTimeString() : "–"},
                  övertid {projection?.overtimeMin ?? 0} min. Pågående och klara stopp är låsta.
                </span>
              </div>
              <Button
                size="sm"
                className="h-7"
                data-testid={`approve-execution-suggestion-${route.id}`}
                disabled={approveExecutionRedistribution.isPending}
                onClick={() => approveExecutionRedistribution.mutate({
                  id: route.id,
                  data: { planVersion: route.planRevision },
                })}
              >
                Godkänn förslag
              </Button>
            </div>
          );
        })}
        <div className="flex min-h-0 w-full flex-1 flex-col lg:flex-row">
          <ResizableSidePanel collapsedLabel={["Välj underlag", "Bygg och granska", "Kontrollera och skicka"][effectiveStep - 1]}>
            <div className="flex min-h-0 flex-1 flex-col">
              {effectiveStep === 1 ? stepOne : effectiveStep === 2 ? stepTwo : stepThree}
            </div>
            {footer}
          </ResizableSidePanel>

          <div className="relative flex min-h-[320px] flex-1 flex-col bg-background/50">
            <PlannerResultStrip
              summary={resultIsCurrent && optimizeResult
                ? `${t("planner.optimizationComplete")}: ${t("planner.generatedRoutes", { count: optimizeResult.routes.length, distance: formatDistance(optimizeResult.totalDistanceKm) })}`
                : null}
              unassignedCount={unassignedAfterOptimize}
              unassignedReasons={resultIsCurrent ? optimizeResult?.unassignedReasons || [] : []}
              chargingCount={resultIsCurrent ? (optimizeResult?.routes as OptimizedRouteResult[] | undefined ?? []).reduce((sum, r) => sum + (r.chargingStopsInserted ?? 0), 0) : 0}
              overtimeRoutes={routeFacts.overtime}
              lateStops={routeFacts.late}
              dirty={sourceDirty}
              technical={resultIsCurrent && optimizationTiming ? t("planner.performanceStatus", {
                profile: t(`planner.profile${optimizationTiming.profile[0].toUpperCase()}${optimizationTiming.profile.slice(1)}`),
                source: t(`planner.distanceSource${optimizationTiming.distanceSource[0].toUpperCase()}${optimizationTiming.distanceSource.slice(1)}`),
                time: formatOptimizationDuration(optimizationTiming.totalMs),
              }) : null}
            />
            <div className="relative min-h-0 flex-1">
              <RouteMap
                routes={mapRoutes}
                unassignedStops={mapUnassigned}
                interactive={true}
                showPredictions={showPredictions}
                selectedStopId={detailStopId}
                selectedStopIds={effectiveStep === 1 ? selectedStopIds : undefined}
                onSelectStop={(id) => setDetailStopId(id)}
              />
              <button
                type="button"
                aria-pressed={showPredictions}
                data-testid="button-toggle-heatmap"
                onClick={() => setShowPredictions(!showPredictions)}
                className={`absolute bottom-3 left-3 z-[1000] flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium backdrop-blur transition-colors ${
                  showPredictions
                    ? "border-orange-500/60 bg-orange-500/15 text-orange-800 dark:text-orange-200"
                    : "border-border/70 bg-card/80 text-muted-foreground hover:text-foreground"
                }`}
              >
                <Thermometer className="h-3 w-3" />
                {t("predictions.heatmap")}
              </button>
              {detailStop && <StopDetailPanel stop={detailStop} onClose={() => setDetailStopId(null)} />}
            </div>
          </div>
        </div>
      </div>
      <Dialog open={conflictPlanId !== null} onOpenChange={(open) => {
        if (!open) setConflictPlanId(null);
      }}>
        <DialogContent data-testid="planner-conflict-dialog">
          <DialogHeader>
            <DialogTitle>Planen har ändrats</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Någon annan har sparat en ny version av planen. Dina försökta, osparade
            ruttändringar ligger kvar så att inget arbete skrivs över.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConflictPlanId(null)}
            >
              Behåll mina ändringar
            </Button>
            <Button
              type="button"
              data-testid="planner-load-latest"
              onClick={() => {
                const planId = conflictPlanId;
                if (!planId) return;
                void restoreServerPlan(planId)
                  .then(() => {
                    setConflictPlanId(null);
                    setSaveStatus("idle");
                    setSaveMessage(null);
                  })
                  .catch((error) => {
                    setSaveStatus("error");
                    setSaveMessage(localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }));
                  });
              }}
            >
              Ladda senaste versionen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
