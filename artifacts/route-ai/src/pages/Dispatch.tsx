import { StopRegisterDialog } from "@/components/customers/StopRegisterDialog";
import { Button } from "@/components/ui/button";
import type { StopRegisterTarget } from "@/lib/stop-register";
import { RouteAppendImport } from "@/components/routes/RouteAppendImport";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { useDrivers } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { GanttTimeline } from "@/components/dispatch/GanttTimeline";
import { DispatchBulkActions, type DispatchRouteRequest } from "@/components/dispatch/DispatchBulkActions";
import { dispatchRouteDriverNames } from "@/lib/dispatch-route-drivers";
import { StopDetailPanel } from "@/components/dispatch/StopDetailPanel";
import { nearbyStopsForSelection } from "@/lib/nearby-stops";
import { UnplannedInbox } from "@/components/dispatch/UnplannedInbox";
import { UnscheduledStopsLane } from "@/components/dispatch/UnscheduledStopsLane";
import { DispatchSearch } from "@/components/dispatch/DispatchSearch";
import { KeyboardHelp } from "@/components/dispatch/KeyboardHelp";
import { ActionQueue, type ActionSection } from "@/components/dispatch/ActionQueue";
import { ActionQueueToggle } from "@/components/dispatch/ActionQueueToggle";
import { PlanOptimizationAction } from "@/components/dispatch/PlanOptimizationAction";
import { DispatchReauthenticationDialog } from "@/components/dispatch/DispatchReauthenticationDialog";
import { ImportPlanApprovalPanel } from "@/components/dispatch/ImportPlanApprovalPanel";
import { RouteReoptimizationMenu } from "@/components/routes/RouteReoptimizationMenu";
import { DispatchReoptimizationAction } from "@/components/dispatch/DispatchReoptimizationAction";
import { RouteMap } from "@/components/map/RouteMap";
import { ImportWorkflow } from "@/pages/Import";
import { StopForm } from "@/pages/Stops";
import { Step7Adjust } from "@/components/import/Step7Adjust";
import { LoadingState } from "@/components/ui/LoadingState";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DEPOT_LOCATION, ROUTE_COLORS } from "@/lib/constants";
import {
  attachWorkdayEvidence,
  computeSchedule,
  getDispatchFinishEvidence,
  getWorkdayEvidence,
  type ScheduledRow,
  type ScheduledStop,
} from "@/lib/scheduling";
import { slaMarginMinutes, SLA_RISK_MARGIN_MINUTES } from "@/lib/dispatch-status";
import { useDispatchChannel } from "@/hooks/use-dispatch-channel";
import { useDispatchRouteSelection } from "@/hooks/use-dispatch-route-selection";
import { useDispatchMove } from "@/hooks/use-dispatch-move";
import { useDirectDispatchDrag } from "@/hooks/use-direct-dispatch-drag";
import { useDirectStopMove } from "@/hooks/use-direct-stop-move";
import { createDispatchKeyboardHandler } from "@/lib/dispatch-keyboard";
import { useTranslation } from "react-i18next";
import { useLocation, useSearch } from "wouter";
import { carryRoutesReturnTo } from "@/lib/routes-return";
import { RoutesReturnLink } from "@/components/routes/RoutesReturnLink";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-context";
import {
  CalendarClock,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Send,
  MapPin,
  Route as RouteIcon,
  Package,
  AlertTriangle,
  Map as MapIcon,
  EyeOff,
  Clock,
  HelpCircle,
  Rows2,
  Rows3,
  Rows4,
  Gauge,
  ExternalLink,
  ShieldAlert,
  ChevronDown,
  Maximize2,
  Minimize2,
  FileUp,
  FileSpreadsheet,
  Plus,
  BookMarked,
} from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  getRoute,
  getRoutePreflight,
  getGetImportRoutePlanApprovalQueryKey,
  useGetImportRoutePlanApproval,
  type Route,
  type RoutePreflight,
  type Stop,
} from "@workspace/api-client-react";
import { PlanStatusChain } from "@/components/planning/PlanStatusChain";
import { RouteFreezeControl } from "@/components/dispatch/PlanningLocksControl";
import { RouteDriverAction } from "@/components/dispatch/RouteDriverAction";
import { PlannerCorrectionsPanel } from "@/components/dispatch/PlannerCorrectionsPanel";
import { authoritativeServiceStartIso } from "@/lib/planning-locks";
import { canConfirmPlanningDeviation } from "@/lib/planning-deviation";
import { useVehiclePositions, useGeofenceEvents } from "@/hooks/use-tracking";
import { TrafficLayoutSwitch } from "@/components/traffic/TrafficLayoutSwitch";
import { TrafficTelemetryPanel } from "@/components/traffic/TrafficTelemetryPanel";
import { TrafficHistoryMap } from "@/components/traffic/TrafficHistoryMap";
import { actualTelemetryOnly, LIVE_MAP_POPOUT_HREF, readTrafficLayout, type TrafficLayout } from "@/lib/live-telemetry";
import { PlannerWorkspaceHeader, type MomentShortcut } from "@/components/dispatch/PlannerWorkspaceHeader";
import { usePlannerOutgoingView } from "@/hooks/use-planner-outgoing-view";
import { PlannerWorkQueue, type WorkQueueTab } from "@/components/dispatch/PlannerWorkQueue";
import { deriveReviewScopeNotice, deriveWorkflowMoments, deriveWorkspaceScope, formatDateRange, type MomentId } from "@/lib/planner-workspace";
import { useRoutes, useRouteStops, useDispatchRoute, useRouteIncidents } from "@/hooks/use-routes";
import {
  chooseRoutePlanExportSelection,
  routePlanSelectionStorageKey,
} from "@/lib/route-plan-export-selection";
import {
  activateDispatchDrag,
  cancelDispatchDrag,
  createDispatchDragSession,
  firstDispatchTouchPoint,
  handoffDispatchDrag,
  type DispatchDragPointer,
} from "@/lib/dispatch-drag";
import {
  createDispatchMoveError,
  isDispatchMoveRevisionConflict,
  isDispatchMoveUnauthorized,
} from "@/lib/dispatch-move-auth";
import { formatLockedStopError } from "@/lib/locked-stop-error";
import { getErrorStatus, localizeError, TrustedLocalizedError, type ErrorTranslator } from "@/lib/localize-error";
import {
  hasCurrentHandoff as hasReusableHandoff,
  matchesPlanRevision,
} from "@/lib/dispatch-reconciliation";
import { resolvePlanReviewDepot } from "@/lib/plan-review";
import {
  filterDispatchSearchScope,
  getEffectiveStopPriority,
  searchDispatchItems,
  type DispatchSearchItem,
} from "@/lib/dispatch-search";
import { canonicalInsertionIndex } from "@/lib/dispatch-move-index";
import {
  routeMatchesPlan,
} from "@/lib/route-plan-navigation";
import { isTerminalRouteStatus } from "@/lib/route-plan-groups";
import { dispatchPlanOptions, resolveDispatchScope, unambiguousDispatchPlan, unambiguousLivePlan, ganttPopoutHref, readDispatchScope, selectScopedRoutes, selectScopedUnassignedStops, sortScheduledRows } from "@/lib/dispatch-scope";
import { DispatchScopeGuidance, DispatchScopeSelector } from "@/components/dispatch/DispatchScopeSelector";
import { useMapPopoutScope } from "@/hooks/use-map-popout-scope";
import { openWorkspacePopout } from "@/lib/workspace-context";

type RouteHandoff = Route & {
  handoffStatus?: "pending" | "sent" | "received" | "opened" | "accepted" | "rejected";
  handoffVersion?: number;
  sentAt?: string | null;
  receivedAt?: string | null;
  openedAt?: string | null;
  acceptedAt?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
};

export default function Dispatch() {
  const { t, i18n } = useTranslation();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const { hasRole, user } = useAuth();
  const { enabled: directStopMoveEnabled, setEnabled: setDirectStopMoveEnabled } = useDirectStopMove();
  const queryClient = useQueryClient();
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: workingStops, isLoading: loadingStops } = useStops(undefined, true);
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();

  const dispatchRoute = useDispatchRoute();
  const [isDispatching, setIsDispatching] = useState(false);
  const [isExportingXlsx, setIsExportingXlsx] = useState(false);
  const [planWorkflowOpen, setPlanWorkflowOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(
    () => {
      const params = new URLSearchParams(search);
      return params.get("workflow") === "import" && Boolean(params.get("draftId"));
    },
  );
  const [importDraftId, setImportDraftId] = useState<string | null>(
    () => new URLSearchParams(search).get("draftId"),
  );
  const [serviceTimePlanId, setServiceTimePlanId] = useState<string | null>(null);
  const [lateStopPlan, setLateStopPlan] = useState<{
    id: string; name: string; routes: Array<{ routeId: string; planRevision: number }>;
  } | null>(null);
  const [preflight, setPreflight] = useState<Record<string, RoutePreflight>>({});
  const [isPreflightLoading, setIsPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [dispatchRouteFailures, setDispatchRouteFailures] = useState<Array<{ routeId: string; routeName: string; message: string }>>([]);
  const [validationSuccessPlanId, setValidationSuccessPlanId] = useState<string | null>(null);
  const consumedValidationMarker = useRef<string | null>(null);

  const setImportWorkflowOpen = useCallback(async (open: boolean) => {
    if (open && !importDraftId) {
      const planId = new URLSearchParams(window.location.search).get("planId");
      if (planId) {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/planning-drafts`, { credentials: "include", cache: "no-store" });
          if (!response.ok) throw new Error("Underlaget kunde inte hämtas. Kontrollera inloggningen och försök igen.");
          const body: unknown = await response.json();
          const drafts: unknown = body && typeof body === "object" && "drafts" in body ? body.drafts : null;
          const matches = Array.isArray(drafts) ? drafts.filter((draft: { planId?: string; id?: string }) =>
            draft.planId === planId && typeof draft.id === "string") : [];
          if (matches.length !== 1) throw new Error("Planens ursprungliga underlag kunde inte identifieras entydigt. Använd planens åtgärd för sena uppdrag om du vill lägga till ett uppdrag.");
          const params = new URLSearchParams(window.location.search);
          if (params.get("planId") !== planId) return;
          params.set("draftId", matches[0].id);
          params.set("workflow", "import");
          setImportDraftId(matches[0].id);
          setImportOpen(true);
          navigate(`/dispatch?${params.toString()}`);
        } catch (error) {
          toast({ title: "Underlaget öppnades inte", description: error instanceof Error ? error.message : "Försök igen.", variant: "destructive" });
        }
        return;
      }
      navigate("/routes/create");
      return;
    }
    setImportOpen(open);
    const params = new URLSearchParams(window.location.search);
    if (open) {
      params.set("workflow", "import");
      if (importDraftId) params.set("draftId", importDraftId);
    } else {
      params.delete("workflow");
      params.delete("draftId");
    }
    const query = params.toString();
    navigate(`/dispatch${query ? `?${query}` : ""}`, open ? undefined : { replace: true });
  }, [importDraftId, navigate, toast]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const draftIdFromQuery = params.get("draftId");
    const workflowRequested = params.get("workflow") === "import";
    if (workflowRequested && !draftIdFromQuery) {
      navigate("/routes/create", { replace: true });
      return;
    }
    const workflowOpen = Boolean(draftIdFromQuery);
    setImportOpen(workflowOpen);
    setImportDraftId(draftIdFromQuery);
  }, [navigate, search]);

  useEffect(() => {
    if (new URLSearchParams(search).get("planId")) return;
    let cancelled = false;
    const candidates = selectScopedRoutes(routes ?? [], readDispatchScope(search)).filter(
      (route) => route.status === "optimized" || route.status === "in_progress",
    );
    if (candidates.length === 0) {
      setPreflight({});
      setIsPreflightLoading(false);
      setPreflightError(null);
      return;
    }
    setIsPreflightLoading(true);
    setPreflightError(null);
    void Promise.all(candidates.map((route) => getRoutePreflight(route.id)))
      .then((checks) => {
        if (cancelled) return;
        setPreflight(Object.fromEntries(checks.map((check) => [check.routeId, check])));
      })
      .catch((error) => {
        if (cancelled) return;
        setPreflight({});
        setPreflightError(localizeError(error, t, { fallbackKey: "dispatch.preflightLoadFailed" }));
      })
      .finally(() => {
        if (!cancelled) setIsPreflightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, routes, t]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("validated") !== "1") return;

    const planIdFromQuery = params.get("planId");
    const marker = `${planIdFromQuery ?? ""}:validated`;
    if (consumedValidationMarker.current === marker) return;
    consumedValidationMarker.current = marker;
    if (planIdFromQuery) setValidationSuccessPlanId(planIdFromQuery);

    // The marker is only a one-time UI success signal, never authorization.
    // The approval panel always re-reads the protected plan independently.
    params.delete("validated");
    const query = params.toString();
    navigate(`/dispatch${query ? `?${query}` : ""}`, { replace: true });
  }, [navigate, search]);

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedRowIdx, setSelectedRowIdx] = useState<number>(0);
  const { highlightedRouteId, highlightedRouteIds, setHighlightedRouteId,
    setHighlightedRouteIds, selectRoute: selectDriverRoute, clearRoutes: clearDriverRoutes,
    scopeKey: driverSelectionScopeKey } = useDispatchRouteSelection(
      search, routes, `${user?.organizationId ?? ""}:${user?.id ?? ""}`,
    );
  const consumedRouteIntentRef = useRef<string | null>(null);
  const previousRouteIntentSearchRef = useRef(search);
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [dispatchSearchQuery, setDispatchSearchQuery] = useState("");
  const [trafficLayout, setTrafficLayoutState] = useState<TrafficLayout>(() =>
    readTrafficLayout(new URLSearchParams(search).get("layout") ?? (typeof window !== "undefined" ? window.localStorage.getItem("traffic.layout") : null)));
  useEffect(() => {
    const fromUrl = new URLSearchParams(search).get("layout");
    if (fromUrl) setTrafficLayoutState(readTrafficLayout(fromUrl));
  }, [search]);
  const setTrafficLayout = useCallback((layout: TrafficLayout) => {
    setTrafficLayoutState(layout);
    window.localStorage.setItem("traffic.layout", layout);
    const params = new URLSearchParams(window.location.search);
    params.set("layout", layout);
    navigate(`/dispatch?${params.toString()}`, { replace: true });
  }, [navigate]);
  const mapVisible = trafficLayout !== "timeline";
  const timelineVisible = trafficLayout !== "map";
  const [showPredictions, setShowPredictions] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [planLiveMode, setPlanLiveMode] = useState<"plan" | "live">(() => {
    const mode = new URLSearchParams(search).get("mode");
    return mode === "live" || new URLSearchParams(search).get("view") === "live"
      ? "live"
      : "plan";
  });

  useEffect(() => {
    const params = new URLSearchParams(search);
    const mode = params.get("mode") === "live" || params.get("view") === "live" ? "live" : "plan";
    setPlanLiveMode((current) => current === mode ? current : mode);
  }, [search]);

  const setPersistedPlanLiveMode = useCallback((mode: "plan" | "live") => {
    setPlanLiveMode(mode);
    const params = new URLSearchParams(window.location.search);
    params.set("mode", mode);
    params.set("view", mode === "live" ? "live" : "traffic");
    navigate(`/dispatch?${params.toString()}`, { replace: true });
  }, [navigate]);

  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [mapDropRequest, setMapDropRequest] = useState<{ clientX: number; clientY: number; nonce: number } | null>(null);
  const [mapRouteRequest, setMapRouteRequest] = useState<DispatchRouteRequest | null>(null);
  const mapDropStops = useRef<string[]>([]);
  const livePositionsQuery = useVehiclePositions(planLiveMode === "live");
  const geofenceQuery = useGeofenceEvents(30, planLiveMode === "live");
  // useVehiclePositions stops polling while the socket reports connected; if
  // socket messages silently stop, fall back to an independent refetch.
  const refetchLivePositions = livePositionsQuery.refetch;
  const livePositionsUpdatedRef = useRef(0);
  livePositionsUpdatedRef.current = livePositionsQuery.dataUpdatedAt;
  useEffect(() => {
    if (planLiveMode !== "live") return;
    const id = setInterval(() => {
      if (Date.now() - livePositionsUpdatedRef.current > 15000) void refetchLivePositions();
    }, 5000);
    return () => clearInterval(id);
  }, [planLiveMode, refetchLivePositions]);
  const openLiveMapPopout = useCallback(() => {
    // Independent read-only monitor: no channel, no scope sync, survives opener close.
    const w = openWorkspacePopout(LIVE_MAP_POPOUT_HREF, "traivo-live-map", "width=1600,height=1000");
    if (!w) toast({ title: "Livekartan öppnades inte", description: "Tillåt popup-fönster för den här webbplatsen och försök igen.", variant: "destructive" });
  }, [toast]);
  const [forceAssignment, setForceAssignment] = useState<{
    stopIds: string[];
    routeId: string;
    conflicts: string[];
    targetIndex?: number;
  } | null>(null);
  const [dispatchReauthenticationOpen, setDispatchReauthenticationOpen] = useState(false);
  const [dragState, setDragState] = useState<{
    stopIds: string[];
    sourceRouteId: string;
  } | null>(null);
  const [dropTargetRouteId, setDropTargetRouteId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const dropTargetAnchorRef = useRef<string | null>(null);
  const dropTargetRouteIdRef = useRef<string | null>(null);
  const dropTargetIndexRef = useRef<number | null>(null);
  const dragStateRef = useRef<ReturnType<typeof createDispatchDragSession> | null>(null);

  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const popoutWindowRef = useRef<Window | null>(null);
  const [ganttPopoutOpen, setGanttPopoutOpen] = useState(false);
  const ganttPopoutWindowRef = useRef<Window | null>(null);
  const [kbdHelpOpen, setKbdHelpOpen] = useState(false);
  const [actionQueueOpen, setActionQueueOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("dispatch.actionQueueOpen") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dispatch.actionQueueOpen", actionQueueOpen ? "1" : "0");
    }
  }, [actionQueueOpen]);
  const [inboxRailOpen, setInboxRailOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("dispatch.inboxRailOpen") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dispatch.inboxRailOpen", inboxRailOpen ? "1" : "0");
    }
  }, [inboxRailOpen]);
  const [queueTab, setQueueTab] = useState<WorkQueueTab>("unassigned");
  const [overviewOpen, setOverviewOpen] = useState<boolean>(false);
  const overviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overviewOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!overviewRef.current?.contains(e.target as Node)) setOverviewOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [overviewOpen]);
  const [focusMode, setFocusMode] = useState<boolean>(false);
  useEffect(() => {
    setSelectedStopId(null);
    setSelectedStopIds(new Set());
    setFocusStopId(null);
    setHoveredStopId(null);
    setMapDropRequest(null);
    setMapRouteRequest(null);
    mapDropStops.current = [];
    setForceAssignment(null);
    dragStateRef.current = null;
    setDragState(null);
  }, [driverSelectionScopeKey, user?.id, user?.organizationId, user?.role, planLiveMode]);
  const [actionFocusSection, setActionFocusSection] = useState<ActionSection | null>(null);
  const focusActionSection = useCallback((section: ActionSection) => {
    setActionQueueOpen(true);
    setActionFocusSection(section);
    setTimeout(() => {
      const el = document.getElementById(`aq-${section}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    setTimeout(() => setActionFocusSection(null), 1600);
  }, []);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [density, setDensity] = useState<"compact" | "comfortable" | "spacious">(() => {
    if (typeof window === "undefined") return "comfortable";
    const stored = window.localStorage.getItem("dispatch.density");
    if (stored === "compact" || stored === "comfortable" || stored === "spacious") return stored;
    return "comfortable";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dispatch.density", density);
    }
  }, [density]);
  const rowHeight = density === "compact" ? 32 : density === "spacious" ? 56 : 44;

  const driversByVehicleId = useMemo(() => {
    const activeByVehicle = new Map<string, NonNullable<typeof drivers>[number][]>();
    drivers?.forEach((driver) => {
      if (!driver.vehicleId || !driver.isActive) return;
      activeByVehicle.set(
        driver.vehicleId,
        [...(activeByVehicle.get(driver.vehicleId) ?? []), driver],
      );
    });
    const map = new Map<string, {
      id: string;
      name: string;
      workStartTime?: string | null;
      startLatitude?: number | null;
      startLongitude?: number | null;
    }>();
    activeByVehicle.forEach((candidates, vehicleId) => {
      if (candidates.length !== 1) return;
      const [driver] = candidates;
      map.set(vehicleId, {
        id: driver.id,
        name: driver.name,
        workStartTime: driver.workStartTime,
        startLatitude: driver.startLatitude,
        startLongitude: driver.startLongitude,
      });
    });
    return map;
  }, [drivers]);

  const vehiclesById = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        licensePlate: string;
        vehicleType: string;
        capacityKg: number | null;
        capacityVolume: number | null;
        routeColor: string;
        isActive: boolean;
      }
    >();
    vehicles?.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const requestedPlanId = useMemo(() => {
    return new URLSearchParams(search).get("planId");
  }, [search]);
  const requestedRouteId = useMemo(
    () => new URLSearchParams(search).get("routeId"),
    [search],
  );
  const approvalQuery = useGetImportRoutePlanApproval(requestedPlanId ?? "", {
    query: {
      queryKey: getGetImportRoutePlanApprovalQueryKey(requestedPlanId ?? ""),
      enabled: Boolean(requestedPlanId),
      staleTime: 0,
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    },
  });
  // A plan is scoped only by an explicit URL. Session storage is used to
  // remember the last plan after planning, but must never silently restore a
  // completed/cancelled plan when the user opens the global dispatch board.
  const selectedPlanId = requestedPlanId;
  useEffect(() => {
    setPlanWorkflowOpen(false);
    setLateStopPlan(null);
  }, [requestedPlanId]);

  const workingActiveRoutes = useMemo(() => {
    return selectScopedRoutes(routes ?? [], readDispatchScope(search));
  }, [routes, search]);
  // Open an empty board with both work surfaces, even after a saved map-only view.
  // Depend on emptiness, not polling results, so manual layout choices still work.
  const emptyBoard = workingActiveRoutes.length === 0;
  useEffect(() => {
    if (!loadingRoutes && emptyBoard) setTrafficLayoutState("split");
  }, [loadingRoutes, emptyBoard]);
  const planOptions = useMemo(() => dispatchPlanOptions(routes ?? []), [routes]);
  const resolvedScope = useMemo(() => resolveDispatchScope(routes ?? [], readDispatchScope(search)), [routes, search]);
  const changeDispatchScope = useCallback((next: { planId: string | null; day: string | null }) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("routeId");
    if (next.planId) params.set("planId", next.planId); else params.delete("planId");
    if (next.day) params.set("day", next.day); else params.delete("day");
    setSelectedStopId(null); setSelectedStopIds(new Set()); setFocusStopId(null);
    navigate(`/dispatch?${params.toString()}`);
  }, [navigate]);
  // Make the effective scope explicit in the URL so actions and popouts share
  // it: an unambiguous single open plan, or the only day of a scoped plan.
  useEffect(() => {
    if (loadingRoutes || !routes) return;
    const params = new URLSearchParams(search);
    if (!params.get("planId") && !params.get("routeId")) {
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
      const livePlan = planLiveMode === "live" ? unambiguousLivePlan(routes, today) : null;
      const only = livePlan ?? unambiguousDispatchPlan(planOptions);
      if (!only) return;
      params.set("planId", only);
      if (livePlan) params.set("day", today); else params.delete("day");
      navigate(`/dispatch?${params.toString()}`, { replace: true });
      return;
    }
    if (!params.get("day") && resolvedScope.status === "ready" && resolvedScope.day) {
      params.set("day", resolvedScope.day);
      navigate(`/dispatch?${params.toString()}`, { replace: true });
    }
  }, [loadingRoutes, routes, search, planOptions, resolvedScope, navigate, planLiveMode]);
  const outgoingView = usePlannerOutgoingView(workingActiveRoutes, workingStops ?? [], planLiveMode === "live");
  const activeRoutes = outgoingView.routes;
  const allStops = planLiveMode === "live" ? outgoingView.stops : workingStops;
  const lateStopPlanId = requestedPlanId ?? (requestedRouteId ? activeRoutes[0]?.planId : null);
  const canAddLateStop = Boolean(
    lateStopPlanId
    && activeRoutes.some((route) => ["draft", "optimized", "in_progress"].includes(route.status))
    && hasRole("admin", "dispatcher"),
  );
  const selectedScopeReadOnly = Boolean(
    (selectedPlanId || requestedRouteId)
    && activeRoutes.length > 0
    && activeRoutes.every((route) => isTerminalRouteStatus(route.status)),
  );

  const [stopRegisterOpen, setStopRegisterOpen] = useState(false);
  const stopRegisterTarget = useMemo<StopRegisterTarget | null>(() => {
    // Only an explicitly opened, named, non-terminal plan is a valid target.
    if (!requestedPlanId || selectedScopeReadOnly || planLiveMode !== "plan") return null;
    const planRoutes = (workingActiveRoutes ?? []).filter((route) => route.planId === requestedPlanId);
    if (planRoutes.length === 0 || planRoutes.some((route) => isTerminalRouteStatus(route.status))) return null;
    const name = planRoutes[0].customerReference || planRoutes[0].name;
    // Same day derivation as the workspace scope header (formatDateRange);
    // a multi-day range is not a valid single target date.
    const date = formatDateRange(planRoutes.map((route) => route.date));
    if (!name || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return {
      kind: "plan",
      planId: requestedPlanId,
      name,
      date,
      routes: planRoutes.map((route) => ({ routeId: route.id, planRevision: route.planRevision })),
    };
  }, [requestedPlanId, selectedScopeReadOnly, planLiveMode, workingActiveRoutes]);
  useEffect(() => { setStopRegisterOpen(false); }, [requestedPlanId]);

  useEffect(() => {
    if (loadingRoutes || !routes) return;
    const params = new URLSearchParams(search);
    const routeIdFromQuery = params.get("routeId");
    const searchChanged = previousRouteIntentSearchRef.current !== search;
    previousRouteIntentSearchRef.current = search;
    if (!routeIdFromQuery) {
      // Allow browser back/forward to revisit the same route intent after the
      // user used "All plans"; polling must not consume it repeatedly.
      consumedRouteIntentRef.current = null;
      if (searchChanged) setHighlightedRouteId(null);
      return;
    }
    const intentKey = `${params.get("planId") ?? ""}:${routeIdFromQuery ?? ""}`;
    if (!routeIdFromQuery || consumedRouteIntentRef.current === intentKey) return;
    consumedRouteIntentRef.current = intentKey;
    const target = routes.find((route) => route.id === routeIdFromQuery);
    if (!target) {
      setHighlightedRouteId(null);
      return;
    }
    const planIdFromQuery = params.get("planId");
    if (planIdFromQuery && !routeMatchesPlan(target, planIdFromQuery)) {
      setHighlightedRouteId(null);
      return;
    }
    setHighlightedRouteId(target.id);
  }, [loadingRoutes, routes, search]);

  const dispatchIntentError = useMemo(() => {
    if (loadingRoutes || !routes) return null;
    const params = new URLSearchParams(search);
    const planIdFromQuery = params.get("planId");
    const routeIdFromQuery = params.get("routeId");
    if (planIdFromQuery && !routes.some((route) => route.planId === planIdFromQuery)) {
      return t("dispatch.planNotFound");
    }
    if (!routeIdFromQuery) return null;
    const target = routes.find((route) => route.id === routeIdFromQuery);
    if (!target) return t("dispatch.routeNotFound");
    if (planIdFromQuery && !routeMatchesPlan(target, planIdFromQuery)) {
      return t("dispatch.routePlanMismatch");
    }
    return null;
  }, [loadingRoutes, routes, search, t]);

  const activePlanIds = useMemo(
    () => new Set(activeRoutes.map((route) => route.planId)),
    [activeRoutes],
  );
  const selectedOptimizedPlanRoutes = useMemo(() => {
    const selectedRoute = activeRoutes.find((route) => route.id === highlightedRouteId);
    if (!selectedRoute) return null;
    return activeRoutes.filter((route) => route.planId === selectedRoute.planId);
  }, [activeRoutes, highlightedRouteId]);
  const selectedReoptimizationRoute = useMemo(
    () => activeRoutes.find((route) => route.id === highlightedRouteId) ?? null,
    [activeRoutes, highlightedRouteId],
  );
  const selectedReoptimizationPlanRoutes = useMemo(
    () =>
      selectedReoptimizationRoute
        ? activeRoutes.filter(
            (route) => route.planId === selectedReoptimizationRoute.planId,
          )
        : [],
    [activeRoutes, selectedReoptimizationRoute],
  );

  const selectedExistingPlan = useMemo(() => {
    if (!selectedOptimizedPlanRoutes) return null;
    // Terminal plans may be opened from Routes for historical review, but
    // must not expose the resource/replan mutation flow.
    if (selectedOptimizedPlanRoutes.some((route) => isTerminalRouteStatus(route.status))) {
      return null;
    }
    const depot = resolvePlanReviewDepot(
      selectedOptimizedPlanRoutes,
      drivers ?? [],
      new Set((vehicles ?? [])
        .filter((vehicle) => vehicle.isActive)
        .map((vehicle) => vehicle.id)),
    );
    if (!depot) return null;
    return {
      planId: selectedOptimizedPlanRoutes[0].planId,
      draftId: selectedOptimizedPlanRoutes.find((route) => route.draftId)?.draftId ?? null,
      routes: selectedOptimizedPlanRoutes,
      depotLatitude: depot.depotLatitude,
      depotLongitude: depot.depotLongitude,
      fallbackDriverId: depot.fallbackDriverId,
    };
  }, [
    selectedOptimizedPlanRoutes,
    drivers,
    vehicles,
  ]);
  const reviewDraftId = useMemo(
    () => activeRoutes.find((route) => route.draftId)?.draftId ?? null,
    [activeRoutes],
  );

  const exportSelection = useMemo(() => {
    return chooseRoutePlanExportSelection(
      activeRoutes,
      highlightedRouteId,
      requestedPlanId,
    );
  }, [activeRoutes, highlightedRouteId, requestedPlanId]);

  const exportRoutePlanXlsx = useCallback(async () => {
    if (!exportSelection || isExportingXlsx) return;
    setIsExportingXlsx(true);
    const query = new URLSearchParams({ type: "routePlan", format: "xlsx" });
    if (exportSelection.kind === "date") {
      query.set("from", exportSelection.id);
      query.set("to", exportSelection.id);
    } else {
      query.set(exportSelection.kind === "route" ? "routeId" : "planId", exportSelection.id);
    }
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const response = await fetch(`${apiBase}/api/export?${query.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data?.error || t("dispatch.exportXlsxError"));
        Object.assign(error, { status: response.status, data });
        throw error;
      }
      const blob = await response.blob();
      const responseName = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = responseName || `traivo-ruttplan-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: t("dispatch.exportXlsxReady") });
    } catch (error) {
      toast({
        title: t("dispatch.exportXlsxError"),
        description: localizeError(error, t, { fallbackKey: "dispatch.exportXlsxError" }),
        variant: "destructive",
      });
    } finally {
      setIsExportingXlsx(false);
    }
  }, [exportSelection, isExportingXlsx, t, toast]);

  const acknowledgementRoutes = useMemo(
    () =>
      activeRoutes
        .map((route) => route as RouteHandoff)
        .filter((route) => route.handoffStatus && route.handoffStatus !== "pending"),
    [activeRoutes],
  );
  const incidentQueries = useRouteIncidents(acknowledgementRoutes.map((route) => route.id));
  const incidentsByRoute = useMemo(
    () => new Map(
      acknowledgementRoutes.map((route, index) => [route.id, incidentQueries[index]?.data ?? []]),
    ),
    [acknowledgementRoutes, incidentQueries],
  );

  const overdueAcknowledgements = useMemo(
    () =>
      acknowledgementRoutes.filter((route) => {
        if (route.handoffStatus !== "sent" || !route.sentAt) return false;
        return Date.now() - new Date(route.sentAt).getTime() > 5 * 60 * 1000;
      }),
    [acknowledgementRoutes],
  );

  const handoffTimestamp = useCallback((route: RouteHandoff) => {
    const value =
      route.handoffStatus === "rejected" ? route.rejectedAt :
      route.handoffStatus === "accepted" ? route.acceptedAt :
      route.handoffStatus === "opened" ? route.openedAt :
      route.handoffStatus === "received" ? route.receivedAt :
      route.sentAt;
    return value
      ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  }, []);

  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, Stop[]>();
    if (!allStops) return map;
    allStops.forEach((s) => {
      if (s.routeId) {
        const arr = map.get(s.routeId) || [];
        arr.push(s);
        map.set(s.routeId, arr);
      }
    });
    return map;
  }, [allStops]);

  const planUnassignedStops = useMemo(
    () => selectScopedUnassignedStops(allStops ?? [], readDispatchScope(search), activeRoutes),
    [allStops, search, activeRoutes],
  );
  const unassignedStops = useMemo(
    () => selectScopedUnassignedStops(allStops ?? [], {
      ...readDispatchScope(search),
      routeId: requestedRouteId ?? highlightedRouteId,
    }, activeRoutes),
    [allStops, search, requestedRouteId, highlightedRouteId, activeRoutes],
  );

  const scheduledRows: ScheduledRow[] = useMemo(() => {
    const routeRows = activeRoutes.map((route, idx) => {
      const vehicle = planLiveMode === "live" ? outgoingView.perRouteResources[route.id]?.vehicle : route.vehicleId
        ? vehiclesById.get(route.vehicleId)
        : undefined;
      const driver = planLiveMode === "live" ? outgoingView.perRouteResources[route.id]?.driver : route.vehicleId
        ? driversByVehicleId.get(route.vehicleId)
        : undefined;

      const routeStops = stopsByRouteId.get(route.id) || [];
      const effectivePriorities = route.optimizationPlanningSnapshot?.stopPriorities;
      const scheduledMetadata = computeSchedule(
        routeStops.map((stop) => ({
          ...stop,
          priority: getEffectiveStopPriority(stop, effectivePriorities),
        })),
      );
      const evidence = getWorkdayEvidence(
        route.workdayTimeline,
        route.workdaySummary,
        scheduledMetadata.map((stop) => stop.stopId),
      );
      const scheduled = evidence.timeline
        ? attachWorkdayEvidence(scheduledMetadata, evidence.timeline)
        : scheduledMetadata;

      const totalWeight = scheduled.reduce((s, st) => s + st.weightKg, 0);
      const totalVolume = scheduled.reduce((s, st) => s + st.volumeM3, 0);
      const capKg = vehicle?.capacityKg ?? 0;
      const capPct = capKg > 0 ? (totalWeight / capKg) * 100 : 0;

      return {
        routeId: route.id,
        routeName: route.name,
        optimizationFrozen: route.optimizationFrozen,
        routeDate: route.date,
        driverId: driver?.id ?? null,
        driverName: vehicle?.name ?? driver?.name ?? t("dispatch.unassigned"),
        planRevision: route.planRevision,
        manualReviewRequired: route.manualReviewRequired,
        manualReviewedAt: route.manualReviewedAt,
        handoffStatus: route.handoffStatus,
        handoffVersion: route.handoffVersion,
        handoffDriverId: route.handoffDriverId,
        sentAt: route.sentAt,
        vehicleId: route.vehicleId ?? "",
        vehicleName: vehicle?.name ?? t("dispatch.noVehicle"),
        vehicleType: vehicle?.vehicleType ?? "fossil",
        capacityKg: vehicle?.capacityKg ?? 0,
        capacityVolume: vehicle?.capacityVolume ?? 0,
        totalWeightKg: totalWeight,
        totalVolumeM3: totalVolume,
        capacityPercent: capPct,
        color: vehicle?.routeColor ?? ROUTE_COLORS[idx % ROUTE_COLORS.length],
        stops: scheduled,
        timeline: evidence.timeline ?? undefined,
        summary: evidence.summary ?? undefined,
        workdayStatus: evidence.status,
      };
    });

    return sortScheduledRows(routeRows);
  }, [activeRoutes, vehiclesById, driversByVehicleId, stopsByRouteId, t, planLiveMode, outgoingView.perRouteResources]);
  const scheduledRowsRef = useRef<ScheduledRow[]>(scheduledRows);
  scheduledRowsRef.current = scheduledRows;
  const livePriorityRows = useMemo(() => {
    return scheduledRows;
  }, [scheduledRows]);

  const dispatchSearchItems = useMemo<DispatchSearchItem[]>(() => {
    const stopsById = new Map((allStops ?? []).map((stop) => [stop.id, stop]));
    const routesById = new Map(activeRoutes.map((route) => [route.id, route]));
    const items: DispatchSearchItem[] = [];

    for (const row of scheduledRows) {
      const route = routesById.get(row.routeId);
      const vehicle = planLiveMode === "live" ? outgoingView.perRouteResources[row.routeId]?.vehicle
        : route?.vehicleId ? vehiclesById.get(route.vehicleId) : undefined;
      for (const scheduledStop of row.stops) {
        const stop = stopsById.get(scheduledStop.stopId);
        if (!stop) continue;
        items.push({
          stopId: stop.id,
          organizationId: stop.organizationId,
          planId: route?.planId ?? null,
          routeId: route?.id ?? row.routeId,
          routeDate: route?.date ?? null,
          routeName: row.routeName,
          vehicleName: row.vehicleName,
          vehicleLicense: vehicle?.licensePlate ?? null,
          driverName: row.driverName,
          stop,
          effectivePriority: getEffectiveStopPriority(
            stop,
            route?.optimizationPlanningSnapshot?.stopPriorities,
          ),
        });
      }
    }

    for (const stop of unassignedStops) {
      items.push({
        stopId: stop.id,
        organizationId: stop.organizationId,
        planId: null,
        routeId: null,
        routeDate: null,
        routeName: null,
        vehicleName: null,
        vehicleLicense: null,
        driverName: null,
        stop,
        effectivePriority: getEffectiveStopPriority(stop),
      });
    }

    return filterDispatchSearchScope(items, {
      organizationId: user?.organizationId,
      planId: requestedPlanId,
      includeUnassigned: true,
    });
  }, [
    activeRoutes,
    allStops,
    requestedPlanId,
    scheduledRows,
    unassignedStops,
    user?.organizationId,
    vehiclesById,
    planLiveMode,
    outgoingView.perRouteResources,
  ]);

  const dispatchSearchResults = useMemo(
    () => searchDispatchItems(dispatchSearchItems, dispatchSearchQuery),
    [dispatchSearchItems, dispatchSearchQuery],
  );

  const totalStopsCount = scheduledRows.reduce((s, r) => s + r.stops.length, 0) + unassignedStops.length;
  const routeRowsCount = scheduledRows.length;

  const slaCountByRoute = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of scheduledRows) {
      if (row.routeId === "unplanned" || row.workdayStatus !== "authoritative") continue;
      let count = 0;
      for (const stop of row.stops) {
        const margin = slaMarginMinutes(stop);
        if (margin !== null && margin < SLA_RISK_MARGIN_MINUTES) count++;
      }
      if (count > 0) map.set(row.routeId, count);
    }
    return map;
  }, [scheduledRows]);

  const slaRiskCount = useMemo(() => {
    let total = 0;
    slaCountByRoute.forEach((c) => (total += c));
    return total;
  }, [slaCountByRoute]);

  const avgCapacityPercent = useMemo(() => {
    const routesWithCap = scheduledRows.filter(
      (r) => r.routeId !== "unplanned" && r.capacityKg > 0,
    );
    if (routesWithCap.length === 0) return 0;
    return routesWithCap.reduce((s, r) => s + r.capacityPercent, 0) / routesWithCap.length;
  }, [scheduledRows]);

  const finishEvidence = useMemo(
    () => getDispatchFinishEvidence(scheduledRows),
    [scheduledRows],
  );
  const lastEndTime = finishEvidence.lastEndTime;
  const overtimeEndTime = finishEvidence.overtimeEndTime;
  const lastEndOverLimit = finishEvidence.lastEndOverLimit;

  const lastImportAt = useMemo<string | null>(() => {
    if (!allStops || allStops.length === 0) return null;
    let latest = 0;
    for (const s of allStops) {
      const t = new Date(s.createdAt).getTime();
      if (t > latest) latest = t;
    }
    return latest > 0 ? new Date(latest).toISOString() : null;
  }, [allStops]);

  const mapRoutes = useMemo(() => {
    return activeRoutes.map((route) => {
      const routeStops = stopsByRouteId.get(route.id) || [];
      const sorted = [...routeStops].sort(
        (a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0),
      );
      const vehicle = planLiveMode === "live" ? outgoingView.perRouteResources[route.id]?.vehicle : route.vehicleId
        ? vehiclesById.get(route.vehicleId)
        : undefined;
      return {
        ...route,
        stopsList: sorted,
        routeColor: vehicle?.routeColor,
      };
    });
  }, [activeRoutes, stopsByRouteId, vehiclesById, planLiveMode, outgoingView.perRouteResources]);

  const {
    visibleScheduledRows,
    visibleUnassignedStops,
    visibleMapRoutes,
  } = useMemo(() => {
    if (!dispatchSearchQuery.trim()) {
      return {
        visibleScheduledRows: livePriorityRows,
        visibleUnassignedStops: unassignedStops,
        visibleMapRoutes: mapRoutes,
      };
    }

    const matchingStopIds = new Set(dispatchSearchResults.map((result) => result.stopId));
    const matchingRouteIds = new Set(
      dispatchSearchResults
        .map((result) => result.routeId)
        .filter((routeId): routeId is string => Boolean(routeId)),
    );
    return {
      visibleScheduledRows: livePriorityRows.flatMap((row) => {
        if (!matchingRouteIds.has(row.routeId)) return [];
        const stops = row.stops.filter((stop) => matchingStopIds.has(stop.stopId));
        return stops.length > 0 ? [{ ...row, stops }] : [];
      }),
      visibleUnassignedStops: unassignedStops.filter((stop) => matchingStopIds.has(stop.id)),
      visibleMapRoutes: mapRoutes
        .filter((route) => matchingRouteIds.has(route.id))
        .map((route) => ({
          ...route,
          stopsList: route.stopsList.filter((stop) => matchingStopIds.has(stop.id)),
        }))
        .filter((route) => route.stopsList.length > 0),
    };
  }, [
    dispatchSearchQuery,
    dispatchSearchResults,
    livePriorityRows,
    mapRoutes,
    unassignedStops,
  ]);

  const handleToggleHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId((prev) => (prev === routeId ? null : routeId));
    },
    [],
  );

  const handleSetHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId(routeId);
    },
    [],
  );

  const handleMapSelectStop = useCallback(
    (stopId: string, modifiers?: { additive: boolean }) => {
      if (modifiers?.additive) {
        setSelectedStopIds((current) => {
          const next = new Set(current);
          if (next.has(stopId)) next.delete(stopId);
          else next.add(stopId);
          return next;
        });
        return;
      }
      if (selectedStopId === stopId) {
        setSelectedStopIds(new Set());
        setSelectedStopId(null);
      } else {
        setSelectedStopIds(new Set([stopId]));
        setSelectedStopId(stopId);
        for (let i = 0; i < scheduledRows.length; i++) {
          if (scheduledRows[i].stops.some((s) => s.stopId === stopId)) {
            setSelectedRowIdx(i);
            break;
          }
        }
      }
    },
    [selectedStopId, scheduledRows],
  );

  const selectedStop = useMemo(() => {
    if (!selectedStopId) return null;
    for (const row of scheduledRows) {
      const found = row.stops.find((s) => s.stopId === selectedStopId);
      if (found) return found;
    }
    const unassigned = unassignedStops.find((stop) => stop.id === selectedStopId);
    return unassigned ? computeSchedule([unassigned])[0] ?? null : null;
  }, [selectedStopId, scheduledRows, unassignedStops]);

  const selectedRow = scheduledRows[selectedRowIdx] ?? null;
  const selectedStopIsUnassigned = Boolean(
    selectedStopId && unassignedStops.some((stop) => stop.id === selectedStopId),
  );
  const selectedRoute = selectedStopIsUnassigned
    ? null
    : activeRoutes.find((route) => route.id === selectedRow?.routeId) ?? null;
  const selectedRawStop = selectedStopId
    ? allStops?.find((stop) => stop.id === selectedStopId) ?? null
    : null;
  const selectedFirstStopLock = selectedRoute && selectedRawStop
    ? {
        routeId: selectedRoute.id,
        planRevision: selectedRoute.planRevision,
        routeStatus: selectedRoute.status,
        lockedFirstStopId: selectedRoute.lockedFirstStopId,
        stopId: selectedRawStop.id,
        stopStatus: selectedRawStop.status,
        stopRouteId: selectedRawStop.routeId,
      }
    : undefined;

  const requestDispatchMove = useDispatchMove(activeRoutes, allStops);
  const directDrag = useDirectDispatchDrag({
    identity: JSON.stringify([user?.id, user?.organizationId, user?.role, search, driverSelectionScopeKey]),
    canEdit: planLiveMode === "plan" && !selectedScopeReadOnly && hasRole("admin", "dispatcher"),
    routes: activeRoutes, stops: allStops ?? [], requestMove: requestDispatchMove,
    select: setSelectedStopIds,
    review: (ids, routeId, targetIndex) => {
      setSelectedStopIds(new Set(ids));
      setMapRouteRequest({ routeId, targetIndex, nonce: Date.now() });
    },
    notify: description => toast({ title: description }),
  });

  const handleSelectStop = useCallback(
    (stopId: string, rowIdx: number) => {
      if (selectedStopId === stopId) {
        setSelectedStopId(null);
        setFocusStopId(null);
      } else {
        setSelectedStopId(stopId);
        const sourceRowIdx = scheduledRows.findIndex((row) =>
          row.stops.some((stop) => stop.stopId === stopId),
        );
        setSelectedRowIdx(sourceRowIdx >= 0 ? sourceRowIdx : rowIdx);
        setFocusStopId(stopId);
      }
    },
    [scheduledRows, selectedStopId],
  );

  const handleDispatchSearchSelect = useCallback(
    (result: { stopId: string; routeId?: string | null }) => {
      const rowIdx = scheduledRows.findIndex((row) =>
        row.stops.some((stop) => stop.stopId === result.stopId),
      );
      setSelectedStopId(result.stopId);
      setSelectedStopIds(new Set([result.stopId]));
      setSelectedRowIdx(Math.max(0, rowIdx));
      setFocusStopId(result.stopId);
      setHighlightedRouteId(result.routeId ?? null);
    },
    [scheduledRows],
  );

  const handleReassignStops = useCallback(
    async (stopIds: string[], targetRouteId: string, targetIndex?: number) => {
      if (planLiveMode === "live") return;
      if (stopIds.length === 0) return;
      const newRouteId = targetRouteId === "unplanned" ? null : targetRouteId;
      const targetRow = scheduledRows.find((r) => r.routeId === targetRouteId);
      const targetLabel = targetRow?.routeName ?? t("dispatch.unplannedStops");

      const selected = new Set(stopIds);
      const ordered = [
        ...scheduledRows.flatMap((row) => row.stops.map((stop) => stop.stopId)),
        ...unassignedStops.map((stop) => stop.id),
      ]
        .filter((id) => selected.has(id))
        .map((id) => allStops?.find((stop) => stop.id === id))
        .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop));

      if (newRouteId || targetRouteId === "unplanned") {
        await directDrag.drag(ordered.map(stop => stop.id), targetRouteId, targetIndex ?? targetRow?.stops.length ?? 0);
        return;
      }

      try {
        const result = await requestDispatchMove(
          ordered.map((stop) => stop.id),
          newRouteId,
          targetIndex ?? targetRow?.stops.length ?? 0,
        );
        if (result.error && result.conflicts.length === 0) {
          const lockedStopError = formatLockedStopError(result, i18n.language);
          if (lockedStopError) {
            toast({
              title: t("common.somethingWentWrong"),
              description: lockedStopError,
              variant: "destructive",
            });
            return;
          }
          throw createDispatchMoveError(
            result.status ?? 409,
            result.error,
            {
              ...(result.code ? { code: result.code } : {}),
              ...(result.details && typeof result.details === "object"
                ? { details: result.details as Record<string, unknown> }
                : {}),
            },
          );
        }
        if (result.conflicts.length > 0 && newRouteId) {
          setForceAssignment({
            stopIds: ordered.map((candidate) => candidate.id),
            routeId: newRouteId,
            conflicts: result.conflicts,
            targetIndex: targetIndex ?? targetRow?.stops.length ?? 0,
          });
          return;
        }
        toast({
          title: t("dispatch.stopsReassigned"),
          description: `${stopIds.length} → ${targetLabel}`,
          duration: 6000,
        });
      } catch (error) {
        if (isDispatchMoveUnauthorized(error)) {
          // Keep the failed move out of any retry queue. Retaining the local
          // selection lets the dispatcher explicitly retry after signing in.
          setSelectedStopIds(new Set(ordered.map((stop) => stop.id)));
          setDispatchReauthenticationOpen(true);
          return;
        }
        if (isDispatchMoveRevisionConflict(error)) {
          // A refresh is safe; replaying the rejected drag is not. The
          // dispatcher must decide whether the move still makes sense.
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
            queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
          ]);
          toast({
            title: t("common.errorConflict"),
            description: t("dispatch.moveRevisionConflict"),
            variant: "destructive",
          });
          return;
        }
        toast({
          title: t("common.somethingWentWrong"),
          description: describeDispatchError(error, t, "common.errorRequestFailed"),
          variant: "destructive",
        });
      }
    },
    [
      allStops,
      scheduledRows,
      unassignedStops,
      toast,
      t,
      i18n.language,
      queryClient,
      requestDispatchMove,
      planLiveMode,
      directDrag.drag,
    ],
  );

  const startDrag = useCallback(
    (stopId: string, sourceRouteId: string, pointerDown: DispatchDragPointer) => {
      if (planLiveMode === "live" || selectedStopIds.size > 1 || directDrag.isBusy()) return;
      const ids = selectedStopIds.has(stopId)
        ? scheduledRows
            .flatMap((row) => row.stops.map((stop) => stop.stopId))
            .concat(unassignedStops.map((stop) => stop.id))
            .filter((id) => selectedStopIds.has(id))
        : [stopId];
      dragStateRef.current = createDispatchDragSession(ids, sourceRouteId, pointerDown);
      dropTargetAnchorRef.current = null;
      dropTargetRouteIdRef.current = null;
      dropTargetIndexRef.current = null;
      setDropTargetRouteId(null);
      setDropTargetIndex(null);
    },
    [selectedStopIds, scheduledRows, unassignedStops, planLiveMode],
  );

  useEffect(() => {
    const clearDragSession = (clearSelection = false) => {
      dragStateRef.current = cancelDispatchDrag(dragStateRef.current);
      setDragState(null);
      setDropTargetRouteId(null);
      setDropTargetIndex(null);
      dropTargetAnchorRef.current = null;
      dropTargetRouteIdRef.current = null;
      dropTargetIndexRef.current = null;
      if (clearSelection) setSelectedStopIds(new Set());
    };

    const canonicalIndexForAnchor = (
      routeId: string,
      anchorStopId: string | null | undefined,
      draggedStopIds: readonly string[],
    ) => {
      const targetRow = scheduledRowsRef.current.find((row) => row.routeId === routeId);
      return targetRow
        ? canonicalInsertionIndex({
            canonicalStopIds: targetRow.stops.map((stop) => stop.stopId),
            draggedStopIds,
            anchorStopId,
          })
        : 0;
    };

    const updateDropTarget = (pointer: DispatchDragPointer) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const el = document.elementFromPoint(pointer.clientX, pointer.clientY);
      const target = el?.closest<HTMLElement>("[data-drop-route-id]");
      const id = target?.dataset.dropRouteId ?? null;
      const timeline =
        target?.closest<HTMLElement>("[data-testid='dispatch-timeline-row']") ?? target;
      const blocks = timeline
        ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-testid='dispatch-stop-block']"))
            .filter((block) => !ds.stopIds.includes(block.dataset.stopId ?? ""))
        : [];
      const index = blocks.findIndex(
        (block) =>
          pointer.clientX <
          block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2,
      );
      const anchorStopId = index < 0 ? null : blocks[index]?.dataset.stopId ?? null;
      const canonicalIndex = id
        ? canonicalIndexForAnchor(id, anchorStopId, ds.stopIds)
        : null;
      dropTargetAnchorRef.current = anchorStopId;
      dropTargetRouteIdRef.current = id;
      dropTargetIndexRef.current = canonicalIndex;
      setDropTargetRouteId(id);
      setDropTargetIndex(id ? (index < 0 ? blocks.length : index) : null);
    };

    const activateDrag = (pointer: DispatchDragPointer) => {
      const pending = dragStateRef.current;
      if (!pending) return false;
      const activated = activateDispatchDrag(pending, pointer);
      if (!activated.active) return false;
      if (!pending.active) {
        dragStateRef.current = activated;
        setDragState({
          stopIds: activated.stopIds,
          sourceRouteId: activated.sourceRouteId,
        });
      }
      updateDropTarget(pointer);
      return true;
    };

    const onMove = (ev: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      activateDrag({ clientX: ev.clientX, clientY: ev.clientY });
    };
    const onTouchMove = (ev: TouchEvent) => {
      const pointer = firstDispatchTouchPoint(ev.touches, ev.changedTouches);
      if (!pointer) return;
      const activated = activateDrag(pointer);
      if (activated) ev.preventDefault();
    };
    const completeDrag = (pointer?: DispatchDragPointer) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      if (!ds.active) {
        clearDragSession();
        return;
      }
      if (pointer && document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest("[data-testid='dispatch-map-panel']")) {
        mapDropStops.current = [...ds.stopIds];
        setSelectedStopId(null);
        setSelectedStopIds(new Set(ds.stopIds));
        setMapDropRequest({ ...pointer, nonce: Date.now() });
        clearDragSession();
        return;
      }
      const target = pointer
        ? document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>(
            "[data-drop-route-id]",
          )
        : null;
      const id = target?.dataset.dropRouteId ?? dropTargetRouteIdRef.current;
      if (id) {
        const timeline =
          target?.closest<HTMLElement>("[data-testid='dispatch-timeline-row']") ?? target;
        const blocks = timeline
          ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-testid='dispatch-stop-block']"))
              .filter((block) => !ds.stopIds.includes(block.dataset.stopId ?? ""))
          : [];
        const found = pointer
          ? blocks.findIndex(
              (block) =>
                pointer.clientX <
                block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2,
            )
          : -1;
        const anchorStopId = found < 0
          ? dropTargetAnchorRef.current
          : blocks[found]?.dataset.stopId ?? null;
        const index = target
          ? canonicalIndexForAnchor(id, anchorStopId, ds.stopIds)
          : dropTargetIndexRef.current ?? 0;
        // Clear the drag before opening review. Clearing afterward erases
        // the selection that the review handler just populated.
        handoffDispatchDrag(
          () => clearDragSession(true),
          () => { void directDrag.drag(ds.stopIds, id, index); },
        );
        return;
      }
      clearDragSession(true);
    };
    const onUp = (ev: MouseEvent) => {
      completeDrag({ clientX: ev.clientX, clientY: ev.clientY });
    };
    const onTouchEnd = (ev: TouchEvent) => {
      const pointer = firstDispatchTouchPoint(ev.touches, ev.changedTouches);
      completeDrag(pointer ?? undefined);
    };
    const onCancel = () => clearDragSession();
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCancel();
    };
    const touchMoveOptions: AddEventListenerOptions = { passive: false };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, touchMoveOptions);
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onCancel);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove, touchMoveOptions);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onCancel);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const snapshotRef = useRef({
    hoveredStopId: null as string | null,
    selectedStopId: null as string | null,
    highlightedRouteId: null as string | null,
    highlightedRouteIds: [] as string[],
    scopeKey: driverSelectionScopeKey,
    focusStopId: null as string | null,
  });
  useEffect(() => {
    snapshotRef.current = {
      hoveredStopId,
      selectedStopId,
      highlightedRouteId,
      highlightedRouteIds: [...highlightedRouteIds],
      scopeKey: driverSelectionScopeKey,
      focusStopId,
    };
  }, [hoveredStopId, selectedStopId, highlightedRouteId, highlightedRouteIds, driverSelectionScopeKey, focusStopId]);

  const sendChannelRef = useRef<((msg: { type: string; stopId?: string | null; routeId?: string | null; routeIds?: string[]; scopeKey?: string }) => void) | null>(null);

  const onChannelMessage = useCallback((msg: {
    type: string;
    stopId?: string | null;
    routeId?: string | null;
    routeIds?: string[];
    scopeKey?: string;
  }) => {
    if (msg.type === "hover") {
      setHoveredStopId(msg.stopId ?? null);
    } else if (msg.type === "select") {
      if (msg.stopId) setSelectedStopId(msg.stopId);
    } else if (msg.type === "route-selection") {
      if (msg.scopeKey === driverSelectionScopeKey && Array.isArray(msg.routeIds)) {
        setHighlightedRouteIds(msg.routeIds);
      }
    } else if (msg.type === "highlight") {
      setHighlightedRouteId(msg.routeId ?? null);
    } else if (msg.type === "pong") {
      setPopoutOpen(true);
      const snap = snapshotRef.current;
      const send = sendChannelRef.current;
      if (send) {
        send({ type: "hover", stopId: snap.hoveredStopId });
        send({ type: "select", stopId: snap.selectedStopId });
        send({ type: "route-selection", routeIds: snap.highlightedRouteIds, scopeKey: snap.scopeKey });
        if (snap.focusStopId) send({ type: "focus", stopId: snap.focusStopId });
      }
    } else if (msg.type === "close") {
      setPopoutOpen(false);
      popoutWindowRef.current = null;
    }
  }, [driverSelectionScopeKey, setHighlightedRouteIds, setHighlightedRouteId]);

  const { send: sendChannel } = useDispatchChannel("main", onChannelMessage, () => popoutWindowRef.current);
  useEffect(() => {
    sendChannelRef.current = sendChannel;
  }, [sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    sendChannel({ type: "hover", stopId: hoveredStopId });
  }, [hoveredStopId, popoutOpen, sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    sendChannel({ type: "select", stopId: selectedStopId });
    sendChannel({ type: "focus", stopId: selectedStopId });
  }, [selectedStopId, popoutOpen, sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    sendChannel({ type: "route-selection", routeIds: [...highlightedRouteIds], scopeKey: driverSelectionScopeKey });
  }, [highlightedRouteIds, driverSelectionScopeKey, popoutOpen, sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    const id = setInterval(() => {
      const w = popoutWindowRef.current;
      if (w && w.closed) {
        setPopoutOpen(false);
        popoutWindowRef.current = null;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [popoutOpen]);

  const mapHref = useMapPopoutScope(search, popoutWindowRef);
  const openMapPopout = useCallback(() => {
    const existing = popoutWindowRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const features = "width=1400,height=900,menubar=no,toolbar=no,location=no,status=no";
    const w = openWorkspacePopout(mapHref, "_blank", features);
    if (w) {
      popoutWindowRef.current = w;
      setPopoutOpen(true);
    }
  }, [mapHref]);

  const closeMapPopout = useCallback(() => {
    const w = popoutWindowRef.current;
    if (w && !w.closed) {
      try {
        w.close();
      } catch {
        // browser may refuse if window wasn't script-opened
      }
    }
    setTimeout(() => {
      const win = popoutWindowRef.current;
      if (!win || win.closed) {
        popoutWindowRef.current = null;
        setPopoutOpen(false);
      }
    }, 100);
  }, []);

  useEffect(() => {
    return () => {
      const w = popoutWindowRef.current;
      if (w && !w.closed) {
        try { w.close(); } catch { /* ignore */ }
      }
      popoutWindowRef.current = null;
    };
  }, []);

  const ganttHref = ganttPopoutHref(search, import.meta.env.BASE_URL);
  useEffect(() => {
    const popup = ganttPopoutWindowRef.current;
    if (popup && !popup.closed) {
      popup.postMessage({
        type: "traivo-gantt-scope",
        search: new URL(ganttHref, window.location.origin).search,
      }, window.location.origin);
    }
  }, [ganttHref]);

  const openGanttPopout = useCallback(() => {
    const existing = ganttPopoutWindowRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const features = "width=1600,height=900,menubar=no,toolbar=no,location=no,status=no";
    const w = openWorkspacePopout(ganttHref, "traivo-gantt-popout", features);
    if (w) {
      ganttPopoutWindowRef.current = w;
      setGanttPopoutOpen(true);
    }
  }, [ganttHref]);

  const closeGanttPopout = useCallback(() => {
    const w = ganttPopoutWindowRef.current;
    if (w && !w.closed) {
      try { w.close(); } catch { /* ignore */ }
    }
    setTimeout(() => {
      const win = ganttPopoutWindowRef.current;
      if (!win || win.closed) {
        ganttPopoutWindowRef.current = null;
        setGanttPopoutOpen(false);
      }
    }, 100);
  }, []);

  useEffect(() => {
    if (!ganttPopoutOpen) return;
    const id = setInterval(() => {
      const w = ganttPopoutWindowRef.current;
      if (w && w.closed) {
        setGanttPopoutOpen(false);
        ganttPopoutWindowRef.current = null;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [ganttPopoutOpen]);

  useEffect(() => {
    return () => {
      const w = ganttPopoutWindowRef.current;
      if (w && !w.closed) {
        try { w.close(); } catch { /* ignore */ }
      }
      ganttPopoutWindowRef.current = null;
    };
  }, []);

  const flatStopList = useMemo(() => {
    const list: Array<{ stopId: string; rowIdx: number }> = [];
    scheduledRows.forEach((row, rowIdx) => {
      row.stops.forEach((s) => list.push({ stopId: s.stopId, rowIdx }));
    });
    return list;
  }, [scheduledRows]);

  const dispatchAllRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onKey = createDispatchKeyboardHandler({
      kbdHelpOpen, focusMode, overviewOpen, selectedStopId, inboxRailOpen, actionQueueOpen,
      scheduledRows, flatStopList, searchInputRef, dispatchAllRef,
      setKbdHelpOpen, setFocusMode, setOverviewOpen, setSelectedStopId,
      setInboxRailOpen, setActionQueueOpen, setSelectedStopIds, setHighlightedRouteId,
      setSelectedRowIdx, setFocusStopId,
    });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbdHelpOpen, scheduledRows, flatStopList, selectedStopId, focusMode, overviewOpen, inboxRailOpen, actionQueueOpen]);

  const selectedPlanHeaderRoute = highlightedRouteId
    ? activeRoutes.find((route) => route.id === highlightedRouteId)
    : (requestedPlanId || requestedRouteId)
      ? activeRoutes.find((route) => route.customerReference?.trim() || route.name?.trim() || route.date) ?? activeRoutes[0]
      : null;

  const selectedPlanHeaderName = selectedPlanHeaderRoute?.name?.trim() || selectedPlanHeaderRoute?.customerReference?.trim() || null;
  const selectedPlanHeaderRef = selectedPlanHeaderRoute?.customerReference?.trim() || null;

  const dispatchHeaderTitle = selectedPlanHeaderName || t("dispatch.title");

  const dispatchHeaderDetail = selectedPlanHeaderRoute
    ? [
        selectedPlanHeaderName !== selectedPlanHeaderRef ? selectedPlanHeaderRef : null,
        selectedPlanHeaderRoute.date ? new Date(selectedPlanHeaderRoute.date).toLocaleDateString(
          i18n.language === "sv" ? "sv-SE" : "en-US",
          { timeZone: "UTC", weekday: "short", year: "numeric", month: "short", day: "numeric" },
        ) : null
      ].filter(Boolean).join(" · ") || t("dispatch.title")
    : t("dispatch.subtitle", { count: activeRoutes.length });

  const overloadedCount = useMemo(
    () => scheduledRows.filter((r) => r.routeId !== "unplanned" && r.capacityPercent > 100).length,
    [scheduledRows],
  );

  const dispatchAll = useCallback(async () => {
    // Imported plans use the protected approval gate below. Never let the
    // general toolbar/keyboard action bypass that explicit approve-then-send
    // flow for the selected plan.
    if (requestedPlanId) {
      return;
    }
    if (activePlanIds.size > 1) {
      toast({
        title: t("dispatch.selectPlanBeforeDispatch"),
        description: t("dispatch.selectPlanBeforeDispatchDesc"),
        variant: "destructive",
      });
      return;
    }
    if (planUnassignedStops.length > 0) {
      setInboxRailOpen(true);
      toast({
        title: t("dispatch.dispatchNeedsAction"),
        description: t("dispatch.dispatchNeedsActionDesc", { count: planUnassignedStops.length }),
        variant: "destructive",
      });
      return;
    }
    const toDispatch = activeRoutes.filter((r) => r.status === "optimized" || r.status === "in_progress");
    if (toDispatch.length === 0) {
      toast({
        title: t("dispatch.sentToDrivers"),
        description: t("dispatch.sentToDriversDesc"),
      });
      return;
    }
    const routesNeedingRecalculation = toDispatch.filter((route) =>
      scheduledRows.find((row) => row.routeId === route.id)?.workdayStatus !== "authoritative",
    );
    if (routesNeedingRecalculation.length > 0) {
      toast({
        title: t("dispatch.scheduleNeedsRecalculation"),
        description: t("dispatch.scheduleNeedsRecalculationBeforeDispatch"),
        variant: "destructive",
      });
      return;
    }
    setIsDispatching(true);
    setDispatchRouteFailures([]);
    try {
      const failures: Array<{ routeId: string; routeName: string; message: string }> = [];
      let sentCount = 0;
      let currentCount = 0;
      for (const route of toDispatch) {
        try {
          const actual = await getRoute(route.id);
          if (!matchesPlanRevision(actual, route.planRevision)) {
            throw new TrustedLocalizedError(t("dispatch.planRevisionChanged"));
          }
          if (hasReusableHandoff(actual, actual.planRevision)) {
            currentCount += 1;
            continue;
          }
          const check = await getRoutePreflight(route.id);
          setPreflight((previous) => ({ ...previous, [check.routeId]: check }));
          if (!matchesPlanRevision(check, route.planRevision)) {
            throw new TrustedLocalizedError(t("dispatch.planRevisionChanged"));
          }
          if (!check.ready) {
            if (check.issues.some((issue) => issue.code === "review_required")) {
              setHighlightedRouteId(route.id);
              setServiceTimePlanId(route.planId);
              throw new TrustedLocalizedError(t("dispatch.planReviewRequired"));
            }
            throw new Error(check.issues
              .map((issue) => localizeError(issue, t, { fallbackKey: "common.errorRequestFailed" }))
              .join(" "));
          }
          if (!check?.driverId) {
            throw new Error(t("dispatch.preflightMissingDriver"));
          }
          await dispatchRoute.mutateAsync({
            id: route.id,
            data: { driverId: check.driverId },
          });
          sentCount += 1;
        } catch (error) {
          failures.push({
            routeId: route.id,
            routeName: route.name,
            message: localizeError(error, t, { fallbackKey: "dispatch.sendError" }),
          });
        }
      }
      setDispatchRouteFailures(failures);
      if (failures.length > 0) {
        const reviewRequiredOnly = failures.every(
          (failure) => failure.message === t("dispatch.planReviewRequired"),
        );
        toast({
          title: reviewRequiredOnly
            ? t("dispatch.planReviewRequired")
            : t("dispatch.sendPartialFailure"),
          description: failures.map((failure) => `${failure.routeName}: ${failure.message}`).join(" "),
          variant: "destructive",
        });
      } else if (sentCount > 0) {
        toast({
          title: t("dispatch.sentToDrivers"),
          description: currentCount > 0
            ? t("dispatch.sentToDriversWithSkippedCurrent", { sent: sentCount, skipped: currentCount })
            : t("dispatch.sentToDriversDesc"),
        });
      } else {
        toast({
          title: t("dispatch.alreadyCurrent"),
          description: t("dispatch.alreadyCurrentDesc", { count: currentCount }),
        });
      }
    } finally {
      setIsDispatching(false);
    }
  }, [activeRoutes, activePlanIds, requestedPlanId, planUnassignedStops, scheduledRows, dispatchRoute, toast, t]);

  useEffect(() => {
    dispatchAllRef.current = dispatchAll;
  }, [dispatchAll]);

  if (loadingRoutes || loadingStops) {
    return (
      <AppLayout>
        <LoadingState message={t("dispatch.loading")} />
      </AppLayout>
    );
  }

  const scheduledStopTotal = scheduledRows.reduce((n, row) => n + (row.routeId === "unplanned" ? 0 : row.stops.length), 0);
  const workspaceRoutes = workingActiveRoutes.map(route => ({
    ...route, routeId: route.id,
    driverId: route.vehicleId ? driversByVehicleId.get(route.vehicleId)?.id ?? null : null,
  }));
  const stopsUnknown = !allStops;
  const selectedLockRoute = selectedRow
    ? activeRoutes.find(route => route.id === selectedRow.routeId)
    : undefined;
  const selectedApiStop = allStops?.find(stop => stop.id === selectedStopId);
  const selectedPlanningLocks = planLiveMode === "plan" && selectedLockRoute && selectedApiStop && selectedRow ? {
    route: { ...selectedLockRoute, driverId: selectedRow.driverId },
    stop: selectedApiStop,
    authoritativeServiceStartAt: authoritativeServiceStartIso(
      selectedLockRoute.workdayTimeline?.find(event => event.type === "service" && event.stopId === selectedApiStop.id)?.startAt,
      selectedRow.workdayStatus === "authoritative",
    ),
    driverName: selectedRow.driverName,
    vehicleName: selectedRow.vehicleName,
  } : undefined;
  const workspaceScope = deriveWorkspaceScope({
    day: readDispatchScope(search).day,
    planId: requestedPlanId, routeId: requestedRouteId, routes: workspaceRoutes,
    scheduledStopCount: !workingStops ? null : workingStops.filter(stop => workspaceRoutes.some(route => route.id === stop.routeId)).length,
    unassignedCount: !workingStops ? null : selectScopedUnassignedStops(workingStops, readDispatchScope(search), workingActiveRoutes).length,
  });
  const reviewScopeNotice = deriveReviewScopeNotice(workspaceScope.kind, workspaceRoutes);
  const workflowMoments = deriveWorkflowMoments({
    scopeKind: workspaceScope.kind, routes: workspaceRoutes,
    scheduledStopCount: !workingStops ? null : workingStops.filter(stop => workspaceRoutes.some(route => route.id === stop.routeId)).length,
    unassignedCount: !workingStops ? null : selectScopedUnassignedStops(workingStops, readDispatchScope(search), workingActiveRoutes).length,
    approval: approvalQuery.data,
    approvalLoading: Boolean(requestedPlanId) && approvalQuery.isLoading,
    approvalError: Boolean(requestedPlanId) && Boolean(approvalQuery.error) && getErrorStatus(approvalQuery.error) !== 404,
  });
  const openQueue = (tab: WorkQueueTab) => { setQueueTab(tab); setInboxRailOpen(true); };
  const momentShortcuts: Partial<Record<MomentId, MomentShortcut>> = {
    underlag: selectedScopeReadOnly
      ? { kind: "unavailable", reason: "Avslutad plan, endast läsläge" }
      : { kind: "action", label: "Öppna import/underlag", run: () => setImportWorkflowOpen(true) },
    resurser: { kind: "action", label: "Visa rutter som saknar resurser", run: () => { setActionQueueOpen(false); setActionFocusSection("missingResources"); openQueue("action"); } },
    planforslag: requestedPlanId && workspaceRoutes.some(route => route.manualReviewRequired && !route.manualReviewedAt)
      ? { kind: "action", label: "Granska rutter före godkännande", run: () => setPlanWorkflowOpen(true) }
      : { kind: "action", label: "Visa ej tilldelade uppdrag", run: () => { setPersistedPlanLiveMode("plan"); openQueue("unassigned"); } },
    granskning: requestedPlanId
      ? { kind: "action", label: "Öppna granskning och godkännande", run: () => setPlanWorkflowOpen(true) }
      : { kind: "unavailable", reason: "Granskning öppnas från en enskild plan" },
    godkann: requestedPlanId
      ? { kind: "action", label: "Öppna godkännande (inget skickas automatiskt)", run: () => setPlanWorkflowOpen(true) }
      : { kind: "unavailable", reason: "Godkännande kräver planvy" },
    utforande: { kind: "action", label: "Växla till liveläge", run: () => setPersistedPlanLiveMode("live") },
  };
  const workspaceHeader = (
    <PlannerWorkspaceHeader
      scope={workspaceScope}
      moments={workflowMoments}
      reviewNotice={reviewScopeNotice}
      shortcuts={momentShortcuts}
      liveStops={planLiveMode === "live" && !outgoingView.isLoading && !outgoingView.error
        ? (allStops ?? []).filter(stop => activeRoutes.some(route => route.id === stop.routeId))
        : undefined}
    />
  );
  const workspaceHeaderWithGuidance = (
    <>
      {workspaceHeader}
      <DispatchScopeGuidance status={resolvedScope.status} hasPlans={planOptions.length > 0} />
    </>
  );

  const planStatusPanel = activeRoutes.length > 0 && activePlanIds.size === 1 ? (
          <div className="shrink-0 border-b border-border bg-background px-3 py-1">
            <PlanStatusChain
              compact
              routes={scheduledRows}
              approval={approvalQuery.data}
              unplannedCount={unassignedStops.length}
              planId={activeRoutes[0]?.planId}
              planName={activeRoutes[0]?.customerReference ?? activeRoutes[0]?.name}
              date={activeRoutes[0]?.date}
              orderCount={totalStopsCount}
              resourceCount={scheduledRows.length}
              resourceNames={{
                vehicles: Object.fromEntries((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle.name])),
                drivers: Object.fromEntries((drivers ?? []).map((driver) => [driver.id, driver.name])),
              }}
              revision={Math.max(...scheduledRows.map((route) => route.planRevision ?? 0))}
              stateLoading={Boolean(requestedPlanId) && approvalQuery.isLoading}
              stateError={approvalQuery.error && getErrorStatus(approvalQuery.error) !== 404
                ? localizeError(approvalQuery.error, t, { fallbackKey: "dispatch.importApprovalError" })
                : null}
              onRetry={() => void approvalQuery.refetch()}
              onBlockerAction={selectedScopeReadOnly ? undefined : (blocker) => {
                setPlanWorkflowOpen(false);
                if (blocker.type === "unplannedStops") {
                  const stop = unassignedStops[0];
                  focusActionSection("unplannedTw");
                  if (stop) {
                    setFocusStopId(stop.id);
                    setSelectedStopIds(new Set([stop.id]));
                  }
                } else if (blocker.type === "missingVehicle" || blocker.type === "missingDriver") {
                  focusActionSection("missingResources");
                  const missing = scheduledRows.find((candidate) =>
                    !candidate.vehicleId || !candidate.driverId);
                  if (missing) setHighlightedRouteId(missing.routeId);
                } else if (blocker.type === "manualReview") {
                  const route = activeRoutes.find((candidate) => candidate.status === "optimized")
                    ?? activeRoutes[0];
                  if (route) {
                    setHighlightedRouteId(route.id);
                    setServiceTimePlanId(route.planId);
                  }
                }
              }}
              onNextAction={() => {
                if (requestedPlanId) {
                  setPlanWorkflowOpen(true);
                  document.querySelector('[data-testid="dispatch-import-plan-approval"]')?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                } else if (activeRoutes.some((route) => route.handoffStatus && route.handoffStatus !== "pending")) {
                  setPersistedPlanLiveMode("live");
                } else if (unassignedStops.length === 0) {
                  void dispatchAll();
                } else {
                  focusActionSection("unplannedTw");
                }
              }}
            />
          </div>
        ) : null;

  // Only current blocking conditions stay visible above the map/timeline.
  // Details remain expandable so the work surface keeps its height.
  const preflightBlocked = activeRoutes.length > 0 && activePlanIds.size === 1
    && Object.values(preflight).some((check) => !check.ready);
  const preflightShowError = activeRoutes.length > 0 && activePlanIds.size === 1 && Boolean(preflightError);
  const workspaceDataError = outgoingView.error ? outgoingView.error.message : stopsUnknown ? "Uppdragsdata kunde inte läsas. Status visas som okänd." : null;
  const liveBlockingError = planLiveMode === "live"
    ? outgoingView.error
      ? `Livevyn visas inte: ${outgoingView.error.message} Arbetsförslaget används inte som ersättning.`
      : livePositionsQuery.isError
        ? "GPS-rapporter kunde inte hämtas. Senast visade position kan vara inaktuell."
        : null
    : null;
  const liveInfoText = planLiveMode === "live" && !liveBlockingError
    ? outgoingView.isLoading
      ? "Hämtar utskickade versioner…"
      : livePositionsQuery.isLoading
        ? "Hämtar GPS-rapporter…"
        : `Live visar endast utskickade versioner; arbetsförslag visas i Plan. ${outgoingView.omittedRouteIds.length} rutter är ännu inte utskickade. Klicka på ett fordon för GPS-rapport. Planerade tider är inte faktisk ankomst.`
    : null;
  const dispatchBlockingDetails = (preflightBlocked || preflightShowError || dispatchRouteFailures.length > 0) ? (
    <div className="space-y-0.5">
      {preflightBlocked && (
        <p className="text-xs font-semibold text-destructive" data-testid="preflight-blocked">
          Preflight blockerar utskick tills förare, fordon och kritiska fel är åtgärdade.
        </p>
      )}
      {preflightShowError && (
        <p className="text-xs font-semibold text-destructive" data-testid="preflight-error">
          {preflightError}
        </p>
      )}
      {dispatchRouteFailures.length > 0 && (
        <ul className="space-y-0.5 text-xs font-semibold text-destructive" data-testid="dispatch-route-failures">
          {dispatchRouteFailures.map((failure) => (
            <li key={failure.routeId}>{failure.routeName}: {failure.message}</li>
          ))}
        </ul>
      )}
    </div>
  ) : null;
  const attentionMoments = workflowMoments.filter((moment) => moment.state === "attention").length;

  return (
    <AppLayout>
      <div className="flex min-h-0 flex-col h-full w-full overflow-y-auto md:overflow-hidden">
        {!focusMode && (
        <div className="relative z-20 shrink-0 px-3 py-1 border-b border-border bg-card/80 backdrop-blur-sm flex items-center gap-2 flex-wrap" data-testid="dispatch-compact-toolbar">
          <RoutesReturnLink search={search} />
          <CalendarClock className="h-5 w-5 text-primary shrink-0" />
          <div className="mr-1 min-w-0 basis-full sm:basis-auto sm:w-32 sm:shrink" title={typeof dispatchHeaderDetail === "string" ? dispatchHeaderDetail : undefined}>
            <h1 className="truncate text-sm font-bold leading-tight" data-testid="dispatch-header-title">
              {dispatchHeaderTitle}
            </h1>
            <p className="truncate text-[11px] leading-tight text-muted-foreground" data-testid="dispatch-header-detail">
              {dispatchHeaderDetail}
            </p>
          </div>

          <div className="flex items-center bg-muted/50 rounded-md p-0.5 border border-border/50">
            <button
              type="button"
              className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors cursor-pointer ${
                planLiveMode === "plan"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setPersistedPlanLiveMode("plan")}
            >
              {t("dispatch.planMode")}
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors cursor-pointer ${
                planLiveMode === "live"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setPersistedPlanLiveMode("live")}
            >
              {t("dispatch.liveMode")}
            </button>
          </div>
          <DispatchScopeSelector options={planOptions} planId={requestedPlanId} routeId={requestedRouteId}
            day={resolvedScope.day} days={resolvedScope.days} status={resolvedScope.status} onChange={changeDispatchScope} />
          {canAddLateStop && (
            <button
              type="button"
              onClick={() => navigate(`/orders?${new URLSearchParams({ planId: lateStopPlanId!, create: "1" })}`)}
              data-testid="dispatch-add-late-stop"
              className="flex min-h-[36px] items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/10"
              title={t("dispatch.addLateStopDescription")}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("dispatch.addLateStop")}
            </button>
          )}
          {planLiveMode === "live" && selectedPlanId && (
            <button
              type="button"
              data-testid="dispatch-return-to-review"
              onClick={() => {
                if (!reviewDraftId) {
                  toast({
                    title: t("dispatch.returnToReviewUnavailable"),
                    variant: "destructive",
                  });
                  return;
                }
                navigate(`/routes/drafts/${reviewDraftId}?review=1`);
              }}
              className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 sm:text-[11px]"
              title={reviewDraftId
                ? t("dispatch.returnToReview")
                : t("dispatch.returnToReviewUnavailable")}
            >
              <Clock className="h-3.5 w-3.5" />
              {t("dispatch.returnToReview")}
            </button>
          )}

          <div className="hidden h-6 w-px bg-border/60 sm:block" />

          <div className="flex items-center gap-1.5 flex-wrap">
            {unassignedStops.length > 0 && (
              <button
                type="button"
                onClick={() => focusActionSection("unplannedTw")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-destructive/15 border border-destructive/30 hover:bg-destructive/25 transition-colors cursor-pointer animate-pulse"
                title={t("dispatch.unplannedWithTw")}
              >
                <Package className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs font-bold tabular-nums text-destructive" data-testid="dispatch-unplanned-count">
                  {unassignedStops.length}
                </span>
                <span className="text-[10px] text-destructive/80 font-semibold">
                  {t("dispatch.unplannedLabel")}
                </span>
              </button>
            )}
            {overloadedCount > 0 && (
              <button
                type="button"
                onClick={() => focusActionSection("overloaded")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 transition-colors cursor-pointer animate-pulse"
                title={t("dispatch.overloaded")}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                  {t("dispatch.overloadedRoutes", { count: overloadedCount })}
                </span>
              </button>
            )}
            {slaRiskCount > 0 && (
              <button
                type="button"
                onClick={() => focusActionSection("sla")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 transition-colors cursor-pointer animate-pulse"
                title={t("dispatch.slaRiskExplanation")}
              >
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {t("dispatch.slaRiskCount", { count: slaRiskCount })}
                </span>
              </button>
            )}
            {lastEndOverLimit && overtimeEndTime && (
              <button
                type="button"
                onClick={() => focusActionSection("lateFinish")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-destructive/15 border border-destructive/30 hover:bg-destructive/25 transition-colors cursor-pointer"
                title={t("dispatch.lateFinish")}
              >
                <Clock className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs font-bold tabular-nums text-destructive">
                  {overtimeEndTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            )}
          </div>

          <DispatchSearch
            items={dispatchSearchItems}
            query={dispatchSearchQuery}
            onQueryChange={setDispatchSearchQuery}
            onSelect={handleDispatchSearchSelect}
            inputRef={searchInputRef}
          />

          <div
            className="ml-0 flex w-full min-w-0 flex-wrap items-center gap-1 xl:ml-auto xl:w-auto xl:flex-nowrap"
            data-testid="dispatch-action-toolbar"
          >
            <div className="relative" ref={overviewRef}>
              <button
                type="button"
                onClick={() => setOverviewOpen((v) => !v)}
                className={`flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold rounded-md transition-colors cursor-pointer ${overviewOpen ? "bg-muted text-foreground" : "text-foreground/85 hover:text-foreground hover:bg-muted/60"}`}
                title={t("dispatch.overviewToggle")}
                aria-expanded={overviewOpen}
              >
                <Gauge className="h-3.5 w-3.5" />
                {t("dispatch.overviewToggle")}
                <ChevronDown className={`h-3 w-3 transition-transform ${overviewOpen ? "rotate-180" : ""}`} />
              </button>
              {overviewOpen && (
                <div
                  className="absolute left-0 top-full z-50 mt-1 w-[min(16rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-3 shadow-xl animate-in slide-in-from-top-2 duration-150 sm:left-auto sm:right-0"
                  data-testid="dispatch-overview-popover"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <RouteIcon className="h-3 w-3" />
                        {t("dispatch.routesLabel")}
                      </span>
                      <span className="text-lg font-bold tabular-nums leading-none">{routeRowsCount}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {t("common.stops")}
                      </span>
                      <span className="text-lg font-bold tabular-nums leading-none">{totalStopsCount}</span>
                    </div>
                    {avgCapacityPercent > 0 && (
                      <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                          <Gauge className="h-3 w-3" />
                          {t("dispatch.avgUtil")}
                        </span>
                        <span className={`text-lg font-bold tabular-nums leading-none ${avgCapacityPercent > 100 ? "text-destructive" : avgCapacityPercent >= 85 ? "text-amber-500" : ""}`}>
                          {Math.round(avgCapacityPercent)}%
                        </span>
                      </div>
                    )}
                    {lastEndTime && (
                      <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {t("dispatch.lastEtaAt", { time: "" }).replace("—", "").trim() || t("dispatch.end")}
                        </span>
                        <span className={`text-lg font-bold tabular-nums leading-none ${lastEndOverLimit ? "text-destructive" : ""}`}>
                          {lastEndTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="hidden xl:flex items-center bg-muted/50 rounded-md p-0.5 border border-border/50" title={t("dispatch.density")}>
              <button
                type="button"
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors cursor-pointer ${density === "compact" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setDensity("compact")}
                aria-label={t("dispatch.densityCompact")}
                title={t("dispatch.densityCompact")}
              >
                <Rows4 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
              <button
                type="button"
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors cursor-pointer ${density === "comfortable" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setDensity("comfortable")}
                aria-label={t("dispatch.densityComfortable")}
                title={t("dispatch.densityComfortable")}
              >
                <Rows3 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
              <button
                type="button"
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors cursor-pointer ${density === "spacious" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setDensity("spacious")}
                aria-label={t("dispatch.densitySpacious")}
                title={t("dispatch.densitySpacious")}
              >
                <Rows2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
            </div>
            <TrafficLayoutSwitch value={trafficLayout} onChange={setTrafficLayout} />
            {mapVisible && (
              <button type="button" data-testid="button-toggle-history" aria-pressed={showHistory}
                onClick={() => setShowHistory((v) => !v)}
                title="Visa avslutade rutter på kartan (endast visning)"
                className={`flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-colors ${showHistory ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-muted/60"}`}>
                <Clock className="h-3.5 w-3.5" />Historik
              </button>
            )}
            {mapVisible && (
              <button type="button" data-testid="button-toggle-predictions" aria-pressed={showPredictions}
                onClick={() => setShowPredictions((v) => !v)}
                title="Visa prognoslager på kartan"
                className={`flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold transition-colors ${showPredictions ? "bg-primary/10 text-primary" : "text-foreground/85 hover:bg-muted/60"}`}>
                <Gauge className="h-3.5 w-3.5" />Prognos
              </button>
            )}
            {hasRole("admin", "dispatcher") && (
              <button type="button" data-testid="button-open-live-map" onClick={openLiveMapPopout}
                title="Öppna fristående livekarta för en extra skärm"
                className="flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-[11px] font-semibold text-foreground/85 transition-colors hover:bg-muted/60">
                <ExternalLink className="h-3.5 w-3.5" />Livekarta
              </button>
            )}

            <button
              type="button"
              onClick={() => setFocusMode(true)}
              data-testid="dispatch-focus-toggle"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-foreground/85 transition-colors hover:bg-muted/60 hover:text-foreground sm:px-2 sm:text-[11px]"
              aria-label={t("dispatch.focusMode")}
              title={t("dispatch.focusMode") + " (F)"}
            >
              <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              {t("dispatch.focusMode")}
            </button>

            <button
              type="button"
              onClick={popoutOpen ? closeMapPopout : openMapPopout}
              data-testid="button-map-popout"
              className={`flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors sm:px-2 sm:text-[11px] ${popoutOpen ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25" : "text-foreground/85 hover:text-foreground hover:bg-muted/60"}`}
              aria-label={popoutOpen ? t("dispatch.popoutClose") : t("dispatch.popoutOpen")}
              title={popoutOpen ? t("dispatch.popoutClose") : t("dispatch.popoutOpen")}
            >
              <ExternalLink className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              {popoutOpen ? t("dispatch.popoutActive") : t("dispatch.popoutMap")}
            </button>

            <button
              type="button"
              onClick={ganttPopoutOpen ? closeGanttPopout : openGanttPopout}
              className={`flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors sm:px-2 sm:text-[11px] ${ganttPopoutOpen ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25" : "text-foreground/85 hover:text-foreground hover:bg-muted/60"}`}
              aria-label={ganttPopoutOpen ? t("dispatch.ganttPopoutClose") : t("dispatch.ganttPopoutOpen")}
              title={ganttPopoutOpen ? t("dispatch.ganttPopoutClose") : t("dispatch.ganttPopoutOpen")}
              data-testid="button-gantt-popout"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {ganttPopoutOpen ? t("dispatch.ganttPopoutActive") : t("dispatch.ganttPopout")}
            </button>

            <details className="relative ml-auto" data-testid="dispatch-extra-tools">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 rounded-md border border-border px-3 text-xs font-semibold hover:bg-muted/60">
                {t("common.actions", "Verktyg")}
                <ChevronDown className="h-3.5 w-3.5" />
              </summary>
              <div className="absolute right-0 top-full z-50 mt-1 flex w-[min(34rem,calc(100vw-2rem))] flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-xl">
                {hasRole("admin", "dispatcher") && <label className="flex w-full items-start gap-2 text-xs">
                  <input type="checkbox" checked={directStopMoveEnabled} data-testid="dispatch-direct-stop-move"
                    onChange={event => {
                      if (!setDirectStopMoveEnabled(event.target.checked)) toast({ title: "Inställningen kunde inte sparas", variant: "destructive" });
                    }} />
                  Flytta utan bekräftelse när inga konflikter finns. Avvikelser kräver alltid granskning.
                </label>}
                <label className="flex w-full items-center gap-2 text-xs xl:hidden">
                  {t("dispatch.density")}
                  <select
                    className="min-h-[44px] rounded-md border border-border bg-background px-2"
                    value={density}
                    onChange={(event) => setDensity(event.target.value as "compact" | "comfortable" | "spacious")}
                  >
                    <option value="compact">{t("dispatch.densityCompact")}</option>
                    <option value="comfortable">{t("dispatch.densityComfortable")}</option>
                    <option value="spacious">{t("dispatch.densitySpacious")}</option>
                  </select>
                </label>
            <button
              type="button"
              onClick={() => setImportWorkflowOpen(true)}
              data-testid="dispatch-import-orders"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:text-[11px]"
              aria-label={t("dispatch.importOrders")}
              title={t("dispatch.importOrders")}
              hidden={!hasRole("admin", "dispatcher")}
            >
              <FileUp className="h-3.5 w-3.5" />
              {t("dispatch.importOrders")}
            </button>
            {hasRole("admin", "dispatcher") && (
              <button
                type="button"
                onClick={exportRoutePlanXlsx}
                disabled={!exportSelection || isExportingXlsx}
                data-testid="dispatch-export-xlsx"
                className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:text-[11px]"
                aria-label={t("dispatch.exportXlsx")}
                title={!exportSelection
                  ? t("dispatch.exportXlsxSelect")
                  : exportSelection.kind === "route"
                    ? t("dispatch.exportXlsxRoute")
                    : exportSelection.kind === "plan"
                      ? t("dispatch.exportXlsxPlan")
                      : t("dispatch.exportXlsxDate")}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                {isExportingXlsx ? t("dispatch.exportXlsxWorking") : t("dispatch.exportXlsx")}
              </button>
            )}
            {hasRole("admin", "dispatcher") && planLiveMode === "plan" && (
              <button
                type="button"
                data-testid="dispatch-stop-register"
                disabled={!stopRegisterTarget}
                aria-disabled={!stopRegisterTarget}
                title={stopRegisterTarget
                  ? t("stopRegister.dispatchHint")
                  : t("stopRegister.dispatchUnavailable")}
                className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => setStopRegisterOpen(true)}
              >
                <BookMarked className="h-3.5 w-3.5" />
                {t("stopRegister.title")}
              </button>
            )}
            {hasRole("admin", "dispatcher") && requestedPlanId && activeRoutes.length > 0
              && !selectedScopeReadOnly && activeRoutes.some((route) => ["draft", "optimized", "in_progress"].includes(route.status)) && (
              <button
                type="button"
                data-testid="dispatch-add-plan-stop"
                className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                onClick={() => setLateStopPlan({
                  id: requestedPlanId,
                  name: activeRoutes[0].customerReference || activeRoutes[0].name,
                  routes: activeRoutes.map((route) => ({ routeId: route.id, planRevision: route.planRevision })),
                })}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("dispatch.addPlanStop")}
              </button>
            )}
            {hasRole("admin", "dispatcher") && (
              <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground sm:text-[11px]">
                <span className="sr-only">Välj rutt för optimering</span>
                <select
                  data-testid="dispatch-reoptimization-route-select"
                  aria-label="Välj rutt för optimering"
                  value={highlightedRouteId ?? ""}
                  onChange={(event) => setHighlightedRouteId(event.target.value || null)}
                  className="max-w-[220px] bg-transparent outline-none"
                >
                  <option value="">Välj rutt…</option>
                  {activeRoutes.map((route) => {
                    const vehicleName = route.vehicleId
                      ? vehiclesById.get(route.vehicleId)?.name
                      : undefined;
                    return (
                      <option key={route.id} value={route.id}>
                        {route.name || vehicleName || "Rutt"}
                        {vehicleName && vehicleName !== route.name ? ` · ${vehicleName}` : ""}
                        {route.status === "in_progress" ? " · pågår" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
            {hasRole("admin", "dispatcher") && selectedOptimizedPlanRoutes && (
              <>
                <button
                  type="button"
                  onClick={() => selectedExistingPlan &&
                    setServiceTimePlanId(selectedExistingPlan.planId)}
                  disabled={!selectedExistingPlan}
                  className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:text-[11px]"
                  title={selectedExistingPlan
                    ? t("dispatch.adjustPlanTooltip")
                    : t("dispatch.adjustPlanInvalidTooltip")}
                >
                  <Clock className="h-3.5 w-3.5" />
                  {t("dispatch.replan")}
                </button>
                {!selectedExistingPlan && (
                  <span className="max-w-[260px] text-[10px] font-semibold text-destructive">
                    {t("dispatch.adjustPlanRecoveryError")}
                  </span>
                )}
              </>
            )}
            {hasRole("admin", "dispatcher") && <PlanOptimizationAction routes={activeRoutes} enabled={planLiveMode === "plan" && !selectedScopeReadOnly} />}
            <RouteAppendImport route={selectedReoptimizationRoute} enabled={planLiveMode === "plan" && !selectedScopeReadOnly} />
            {hasRole("admin", "dispatcher") && planLiveMode === "plan" && !selectedScopeReadOnly && selectedReoptimizationRoute &&
              <RouteDriverAction route={selectedReoptimizationRoute} vehicles={vehicles ?? []} drivers={drivers ?? []}
                currentDriverName={dispatchRouteDriverNames(activeRoutes, drivers ?? [], approvalQuery.error ? undefined : approvalQuery.data).get(selectedReoptimizationRoute.id)} />}
            {hasRole("admin", "dispatcher") && selectedReoptimizationRoute
              && !isTerminalRouteStatus(selectedReoptimizationRoute.status) && (
              <RouteReoptimizationMenu
                route={selectedReoptimizationRoute}
                planRoutes={selectedReoptimizationPlanRoutes}
                drivers={drivers ?? []}
                vehicles={vehicles ?? []}
                stops={allStops ?? []}
                depotLatitude={selectedReoptimizationRoute.depotSnapshot?.start.latitude ?? DEPOT_LOCATION.lat}
                depotLongitude={selectedReoptimizationRoute.depotSnapshot?.start.longitude ?? DEPOT_LOCATION.lng}
                onSaved={async () => {
                  await queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                  await queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
                }}
              />
            )}
            {hasRole("admin", "dispatcher") && !selectedReoptimizationRoute && (
              <button
                type="button"
                disabled
                data-testid="button-reoptimization-menu-no-route"
                title={highlightedRouteId
                  ? "Den valda rutten är inte optimerad och kan inte öppnas här."
                  : "Välj en optimerad rutt för att öppna optimeringsåtgärder."}
                className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60 sm:text-[11px]"
              >
                {highlightedRouteId ? "Optimera (rutt ej tillgänglig)" : "Optimera (välj rutt)"}
              </button>
            )}
            <button
              type="button"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 sm:text-[11px]"
              onClick={() => navigate("/planner")}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("dispatch.optimize")}
            </button>
            {!requestedPlanId && (
              <button
                type="button"
                disabled={
                  isDispatching
                  || isPreflightLoading
                  || activeRoutes.some((route) =>
                    (route.status === "optimized" || route.status === "in_progress")
                    && (!route.handoffStatus || route.handoffStatus === "pending")
                    && !preflight[route.id]?.ready)
                }
                className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-60 sm:text-[11px]"
                onClick={dispatchAll}
              >
                <Send className="h-3.5 w-3.5" />
                {isDispatching ? t("dispatch.sending") : t("dispatch.sendToDrivers")}
              </button>
            )}
              </div>
            </details>
          </div>
        </div>
        )}

        {planLiveMode === "live" && activeRoutes.filter(route => route.executionProjection?.selectionChangedAt).map(route => {
          const target = allStops?.find(stop => stop.id === route.executionProjection?.activeStopId);
          return <div key={route.id} className="shrink-0 border-b bg-amber-50 px-3 py-2 text-xs text-amber-950"
            data-testid={`driver-selected-stop-${route.id}`}>
            <strong>{route.name}: chauffören har ändrat körordningen.</strong>{" "}
            {target ? `Aktivt mål: ${target.address}. ` : "Valt stopp är hanterat; återstående stopp följer planen. "}
            ETA räknas om från aktuell GPS i livekartan. Planerade ankomst- och sluttider gäller inte som liveprognos.
          </div>;
        })}
        {(dispatchIntentError || workspaceDataError || liveBlockingError || dispatchBlockingDetails || (focusMode && overdueAcknowledgements.length > 0)) && (
          <div
            className="shrink-0 space-y-1 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5"
            data-testid="dispatch-blocking-warnings"
          >
            {dispatchIntentError && (
              <p className="text-sm text-destructive" role="alert" data-testid="dispatch-route-intent-error">
                {dispatchIntentError}
              </p>
            )}
            {workspaceDataError && (
              <p role="alert" className="text-xs font-semibold text-destructive" data-testid="text-workspace-error">{workspaceDataError}</p>
            )}
            {liveBlockingError && !outgoingView.error && (
              <p role="alert" className="text-xs font-semibold text-destructive" data-testid="dispatch-live-error">{liveBlockingError}</p>
            )}
            {focusMode && overdueAcknowledgements.length > 0 && (
              <p className="flex items-center gap-2 text-xs font-bold text-destructive" role="alert" data-testid="handoff-overdue-alert">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t("dispatch.handoffOverdue", { count: overdueAcknowledgements.length })}
              </p>
            )}
            {dispatchBlockingDetails && (
              <details data-testid="dispatch-blocking-details">
                <summary className="cursor-pointer text-xs font-semibold text-destructive">
                  Utskick blockerat: visa detaljer
                </summary>
                <div className="pt-1">{dispatchBlockingDetails}</div>
              </details>
            )}
          </div>
        )}
        {!focusMode && (
          <details
            className="group relative z-10 shrink-0 border-b border-border bg-card/60"
            data-testid="dispatch-plan-overview"
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-xs hover:bg-muted/40">
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
              <span className="shrink-0 font-semibold">Planöversikt</span>
              {overdueAcknowledgements.length > 0 && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive px-1.5 py-0.5 text-[11px] font-bold text-destructive-foreground"
                  role="alert"
                  data-testid="handoff-overdue-alert"
                  title={t("dispatch.handoffOverdue", { count: overdueAcknowledgements.length })}
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{t("dispatch.handoffOverdue", { count: overdueAcknowledgements.length })}</span>
                </span>
              )}
              <span className="truncate text-muted-foreground">
                {workspaceScope.title} · {workspaceScope.dateLabel} · {workspaceScope.routeCount} rutter
              </span>
              {attentionMoments > 0 && (
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300" data-testid="dispatch-overview-attention">
                  {attentionMoments} arbetsflödessteg kräver kontroll
                </span>
              )}
              {reviewScopeNotice && (
                <span
                  className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300"
                  data-testid="dispatch-review-scope-summary"
                  title={`Sparad granskningsflagga i ${reviewScopeNotice.routeCount} rutter kan markera två steg · öppna översikten för planlänkar och aktuellt godkännande`}
                >
                  Granskning · {reviewScopeNotice.routeCount} rutter
                  <span className="sr-only"> – sparad granskningsflagga kan markera två steg; öppna översikten för planlänkar och aktuellt godkännande</span>
                </span>
              )}
              {liveInfoText && (
                <span className="ml-auto hidden truncate text-[11px] text-muted-foreground lg:inline" role="status" title={liveInfoText}>
                  {liveInfoText}
                </span>
              )}
            </summary>
            <div className="max-h-[45dvh] overflow-y-auto">
              {workspaceHeaderWithGuidance}
              {!requestedPlanId && planStatusPanel}
        {planLiveMode === "plan" && activeRoutes.length > 0 && hasRole("admin", "dispatcher") && (
          <details className="border-t border-border px-3 py-1 text-xs">
            <summary className="cursor-pointer py-1 font-semibold">Ruttlås – frysning mot planändringar</summary>
            <div className="max-h-44 space-y-2 overflow-y-auto py-2">
              {activeRoutes.map(route => (
                <div key={route.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{route.name}</span>
                  <RouteFreezeControl route={{ ...route, driverId: scheduledRows.find(row => row.routeId === route.id)?.driverId }} />
                </div>
              ))}
            </div>
          </details>
        )}
        {acknowledgementRoutes.length > 0 && (
          <section
            className="border-t border-border bg-card px-3 py-2"
            aria-label={t("dispatch.handoffOverview")}
            data-testid="handoff-overview"
          >
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {acknowledgementRoutes.map((route) => {
                const isOverdue = overdueAcknowledgements.some((item) => item.id === route.id);
                const isRejected = route.handoffStatus === "rejected";
                const isAccepted = route.handoffStatus === "accepted";
                const time = handoffTimestamp(route);
                return (
                  <article
                    key={route.id}
                    className={`min-w-[220px] rounded-md border px-3 py-2 ${
                      isOverdue
                        ? "border-destructive/50 bg-destructive/5"
                        : isRejected
                          ? "border-destructive/30 bg-destructive/5"
                          : isAccepted
                            ? "border-emerald-500/30 bg-emerald-500/5"
                            : "border-border bg-muted/25"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-xs font-bold" title={route.name}>{route.name}</span>
                      <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {t("dispatch.handoffVersion", { version: route.handoffVersion ?? "—" })}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${
                        isRejected || isOverdue ? "bg-destructive" :
                        isAccepted ? "bg-emerald-500" :
                        route.handoffStatus === "opened" ? "bg-blue-500" :
                        route.handoffStatus === "received" ? "bg-cyan-500" :
                        "bg-amber-500"
                      }`} aria-hidden="true" />
                      <span className={`text-[11px] font-semibold ${isRejected || isOverdue ? "text-destructive" : ""}`}>
                        {t(`dispatch.handoffStatus.${route.handoffStatus}`)}
                        {time ? ` · ${time}` : ""}
                      </span>
                    </div>
                    {isRejected && route.rejectionReason && (
                      <p className="mt-1 text-[11px] leading-snug text-destructive">
                        <span className="font-semibold">{t("dispatch.handoffReason")}:</span>{" "}
                        {route.rejectionReason}
                      </p>
                    )}
                    {isOverdue && (
                      <p className="mt-1 text-[11px] font-semibold text-destructive">
                        {t("dispatch.handoffOverdueRoute")}
                      </p>
                    )}
                    {(incidentsByRoute.get(route.id) ?? []).length > 0 && (
                      <div className="mt-2 border-t border-border/70 pt-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          {t("dispatch.incidents")}
                        </p>
                        <ul className="mt-1 space-y-1.5">
                          {(incidentsByRoute.get(route.id) ?? []).map((incident) => (
                            <li key={incident.id} className="rounded bg-background/60 px-2 py-1.5 text-[11px]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold">{t(`dispatch.incidentCategory.${incident.category}`)}</span>
                                <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={incident.createdAt}>
                                  {new Date(incident.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </time>
                              </div>
                              <p className="mt-0.5 leading-snug">{incident.comment}</p>
                              {isHttpsUrl(incident.attachmentUrl) ? (
                                <a
                                  href={incident.attachmentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-flex underline text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                                >
                                  {t("dispatch.incidentEvidence")}
                                </a>
                              ) : incident.attachmentUrl ? (
                                <span className="mt-1 block break-all text-muted-foreground">
                                  {incident.attachmentUrl}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}
            </div>
          </details>
        )}
        <Dialog open={planWorkflowOpen && Boolean(requestedPlanId)} onOpenChange={setPlanWorkflowOpen}>
          <DialogContent data-testid="dispatch-plan-workflow-dialog" className="max-h-[90dvh] w-[96vw] max-w-5xl overflow-y-auto">
            <DialogTitle>{t("dispatch.importApprovalTitle")}</DialogTitle>
            <DialogDescription className="break-words">{dispatchHeaderTitle}</DialogDescription>
            {planStatusPanel}
            {dispatchBlockingDetails}
            <ImportPlanApprovalPanel
            requestedPlanId={requestedPlanId}
            liveRoutes={routes ?? []}
            showValidationSuccess={validationSuccessPlanId === requestedPlanId}
            canWrite={hasRole("admin", "dispatcher") && !selectedScopeReadOnly}
            onContinueLive={() => {
              setPlanWorkflowOpen(false);
              if (requestedPlanId) {
                navigate(`/dispatch?${carryRoutesReturnTo(new URLSearchParams({ view: "live", planId: requestedPlanId }), window.location.search).toString()}`, { replace: true });
              }
            }}
            />
          </DialogContent>
        </Dialog>


        {!focusMode && (
          <section
            className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b border-border px-3 py-1"
            aria-label="Planåtgärder"
            data-testid="dispatch-send-plan-bar"
          >
            {planLiveMode === "plan" && hasRole("admin", "dispatcher") && !selectedScopeReadOnly && (
              <DispatchReoptimizationAction routes={activeRoutes} drivers={drivers ?? []}
                vehicles={vehicles ?? []} stops={allStops ?? []} selectedIds={highlightedRouteIds} />
            )}
            {planLiveMode === "plan" && requestedPlanId && hasRole("admin", "dispatcher") && !selectedScopeReadOnly && <Button
              type="button"
              size="sm"
              className="h-7 min-h-7 gap-1.5 rounded px-2 py-0 text-[11px] font-semibold shadow-none [&_svg]:size-3 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-h-11"
              data-testid="dispatch-plan-workflow-open"
              aria-haspopup="dialog"
              onClick={() => setPlanWorkflowOpen(true)}
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              Skicka till chaufför
            </Button>}
            <ActionQueueToggle open={actionQueueOpen} count={overloadedCount + slaRiskCount} onToggle={() => setActionQueueOpen(value => !value)} />
          </section>
        )}

        <div className="flex-1 grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto] min-h-[480px] shrink-0 md:min-h-0 md:shrink w-full relative z-0 pb-2">
          {!focusMode && (
            <div className="col-start-1 row-start-2 border-t border-border bg-card/60 flex items-center px-2 py-0.5 z-10">
              <button
                type="button"
                onClick={() => setInboxRailOpen((v) => !v)}
                className={`relative h-7 flex items-center gap-2 rounded px-2 text-xs font-semibold transition-colors cursor-pointer ${
                  inboxRailOpen
                    ? "bg-primary/15 text-primary"
                    : unassignedStops.length > 0
                      ? "text-destructive hover:bg-destructive/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                aria-label={t("dispatch.leftRailTooltip")}
                title={t("dispatch.leftRailTooltip")}
                aria-expanded={inboxRailOpen}
                aria-controls="dispatch-work-queue-dock"
              >
                <Package className="h-4 w-4" />
                Uppdrag
                {unassignedStops.length > 0 && (
                  <span className="rounded bg-muted px-1 text-[10px] tabular-nums">
                    {unassignedStops.length > 99 ? "99+" : unassignedStops.length}
                  </span>
                )}
                <span aria-hidden="true">{inboxRailOpen ? "▾" : "▴"}</span>
              </button>
            </div>
          )}

          <div className="col-start-1 row-start-1 flex flex-col min-w-0 min-h-0">
            <DispatchBulkActions selectedStopIds={selectedStopIds} setSelectedStopIds={setSelectedStopIds}
              routeRequest={mapRouteRequest}
              stops={allStops ?? []} routes={activeRoutes}
              routeDriverNames={dispatchRouteDriverNames(activeRoutes, drivers ?? [], approvalQuery.error ? undefined : approvalQuery.data)}
              canEdit={planLiveMode === "plan" && !selectedScopeReadOnly && hasRole("admin", "dispatcher")}
              requestMove={(ids, routeId, index, force, expectedPreviewDigest, optimizeTargetRoute) => requestDispatchMove(ids, routeId, index, force, expectedPreviewDigest, optimizeTargetRoute)} />
            <ResizablePanelGroup
              key={`traffic-panels-${trafficLayout}-${popoutOpen ? "detached" : "embedded"}`}
              direction="vertical"
              className="min-h-0 flex-1 w-full"
              data-testid="dispatch-split"
            >
              {mapVisible && popoutOpen && (
                <>
                  <ResizablePanel
                    id="dispatch-map-popout"
                    order={1}
                    defaultSize={timelineVisible ? 58 : 100}
                    minSize={28}
                    maxSize={timelineVisible ? 72 : 100}
                    minSizePixels={120}
                    className="relative z-0"
                  >
                    <div className="w-full h-full flex items-center justify-center bg-muted/30 border-b border-border/50">
                      <div className="text-center p-6 max-w-md">
                        <ExternalLink className="h-8 w-8 mx-auto mb-3 text-emerald-500" />
                        <p className="text-sm font-semibold mb-1">{t("dispatch.popoutBanner")}</p>
                        <p className="text-xs text-muted-foreground mb-4">
                          {mapRoutes.length} {t("dispatch.routesLabel")} · {unassignedStops.length} {t("dispatch.unplannedLabel")}
                        </p>
                        <div className="flex items-center gap-2 justify-center">
                          <button
                            type="button"
                            onClick={() => popoutWindowRef.current?.focus()}
                            className="px-3 py-1.5 text-xs font-semibold bg-card border border-border rounded-md hover:bg-muted transition-colors cursor-pointer"
                          >
                            {t("dispatch.popoutFocus")}
                          </button>
                          <button
                            type="button"
                            onClick={closeMapPopout}
                            className="px-3 py-1.5 text-xs font-semibold bg-muted rounded-md hover:bg-muted/80 transition-colors cursor-pointer"
                          >
                            {t("dispatch.popoutClose")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </ResizablePanel>
                  {timelineVisible && <ResizableHandle
                    withHandle
                    className="h-2 bg-border/60 hover:bg-primary/40 transition-colors shrink-0 z-10"
                  />}
                </>
              )}
              {mapVisible && !popoutOpen && (
                <>
                  <ResizablePanel
                    id="dispatch-map"
                    order={1}
                    defaultSize={timelineVisible ? 58 : 100}
                    minSize={28}
                    maxSize={timelineVisible ? 72 : 100}
                    minSizePixels={120}
                    data-testid="dispatch-map-panel"
                    className="relative z-0"
                  >
                    <div className="w-full h-full p-2">
                      <div className="relative w-full h-full rounded-xl overflow-hidden shadow-inner border border-border/50 bg-card">
                        {showHistory ? (
                          <TrafficHistoryMap routes={routes ?? []} showPredictions={showPredictions}
                            routeColor={(route) => (route.vehicleId ? vehiclesById.get(route.vehicleId)?.routeColor : undefined)} />
                        ) : (<>
                        {planLiveMode === "live" && (
                          <TrafficTelemetryPanel
                            routes={visibleMapRoutes.map((route) => ({ id: route.id, name: route.name, color: route.routeColor }))}
                            positions={livePositionsQuery.data ?? []}
                            positionsError={livePositionsQuery.isError}
                            positionsUpdatedAt={livePositionsQuery.dataUpdatedAt}
                            eventsUpdatedAt={geofenceQuery.dataUpdatedAt}
                            events={geofenceQuery.data ?? []}
                            eventsError={geofenceQuery.isError}
                            selectedRouteId={highlightedRouteId}
                            onSelectRoute={(routeId) => handleSetHighlightRoute(routeId)}
                          />
                        )}
                        <RouteMap
                          showPredictions={showPredictions}
                          key={focusMode ? "dispatch-map-focus" : "dispatch-map-standard"}
                          routes={visibleMapRoutes}
                          planningActionsEnabled={planLiveMode === "plan" && !selectedScopeReadOnly}
                          dropRequest={mapDropRequest}
                          onDropRoute={routeId => {
                            if (!routeId) {
                              toast({ title: "Ingen rutt valdes", description: "Släpp nära en ruttlinje eller använd Flytta uppdrag för att välja rutt." });
                              return;
                            }
                            setSelectedStopIds(new Set(mapDropStops.current));
                            setMapRouteRequest({ routeId, nonce: Date.now() });
                          }}
                          vehiclePositions={planLiveMode === "live"
                            ? actualTelemetryOnly(livePositionsQuery.data ?? []).filter(position => visibleMapRoutes.some(route => route.id === position.routeId))
                            : []}
                          unassignedStops={visibleUnassignedStops}
                          interactive={true}
                          selectedStopId={selectedStopId}
                          onHoverStop={setHoveredStopId}
                          selectedStopIds={selectedStopIds}
                          onSelectStop={handleMapSelectStop}
                          selectionEnabled
                          onPolygonSelect={(ids) => {
                            if (!ids.length) return;
                            setSelectedStopId(null); setSelectedStopIds(new Set(ids));
                            setMapRouteRequest({ origin: "polygon", routeId: null, nonce: Date.now() });
                          }}
                          highlightedRouteId={highlightedRouteId}
                          highlightedRouteIds={highlightedRouteIds}
                          onHighlightRoute={handleSetHighlightRoute}
                          onSelectDriverRoute={selectDriverRoute}
                          onClearDriverRoutes={clearDriverRoutes}
                          focusStopId={focusStopId}
                          hoveredStopId={hoveredStopId}
                        />
                        </>)}
                      </div>
                    </div>
                  </ResizablePanel>
                  {timelineVisible && <ResizableHandle
                    withHandle
                    data-testid="dispatch-split-handle"
                    className="h-2 data-[panel-group-direction=vertical]:h-2 touch-none cursor-ns-resize bg-border/60 hover:bg-primary/40 transition-colors shrink-0 z-10"
                  />}
                </>
              )}

              {timelineVisible && <ResizablePanel
                id="dispatch-timeline"
                order={2}
                defaultSize={mapVisible ? 42 : 100}
                minSize={28}
                minSizePixels={120}
                data-testid="dispatch-timeline-panel"
                className="flex flex-col flex-1 min-h-0 overflow-hidden relative"
              >
                {visibleScheduledRows.length === 0 && visibleUnassignedStops.length === 0 && (
                  <div className="shrink-0 border-b border-border px-3 py-2 text-muted-foreground text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      {dispatchSearchQuery.trim() ? (
                        <>
                          <p role="status" aria-live="polite">
                            {t("dispatch.searchNoResults")}
                          </p>
                          <button
                            type="button"
                            onClick={() => setDispatchSearchQuery("")}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
                          >
                            {t("dispatch.clearSearch")}
                          </button>
                        </>
                      ) : (
                        <>
                          <p>{t("dispatch.noRoutes")}</p>
                          <button
                            type="button"
                            onClick={() => navigate("/planner")}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            {t("dispatch.runPlanner")}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
                  <div className="relative flex flex-1 min-h-0 flex-col bg-card">
                    <UnscheduledStopsLane
                      stops={visibleUnassignedStops}
                      selectedStopIds={selectedStopIds}
                      selectedStopId={selectedStopId}
                      setSelectedStopIds={setSelectedStopIds}
                      onSelectStop={handleMapSelectStop}
                      startDrag={startDrag}
                    />
                    <div className="absolute top-1 right-3 z-30 flex origin-top-right scale-[0.6] items-center bg-card/90 backdrop-blur-sm rounded-md border border-border px-0.5 shadow-md">
                      <button
                        type="button"
                        className="w-11 h-11 flex items-center justify-center rounded-l-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                        onClick={() => setZoomLevel((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                        disabled={zoomLevel <= 0.5}
                        aria-label={t("dispatch.zoomOut")}
                      >
                        <ZoomOut className="h-4 w-4" />
                      </button>
                      <span className="text-xs font-mono text-muted-foreground min-w-[36px] text-center select-none" data-testid="zoom-level">
                        {Math.round(zoomLevel * 100)}%
                      </span>
                      <button
                        type="button"
                        className="w-11 h-11 flex items-center justify-center rounded-r-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                        onClick={() => setZoomLevel((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
                        disabled={zoomLevel >= 3}
                        aria-label={t("dispatch.zoomIn")}
                      >
                        <ZoomIn className="h-4 w-4" />
                      </button>
                    </div>
                    <GanttTimeline
                      rows={visibleScheduledRows}
                      showActualTimes
                      renderResourceAction={hasRole("admin", "dispatcher") && planLiveMode === "plan" ? (routeId) => {
                        const route = routes?.find(candidate => candidate.id === routeId);
                        return route ? <div className="flex gap-1">
                          <RouteDriverAction key={route.id} route={route}
                            vehicles={vehicles ?? []} drivers={drivers ?? []} compact />
                        </div> : null;
                      } : undefined}
                      selectedStopId={selectedStopId}
                      onSelectStop={handleSelectStop}
                      zoomLevel={zoomLevel}
                      highlightedRouteId={highlightedRouteId}
                      highlightedRouteIds={highlightedRouteIds}
                      onSelectDriverRoute={selectDriverRoute}
                      onClearDriverRoutes={clearDriverRoutes}
                      onHighlightRoute={handleSetHighlightRoute}
                      scrollToRouteId={highlightedRouteId}
                      onReassignStops={handleReassignStops}
                      bulkActionsExternal
                      selectedStopIds={selectedStopIds}
                      setSelectedStopIds={setSelectedStopIds}
                      dragState={dragState}
                      startDrag={startDrag}
                      dropTargetRouteId={dropTargetRouteId}
                      dropTargetIndex={dropTargetIndex}
                      slaCountByRoute={slaCountByRoute}
                      onFocusAlerts={() => focusActionSection("sla")}
                      rowHeight={density === "compact" ? 44 : density === "spacious" ? 72 : 56}
                      hoveredStopId={hoveredStopId}
                      onHoverStop={setHoveredStopId}
                      drivers={drivers}
                    />
                  </div>
              </ResizablePanel>}
            </ResizablePanelGroup>
          </div>

          {inboxRailOpen && !focusMode && (
            <div id="dispatch-work-queue-dock" className="col-start-1 row-start-3 h-[min(28dvh,240px)] min-h-0 min-w-0 flex overflow-hidden border-t border-border bg-card text-card-foreground">
              <PlannerWorkQueue
                tab={queueTab}
                onTabChange={setQueueTab}
                unassignedCount={unassignedStops.length}
                rows={scheduledRows}
                unassignedStops={unassignedStops}
                selectedStopId={selectedStopId}
                onSelectScheduled={(stopId, rowIdx) => {
                  setSelectedStopIds(new Set());
                  handleSelectStop(stopId, rowIdx);
                }}
                onSelectUnassigned={(stopId) => {
                  setSelectedStopId(stopId);
                  setFocusStopId(stopId);
                  setSelectedStopIds(new Set([stopId]));
                }}
                onHoverStop={setHoveredStopId}
                onClose={() => setInboxRailOpen(false)}
                actionPanel={
                  <ActionQueue
                    rows={livePriorityRows}
                    unassignedStops={unassignedStops}
                    focusSection={actionFocusSection}
                    onSelectStop={(stopId, rowIdx) => {
                      setSelectedStopIds(new Set());
                      handleSelectStop(stopId, rowIdx);
                    }}
                    onHighlightRoute={handleSetHighlightRoute}
                    onFocusUnassigned={(stopId) => {
                      setSelectedStopId(stopId);
                      setFocusStopId(stopId);
                      setSelectedStopIds(new Set([stopId]));
                    }}
                  />
                }
                unassignedPanel={
                  <UnplannedInbox
                    stops={unassignedStops}
                    selectedStopIds={selectedStopIds}
                    setSelectedStopIds={setSelectedStopIds}
                    startDrag={startDrag}
                    dropTargetRouteId={dropTargetRouteId}
                    isDragging={!!dragState}
                    onFocusStop={(stopId) => {
                      setFocusStopId(stopId);
                      setSelectedStopId(stopId);
                      setSelectedStopIds(new Set([stopId]));
                    }}
                    onHoverStop={setHoveredStopId}
                    density={density}
                    lastImportAt={lastImportAt}
                  />
                }
              />
            </div>
          )}

          {actionQueueOpen && !focusMode && (
            <div id="dispatch-action-queue" className="absolute inset-y-0 right-0 w-[300px] max-w-full z-30 flex shadow-2xl animate-in slide-in-from-right-2 duration-150">
              <ActionQueue
                rows={livePriorityRows}
                unassignedStops={unassignedStops}
                focusSection={actionFocusSection}
                onSelectStop={handleSelectStop}
                onHighlightRoute={handleSetHighlightRoute}
                onFocusUnassigned={(stopId) => {
                  setFocusStopId(stopId);
                  setSelectedStopIds(new Set([stopId]));
                }}
                onClose={() => setActionQueueOpen(false)}
              />
            </div>
          )}

          {selectedStop && !focusMode && (
            <div
              className={`absolute inset-y-0 w-[320px] z-40 flex shadow-2xl animate-in slide-in-from-right-2 duration-150 ${actionQueueOpen ? "right-[300px]" : "right-0"}`}
            >
              <StopDetailPanel
                planningLocks={selectedPlanningLocks}
                correctionPanel={planLiveMode === "plan" && selectedApiStop?.status === "pending" && hasRole("admin", "dispatcher") ? (
                  <PlannerCorrectionsPanel stopId={selectedApiStop.id} address={selectedApiStop.address}
                    routeIds={activeRoutes.filter(route => route.planId != null &&
                      route.planId === (requestedPlanId ?? selectedLockRoute?.planId ?? selectedApiStop.planningPlanId)).map(route => route.id)} />
                ) : undefined}
                routeId={selectedStopIsUnassigned ? undefined : selectedRow?.routeId}
                routeLabel={selectedRow?.routeName}
                organizationId={user?.organizationId ?? undefined}
                stop={selectedStop}
                nearbyStops={nearbyStopsForSelection(selectedStop, scheduledRows, activeRoutes)}
                onSelectNearbyStop={(stopId) => handleSelectStop(stopId, scheduledRows.findIndex((row) => row.stops.some((item) => item.stopId === stopId)))}
                routeColor={selectedStopIsUnassigned ? "#06b6d4" : selectedRow?.color ?? "#06b6d4"}
                driverName={selectedStopIsUnassigned ? t("dispatch.unassigned") : selectedRow?.driverName}
                vehicleName={selectedStopIsUnassigned ? t("dispatch.noVehicle") : selectedRow?.vehicleName}
                hasDispatchedDriver={!selectedStopIsUnassigned}
                readOnlyMessages={user?.role === "viewer"}
                firstStopLock={selectedFirstStopLock}
                onClose={() => setSelectedStopId(null)}
              />
            </div>
          )}

          {focusMode && (
            <button
              type="button"
              onClick={() => setFocusMode(false)}
              data-testid="dispatch-focus-exit"
              className="absolute right-3 top-3 z-50 flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] font-semibold shadow-lg transition-colors hover:bg-muted"
              aria-label={t("dispatch.exitFocus")}
              title={t("dispatch.exitFocus") + " (F / Esc)"}
            >
              <Minimize2 className="h-3.5 w-3.5" />
              {t("dispatch.exitFocus")}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setKbdHelpOpen(true)}
          className="fixed bottom-4 right-4 z-40 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-card border border-border shadow-md hover:bg-muted transition-colors cursor-pointer"
          aria-label={t("dispatch.kbdHelpTitle")}
          title={t("dispatch.kbdHelpTitle") + " (?)"}
        >
          <HelpCircle className="h-5 w-5 text-muted-foreground" />
        </button>

        <KeyboardHelp open={kbdHelpOpen} onClose={() => setKbdHelpOpen(false)} />

        <Dialog open={importOpen} onOpenChange={setImportWorkflowOpen}>
          <DialogContent className="h-[92vh] w-[96vw] max-w-[1400px] overflow-hidden p-0">
            <DialogTitle className="sr-only">{t("dispatch.importOrders")}</DialogTitle>
            {importOpen && importDraftId ? (
                <ImportWorkflow
                  embedded
                  draftId={importDraftId}
                  onComplete={({ planId, validated, previewMap }) => {
                    setImportOpen(false);
                    if (user?.organizationId) {
                      sessionStorage.setItem(
                        routePlanSelectionStorageKey(user.organizationId),
                        planId,
                      );
                    }
                    const params = new URLSearchParams(window.location.search);
                    params.delete("workflow");
                    params.delete("draftId");
                    params.set("planId", planId);
                    if (previewMap) {
                      params.delete("routeId");
                      params.delete("validated");
                      params.set("view", "traffic");
                      params.set("mode", "plan");
                      if (trafficLayout === "timeline") setTrafficLayout("split");
                      navigate(`/dispatch?${params.toString()}`, { replace: true });
                      return;
                    }
                    params.set("view", validated ? "traffic" : "live");
                    if (validated) {
                      params.set("validated", "1");
                      void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                      navigate(`/dispatch?${params.toString()}`, { replace: true });
                      return;
                    }
                    navigate(`/dispatch?${params.toString()}`, { replace: true });
                    toast({
                      title: t("dispatch.importComplete"),
                      description: t("dispatch.importCompleteDescription"),
                    });
                  }}
                />
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog
          open={serviceTimePlanId != null}
          onOpenChange={(open) => !open && setServiceTimePlanId(null)}
        >
          <DialogContent showCloseButton={false} className="flex h-[92vh] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:p-0">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-2 sm:px-6">
              <DialogTitle>{t("dispatch.adjustPlanTitle")}</DialogTitle>
              <DialogClose className="flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border px-4 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="close-adjust-plan">
                {t("common.close")}
              </DialogClose>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {serviceTimePlanId && !selectedExistingPlan && (
              <Alert variant="destructive" data-testid="plan-review-depot-unavailable-dialog">
                <ShieldAlert className="h-4 w-4" />
                <AlertDescription>{t("dispatch.adjustPlanRecoveryError")}</AlertDescription>
              </Alert>
            )}
            {serviceTimePlanId && selectedExistingPlan?.planId === serviceTimePlanId && (
              <Step7Adjust
                routes={selectedExistingPlan.routes.map((route) => {
                  const driver = route.vehicleId
                    ? driversByVehicleId.get(route.vehicleId)
                    : undefined;
                  return {
                    routeId: route.id,
                    planId: route.planId,
                    name: route.name,
                    vehicleId: route.vehicleId!,
                    driverId: driver?.id ?? selectedExistingPlan.fallbackDriverId ?? route.handoffDriverId ?? "",
                    stopCount: route.totalStops,
                    totalDistanceKm: route.totalDistanceKm ?? 0,
                    totalDurationMin: route.totalDurationMin ?? 0,
                    planRevision: route.planRevision,
                    status: "optimized" as const,
                  };
                })}
                unplannedStops={[]}
                unplannedDiagnostics={[]}
                vehicles={vehicles || []}
                drivers={drivers || []}
                depotLatitude={selectedExistingPlan.depotLatitude}
                depotLongitude={selectedExistingPlan.depotLongitude}
                readOnly={selectedExistingPlan.routes.some((route) => route.status !== "optimized")}
                allowResourceSelection
                onValidated={async (validatedRoutes) => {
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
                    queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
                  ]);
                  setServiceTimePlanId(null);
                  const planId = validatedRoutes[0]?.planId;
                  if (planId) {
                    navigate(`/dispatch?${carryRoutesReturnTo(new URLSearchParams({ view: "traffic", planId, validated: "1" }), window.location.search)}`, { replace: true });
                  }
                }}
                onNext={() => {
                  setServiceTimePlanId(null);
                  void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                  void queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
                }}
              />
            )}
            </div>
          </DialogContent>
        </Dialog>

        <StopRegisterDialog
          open={stopRegisterOpen}
          onOpenChange={setStopRegisterOpen}
          target={stopRegisterTarget}
          onSuccess={async (result) => {
            // Authoritative refresh only: no route assignment, no send.
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
              queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
              requestedPlanId
                ? queryClient.invalidateQueries({ queryKey: getGetImportRoutePlanApprovalQueryKey(requestedPlanId) })
                : Promise.resolve(),
            ]);
            setQueueTab("unassigned");
            toast({
              title: t("stopRegister.addedUnassigned", { count: result.count }),
            });
          }}
        />
        <Dialog open={Boolean(lateStopPlan)} onOpenChange={(open) => { if (!open) setLateStopPlan(null); }}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogTitle>{t("dispatch.addPlanStopTitle", { name: lateStopPlan?.name })}</DialogTitle>
            <DialogDescription>{t("dispatch.addPlanStopDescription")}</DialogDescription>
            {lateStopPlan && user?.organizationId && (
              <StopForm
                organizationId={user.organizationId}
                plan={lateStopPlan}
                onCancel={() => setLateStopPlan(null)}
                onSuccess={() => {
                  setLateStopPlan(null);
                  void queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
                  void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                  toast({ title: t("dispatch.addPlanStopSuccess") });
                }}
              />
            )}
          </DialogContent>
        </Dialog>
        {forceAssignment && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="force-assignment-title">
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                <div>
                  <h2 id="force-assignment-title" className="font-semibold">{t("dispatch.assignmentConflict")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t("dispatch.assignmentConflictDescription")}</p>
                </div>
              </div>
              <ul className="mt-4 space-y-1 text-sm">
                {forceAssignment.conflicts.map((conflict) => (
                  <li key={conflict} className="rounded bg-amber-50 px-2 py-1 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                    {{
                      CAPACITY: t("dispatch.reasonCapacity"),
                      TIME_WINDOW: t("dispatch.reasonTimeWindow"),
                      WORKING_HOURS: t("dispatch.reasonWorkingHours"),
                      RANGE: t("dispatch.reasonRange"),
                      NO_VEHICLE: t("dispatch.reasonNoVehicle"),
                    }[conflict] ?? conflict}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted-foreground">{t("dispatch.forceAssignmentWarning")}</p>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted" onClick={() => setForceAssignment(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700"
                  onClick={async () => {
                    const assignment = forceAssignment;
                    if (!canConfirmPlanningDeviation(assignment.conflicts)) {
                      toast({ title: "Flytten är blockerad", description: "Hårda eller okända begränsningar kan inte överstyras.", variant: "destructive" });
                      return;
                    }
                    try {
                      const result = await requestDispatchMove(
                        assignment.stopIds,
                        assignment.routeId,
                        assignment.targetIndex ?? 0,
                        true,
                      );
                      if (result.conflicts.length > 0 || result.error) {
                        const lockedStopError = formatLockedStopError(result, i18n.language);
                        if (lockedStopError) {
                          toast({
                            title: t("common.somethingWentWrong"),
                            description: lockedStopError,
                            variant: "destructive",
                          });
                          return;
                        }
                        throw createDispatchMoveError(
                          result.status ?? 409,
                          result.error || "Forced assignment was not accepted",
                          result.code ? { code: result.code } : undefined,
                        );
                      }
                      setForceAssignment(null);
                      toast({ title: t("dispatch.assignmentForced") });
                    } catch (error) {
                      if (isDispatchMoveUnauthorized(error)) {
                        setSelectedStopIds(new Set(assignment.stopIds));
                        setDispatchReauthenticationOpen(true);
                        return;
                      }
                      if (isDispatchMoveRevisionConflict(error)) {
                        setForceAssignment(null);
                        await Promise.all([
                          queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
                          queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
                        ]);
                        toast({
                          title: t("common.errorConflict"),
                          description: t("dispatch.moveRevisionConflict"),
                          variant: "destructive",
                        });
                        return;
                      }
                      toast({
                        title: t("common.somethingWentWrong"),
                          description: describeDispatchError(error, t, "common.errorRequestFailed"),
                        variant: "destructive",
                      });
                    }
                  }}
                >
                  {t("dispatch.forceIntoRoute")}
                </button>
              </div>
            </div>
          </div>
        )}
        <DispatchReauthenticationDialog
          open={dispatchReauthenticationOpen}
          onOpenChange={setDispatchReauthenticationOpen}
          onSuccess={() => {
            toast({
              title: t("dispatch.reauthenticationSucceeded"),
              description: t("dispatch.reauthenticationRetry"),
              duration: 6000,
            });
          }}
        />
      </div>
    </AppLayout>
  );
}
function DispatchIncoming() {
  const { t, i18n } = useTranslation();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const { hasRole, user } = useAuth();
  const queryClient = useQueryClient();
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops(undefined, true);
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();

  const dispatchRoute = useDispatchRoute();
  const [isDispatching, setIsDispatching] = useState(false);
  const [isExportingXlsx, setIsExportingXlsx] = useState(false);
  const [importOpen, setImportOpen] = useState(
    () => {
      const params = new URLSearchParams(search);
      return params.get("workflow") === "import" && Boolean(params.get("draftId"));
    },
  );
  const [importDraftId, setImportDraftId] = useState<string | null>(
    () => new URLSearchParams(search).get("draftId"),
  );
  const [serviceTimePlanId, setServiceTimePlanId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Record<string, RoutePreflight>>({});
  const [isPreflightLoading, setIsPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [dispatchRouteFailures, setDispatchRouteFailures] = useState<Array<{ routeId: string; routeName: string; message: string }>>([]);
  const [validationSuccessPlanId, setValidationSuccessPlanId] = useState<string | null>(null);
  const consumedValidationMarker = useRef<string | null>(null);

  const setImportWorkflowOpen = useCallback((open: boolean) => {
    if (open && !importDraftId) {
      navigate("/routes/create");
      return;
    }
    setImportOpen(open);
    const params = new URLSearchParams(window.location.search);
    if (open) {
      params.set("workflow", "import");
      if (importDraftId) params.set("draftId", importDraftId);
    } else {
      params.delete("workflow");
      params.delete("draftId");
    }
    const query = params.toString();
    navigate(`/dispatch${query ? `?${query}` : ""}`, open ? undefined : { replace: true });
  }, [importDraftId, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    const draftIdFromQuery = params.get("draftId");
    const workflowRequested = params.get("workflow") === "import";
    if (workflowRequested && !draftIdFromQuery) {
      navigate("/routes/create", { replace: true });
      return;
    }
    const workflowOpen = Boolean(draftIdFromQuery);
    setImportOpen(workflowOpen);
    setImportDraftId(draftIdFromQuery);
  }, [navigate, search]);

  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("validated") !== "1") return;

    const planIdFromQuery = params.get("planId");
    const marker = `${planIdFromQuery ?? ""}:validated`;
    if (consumedValidationMarker.current === marker) return;
    consumedValidationMarker.current = marker;
    if (planIdFromQuery) setValidationSuccessPlanId(planIdFromQuery);

    // The marker is only a one-time UI success signal, never authorization.
    // The approval panel always re-reads the protected plan independently.
    params.delete("validated");
    const query = params.toString();
    navigate(`/dispatch${query ? `?${query}` : ""}`, { replace: true });
  }, [navigate, search]);

  useEffect(() => {
    if (new URLSearchParams(search).get("planId")) return;
    let cancelled = false;
    const candidates = (routes ?? []).filter(
      (route) => route.status === "optimized" || route.status === "in_progress",
    );
    if (candidates.length === 0) {
      setPreflight({});
      setIsPreflightLoading(false);
      setPreflightError(null);
      return;
    }
    setIsPreflightLoading(true);
    setPreflightError(null);
    void Promise.all(candidates.map((route) => getRoutePreflight(route.id)))
      .then((checks) => {
        if (cancelled) return;
        setPreflight(Object.fromEntries(checks.map((check) => [check.routeId, check])));
      })
      .catch((error) => {
        if (cancelled) return;
        setPreflight({});
        setPreflightError(localizeError(error, t, { fallbackKey: "dispatch.preflightLoadFailed" }));
      })
      .finally(() => {
        if (!cancelled) setIsPreflightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, routes, t]);

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedRowIdx, setSelectedRowIdx] = useState<number>(0);
  const { highlightedRouteId, highlightedRouteIds, setHighlightedRouteId,
    setHighlightedRouteIds, selectRoute: selectDriverRoute, clearRoutes: clearDriverRoutes,
    scopeKey: driverSelectionScopeKey } = useDispatchRouteSelection(
      search, routes, `${user?.organizationId ?? ""}:${user?.id ?? ""}`,
    );
  const [focusStopId, setFocusStopId] = useState<string | null>(null);
  const [mapVisible, setMapVisible] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [planLiveMode, setPlanLiveMode] = useState<"plan" | "live">(() => {
    const mode = new URLSearchParams(search).get("mode");
    return mode === "live" || new URLSearchParams(search).get("view") === "live"
      ? "live"
      : "plan";
  });

  useEffect(() => {
    const params = new URLSearchParams(search);
    const mode = params.get("mode") === "live" || params.get("view") === "live" ? "live" : "plan";
    setPlanLiveMode((current) => current === mode ? current : mode);
  }, [search]);

  const setPersistedPlanLiveMode = useCallback((mode: "plan" | "live") => {
    setPlanLiveMode(mode);
    const params = new URLSearchParams(window.location.search);
    params.set("mode", mode);
    params.set("view", mode === "live" ? "live" : "traffic");
    navigate(`/dispatch?${params.toString()}`, { replace: true });
  }, [navigate]);

  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [forceAssignment, setForceAssignment] = useState<{
    stopIds: string[];
    routeId: string;
    conflicts: string[];
    targetIndex?: number;
  } | null>(null);
  const [dispatchReauthenticationOpen, setDispatchReauthenticationOpen] = useState(false);
  const [dragState, setDragState] = useState<{
    stopIds: string[];
    sourceRouteId: string;
  } | null>(null);
  const [dropTargetRouteId, setDropTargetRouteId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const dropTargetRouteIdRef = useRef<string | null>(null);
  const dropTargetIndexRef = useRef<number | null>(null);
  const dragStateRef = useRef<ReturnType<typeof createDispatchDragSession> | null>(null);

  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const popoutWindowRef = useRef<Window | null>(null);
  const [ganttPopoutOpen, setGanttPopoutOpen] = useState(false);
  const ganttPopoutWindowRef = useRef<Window | null>(null);
  const [kbdHelpOpen, setKbdHelpOpen] = useState(false);
  const [actionQueueOpen, setActionQueueOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("dispatch.actionQueueOpen") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dispatch.actionQueueOpen", actionQueueOpen ? "1" : "0");
    }
  }, [actionQueueOpen]);
  const [inboxRailOpen, setInboxRailOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("dispatch.inboxRailOpen") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dispatch.inboxRailOpen", inboxRailOpen ? "1" : "0");
    }
  }, [inboxRailOpen]);
  const [overviewOpen, setOverviewOpen] = useState<boolean>(false);
  const overviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overviewOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!overviewRef.current?.contains(e.target as Node)) setOverviewOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [overviewOpen]);
  const [focusMode, setFocusMode] = useState<boolean>(false);
  const [actionFocusSection, setActionFocusSection] = useState<ActionSection | null>(null);
  const focusActionSection = useCallback((section: ActionSection) => {
    setActionQueueOpen(true);
    setActionFocusSection(section);
    setTimeout(() => {
      const el = document.getElementById(`aq-${section}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    setTimeout(() => setActionFocusSection(null), 1600);
  }, []);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [density, setDensity] = useState<"compact" | "comfortable" | "spacious">(() => {
    if (typeof window === "undefined") return "comfortable";
    const stored = window.localStorage.getItem("dispatch.density");
    if (stored === "compact" || stored === "comfortable" || stored === "spacious") return stored;
    return "comfortable";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("dispatch.density", density);
    }
  }, [density]);
  const rowHeight = density === "compact" ? 32 : density === "spacious" ? 56 : 44;

  const driversByVehicleId = useMemo(() => {
    const activeByVehicle = new Map<string, NonNullable<typeof drivers>[number][]>();
    drivers?.forEach((driver) => {
      if (!driver.vehicleId || !driver.isActive) return;
      activeByVehicle.set(
        driver.vehicleId,
        [...(activeByVehicle.get(driver.vehicleId) ?? []), driver],
      );
    });
    const map = new Map<string, {
      id: string;
      name: string;
      workStartTime?: string | null;
      startLatitude?: number | null;
      startLongitude?: number | null;
    }>();
    activeByVehicle.forEach((candidates, vehicleId) => {
      if (candidates.length !== 1) return;
      const [driver] = candidates;
      map.set(vehicleId, {
        id: driver.id,
        name: driver.name,
        workStartTime: driver.workStartTime,
        startLatitude: driver.startLatitude,
        startLongitude: driver.startLongitude,
      });
    });
    return map;
  }, [drivers]);

  const vehiclesById = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        name: string;
        vehicleType: string;
        capacityKg: number | null;
        capacityVolume: number | null;
        routeColor: string;
        isActive: boolean;
      }
    >();
    vehicles?.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const requestedPlanId = useMemo(() => {
    return new URLSearchParams(search).get("planId");
  }, [search]);
  const approvalQuery = useGetImportRoutePlanApproval(requestedPlanId ?? "", {
    query: {
      queryKey: getGetImportRoutePlanApprovalQueryKey(requestedPlanId ?? ""),
      enabled: Boolean(requestedPlanId),
      staleTime: 0,
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    },
  });
  // A plan is scoped only by an explicit URL. Session storage is used to
  // remember the last plan after planning, but must never silently restore a
  // completed/cancelled plan when the user opens the global dispatch board.
  const selectedPlanId = requestedPlanId;
  const clearPlanScope = useCallback(() => {
    if (user?.organizationId && typeof window !== "undefined") {
      sessionStorage.removeItem(routePlanSelectionStorageKey(user.organizationId));
    }
    const params = new URLSearchParams(window.location.search);
    params.delete("planId");
    navigate(`/dispatch${params.toString() ? `?${params.toString()}` : ""}`, { replace: true });
  }, [navigate, user?.organizationId]);

  const activeRoutes = useMemo(
    () => selectScopedRoutes(routes ?? [], readDispatchScope(search)),
    [routes, search],
  );

  const activePlanIds = useMemo(
    () => new Set(activeRoutes.map((route) => route.planId)),
    [activeRoutes],
  );
  const selectedOptimizedPlanRoutes = useMemo(() => {
    const selectedRoute = activeRoutes.find((route) => route.id === highlightedRouteId);
    if (!selectedRoute) return null;
    return activeRoutes.filter((route) => route.planId === selectedRoute.planId);
  }, [activeRoutes, highlightedRouteId]);
  const selectedReoptimizationRoute = useMemo(
    () => activeRoutes.find((route) => route.id === highlightedRouteId) ?? null,
    [activeRoutes, highlightedRouteId],
  );
  const selectedReoptimizationPlanRoutes = useMemo(
    () =>
      selectedReoptimizationRoute
        ? activeRoutes.filter(
            (route) => route.planId === selectedReoptimizationRoute.planId,
          )
        : [],
    [activeRoutes, selectedReoptimizationRoute],
  );

  const selectedExistingPlan = useMemo(() => {
    if (!selectedOptimizedPlanRoutes) return null;
    const depot = resolvePlanReviewDepot(
      selectedOptimizedPlanRoutes,
      drivers ?? [],
      new Set((vehicles ?? [])
        .filter((vehicle) => vehicle.isActive)
        .map((vehicle) => vehicle.id)),
    );
    if (!depot) return null;
    return {
      planId: selectedOptimizedPlanRoutes[0].planId,
      draftId: selectedOptimizedPlanRoutes.find((route) => route.draftId)?.draftId ?? null,
      routes: selectedOptimizedPlanRoutes,
      depotLatitude: depot.depotLatitude,
      depotLongitude: depot.depotLongitude,
      fallbackDriverId: depot.fallbackDriverId,
    };
  }, [
    selectedOptimizedPlanRoutes,
    drivers,
    vehicles,
  ]);
  const reviewDraftId = useMemo(
    () => activeRoutes.find((route) => route.draftId)?.draftId ?? null,
    [activeRoutes],
  );

  const exportSelection = useMemo(() => {
    return chooseRoutePlanExportSelection(
      activeRoutes,
      highlightedRouteId,
      requestedPlanId,
    );
  }, [activeRoutes, highlightedRouteId, requestedPlanId]);

  const exportRoutePlanXlsx = useCallback(async () => {
    if (!exportSelection || isExportingXlsx) return;
    setIsExportingXlsx(true);
    const query = new URLSearchParams({ type: "routePlan", format: "xlsx" });
    if (exportSelection.kind === "date") {
      query.set("from", exportSelection.id);
      query.set("to", exportSelection.id);
    } else {
      query.set(exportSelection.kind === "route" ? "routeId" : "planId", exportSelection.id);
    }
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const response = await fetch(`${apiBase}/api/export?${query.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data?.error || t("dispatch.exportXlsxError"));
        Object.assign(error, { status: response.status, data });
        throw error;
      }
      const blob = await response.blob();
      const responseName = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = responseName || `traivo-ruttplan-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: t("dispatch.exportXlsxReady") });
    } catch (error) {
      toast({
        title: t("dispatch.exportXlsxError"),
        description: localizeError(error, t, { fallbackKey: "dispatch.exportXlsxError" }),
        variant: "destructive",
      });
    } finally {
      setIsExportingXlsx(false);
    }
  }, [exportSelection, isExportingXlsx, t, toast]);

  const acknowledgementRoutes = useMemo(
    () =>
      activeRoutes
        .map((route) => route as RouteHandoff)
        .filter((route) => route.handoffStatus && route.handoffStatus !== "pending"),
    [activeRoutes],
  );
  const incidentQueries = useRouteIncidents(acknowledgementRoutes.map((route) => route.id));
  const incidentsByRoute = useMemo(
    () => new Map(
      acknowledgementRoutes.map((route, index) => [route.id, incidentQueries[index]?.data ?? []]),
    ),
    [acknowledgementRoutes, incidentQueries],
  );

  const overdueAcknowledgements = useMemo(
    () =>
      acknowledgementRoutes.filter((route) => {
        if (route.handoffStatus !== "sent" || !route.sentAt) return false;
        return Date.now() - new Date(route.sentAt).getTime() > 5 * 60 * 1000;
      }),
    [acknowledgementRoutes],
  );

  const handoffTimestamp = useCallback((route: RouteHandoff) => {
    const value =
      route.handoffStatus === "rejected" ? route.rejectedAt :
      route.handoffStatus === "accepted" ? route.acceptedAt :
      route.handoffStatus === "opened" ? route.openedAt :
      route.handoffStatus === "received" ? route.receivedAt :
      route.sentAt;
    return value
      ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  }, []);

  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, Stop[]>();
    if (!allStops) return map;
    allStops.forEach((s) => {
      if (s.routeId) {
        const arr = map.get(s.routeId) || [];
        arr.push(s);
        map.set(s.routeId, arr);
      }
    });
    return map;
  }, [allStops]);

  const unassignedStops = useMemo(
    () => selectScopedUnassignedStops(allStops ?? [], readDispatchScope(search), activeRoutes),
    [allStops, search, activeRoutes],
  );

  const scheduledRows: ScheduledRow[] = useMemo(() => {
    const routeRows = activeRoutes.map((route, idx) => {
      const vehicle = route.vehicleId
        ? vehiclesById.get(route.vehicleId)
        : undefined;
      const driver = route.vehicleId
        ? driversByVehicleId.get(route.vehicleId)
        : undefined;

      const routeStops = stopsByRouteId.get(route.id) || [];
      const scheduledMetadata = computeSchedule(routeStops);
      const evidence = getWorkdayEvidence(
        route.workdayTimeline,
        route.workdaySummary,
        scheduledMetadata.map((stop) => stop.stopId),
      );
      const scheduled = evidence.timeline
        ? attachWorkdayEvidence(scheduledMetadata, evidence.timeline)
        : scheduledMetadata;

      const totalWeight = scheduled.reduce((s, st) => s + st.weightKg, 0);
      const totalVolume = scheduled.reduce((s, st) => s + st.volumeM3, 0);
      const capKg = vehicle?.capacityKg ?? 0;
      const capPct = capKg > 0 ? (totalWeight / capKg) * 100 : 0;

      return {
        routeId: route.id,
        routeName: route.name,
        routeDate: route.date,
        driverId: driver?.id ?? null,
        driverName: vehicle?.name ?? driver?.name ?? t("dispatch.unassigned"),
        planRevision: route.planRevision,
        manualReviewRequired: route.manualReviewRequired,
        manualReviewedAt: route.manualReviewedAt,
        handoffStatus: route.handoffStatus,
        handoffVersion: route.handoffVersion,
        handoffDriverId: route.handoffDriverId,
        sentAt: route.sentAt,
        vehicleId: route.vehicleId ?? "",
        vehicleName: vehicle?.name ?? t("dispatch.noVehicle"),
        vehicleType: vehicle?.vehicleType ?? "fossil",
        capacityKg: vehicle?.capacityKg ?? 0,
        capacityVolume: vehicle?.capacityVolume ?? 0,
        totalWeightKg: totalWeight,
        totalVolumeM3: totalVolume,
        capacityPercent: capPct,
        color: vehicle?.routeColor ?? ROUTE_COLORS[idx % ROUTE_COLORS.length],
        stops: scheduled,
        timeline: evidence.timeline ?? undefined,
        summary: evidence.summary ?? undefined,
        workdayStatus: evidence.status,
      };
    });

    return sortScheduledRows(routeRows);
  }, [activeRoutes, vehiclesById, driversByVehicleId, stopsByRouteId, t]);

  const livePriorityRows = useMemo(() => {
    return scheduledRows;
  }, [scheduledRows]);

  const totalStopsCount = scheduledRows.reduce((s, r) => s + r.stops.length, 0) + unassignedStops.length;
  const routeRowsCount = scheduledRows.length;

  const slaCountByRoute = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of scheduledRows) {
      if (row.routeId === "unplanned" || row.workdayStatus !== "authoritative") continue;
      let count = 0;
      for (const stop of row.stops) {
        const margin = slaMarginMinutes(stop);
        if (margin !== null && margin < SLA_RISK_MARGIN_MINUTES) count++;
      }
      if (count > 0) map.set(row.routeId, count);
    }
    return map;
  }, [scheduledRows]);

  const slaRiskCount = useMemo(() => {
    let total = 0;
    slaCountByRoute.forEach((c) => (total += c));
    return total;
  }, [slaCountByRoute]);

  const avgCapacityPercent = useMemo(() => {
    const routesWithCap = scheduledRows.filter(
      (r) => r.routeId !== "unplanned" && r.capacityKg > 0,
    );
    if (routesWithCap.length === 0) return 0;
    return routesWithCap.reduce((s, r) => s + r.capacityPercent, 0) / routesWithCap.length;
  }, [scheduledRows]);

  const finishEvidence = useMemo(
    () => getDispatchFinishEvidence(scheduledRows),
    [scheduledRows],
  );
  const lastEndTime = finishEvidence.lastEndTime;
  const overtimeEndTime = finishEvidence.overtimeEndTime;
  const lastEndOverLimit = finishEvidence.lastEndOverLimit;

  const lastImportAt = useMemo<string | null>(() => {
    if (!allStops || allStops.length === 0) return null;
    let latest = 0;
    for (const s of allStops) {
      const t = new Date(s.createdAt).getTime();
      if (t > latest) latest = t;
    }
    return latest > 0 ? new Date(latest).toISOString() : null;
  }, [allStops]);

  const mapRoutes = useMemo(() => {
    return activeRoutes.map((route) => {
      const routeStops = stopsByRouteId.get(route.id) || [];
      const sorted = [...routeStops].sort(
        (a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0),
      );
      const vehicle = route.vehicleId
        ? vehiclesById.get(route.vehicleId)
        : undefined;
      return {
        ...route,
        stopsList: sorted,
        routeColor: vehicle?.routeColor,
      };
    });
  }, [activeRoutes, stopsByRouteId, vehiclesById]);

  const handleToggleHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId((prev) => (prev === routeId ? null : routeId));
    },
    [],
  );

  const handleSetHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId(routeId);
    },
    [],
  );

  const handleMapSelectStop = useCallback(
    (stopId: string, modifiers?: { additive: boolean }) => {
      if (modifiers?.additive) {
        setSelectedStopIds((current) => {
          const next = new Set(current);
          if (next.has(stopId)) next.delete(stopId);
          else next.add(stopId);
          return next;
        });
        return;
      }
      if (selectedStopId === stopId) {
        setSelectedStopIds(new Set());
        setSelectedStopId(null);
      } else {
        setSelectedStopIds(new Set([stopId]));
        setSelectedStopId(stopId);
        for (let i = 0; i < scheduledRows.length; i++) {
          if (scheduledRows[i].stops.some((s) => s.stopId === stopId)) {
            setSelectedRowIdx(i);
            break;
          }
        }
      }
    },
    [selectedStopId, scheduledRows],
  );

  const selectedStop = useMemo(() => {
    if (!selectedStopId) return null;
    for (const row of scheduledRows) {
      const found = row.stops.find((s) => s.stopId === selectedStopId);
      if (found) return found;
    }
    const unassigned = unassignedStops.find((stop) => stop.id === selectedStopId);
    return unassigned ? computeSchedule([unassigned])[0] ?? null : null;
  }, [selectedStopId, scheduledRows, unassignedStops]);

  const selectedRow = scheduledRows[selectedRowIdx] ?? null;
  const selectedStopIsUnassigned = Boolean(
    selectedStopId && unassignedStops.some((stop) => stop.id === selectedStopId),
  );
  const selectedRoute = selectedStopIsUnassigned
    ? null
    : activeRoutes.find((route) => route.id === selectedRow?.routeId) ?? null;
  const selectedRawStop = selectedStopId
    ? allStops?.find((stop) => stop.id === selectedStopId) ?? null
    : null;
  const selectedFirstStopLock = selectedRoute && selectedRawStop
    ? {
        routeId: selectedRoute.id,
        planRevision: selectedRoute.planRevision,
        routeStatus: selectedRoute.status,
        lockedFirstStopId: selectedRoute.lockedFirstStopId,
        stopId: selectedRawStop.id,
        stopStatus: selectedRawStop.status,
        stopRouteId: selectedRawStop.routeId,
      }
    : undefined;

  const requestDispatchMove = useDispatchMove(activeRoutes, allStops);
  const [mapRouteRequest, setMapRouteRequest] = useState<DispatchRouteRequest | null>(null);
  useEffect(() => {
    setMapRouteRequest(null);
    setSelectedStopIds(new Set());
    dragStateRef.current = null;
    setDragState(null);
    setDropTargetRouteId(null);
    setDropTargetIndex(null);
  }, [search, user?.id, user?.organizationId, user?.role, planLiveMode]);
  const directDrag = useDirectDispatchDrag({
    identity: JSON.stringify([user?.id, user?.organizationId, user?.role, search, driverSelectionScopeKey]),
    canEdit: planLiveMode === "plan" && hasRole("admin", "dispatcher"),
    routes: activeRoutes, stops: allStops ?? [], requestMove: requestDispatchMove,
    select: setSelectedStopIds,
    review: (ids, routeId, targetIndex) => {
      setSelectedStopIds(new Set(ids));
      setMapRouteRequest({ routeId, targetIndex, nonce: Date.now() });
    },
    notify: description => toast({ title: description }),
  });

  const handleSelectStop = useCallback(
    (stopId: string, rowIdx: number) => {
      if (selectedStopId === stopId) {
        setSelectedStopId(null);
        setFocusStopId(null);
      } else {
        setSelectedStopId(stopId);
        setSelectedRowIdx(rowIdx);
        setFocusStopId(stopId);
      }
    },
    [selectedStopId],
  );

  const handleReassignStops = useCallback(
    async (stopIds: string[], targetRouteId: string, targetIndex?: number) => {
      if (planLiveMode === "live") return;
      if (stopIds.length === 0) return;
      const newRouteId = targetRouteId === "unplanned" ? null : targetRouteId;
      const targetRow = scheduledRows.find((r) => r.routeId === targetRouteId);
      const targetLabel = targetRow?.routeName ?? t("dispatch.unplannedStops");

      const selected = new Set(stopIds);
      const ordered = [
        ...scheduledRows.flatMap((row) => row.stops.map((stop) => stop.stopId)),
        ...unassignedStops.map((stop) => stop.id),
      ]
        .filter((id) => selected.has(id))
        .map((id) => allStops?.find((stop) => stop.id === id))
        .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop));

      if (newRouteId || targetRouteId === "unplanned") {
        setSelectedStopIds(new Set(ordered.map(stop => stop.id)));
        setMapRouteRequest({ routeId: newRouteId, targetIndex: targetIndex ?? targetRow?.stops.length ?? 0, nonce: Date.now() });
        return;
      }

      try {
        const result = await requestDispatchMove(
          ordered.map((stop) => stop.id),
          newRouteId,
          targetIndex ?? targetRow?.stops.length ?? 0,
        );
        if (result.error && result.conflicts.length === 0) {
          throw new Error(result.error);
        }
        if (result.conflicts.length > 0 && newRouteId) {
          setForceAssignment({
            stopIds: ordered.map((candidate) => candidate.id),
            routeId: newRouteId,
            conflicts: result.conflicts,
            targetIndex: targetIndex ?? targetRow?.stops.length ?? 0,
          });
          return;
        }
        toast({
          title: t("dispatch.stopsReassigned"),
          description: `${stopIds.length} → ${targetLabel}`,
          duration: 6000,
        });
      } catch (error) {
        if (isDispatchMoveUnauthorized(error)) {
          // Keep the failed move out of any retry queue. Retaining the local
          // selection lets the dispatcher explicitly retry after signing in.
          setSelectedStopIds(new Set(ordered.map((stop) => stop.id)));
          setDispatchReauthenticationOpen(true);
          return;
        }
        toast({
          title: t("common.somethingWentWrong"),
          description: describeDispatchError(error, t, "common.errorRequestFailed"),
          variant: "destructive",
        });
      }
    },
    [allStops, scheduledRows, unassignedStops, toast, t, i18n.language, requestDispatchMove, planLiveMode],
  );

  const startDrag = useCallback(
    (stopId: string, sourceRouteId: string, pointerDown: DispatchDragPointer) => {
      if (planLiveMode === "live" || selectedStopIds.size > 1 || directDrag.isBusy()) return;
      const ids = selectedStopIds.has(stopId)
        ? scheduledRows
            .flatMap((row) => row.stops.map((stop) => stop.stopId))
            .concat(unassignedStops.map((stop) => stop.id))
            .filter((id) => selectedStopIds.has(id))
        : [stopId];
      dragStateRef.current = createDispatchDragSession(ids, sourceRouteId, pointerDown);
      dropTargetRouteIdRef.current = null;
      dropTargetIndexRef.current = null;
      setDropTargetRouteId(null);
      setDropTargetIndex(null);
    },
    [selectedStopIds, scheduledRows, unassignedStops, planLiveMode],
  );

  useEffect(() => {
    const clearDragSession = (clearSelection = false) => {
      dragStateRef.current = cancelDispatchDrag(dragStateRef.current);
      setDragState(null);
      setDropTargetRouteId(null);
      setDropTargetIndex(null);
      dropTargetRouteIdRef.current = null;
      dropTargetIndexRef.current = null;
      if (clearSelection) setSelectedStopIds(new Set());
    };

    const updateDropTarget = (pointer: DispatchDragPointer) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const el = document.elementFromPoint(pointer.clientX, pointer.clientY);
      const target = el?.closest<HTMLElement>("[data-drop-route-id]");
      const id = target?.dataset.dropRouteId ?? null;
      const timeline =
        target?.closest<HTMLElement>("[data-testid='dispatch-timeline-row']") ?? target;
      const blocks = timeline
        ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-testid='dispatch-stop-block']"))
            .filter((block) => !ds.stopIds.includes(block.dataset.stopId ?? ""))
        : [];
      const index = blocks.findIndex(
        (block) =>
          pointer.clientX <
          block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2,
      );
      const nextIndex = id ? canonicalInsertionIndex({
        canonicalStopIds: directDrag.canonicalIds(id),
        draggedStopIds: ds.stopIds,
        anchorStopId: index < 0 ? null : blocks[index]?.dataset.stopId ?? null,
      }) : null;
      dropTargetRouteIdRef.current = id;
      dropTargetIndexRef.current = nextIndex;
      setDropTargetRouteId(id);
      // The marker indexes visible stops; the API uses the full route order.
      setDropTargetIndex(id ? (index < 0 ? blocks.length : index) : null);
    };

    const activateDrag = (pointer: DispatchDragPointer) => {
      const pending = dragStateRef.current;
      if (!pending) return false;
      const activated = activateDispatchDrag(pending, pointer);
      if (!activated.active) return false;
      if (!pending.active) {
        dragStateRef.current = activated;
        setDragState({
          stopIds: activated.stopIds,
          sourceRouteId: activated.sourceRouteId,
        });
      }
      updateDropTarget(pointer);
      return true;
    };

    const onMove = (ev: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      activateDrag({ clientX: ev.clientX, clientY: ev.clientY });
    };
    const onTouchMove = (ev: TouchEvent) => {
      const pointer = firstDispatchTouchPoint(ev.touches, ev.changedTouches);
      if (!pointer) return;
      const activated = activateDrag(pointer);
      if (activated) ev.preventDefault();
    };
    const completeDrag = (pointer?: DispatchDragPointer) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      if (!ds.active) {
        clearDragSession();
        return;
      }
      const target = pointer
        ? document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>(
            "[data-drop-route-id]",
          )
        : null;
      const id = target?.dataset.dropRouteId ?? dropTargetRouteIdRef.current;
      if (id) {
        const timeline =
          target?.closest<HTMLElement>("[data-testid='dispatch-timeline-row']") ?? target;
        const blocks = timeline
          ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-testid='dispatch-stop-block']"))
              .filter((block) => !ds.stopIds.includes(block.dataset.stopId ?? ""))
          : [];
        const found = pointer
          ? blocks.findIndex(
              (block) =>
                pointer.clientX <
                block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2,
            )
          : -1;
        const index = target
          ? canonicalInsertionIndex({
              canonicalStopIds: directDrag.canonicalIds(id),
              draggedStopIds: ds.stopIds,
              anchorStopId: found < 0 ? null : blocks[found]?.dataset.stopId ?? null,
            })
          : dropTargetIndexRef.current ?? 0;
        handoffDispatchDrag(
          () => clearDragSession(true),
          () => { void directDrag.drag(ds.stopIds, id, index); },
        );
        return;
      }
      clearDragSession(true);
    };
    const onUp = (ev: MouseEvent) => {
      completeDrag({ clientX: ev.clientX, clientY: ev.clientY });
    };
    const onTouchEnd = (ev: TouchEvent) => {
      const pointer = firstDispatchTouchPoint(ev.touches, ev.changedTouches);
      completeDrag(pointer ?? undefined);
    };
    const onCancel = () => clearDragSession();
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onCancel();
    };
    const touchMoveOptions: AddEventListenerOptions = { passive: false };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, touchMoveOptions);
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onCancel);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove, touchMoveOptions);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onCancel);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const snapshotRef = useRef({
    hoveredStopId: null as string | null,
    selectedStopId: null as string | null,
    highlightedRouteId: null as string | null,
    focusStopId: null as string | null,
  });
  useEffect(() => {
    snapshotRef.current = {
      hoveredStopId,
      selectedStopId,
      highlightedRouteId,
      focusStopId,
    };
  }, [hoveredStopId, selectedStopId, highlightedRouteId, focusStopId]);

  const sendChannelRef = useRef<((msg: { type: string; stopId?: string | null; routeId?: string | null; routeIds?: string[]; scopeKey?: string }) => void) | null>(null);
  const driverSelectionSnapshotRef = useRef({ scopeKey: driverSelectionScopeKey, ids: [] as string[] });
  driverSelectionSnapshotRef.current = { scopeKey: driverSelectionScopeKey, ids: [...highlightedRouteIds] };

  const onChannelMessage = useCallback((msg: {
    type: string;
    stopId?: string | null;
    routeId?: string | null;
    routeIds?: string[];
    scopeKey?: string;
  }) => {
    if (msg.type === "hover") {
      setHoveredStopId(msg.stopId ?? null);
    } else if (msg.type === "select") {
      if (msg.stopId) setSelectedStopId(msg.stopId);
    } else if (msg.type === "route-selection") {
      if (msg.scopeKey === driverSelectionSnapshotRef.current.scopeKey && Array.isArray(msg.routeIds)) {
        setHighlightedRouteIds(msg.routeIds);
      }
    } else if (msg.type === "highlight") {
      setHighlightedRouteId(msg.routeId ?? null);
    } else if (msg.type === "pong") {
      setPopoutOpen(true);
      const snap = snapshotRef.current;
      const send = sendChannelRef.current;
      if (send) {
        send({ type: "hover", stopId: snap.hoveredStopId });
        send({ type: "select", stopId: snap.selectedStopId });
        send({
          type: "route-selection",
          routeIds: driverSelectionSnapshotRef.current.ids,
          scopeKey: driverSelectionSnapshotRef.current.scopeKey,
        });
        if (snap.focusStopId) send({ type: "focus", stopId: snap.focusStopId });
      }
    } else if (msg.type === "close") {
      setPopoutOpen(false);
      popoutWindowRef.current = null;
    }
  }, []);

  const { send: sendChannel } = useDispatchChannel("main", onChannelMessage, () => popoutWindowRef.current);
  useEffect(() => {
    sendChannelRef.current = sendChannel;
  }, [sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    sendChannel({ type: "hover", stopId: hoveredStopId });
  }, [hoveredStopId, popoutOpen, sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    sendChannel({ type: "select", stopId: selectedStopId });
  }, [selectedStopId, popoutOpen, sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    sendChannel({ type: "route-selection", routeIds: [...highlightedRouteIds], scopeKey: driverSelectionScopeKey });
  }, [highlightedRouteIds, driverSelectionScopeKey, popoutOpen, sendChannel]);

  useEffect(() => {
    if (!popoutOpen) return;
    const id = setInterval(() => {
      const w = popoutWindowRef.current;
      if (w && w.closed) {
        setPopoutOpen(false);
        popoutWindowRef.current = null;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [popoutOpen]);

  const mapHref = useMapPopoutScope(search, popoutWindowRef);
  const openMapPopout = useCallback(() => {
    const existing = popoutWindowRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const features = "width=1400,height=900,menubar=no,toolbar=no,location=no,status=no";
    const w = window.open(mapHref, "_blank", features);
    if (w) {
      popoutWindowRef.current = w;
      setPopoutOpen(true);
    }
  }, [mapHref]);

  const closeMapPopout = useCallback(() => {
    const w = popoutWindowRef.current;
    if (w && !w.closed) {
      try {
        w.close();
      } catch {
        // browser may refuse if window wasn't script-opened
      }
    }
    setTimeout(() => {
      const win = popoutWindowRef.current;
      if (!win || win.closed) {
        popoutWindowRef.current = null;
        setPopoutOpen(false);
      }
    }, 100);
  }, []);

  useEffect(() => {
    return () => {
      const w = popoutWindowRef.current;
      if (w && !w.closed) {
        try { w.close(); } catch { /* ignore */ }
      }
      popoutWindowRef.current = null;
    };
  }, []);

  const ganttHref = ganttPopoutHref(search, import.meta.env.BASE_URL);
  useEffect(() => {
    const popup = ganttPopoutWindowRef.current;
    if (popup && !popup.closed) {
      popup.postMessage({
        type: "traivo-gantt-scope",
        search: new URL(ganttHref, window.location.origin).search,
      }, window.location.origin);
    }
  }, [ganttHref]);

  const openGanttPopout = useCallback(() => {
    const existing = ganttPopoutWindowRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const features = "width=1600,height=900,menubar=no,toolbar=no,location=no,status=no";
    const w = window.open(ganttHref, "traivo-gantt-popout", features);
    if (w) {
      ganttPopoutWindowRef.current = w;
      setGanttPopoutOpen(true);
    }
  }, [ganttHref]);

  const closeGanttPopout = useCallback(() => {
    const w = ganttPopoutWindowRef.current;
    if (w && !w.closed) {
      try { w.close(); } catch { /* ignore */ }
    }
    setTimeout(() => {
      const win = ganttPopoutWindowRef.current;
      if (!win || win.closed) {
        ganttPopoutWindowRef.current = null;
        setGanttPopoutOpen(false);
      }
    }, 100);
  }, []);

  useEffect(() => {
    if (!ganttPopoutOpen) return;
    const id = setInterval(() => {
      const w = ganttPopoutWindowRef.current;
      if (w && w.closed) {
        setGanttPopoutOpen(false);
        ganttPopoutWindowRef.current = null;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [ganttPopoutOpen]);

  useEffect(() => {
    return () => {
      const w = ganttPopoutWindowRef.current;
      if (w && !w.closed) {
        try { w.close(); } catch { /* ignore */ }
      }
      ganttPopoutWindowRef.current = null;
    };
  }, []);

  const flatStopList = useMemo(() => {
    const list: Array<{ stopId: string; rowIdx: number }> = [];
    scheduledRows.forEach((row, rowIdx) => {
      row.stops.forEach((s) => list.push({ stopId: s.stopId, rowIdx }));
    });
    return list;
  }, [scheduledRows]);

  const dispatchAllRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onKey = createDispatchKeyboardHandler({
      kbdHelpOpen, focusMode, overviewOpen, selectedStopId, inboxRailOpen, actionQueueOpen,
      scheduledRows, flatStopList, searchInputRef, dispatchAllRef,
      setKbdHelpOpen, setFocusMode, setOverviewOpen, setSelectedStopId,
      setInboxRailOpen, setActionQueueOpen, setSelectedStopIds, setHighlightedRouteId,
      setSelectedRowIdx, setFocusStopId,
    });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbdHelpOpen, scheduledRows, flatStopList, selectedStopId, focusMode, overviewOpen, inboxRailOpen, actionQueueOpen]);

  const todayStr = new Date().toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const overloadedCount = useMemo(
    () => scheduledRows.filter((r) => r.routeId !== "unplanned" && r.capacityPercent > 100).length,
    [scheduledRows],
  );

  const dispatchAll = useCallback(async () => {
    // Imported plans use the protected approval gate below. Never let the
    // general toolbar/keyboard action bypass that explicit approve-then-send
    // flow for the selected plan.
    if (requestedPlanId) {
      return;
    }
    if (activePlanIds.size > 1) {
      toast({
        title: t("dispatch.selectPlanBeforeDispatch"),
        description: t("dispatch.selectPlanBeforeDispatchDesc"),
        variant: "destructive",
      });
      return;
    }
    if (unassignedStops.length > 0) {
      setInboxRailOpen(true);
      toast({
        title: t("dispatch.dispatchNeedsAction"),
        description: t("dispatch.dispatchNeedsActionDesc", { count: unassignedStops.length }),
        variant: "destructive",
      });
      return;
    }
    const toDispatch = activeRoutes.filter((r) => r.status === "optimized" || r.status === "in_progress");
    if (toDispatch.length === 0) {
      toast({
        title: t("dispatch.sentToDrivers"),
        description: t("dispatch.sentToDriversDesc"),
      });
      return;
    }
    const routesNeedingRecalculation = toDispatch.filter((route) =>
      scheduledRows.find((row) => row.routeId === route.id)?.workdayStatus !== "authoritative",
    );
    if (routesNeedingRecalculation.length > 0) {
      toast({
        title: t("dispatch.scheduleNeedsRecalculation"),
        description: t("dispatch.scheduleNeedsRecalculationBeforeDispatch"),
        variant: "destructive",
      });
      return;
    }
    setIsDispatching(true);
    setDispatchRouteFailures([]);
    try {
      const failures: Array<{ routeId: string; routeName: string; message: string }> = [];
      let sentCount = 0;
      let currentCount = 0;
      for (const route of toDispatch) {
        try {
          const actual = await getRoute(route.id);
          if (!matchesPlanRevision(actual, route.planRevision)) {
            throw new TrustedLocalizedError(t("dispatch.planRevisionChanged"));
          }
          if (hasReusableHandoff(actual, actual.planRevision)) {
            currentCount += 1;
            continue;
          }
          const check = await getRoutePreflight(route.id);
          setPreflight((previous) => ({ ...previous, [check.routeId]: check }));
          if (!matchesPlanRevision(check, route.planRevision)) {
            throw new TrustedLocalizedError(t("dispatch.planRevisionChanged"));
          }
          if (!check.ready) {
            if (check.issues.some((issue) => issue.code === "review_required")) {
              setHighlightedRouteId(route.id);
              setServiceTimePlanId(route.planId);
              throw new TrustedLocalizedError(t("dispatch.planReviewRequired"));
            }
            throw new Error(check.issues
              .map((issue) => localizeError(issue, t, { fallbackKey: "common.errorRequestFailed" }))
              .join(" "));
          }
          if (!check.driverId) {
            throw new Error(t("dispatch.preflightMissingDriver"));
          }
          await dispatchRoute.mutateAsync({
            id: route.id,
            data: { driverId: check.driverId },
          });
          sentCount += 1;
        } catch (error) {
          failures.push({
            routeId: route.id,
            routeName: route.name,
            message: localizeError(error, t, { fallbackKey: "dispatch.sendError" }),
          });
        }
      }
      setDispatchRouteFailures(failures);
      if (failures.length > 0) {
        const reviewRequiredOnly = failures.every(
          (failure) => failure.message === t("dispatch.planReviewRequired"),
        );
        toast({
          title: reviewRequiredOnly
            ? t("dispatch.planReviewRequired")
            : t("dispatch.sendPartialFailure"),
          description: failures.map((failure) => `${failure.routeName}: ${failure.message}`).join(" "),
          variant: "destructive",
        });
      } else if (sentCount > 0) {
        toast({
          title: t("dispatch.sentToDrivers"),
          description: currentCount > 0
            ? t("dispatch.sentToDriversWithSkippedCurrent", { sent: sentCount, skipped: currentCount })
            : t("dispatch.sentToDriversDesc"),
        });
      } else {
        toast({
          title: t("dispatch.alreadyCurrent"),
          description: t("dispatch.alreadyCurrentDesc", { count: currentCount }),
        });
      }
    } finally {
      setIsDispatching(false);
    }
  }, [activeRoutes, activePlanIds, requestedPlanId, unassignedStops, scheduledRows, dispatchRoute, toast, t]);

  useEffect(() => {
    dispatchAllRef.current = dispatchAll;
  }, [dispatchAll]);

  if (loadingRoutes || loadingStops) {
    return (
      <AppLayout>
        <LoadingState message={t("dispatch.loading")} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-full w-full">
        {!focusMode && activeRoutes.length > 0 && activePlanIds.size === 1 && (
          <div className="shrink-0 border-b border-border bg-background px-3 py-1">
            <PlanStatusChain
              compact
              routes={scheduledRows}
              approval={approvalQuery.data}
              unplannedCount={unassignedStops.length}
              planId={activeRoutes[0]?.planId}
              planName={activeRoutes[0]?.customerReference ?? activeRoutes[0]?.name}
              date={activeRoutes[0]?.date}
              orderCount={totalStopsCount}
              resourceCount={scheduledRows.length}
              resourceNames={{
                vehicles: Object.fromEntries((vehicles ?? []).map((vehicle) => [vehicle.id, vehicle.name])),
                drivers: Object.fromEntries((drivers ?? []).map((driver) => [driver.id, driver.name])),
              }}
              revision={Math.max(...scheduledRows.map((route) => route.planRevision ?? 0))}
              stateLoading={Boolean(requestedPlanId) && approvalQuery.isLoading}
              stateError={approvalQuery.error && getErrorStatus(approvalQuery.error) !== 404
                ? localizeError(approvalQuery.error, t, { fallbackKey: "dispatch.importApprovalError" })
                : null}
              onRetry={() => void approvalQuery.refetch()}
              onBlockerAction={(blocker) => {
                if (blocker.type === "unplannedStops") {
                  const stop = unassignedStops[0];
                  focusActionSection("unplannedTw");
                  if (stop) {
                    setFocusStopId(stop.id);
                    setSelectedStopIds(new Set([stop.id]));
                  }
                } else if (blocker.type === "missingVehicle" || blocker.type === "missingDriver") {
                  focusActionSection("missingResources");
                  const missing = scheduledRows.find((candidate) =>
                    !candidate.vehicleId || !candidate.driverId);
                  if (missing) setHighlightedRouteId(missing.routeId);
                } else if (blocker.type === "manualReview") {
                  const route = activeRoutes.find((candidate) => candidate.status === "optimized")
                    ?? activeRoutes[0];
                  if (route) {
                    setHighlightedRouteId(route.id);
                    setServiceTimePlanId(route.planId);
                  }
                }
              }}
              onNextAction={() => {
                if (requestedPlanId) {
                  document.querySelector('[data-testid="dispatch-import-plan-approval"]')?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                } else if (activeRoutes.some((route) => route.handoffStatus && route.handoffStatus !== "pending")) {
                  setPersistedPlanLiveMode("live");
                } else if (unassignedStops.length === 0) {
                  void dispatchAll();
                } else {
                  focusActionSection("unplannedTw");
                }
              }}
            />
            {Object.values(preflight).some((check) => !check.ready) && (
              <p className="mt-1 text-xs font-semibold text-destructive" data-testid="preflight-blocked">
                Preflight blockerar utskick tills förare, fordon och kritiska fel är åtgärdade.
              </p>
            )}
            {preflightError && (
              <p className="mt-1 text-xs font-semibold text-destructive" data-testid="preflight-error">
                {preflightError}
              </p>
            )}
            {dispatchRouteFailures.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs font-semibold text-destructive" data-testid="dispatch-route-failures">
                {dispatchRouteFailures.map((failure) => (
                  <li key={failure.routeId}>{failure.routeName}: {failure.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!focusMode && (
        <div className="relative z-20 shrink-0 px-3 py-2 border-b border-border bg-card/80 backdrop-blur-sm flex items-center gap-2 sm:gap-3 flex-wrap">
          <RoutesReturnLink search={search} />
          <CalendarClock className="h-5 w-5 text-primary shrink-0" />
          <div className="mr-1">
            <h1 className="text-sm font-bold leading-tight">{t("dispatch.title")}</h1>
            <p className="text-[10px] text-muted-foreground">{todayStr}</p>
          </div>

          <div className="flex items-center bg-muted/50 rounded-md p-0.5 border border-border/50">
            <button
              type="button"
              className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors cursor-pointer ${
                planLiveMode === "plan"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setPersistedPlanLiveMode("plan")}
            >
              {t("dispatch.planMode")}
            </button>
            <button
              type="button"
              className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors cursor-pointer ${
                planLiveMode === "live"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setPersistedPlanLiveMode("live")}
            >
              {t("dispatch.liveMode")}
            </button>
          </div>
          <button
            type="button"
            data-testid="dispatch-all-plans"
            onClick={clearPlanScope}
            className={`min-h-[36px] rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              selectedPlanId
                ? "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                : "border-primary/40 bg-primary/10 text-primary"
            }`}
            title="Byt plan"
          >
            Byt plan
          </button>
          {planLiveMode === "live" && selectedPlanId && (
            <button
              type="button"
              data-testid="dispatch-return-to-review"
              onClick={() => {
                if (!reviewDraftId) {
                  toast({
                    title: t("dispatch.returnToReviewUnavailable"),
                    variant: "destructive",
                  });
                  return;
                }
                navigate(`/routes/drafts/${reviewDraftId}?review=1`);
              }}
              className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 sm:text-[11px]"
              title={reviewDraftId
                ? t("dispatch.returnToReview")
                : t("dispatch.returnToReviewUnavailable")}
            >
              <Clock className="h-3.5 w-3.5" />
              {t("dispatch.returnToReview")}
            </button>
          )}

          <div className="hidden h-6 w-px bg-border/60 sm:block" />

          <div className="flex items-center gap-1.5 flex-wrap">
            {unassignedStops.length > 0 && (
              <button
                type="button"
                onClick={() => focusActionSection("unplannedTw")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-destructive/15 border border-destructive/30 hover:bg-destructive/25 transition-colors cursor-pointer animate-pulse"
                title={t("dispatch.unplannedWithTw")}
              >
                <Package className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs font-bold tabular-nums text-destructive">
                  {unassignedStops.length}
                </span>
                <span className="text-[10px] text-destructive/80 font-semibold">
                  {t("dispatch.unplannedLabel")}
                </span>
              </button>
            )}
            {overloadedCount > 0 && (
              <button
                type="button"
                onClick={() => focusActionSection("overloaded")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 transition-colors cursor-pointer animate-pulse"
                title={t("dispatch.overloaded")}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                  {t("dispatch.overloadedRoutes", { count: overloadedCount })}
                </span>
              </button>
            )}
            {slaRiskCount > 0 && (
              <button
                type="button"
                onClick={() => focusActionSection("sla")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 transition-colors cursor-pointer animate-pulse"
                title={t("dispatch.slaRiskExplanation")}
              >
                <Clock className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-xs font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {t("dispatch.slaRiskCount", { count: slaRiskCount })}
                </span>
              </button>
            )}
            {lastEndOverLimit && overtimeEndTime && (
              <button
                type="button"
                onClick={() => focusActionSection("lateFinish")}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-destructive/15 border border-destructive/30 hover:bg-destructive/25 transition-colors cursor-pointer"
                title={t("dispatch.lateFinish")}
              >
                <Clock className="h-3.5 w-3.5 text-destructive" />
                <span className="text-xs font-bold tabular-nums text-destructive">
                  {overtimeEndTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
            )}
          </div>

          <div
            className="ml-0 flex w-full min-w-0 flex-wrap items-center gap-2 xl:ml-auto xl:w-auto"
            data-testid="dispatch-action-toolbar"
          >
            <div className="relative" ref={overviewRef}>
              <button
                type="button"
                onClick={() => setOverviewOpen((v) => !v)}
                className={`flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold rounded-md transition-colors cursor-pointer ${overviewOpen ? "bg-muted text-foreground" : "text-foreground/85 hover:text-foreground hover:bg-muted/60"}`}
                title={t("dispatch.overviewToggle")}
                aria-expanded={overviewOpen}
              >
                <Gauge className="h-3.5 w-3.5" />
                {t("dispatch.overviewToggle")}
                <ChevronDown className={`h-3 w-3 transition-transform ${overviewOpen ? "rotate-180" : ""}`} />
              </button>
              {overviewOpen && (
                <div
                  className="absolute left-0 top-full z-50 mt-1 w-[min(16rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-card p-3 shadow-xl animate-in slide-in-from-top-2 duration-150 sm:left-auto sm:right-0"
                  data-testid="dispatch-overview-popover"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <RouteIcon className="h-3 w-3" />
                        {t("dispatch.routesLabel")}
                      </span>
                      <span className="text-lg font-bold tabular-nums leading-none">{routeRowsCount}</span>
                    </div>
                    <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {t("common.stops")}
                      </span>
                      <span className="text-lg font-bold tabular-nums leading-none">{totalStopsCount}</span>
                    </div>
                    {avgCapacityPercent > 0 && (
                      <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                          <Gauge className="h-3 w-3" />
                          {t("dispatch.avgUtil")}
                        </span>
                        <span className={`text-lg font-bold tabular-nums leading-none ${avgCapacityPercent > 100 ? "text-destructive" : avgCapacityPercent >= 85 ? "text-amber-500" : ""}`}>
                          {Math.round(avgCapacityPercent)}%
                        </span>
                      </div>
                    )}
                    {lastEndTime && (
                      <div className="flex flex-col gap-0.5 p-2 rounded-md bg-muted/40">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {t("dispatch.lastEtaAt", { time: "" }).replace("—", "").trim() || t("dispatch.end")}
                        </span>
                        <span className={`text-lg font-bold tabular-nums leading-none ${lastEndOverLimit ? "text-destructive" : ""}`}>
                          {lastEndTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center bg-muted/50 rounded-md p-0.5 border border-border/50" title={t("dispatch.density")}>
              <button
                type="button"
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors cursor-pointer ${density === "compact" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setDensity("compact")}
                aria-label={t("dispatch.densityCompact")}
                title={t("dispatch.densityCompact")}
              >
                <Rows4 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
              <button
                type="button"
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors cursor-pointer ${density === "comfortable" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setDensity("comfortable")}
                aria-label={t("dispatch.densityComfortable")}
                title={t("dispatch.densityComfortable")}
              >
                <Rows3 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
              <button
                type="button"
                className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded transition-colors cursor-pointer ${density === "spacious" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setDensity("spacious")}
                aria-label={t("dispatch.densitySpacious")}
                title={t("dispatch.densitySpacious")}
              >
                <Rows2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setMapVisible((v) => !v)}
              data-testid="dispatch-map-toggle"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-foreground/85 transition-colors hover:bg-muted/60 hover:text-foreground sm:px-2 sm:text-[11px]"
              aria-label={mapVisible ? t("dispatch.hideMap") : t("dispatch.showMap")}
              title={mapVisible ? t("dispatch.hideMap") : t("dispatch.showMap")}
            >
              {mapVisible ? <EyeOff className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <MapIcon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
              {t("dispatch.mapToggle")}
            </button>

            <button
              type="button"
              onClick={() => setFocusMode(true)}
              data-testid="dispatch-focus-toggle"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-foreground/85 transition-colors hover:bg-muted/60 hover:text-foreground sm:px-2 sm:text-[11px]"
              aria-label={t("dispatch.focusMode")}
              title={t("dispatch.focusMode") + " (F)"}
            >
              <Maximize2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              {t("dispatch.focusMode")}
            </button>

            <button
              type="button"
              onClick={popoutOpen ? closeMapPopout : openMapPopout}
              data-testid="button-map-popout"
              className={`flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors sm:px-2 sm:text-[11px] ${popoutOpen ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25" : "text-foreground/85 hover:text-foreground hover:bg-muted/60"}`}
              aria-label={popoutOpen ? t("dispatch.popoutClose") : t("dispatch.popoutOpen")}
              title={popoutOpen ? t("dispatch.popoutClose") : t("dispatch.popoutOpen")}
            >
              <ExternalLink className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              {popoutOpen ? t("dispatch.popoutActive") : t("dispatch.popoutMap")}
            </button>

            <button
              type="button"
              onClick={ganttPopoutOpen ? closeGanttPopout : openGanttPopout}
              className={`flex min-h-[44px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors sm:px-2 sm:text-[11px] ${ganttPopoutOpen ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25" : "text-foreground/85 hover:text-foreground hover:bg-muted/60"}`}
              aria-label={ganttPopoutOpen ? t("dispatch.ganttPopoutClose") : t("dispatch.ganttPopoutOpen")}
              title={ganttPopoutOpen ? t("dispatch.ganttPopoutClose") : t("dispatch.ganttPopoutOpen")}
              data-testid="button-gantt-popout"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {ganttPopoutOpen ? t("dispatch.ganttPopoutActive") : t("dispatch.ganttPopout")}
            </button>

            <button
              type="button"
              onClick={() => setImportWorkflowOpen(true)}
              data-testid="dispatch-import-orders"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:text-[11px]"
              aria-label={t("dispatch.importOrders")}
              title={t("dispatch.importOrders")}
              hidden={!hasRole("admin", "dispatcher")}
            >
              <FileUp className="h-3.5 w-3.5" />
              {t("dispatch.importOrders")}
            </button>
            {hasRole("admin", "dispatcher") && (
              <button
                type="button"
                onClick={exportRoutePlanXlsx}
                disabled={!exportSelection || isExportingXlsx}
                data-testid="dispatch-export-xlsx"
                className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:text-[11px]"
                aria-label={t("dispatch.exportXlsx")}
                title={!exportSelection
                  ? t("dispatch.exportXlsxSelect")
                  : exportSelection.kind === "route"
                    ? t("dispatch.exportXlsxRoute")
                    : exportSelection.kind === "plan"
                      ? t("dispatch.exportXlsxPlan")
                      : t("dispatch.exportXlsxDate")}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                {isExportingXlsx ? t("dispatch.exportXlsxWorking") : t("dispatch.exportXlsx")}
              </button>
            )}
            {hasRole("admin", "dispatcher") && (
              <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground sm:text-[11px]">
                <span className="sr-only">Välj rutt för optimering</span>
                <select
                  data-testid="dispatch-incoming-reoptimization-route-select"
                  aria-label="Välj rutt för optimering"
                  value={highlightedRouteId ?? ""}
                  onChange={(event) => setHighlightedRouteId(event.target.value || null)}
                  className="max-w-[220px] bg-transparent outline-none"
                >
                  <option value="">Välj rutt…</option>
                  {activeRoutes.map((route) => {
                    const vehicleName = route.vehicleId
                      ? vehiclesById.get(route.vehicleId)?.name
                      : undefined;
                    return (
                      <option key={route.id} value={route.id}>
                        {route.name || vehicleName || "Rutt"}
                        {vehicleName && vehicleName !== route.name ? ` · ${vehicleName}` : ""}
                        {route.status === "in_progress" ? " · pågår" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
            {hasRole("admin", "dispatcher") && selectedOptimizedPlanRoutes && (
              <>
                <button
                  type="button"
                  onClick={() => selectedExistingPlan &&
                    setServiceTimePlanId(selectedExistingPlan.planId)}
                  disabled={!selectedExistingPlan}
                  className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:text-[11px]"
                  title={selectedExistingPlan
                    ? t("dispatch.adjustPlanTooltip")
                    : t("dispatch.adjustPlanInvalidTooltip")}
                >
                  <Clock className="h-3.5 w-3.5" />
                  {t("dispatch.replan")}
                </button>
                {!selectedExistingPlan && (
                  <span className="max-w-[260px] text-[10px] font-semibold text-destructive">
                    {t("dispatch.adjustPlanRecoveryError")}
                  </span>
                )}
              </>
            )}
            {hasRole("admin", "dispatcher") && <PlanOptimizationAction routes={activeRoutes} enabled={planLiveMode === "plan"} />}
            <RouteAppendImport route={selectedReoptimizationRoute} enabled={planLiveMode === "plan"} />
            {hasRole("admin", "dispatcher") && selectedReoptimizationRoute && (
              <RouteReoptimizationMenu
                route={selectedReoptimizationRoute}
                planRoutes={selectedReoptimizationPlanRoutes}
                drivers={drivers ?? []}
                vehicles={vehicles ?? []}
                stops={allStops ?? []}
                depotLatitude={selectedReoptimizationRoute.depotSnapshot?.start.latitude ?? DEPOT_LOCATION.lat}
                depotLongitude={selectedReoptimizationRoute.depotSnapshot?.start.longitude ?? DEPOT_LOCATION.lng}
                onSaved={async () => {
                  await queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                  await queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
                }}
              />
            )}
            {hasRole("admin", "dispatcher") && !selectedReoptimizationRoute && (
              <button
                type="button"
                disabled
                data-testid="button-reoptimization-menu-no-route"
                title={highlightedRouteId
                  ? "Den valda rutten är inte optimerad och kan inte öppnas här."
                  : "Välj en optimerad rutt för att öppna optimeringsåtgärder."}
                className="flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60 sm:text-[11px]"
              >
                {highlightedRouteId ? "Optimera (rutt ej tillgänglig)" : "Optimera (välj rutt)"}
              </button>
            )}
            <button
              type="button"
              className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 sm:text-[11px]"
              onClick={() => navigate("/planner")}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t("dispatch.optimize")}
            </button>
            {!requestedPlanId && (
              <button
                type="button"
                disabled={
                  isDispatching
                  || isPreflightLoading
                  || activeRoutes.some((route) =>
                    (route.status === "optimized" || route.status === "in_progress")
                    && (!route.handoffStatus || route.handoffStatus === "pending")
                    && !preflight[route.id]?.ready)
                }
                className="flex min-h-[44px] items-center gap-1.5 rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-60 sm:text-[11px]"
                onClick={dispatchAll}
              >
                <Send className="h-3.5 w-3.5" />
                {isDispatching ? t("dispatch.sending") : t("dispatch.sendToDrivers")}
              </button>
            )}
          </div>
        </div>
        )}

        {!focusMode && planLiveMode === "plan" && requestedPlanId && (
          <ImportPlanApprovalPanel
            requestedPlanId={requestedPlanId}
            liveRoutes={routes ?? []}
            showValidationSuccess={validationSuccessPlanId === requestedPlanId}
            canWrite={hasRole("admin", "dispatcher")}
            onContinueLive={() => {
              if (requestedPlanId) {
                navigate(`/dispatch?${carryRoutesReturnTo(new URLSearchParams({ view: "live", planId: requestedPlanId }), window.location.search).toString()}`, { replace: true });
              }
            }}
          />
        )}

        {!focusMode && acknowledgementRoutes.length > 0 && (
          <section
            className="shrink-0 border-b border-border bg-card px-3 py-2"
            aria-label={t("dispatch.handoffOverview")}
            data-testid="handoff-overview"
          >
            {overdueAcknowledgements.length > 0 && (
              <div
                className="mb-2 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
                role="alert"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="text-xs font-bold">
                  {t("dispatch.handoffOverdue", { count: overdueAcknowledgements.length })}
                </span>
              </div>
            )}
            <div className="flex gap-2 overflow-x-auto pb-0.5">
              {acknowledgementRoutes.map((route) => {
                const isOverdue = overdueAcknowledgements.some((item) => item.id === route.id);
                const isRejected = route.handoffStatus === "rejected";
                const isAccepted = route.handoffStatus === "accepted";
                const time = handoffTimestamp(route);
                return (
                  <article
                    key={route.id}
                    className={`min-w-[220px] rounded-md border px-3 py-2 ${
                      isOverdue
                        ? "border-destructive/50 bg-destructive/5"
                        : isRejected
                          ? "border-destructive/30 bg-destructive/5"
                          : isAccepted
                            ? "border-emerald-500/30 bg-emerald-500/5"
                            : "border-border bg-muted/25"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-xs font-bold" title={route.name}>{route.name}</span>
                      <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        {t("dispatch.handoffVersion", { version: route.handoffVersion ?? "—" })}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${
                        isRejected || isOverdue ? "bg-destructive" :
                        isAccepted ? "bg-emerald-500" :
                        route.handoffStatus === "opened" ? "bg-blue-500" :
                        route.handoffStatus === "received" ? "bg-cyan-500" :
                        "bg-amber-500"
                      }`} aria-hidden="true" />
                      <span className={`text-[11px] font-semibold ${isRejected || isOverdue ? "text-destructive" : ""}`}>
                        {t(`dispatch.handoffStatus.${route.handoffStatus}`)}
                        {time ? ` · ${time}` : ""}
                      </span>
                    </div>
                    {isRejected && route.rejectionReason && (
                      <p className="mt-1 text-[11px] leading-snug text-destructive">
                        <span className="font-semibold">{t("dispatch.handoffReason")}:</span>{" "}
                        {route.rejectionReason}
                      </p>
                    )}
                    {isOverdue && (
                      <p className="mt-1 text-[11px] font-semibold text-destructive">
                        {t("dispatch.handoffOverdueRoute")}
                      </p>
                    )}
                    {(incidentsByRoute.get(route.id) ?? []).length > 0 && (
                      <div className="mt-2 border-t border-border/70 pt-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          {t("dispatch.incidents")}
                        </p>
                        <ul className="mt-1 space-y-1.5">
                          {(incidentsByRoute.get(route.id) ?? []).map((incident) => (
                            <li key={incident.id} className="rounded bg-background/60 px-2 py-1.5 text-[11px]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold">{t(`dispatch.incidentCategory.${incident.category}`)}</span>
                                <time className="shrink-0 text-[10px] text-muted-foreground" dateTime={incident.createdAt}>
                                  {new Date(incident.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </time>
                              </div>
                              <p className="mt-0.5 leading-snug">{incident.comment}</p>
                              {isHttpsUrl(incident.attachmentUrl) ? (
                                <a
                                  href={incident.attachmentUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-flex underline text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                                >
                                  {t("dispatch.incidentEvidence")}
                                </a>
                              ) : incident.attachmentUrl ? (
                                <span className="mt-1 block break-all text-muted-foreground">
                                  {incident.attachmentUrl}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {!focusMode && (
          <div className="flex shrink-0 justify-end border-b border-border px-3 py-1">
            <ActionQueueToggle open={actionQueueOpen} count={overloadedCount + slaRiskCount} onToggle={() => setActionQueueOpen(value => !value)} />
          </div>
        )}
        <div className="flex-1 grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto] min-h-0 w-full relative z-0">
          {!focusMode && (
            <div className="col-start-1 row-start-2 border-t border-border bg-card/60 flex items-center px-2 py-0.5 z-10">
              <button
                type="button"
                onClick={() => setInboxRailOpen((v) => !v)}
                className={`relative h-7 flex items-center gap-2 rounded px-2 text-xs font-semibold transition-colors cursor-pointer ${
                  inboxRailOpen
                    ? "bg-primary/15 text-primary"
                    : unassignedStops.length > 0
                      ? "text-destructive hover:bg-destructive/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                aria-label={t("dispatch.leftRailTooltip")}
                title={t("dispatch.leftRailTooltip")}
                aria-expanded={inboxRailOpen}
                aria-controls="dispatch-work-queue-dock"
              >
                <Package className="h-4 w-4" />
                Uppdrag
                {unassignedStops.length > 0 && (
                  <span className="rounded bg-muted px-1 text-[10px] tabular-nums">
                    {unassignedStops.length > 99 ? "99+" : unassignedStops.length}
                  </span>
                )}
                <span aria-hidden="true">{inboxRailOpen ? "▾" : "▴"}</span>
              </button>
            </div>
          )}

          <div className="col-start-1 row-start-1 flex flex-col min-w-0 min-h-0">
            <DispatchBulkActions selectedStopIds={selectedStopIds} setSelectedStopIds={setSelectedStopIds}
              stops={allStops ?? []} routes={activeRoutes}
              routeRequest={mapRouteRequest}
              routeDriverNames={dispatchRouteDriverNames(activeRoutes, drivers ?? [], approvalQuery.error ? undefined : approvalQuery.data)}
              canEdit={planLiveMode === "plan" && hasRole("admin", "dispatcher")}
              requestMove={(ids, routeId, index, force, expectedPreviewDigest, optimizeTargetRoute) => requestDispatchMove(ids, routeId, index, force, expectedPreviewDigest, optimizeTargetRoute)} />
            <ResizablePanelGroup
              direction="vertical"
              className="h-full w-full"
              data-testid="dispatch-split"
            >
              {mapVisible && popoutOpen && (
                <>
                  <ResizablePanel
                    id="dispatch-map-popout"
                    order={1}
                    defaultSize={58}
                    minSize={28}
                    maxSize={72}
                    minSizePixels={120}
                    className="relative z-0"
                  >
                    <div className="w-full h-full flex items-center justify-center bg-muted/30 border-b border-border/50">
                      <div className="text-center p-6 max-w-md">
                        <ExternalLink className="h-8 w-8 mx-auto mb-3 text-emerald-500" />
                        <p className="text-sm font-semibold mb-1">{t("dispatch.popoutBanner")}</p>
                        <p className="text-xs text-muted-foreground mb-4">
                          {mapRoutes.length} {t("dispatch.routesLabel")} · {unassignedStops.length} {t("dispatch.unplannedLabel")}
                        </p>
                        <div className="flex items-center gap-2 justify-center">
                          <button
                            type="button"
                            onClick={() => popoutWindowRef.current?.focus()}
                            className="px-3 py-1.5 text-xs font-semibold bg-card border border-border rounded-md hover:bg-muted transition-colors cursor-pointer"
                          >
                            {t("dispatch.popoutFocus")}
                          </button>
                          <button
                            type="button"
                            onClick={closeMapPopout}
                            className="px-3 py-1.5 text-xs font-semibold bg-muted rounded-md hover:bg-muted/80 transition-colors cursor-pointer"
                          >
                            {t("dispatch.popoutClose")}
                          </button>
                        </div>
                      </div>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle
                    withHandle
                    className="h-2 bg-border/60 hover:bg-primary/40 transition-colors shrink-0 z-10"
                  />
                </>
              )}
              {mapVisible && !popoutOpen && (
                <>
                  <ResizablePanel
                    id="dispatch-map"
                    order={1}
                    defaultSize={58}
                    minSize={28}
                    maxSize={72}
                    minSizePixels={120}
                    data-testid="dispatch-map-panel"
                    className="relative z-0"
                  >
                    <div className="w-full h-full p-2">
                      <div className="w-full h-full rounded-xl overflow-hidden shadow-inner border border-border/50 bg-card">
                        <RouteMap
                          key={focusMode ? "dispatch-map-focus" : "dispatch-map-standard"}
                          routes={mapRoutes}
                          planningActionsEnabled={planLiveMode === "plan"}
                          unassignedStops={unassignedStops}
                          interactive={true}
                          selectedStopId={selectedStopId}
                          selectedStopIds={selectedStopIds}
                          onSelectStop={handleMapSelectStop}
                          selectionEnabled
                          onPolygonSelect={(ids) => {
                            if (!ids.length) return;
                            setSelectedStopId(null); setSelectedStopIds(new Set(ids));
                            setMapRouteRequest({ origin: "polygon", routeId: null, nonce: Date.now() });
                          }}
                          highlightedRouteId={highlightedRouteId}
                          highlightedRouteIds={highlightedRouteIds}
                          onHighlightRoute={handleSetHighlightRoute}
                          onSelectDriverRoute={selectDriverRoute}
                          onClearDriverRoutes={clearDriverRoutes}
                          focusStopId={focusStopId}
                          hoveredStopId={hoveredStopId}
                        />
                      </div>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle
                    withHandle
                    data-testid="dispatch-split-handle"
                    className="h-2 data-[panel-group-direction=vertical]:h-2 touch-none cursor-ns-resize bg-border/60 hover:bg-primary/40 transition-colors shrink-0 z-10"
                  />
                </>
              )}

              <ResizablePanel
                id="dispatch-timeline"
                order={2}
                defaultSize={mapVisible ? 42 : 100}
                minSize={28}
                minSizePixels={120}
                data-testid="dispatch-timeline-panel"
                className="flex-1 min-h-0 overflow-hidden relative"
              >
                {scheduledRows.length === 0 && (
                  <div className="shrink-0 border-b border-border px-3 py-2 text-muted-foreground text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <p>{t("dispatch.noRoutes")}</p>
                      <button
                        type="button"
                        onClick={() => navigate("/planner")}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        {t("dispatch.runPlanner")}
                      </button>
                    </div>
                  </div>
                )}
                  <div className="relative flex h-full min-h-0 flex-col bg-card">
                    <UnscheduledStopsLane
                      stops={unassignedStops}
                      selectedStopIds={selectedStopIds}
                      selectedStopId={selectedStopId}
                      setSelectedStopIds={setSelectedStopIds}
                      onSelectStop={handleMapSelectStop}
                      startDrag={startDrag}
                    />
                    <div className="absolute top-1 right-3 z-30 flex origin-top-right scale-[0.6] items-center bg-card/90 backdrop-blur-sm rounded-md border border-border px-0.5 shadow-md">
                      <button
                        type="button"
                        className="w-11 h-11 flex items-center justify-center rounded-l-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                        onClick={() => setZoomLevel((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                        disabled={zoomLevel <= 0.5}
                        aria-label={t("dispatch.zoomOut")}
                      >
                        <ZoomOut className="h-4 w-4" />
                      </button>
                      <span className="text-xs font-mono text-muted-foreground min-w-[36px] text-center select-none" data-testid="zoom-level">
                        {Math.round(zoomLevel * 100)}%
                      </span>
                      <button
                        type="button"
                        className="w-11 h-11 flex items-center justify-center rounded-r-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
                        onClick={() => setZoomLevel((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
                        disabled={zoomLevel >= 3}
                        aria-label={t("dispatch.zoomIn")}
                      >
                        <ZoomIn className="h-4 w-4" />
                      </button>
                    </div>
                    <GanttTimeline
                      rows={livePriorityRows}
                      showActualTimes
                      selectedStopId={selectedStopId}
                      onSelectStop={handleSelectStop}
                      zoomLevel={zoomLevel}
                      highlightedRouteId={highlightedRouteId}
                      highlightedRouteIds={highlightedRouteIds}
                      onSelectDriverRoute={selectDriverRoute}
                      onClearDriverRoutes={clearDriverRoutes}
                      onHighlightRoute={handleSetHighlightRoute}
                      scrollToRouteId={highlightedRouteId}
                      onReassignStops={handleReassignStops}
                      bulkActionsExternal
                      selectedStopIds={selectedStopIds}
                      setSelectedStopIds={setSelectedStopIds}
                      dragState={dragState}
                      startDrag={startDrag}
                      dropTargetRouteId={dropTargetRouteId}
                      dropTargetIndex={dropTargetIndex}
                      slaCountByRoute={slaCountByRoute}
                      onFocusAlerts={() => focusActionSection("sla")}
                      rowHeight={density === "compact" ? 44 : density === "spacious" ? 72 : 56}
                      hoveredStopId={hoveredStopId}
                      onHoverStop={setHoveredStopId}
                      drivers={drivers}
                    />
                  </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>

          {inboxRailOpen && !focusMode && (
            <div id="dispatch-work-queue-dock" className="col-start-1 row-start-3 h-[min(28dvh,240px)] min-h-0 min-w-0 flex overflow-hidden border-t border-border bg-card text-card-foreground">
              <UnplannedInbox
                stops={unassignedStops}
                selectedStopIds={selectedStopIds}
                setSelectedStopIds={setSelectedStopIds}
                startDrag={startDrag}
                dropTargetRouteId={dropTargetRouteId}
                isDragging={!!dragState}
                onFocusStop={setFocusStopId}
                onHoverStop={setHoveredStopId}
                density={density}
                lastImportAt={lastImportAt}
                searchInputRef={searchInputRef}
              />
            </div>
          )}

          {actionQueueOpen && !focusMode && (
            <div id="dispatch-action-queue" className="absolute inset-y-0 right-0 w-[300px] max-w-full z-30 flex shadow-2xl animate-in slide-in-from-right-2 duration-150">
              <ActionQueue
                rows={livePriorityRows}
                unassignedStops={unassignedStops}
                focusSection={actionFocusSection}
                onSelectStop={handleSelectStop}
                onHighlightRoute={handleSetHighlightRoute}
                onFocusUnassigned={(stopId) => {
                  setFocusStopId(stopId);
                  setSelectedStopIds(new Set([stopId]));
                }}
                onClose={() => setActionQueueOpen(false)}
              />
            </div>
          )}

          {selectedStop && !focusMode && (
            <div
              className={`absolute inset-y-0 w-[320px] z-40 flex shadow-2xl animate-in slide-in-from-right-2 duration-150 ${actionQueueOpen ? "right-[300px]" : "right-0"}`}
            >
              <StopDetailPanel
                routeId={selectedStopIsUnassigned ? undefined : selectedRow?.routeId}
                routeLabel={selectedRow?.routeName}
                organizationId={user?.organizationId ?? undefined}
                stop={selectedStop}
                nearbyStops={nearbyStopsForSelection(selectedStop, scheduledRows, activeRoutes)}
                onSelectNearbyStop={(stopId) => handleSelectStop(stopId, scheduledRows.findIndex((row) => row.stops.some((item) => item.stopId === stopId)))}
                routeColor={selectedStopIsUnassigned ? "#06b6d4" : selectedRow?.color ?? "#06b6d4"}
                driverName={selectedStopIsUnassigned ? t("dispatch.unassigned") : selectedRow?.driverName}
                vehicleName={selectedStopIsUnassigned ? t("dispatch.noVehicle") : selectedRow?.vehicleName}
                hasDispatchedDriver={!selectedStopIsUnassigned}
                readOnlyMessages={user?.role === "viewer"}
                firstStopLock={selectedFirstStopLock}
                onClose={() => setSelectedStopId(null)}
              />
            </div>
          )}

          {focusMode && (
            <button
              type="button"
              onClick={() => setFocusMode(false)}
              data-testid="dispatch-focus-exit"
              className="absolute right-3 top-3 z-50 flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[11px] font-semibold shadow-lg transition-colors hover:bg-muted"
              aria-label={t("dispatch.exitFocus")}
              title={t("dispatch.exitFocus") + " (F / Esc)"}
            >
              <Minimize2 className="h-3.5 w-3.5" />
              {t("dispatch.exitFocus")}
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setKbdHelpOpen(true)}
          className="fixed bottom-4 right-4 z-40 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-card border border-border shadow-md hover:bg-muted transition-colors cursor-pointer"
          aria-label={t("dispatch.kbdHelpTitle")}
          title={t("dispatch.kbdHelpTitle") + " (?)"}
        >
          <HelpCircle className="h-5 w-5 text-muted-foreground" />
        </button>

        <KeyboardHelp open={kbdHelpOpen} onClose={() => setKbdHelpOpen(false)} />

        <Dialog open={importOpen} onOpenChange={setImportWorkflowOpen}>
          <DialogContent className="h-[92vh] w-[96vw] max-w-[1400px] overflow-hidden p-0">
            <DialogTitle className="sr-only">{t("dispatch.importOrders")}</DialogTitle>
            {importOpen && importDraftId ? (
                <ImportWorkflow
                  embedded
                  draftId={importDraftId}
                  onComplete={({ planId, validated, previewMap }) => {
                    setImportOpen(false);
                    if (user?.organizationId) {
                      sessionStorage.setItem(
                        routePlanSelectionStorageKey(user.organizationId),
                        planId,
                      );
                    }
                    const params = new URLSearchParams(window.location.search);
                    params.delete("workflow");
                    params.delete("draftId");
                    params.set("planId", planId);
                    if (previewMap) {
                      params.delete("routeId");
                      params.delete("validated");
                      params.set("view", "traffic");
                      params.set("mode", "plan");
                      setMapVisible(true);
                      navigate(`/dispatch?${params.toString()}`, { replace: true });
                      return;
                    }
                    params.set("view", validated ? "traffic" : "live");
                    if (validated) {
                      params.set("validated", "1");
                      void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                      navigate(`/dispatch?${params.toString()}`, { replace: true });
                      return;
                    }
                    navigate(`/dispatch?${params.toString()}`, { replace: true });
                    toast({
                      title: t("dispatch.importComplete"),
                      description: t("dispatch.importCompleteDescription"),
                    });
                  }}
                />
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog
          open={serviceTimePlanId != null}
          onOpenChange={(open) => !open && setServiceTimePlanId(null)}
        >
          <DialogContent showCloseButton={false} className="flex h-[92vh] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:p-0">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-2 sm:px-6">
              <DialogTitle>{t("dispatch.adjustPlanTitle")}</DialogTitle>
              <DialogClose className="flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border px-4 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="close-adjust-plan">
                {t("common.close")}
              </DialogClose>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {serviceTimePlanId && !selectedExistingPlan && (
              <Alert variant="destructive" data-testid="plan-review-depot-unavailable-dialog">
                <ShieldAlert className="h-4 w-4" />
                <AlertDescription>{t("dispatch.adjustPlanRecoveryError")}</AlertDescription>
              </Alert>
            )}
            {serviceTimePlanId && selectedExistingPlan?.planId === serviceTimePlanId && (
              <Step7Adjust
                routes={selectedExistingPlan.routes.map((route) => {
                  const driver = route.vehicleId
                    ? driversByVehicleId.get(route.vehicleId)
                    : undefined;
                  return {
                    routeId: route.id,
                    planId: route.planId,
                    name: route.name,
                    vehicleId: route.vehicleId!,
                    driverId: driver?.id ?? selectedExistingPlan.fallbackDriverId ?? route.handoffDriverId ?? "",
                    stopCount: route.totalStops,
                    totalDistanceKm: route.totalDistanceKm ?? 0,
                    totalDurationMin: route.totalDurationMin ?? 0,
                    planRevision: route.planRevision,
                    status: "optimized" as const,
                  };
                })}
                unplannedStops={[]}
                unplannedDiagnostics={[]}
                vehicles={vehicles || []}
                drivers={drivers || []}
                depotLatitude={selectedExistingPlan.depotLatitude}
                depotLongitude={selectedExistingPlan.depotLongitude}
                readOnly={selectedExistingPlan.routes.some((route) => route.status !== "optimized")}
                allowResourceSelection
                onValidated={async (validatedRoutes) => {
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
                    queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
                  ]);
                  setServiceTimePlanId(null);
                  const planId = validatedRoutes[0]?.planId;
                  if (planId) {
                    navigate(`/dispatch?${carryRoutesReturnTo(new URLSearchParams({ view: "traffic", planId, validated: "1" }), window.location.search)}`, { replace: true });
                  }
                }}
                onNext={() => {
                  setServiceTimePlanId(null);
                  void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
                  void queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
                }}
              />
            )}
            </div>
          </DialogContent>
        </Dialog>

        {forceAssignment && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="force-assignment-title">
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-2xl">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                <div>
                  <h2 id="force-assignment-title" className="font-semibold">{t("dispatch.assignmentConflict")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t("dispatch.assignmentConflictDescription")}</p>
                </div>
              </div>
              <ul className="mt-4 space-y-1 text-sm">
                {forceAssignment.conflicts.map((conflict) => (
                  <li key={conflict} className="rounded bg-amber-50 px-2 py-1 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                    {{
                      CAPACITY: t("dispatch.reasonCapacity"),
                      TIME_WINDOW: t("dispatch.reasonTimeWindow"),
                      WORKING_HOURS: t("dispatch.reasonWorkingHours"),
                      RANGE: t("dispatch.reasonRange"),
                      NO_VEHICLE: t("dispatch.reasonNoVehicle"),
                    }[conflict] ?? conflict}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-muted-foreground">{t("dispatch.forceAssignmentWarning")}</p>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted" onClick={() => setForceAssignment(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700"
                  onClick={async () => {
                    const assignment = forceAssignment;
                    try {
                      const result = await requestDispatchMove(
                        assignment.stopIds,
                        assignment.routeId,
                        assignment.targetIndex ?? 0,
                        true,
                      );
                      if (result.conflicts.length > 0 || result.error) {
                        const lockedStopError = formatLockedStopError(result, i18n.language);
                        if (lockedStopError) {
                          toast({
                            title: t("common.somethingWentWrong"),
                            description: lockedStopError,
                            variant: "destructive",
                          });
                          return;
                        }
                        throw new Error(result.error || "Forced assignment was not accepted");
                      }
                      setForceAssignment(null);
                      toast({ title: t("dispatch.assignmentForced") });
                    } catch (error) {
                      if (isDispatchMoveUnauthorized(error)) {
                        setSelectedStopIds(new Set(assignment.stopIds));
                        setDispatchReauthenticationOpen(true);
                        return;
                      }
                      toast({
                        title: t("common.somethingWentWrong"),
                          description: describeDispatchError(error, t, "common.errorRequestFailed"),
                        variant: "destructive",
                      });
                    }
                  }}
                >
                  {t("dispatch.forceIntoRoute")}
                </button>
              </div>
            </div>
          </div>
        )}
        <DispatchReauthenticationDialog
          open={dispatchReauthenticationOpen}
          onOpenChange={setDispatchReauthenticationOpen}
          onSuccess={() => {
            toast({
              title: t("dispatch.reauthenticationSucceeded"),
              description: t("dispatch.reauthenticationRetry"),
              duration: 6000,
            });
          }}
        />
      </div>
    </AppLayout>
  );
}

function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function describeDispatchError(error: unknown, t: ErrorTranslator, fallbackKey: string): string {
  return localizeError(error, t, { fallbackKey });
}
