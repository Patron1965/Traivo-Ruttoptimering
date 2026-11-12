import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useRoutes } from "@/hooks/use-routes";
import { useDrivers } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { useDispatchMove } from "@/hooks/use-dispatch-move";
import { GanttTimeline } from "@/components/dispatch/GanttTimeline";
import { DispatchReauthenticationDialog } from "@/components/dispatch/DispatchReauthenticationDialog";
import { LoadingState } from "@/components/ui/LoadingState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ROUTE_COLORS } from "@/lib/constants";
import {
  attachWorkdayEvidence,
  computeSchedule,
  getWorkdayEvidence,
  type ScheduledRow,
} from "@/lib/scheduling";
import { useDispatchChannel } from "@/hooks/use-dispatch-channel";
import { useDispatchRouteSelection } from "@/hooks/use-dispatch-route-selection";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ZoomIn, ZoomOut, Rows2, Rows3, Rows4 } from "lucide-react";
import type { Stop } from "@workspace/api-client-react";
import { useLocation, useSearch } from "wouter";
import { readDispatchScope, selectScopedRoutes, selectScopedUnassignedStops, sortScheduledRows } from "@/lib/dispatch-scope";
import { getEffectiveStopPriority } from "@/lib/dispatch-search";
import { useAuth } from "@/lib/auth-context";
import {
  activateDispatchDrag,
  cancelDispatchDrag,
  createDispatchDragSession,
  firstDispatchTouchPoint,
  type DispatchDragSession,
  type DispatchDragPointer,
} from "@/lib/dispatch-drag";
import { canonicalInsertionIndex } from "@/lib/dispatch-move-index";
import {
  createDispatchMoveError,
  isDispatchMoveRevisionConflict,
  isDispatchMoveUnauthorized,
} from "@/lib/dispatch-move-auth";
import { formatLockedStopError } from "@/lib/locked-stop-error";
import { localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import { isTerminalRouteStatus } from "@/lib/route-plan-groups";
import { useQueryClient } from "@tanstack/react-query";

interface DispatchMoveResult {
  conflicts: string[];
  error?: string;
  code?: string;
  details?: unknown;
  status?: number;
}

export default function GanttPopout() {
  const { t, i18n } = useTranslation();
  const search = useSearch();
  const [, navigate] = useLocation();
  const { hasRole, user } = useAuth();
  const queryClient = useQueryClient();
  const scope = useMemo(() => readDispatchScope(search), [search]);
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: allStops, isLoading: loadingStops } = useStops(undefined, true);
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();

  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedStopIds, setSelectedStopIds] = useState<Set<string>>(new Set());
  const [hoveredStopId, setHoveredStopId] = useState<string | null>(null);
  const { highlightedRouteId, highlightedRouteIds, setHighlightedRouteId,
    selectRoute: selectDriverRoute, clearRoutes: clearDriverRoutes } = useDispatchRouteSelection(
      search, routes, `${user?.organizationId ?? ""}:${user?.id ?? ""}`,
    );
  const [scrollToRouteId, setScrollToRouteId] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [dragState, setDragState] = useState<{ stopIds: string[]; sourceRouteId: string } | null>(null);
  const [dropTargetRouteId, setDropTargetRouteId] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [moveFeedback, setMoveFeedback] = useState<{ type: "error" | "success"; message: string } | null>(null);
  const [forceAssignment, setForceAssignment] = useState<{
    stopIds: string[];
    routeId: string;
    targetIndex: number;
    conflicts: string[];
  } | null>(null);
  const [reauthenticationOpen, setReauthenticationOpen] = useState(false);
  const [movePending, setMovePending] = useState(false);
  const movePendingRef = useRef(false);
  const dragStateRef = useRef<DispatchDragSession | null>(null);
  const dropTargetAnchorRef = useRef<string | null>(null);
  const dropTargetRouteIdRef = useRef<string | null>(null);
  const dropTargetIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const onScopeChange = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !window.opener || event.source !== window.opener) return;
      if (event.data?.type !== "traivo-gantt-scope" || typeof event.data.search !== "string") return;
      navigate(`/gantt-popout${event.data.search}`, { replace: true });
    };
    window.addEventListener("message", onScopeChange);
    return () => window.removeEventListener("message", onScopeChange);
  }, [navigate]);
  useEffect(() => {
    setSelectedStopId(null);
    setSelectedStopIds(new Set());
    setHoveredStopId(null);
    setHighlightedRouteId(scope.routeId ?? null);
    setScrollToRouteId(scope.routeId ?? null);
    setForceAssignment(null);
    setMoveFeedback(null);
    dragStateRef.current = cancelDispatchDrag(dragStateRef.current);
    setDragState(null);
    setDropTargetRouteId(null);
    setDropTargetIndex(null);
    dropTargetAnchorRef.current = null;
    dropTargetRouteIdRef.current = null;
    dropTargetIndexRef.current = null;
  }, [scope]);
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
  const rowHeight = density === "compact" ? 36 : density === "spacious" ? 60 : 48;

  const driversById = useMemo(() => {
    const activeByVehicle = new Map<string, NonNullable<typeof drivers>[number][]>();
    drivers?.forEach((driver) => {
      if (!driver.vehicleId || !driver.isActive) return;
      activeByVehicle.set(
        driver.vehicleId,
        [...(activeByVehicle.get(driver.vehicleId) ?? []), driver],
      );
    });
    const map = new Map<string, { id: string; name: string }>();
    activeByVehicle.forEach((candidates, vehicleId) => {
      if (candidates.length !== 1) return;
      const [driver] = candidates;
      map.set(vehicleId, { id: driver.id, name: driver.name });
    });
    return map;
  }, [drivers]);

  const vehiclesById = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; vehicleType: string; capacityKg: number | null; capacityVolume: number | null; routeColor: string }
    >();
    vehicles?.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const activeRoutes = useMemo(
    () => selectScopedRoutes(routes ?? [], scope),
    [routes, scope],
  );

  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, Stop[]>();
    if (!allStops) return map;
    allStops.forEach((s) => {
      if (s.routeId) {
        const arr = map.get(s.routeId) ?? [];
        arr.push(s);
        map.set(s.routeId, arr);
      }
    });
    return map;
  }, [allStops]);

  const unassignedStops = useMemo(
    () => selectScopedUnassignedStops(allStops ?? [], {
      ...scope,
      routeId: scope.routeId ?? highlightedRouteId,
    }, activeRoutes),
    [allStops, scope, highlightedRouteId, activeRoutes],
  );

  const scheduledRows: ScheduledRow[] = useMemo(() => {
    const routeRows = activeRoutes.map((route, idx) => {
      const vehicle = route.vehicleId ? vehiclesById.get(route.vehicleId) : undefined;
      const driver = route.vehicleId ? driversById.get(route.vehicleId) : undefined;
      const routeStops = stopsByRouteId.get(route.id) ?? [];
      const scheduledMetadata = computeSchedule(routeStops.map((stop) => ({
        ...stop,
        priority: getEffectiveStopPriority(stop, route.optimizationPlanningSnapshot?.stopPriorities),
      })));
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
        routeDate: route.date ?? null,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? t("dispatch.unassigned"),
        planRevision: route.planRevision,
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
    const sortedRouteRows: ScheduledRow[] = sortScheduledRows(routeRows);

    if (unassignedStops.length > 0) {
      const unplannedScheduled = computeSchedule(unassignedStops);
      const totalWeight = unplannedScheduled.reduce((s, st) => s + st.weightKg, 0);
      const totalVolume = unplannedScheduled.reduce((s, st) => s + st.volumeM3, 0);
      sortedRouteRows.push({
        routeId: "unplanned",
        routeName: t("dispatch.unplanned"),
        routeDate: null,
        driverId: null,
        driverName: t("dispatch.unplanned"),
        planRevision: 0,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null,
        vehicleId: "",
        vehicleName: t("dispatch.noVehicle"),
        vehicleType: "fossil",
        capacityKg: 0,
        capacityVolume: 0,
        totalWeightKg: totalWeight,
        totalVolumeM3: totalVolume,
        capacityPercent: 0,
        color: "#64748B",
        stops: unplannedScheduled,
        timeline: undefined,
        summary: undefined,
        workdayStatus: "needs_recalculation",
      });
    }
    return sortedRouteRows;
  }, [activeRoutes, vehiclesById, driversById, stopsByRouteId, unassignedStops, t]);

  const moveStops = useDispatchMove(activeRoutes, allStops);
  const scheduledRowsRef = useRef(scheduledRows);
  const activeRoutesRef = useRef(activeRoutes);
  const moveStopsRef = useRef(moveStops);
  scheduledRowsRef.current = scheduledRows;
  activeRoutesRef.current = activeRoutes;
  moveStopsRef.current = moveStops;
  const canEdit = hasRole("admin", "dispatcher");
  const visibleStopIds = useMemo(
    () => new Set(scheduledRows.flatMap((row) => row.stops.map((stop) => stop.stopId))),
    [scheduledRows],
  );

  useEffect(() => {
    setSelectedStopIds((current) => {
      const next = new Set([...current].filter((stopId) => visibleStopIds.has(stopId)));
      return next.size === current.size ? current : next;
    });
  }, [visibleStopIds]);

  const onChannelMessage = useCallback(
    (msg: { type: string; stopId?: string | null; routeId?: string | null }) => {
      if (msg.type === "hover") setHoveredStopId(msg.stopId ?? null);
      else if (msg.type === "select") {
        const stopId = msg.stopId && visibleStopIds.has(msg.stopId) ? msg.stopId : null;
        setSelectedStopId(stopId);
        setSelectedStopIds(
          stopId ? new Set([stopId]) : new Set(),
        );
      }
      // Driver highlights are local to this timeline's URL scope, never global broadcasts.
      else if (msg.type === "focus") {
        const stopId = msg.stopId && visibleStopIds.has(msg.stopId) ? msg.stopId : null;
        setSelectedStopId(stopId);
        setSelectedStopIds(
          stopId ? new Set([stopId]) : new Set(),
        );
        for (const row of scheduledRows) {
          if (stopId && row.stops.some((s) => s.stopId === stopId)) {
            setScrollToRouteId(row.routeId);
            setTimeout(() => setScrollToRouteId(null), 600);
            break;
          }
        }
      } else if (msg.type === "close") {
        window.close();
      }
    },
    [scheduledRows, visibleStopIds],
  );

  const { send } = useDispatchChannel("popout", onChannelMessage);

  const setDragSelection = useCallback(
    (stopIds: string[]) => {
      setSelectedStopIds(new Set(stopIds));
      setSelectedStopId(stopIds[0] ?? null);
      if (stopIds[0]) send({ type: "select", stopId: stopIds[0] });
    },
    [send],
  );

  const performMove = useCallback(
    async (stopIds: string[], targetRouteId: string, targetIndex: number, force = false) => {
      if (!canEdit || movePendingRef.current) return;
      const targetRow = scheduledRowsRef.current.find((row) => row.routeId === targetRouteId);
      if (!targetRow) {
        setMoveFeedback({ type: "error", message: t("common.errorNotFound") });
        return;
      }
      const routeId = targetRouteId === "unplanned" ? null : targetRouteId;
      const targetRoute = routeId
        ? activeRoutesRef.current.find((route) => route.id === routeId)
        : null;
      if (routeId && (!targetRoute || isTerminalRouteStatus(targetRoute.status))) {
        setMoveFeedback({ type: "error", message: t("common.errorForbidden") });
        return;
      }
      if (
        stopIds.length === 0 ||
        stopIds.some((stopId) => !visibleStopIds.has(stopId)) ||
        new Set(stopIds).size !== stopIds.length
      ) {
        setMoveFeedback({ type: "error", message: t("dispatch.moveRevisionConflict") });
        return;
      }
      const sourceStops = stopIds.map((stopId) => allStops?.find((stop) => stop.id === stopId));
      if (sourceStops.some((stop) => !stop)) {
        setMoveFeedback({ type: "error", message: t("dispatch.moveRevisionConflict") });
        return;
      }
      const sourceRoutes = sourceStops
        .map((stop) => stop?.routeId)
        .filter((sourceRouteId): sourceRouteId is string => Boolean(sourceRouteId));
      if (sourceRoutes.some((sourceRouteId) => {
        const sourceRoute = activeRoutesRef.current.find((route) => route.id === sourceRouteId);
        return !sourceRoute || isTerminalRouteStatus(sourceRoute.status);
      })) {
        setMoveFeedback({ type: "error", message: t("common.errorForbidden") });
        return;
      }

      movePendingRef.current = true;
      setMovePending(true);
      setMoveFeedback(null);
      try {
        const result = await moveStopsRef.current(
          stopIds,
          routeId,
          targetIndex,
          force,
        ) as DispatchMoveResult;
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        if (
          (result.error || (result.status != null && result.status >= 400) || result.code) &&
          conflicts.length === 0
        ) {
          const lockedStopError = formatLockedStopError(result, i18n.language);
          if (lockedStopError) {
            throw new TrustedLocalizedError(lockedStopError);
          }
          throw createDispatchMoveError(result.status ?? 409, result.error || "The stop move failed.", {
            ...(result.code ? { code: result.code } : {}),
            ...(result.details && typeof result.details === "object"
              ? { details: result.details as Record<string, unknown> }
              : {}),
          });
        }
        if (conflicts.length > 0) {
          if (!force && routeId) {
            setForceAssignment({ stopIds, routeId, targetIndex, conflicts });
            return;
          }
          throw createDispatchMoveError(
            result.status ?? 409,
            result.error || "The stop move still has conflicts.",
            result.code ? { code: result.code } : undefined,
          );
        }
        setForceAssignment(null);
        setSelectedStopIds(new Set());
        setSelectedStopId(null);
        send({ type: "select", stopId: null });
        setMoveFeedback({
          type: "success",
          message: t(force ? "dispatch.assignmentForced" : "dispatch.stopsReassigned"),
        });
      } catch (error) {
        if (isDispatchMoveUnauthorized(error)) {
          setDragSelection(stopIds);
          setMoveFeedback({
            type: "error",
            message: t("dispatch.reauthenticationDescription"),
          });
          setForceAssignment(null);
          setReauthenticationOpen(true);
          return;
        }
        if (isDispatchMoveRevisionConflict(error)) {
          setForceAssignment(null);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
            queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
          ]);
          setMoveFeedback({
            type: "error",
            message: t("dispatch.moveRevisionConflict"),
          });
          return;
        }
        setForceAssignment(null);
        const lockedStopError = formatLockedStopError(error, i18n.language);
        setMoveFeedback({
          type: "error",
          message: lockedStopError ?? localizeError(error, t, { fallbackKey: "common.errorRequestFailed" }),
        });
      } finally {
        movePendingRef.current = false;
        setMovePending(false);
      }
    },
    [
      allStops,
      canEdit,
      i18n.language,
      queryClient,
      send,
      setDragSelection,
      t,
      visibleStopIds,
    ],
  );
  const performMoveRef = useRef(performMove);
  performMoveRef.current = performMove;

  const handleReassignStops = useCallback(
    (stopIds: string[], targetRouteId: string, targetIndex?: number) => {
      const targetRow = scheduledRowsRef.current.find((row) => row.routeId === targetRouteId);
      if (!targetRow) return;
      const selected = new Set(stopIds);
      const ordered = scheduledRowsRef.current
        .flatMap((row) => row.stops.map((stop) => stop.stopId))
        .filter((id) => selected.has(id));
      void performMoveRef.current(ordered, targetRouteId, targetIndex ?? targetRow.stops.length);
    },
    [],
  );

  const startDrag = useCallback(
    (stopId: string, sourceRouteId: string, pointerDown: DispatchDragPointer) => {
      if (!canEdit || movePendingRef.current) return;
      const ids = selectedStopIds.has(stopId)
        ? scheduledRows
            .flatMap((row) => row.stops.map((stop) => stop.stopId))
            .filter((id) => selectedStopIds.has(id))
        : [stopId];
      if (ids.length === 0 || ids.length !== (selectedStopIds.has(stopId) ? selectedStopIds.size : 1)) return;
      const sourceRoute = sourceRouteId === "unplanned"
        ? null
        : activeRoutes.find((route) => route.id === sourceRouteId);
      if (sourceRouteId !== "unplanned" && (!sourceRoute || isTerminalRouteStatus(sourceRoute.status))) return;
      const containsTerminalSource = ids.some((id) => {
        const ownerId = allStops?.find((stop) => stop.id === id)?.routeId;
        if (!ownerId) return false;
        const ownerRoute = activeRoutes.find((route) => route.id === ownerId);
        return !ownerRoute || isTerminalRouteStatus(ownerRoute.status);
      });
      if (containsTerminalSource) return;
      dragStateRef.current = createDispatchDragSession(ids, sourceRouteId, pointerDown);
      dropTargetAnchorRef.current = null;
      dropTargetRouteIdRef.current = null;
      dropTargetIndexRef.current = null;
      setDropTargetRouteId(null);
      setDropTargetIndex(null);
    },
    [activeRoutes, allStops, canEdit, scheduledRows, selectedStopIds],
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
    const canDropOn = (routeId: string | null) => {
      if (!routeId) return false;
      if (routeId === "unplanned") return true;
      const route = activeRoutesRef.current.find((candidate) => candidate.id === routeId);
      return Boolean(route && !isTerminalRouteStatus(route.status));
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
      const session = dragStateRef.current;
      if (!session) return;
      const element = document.elementFromPoint(pointer.clientX, pointer.clientY);
      const target = element?.closest<HTMLElement>("[data-drop-route-id]");
      const candidateId = target?.dataset.dropRouteId ?? null;
      const id = canDropOn(candidateId) ? candidateId : null;
      const timeline =
        target?.closest<HTMLElement>("[data-testid='dispatch-timeline-row']") ?? target;
      const blocks = timeline
        ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-testid='dispatch-stop-block']"))
            .filter((block) => !session.stopIds.includes(block.dataset.stopId ?? ""))
        : [];
      const visualIndex = blocks.findIndex(
        (block) =>
          pointer.clientX <
          block.getBoundingClientRect().left + block.getBoundingClientRect().width / 2,
      );
      const anchorStopId = visualIndex < 0 ? null : blocks[visualIndex]?.dataset.stopId ?? null;
      const index = id ? canonicalIndexForAnchor(id, anchorStopId, session.stopIds) : null;
      dropTargetAnchorRef.current = anchorStopId;
      dropTargetRouteIdRef.current = id;
      dropTargetIndexRef.current = index;
      setDropTargetRouteId(id);
      setDropTargetIndex(id ? (visualIndex < 0 ? blocks.length : visualIndex) : null);
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
    const onMove = (event: MouseEvent) => {
      if (dragStateRef.current) activateDrag({ clientX: event.clientX, clientY: event.clientY });
    };
    const onTouchMove = (event: TouchEvent) => {
      const pointer = firstDispatchTouchPoint(event.touches, event.changedTouches);
      if (pointer && activateDrag(pointer)) event.preventDefault();
    };
    const completeDrag = (pointer?: DispatchDragPointer) => {
      const session = dragStateRef.current;
      if (!session) return;
      if (!session.active) {
        clearDragSession();
        return;
      }
      const target = pointer
        ? document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest<HTMLElement>(
            "[data-drop-route-id]",
          )
        : null;
      const candidateId = target?.dataset.dropRouteId ?? dropTargetRouteIdRef.current;
      const id = canDropOn(candidateId) ? candidateId : null;
      if (id) {
        const timeline =
          target?.closest<HTMLElement>("[data-testid='dispatch-timeline-row']") ?? target;
        const blocks = timeline
          ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-testid='dispatch-stop-block']"))
              .filter((block) => !session.stopIds.includes(block.dataset.stopId ?? ""))
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
          ? canonicalIndexForAnchor(id, anchorStopId, session.stopIds)
          : dropTargetIndexRef.current ?? 0;
        void performMoveRef.current(session.stopIds, id, index);
      }
      clearDragSession(true);
    };
    const onUp = (event: MouseEvent) => completeDrag({ clientX: event.clientX, clientY: event.clientY });
    const onTouchEnd = (event: TouchEvent) => {
      const pointer = firstDispatchTouchPoint(event.touches, event.changedTouches);
      completeDrag(pointer ?? undefined);
    };
    const onCancel = () => clearDragSession();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    const touchMoveOptions: AddEventListenerOptions = { passive: false };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onTouchMove, touchMoveOptions);
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onTouchMove, touchMoveOptions);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      clearDragSession();
    };
  }, []);

  useEffect(() => {
    send({ type: "pong" });
    const onUnload = () => send({ type: "close" });
    window.addEventListener("beforeunload", onUnload);
    document.title = "Traivo Route — Tidslinje";
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      send({ type: "close" });
    };
  }, [send]);

  const handleSelectStop = useCallback(
    (stopId: string) => {
      const next = selectedStopId === stopId ? null : stopId;
      setSelectedStopId(next);
      setSelectedStopIds(next ? new Set([next]) : new Set());
      send({ type: "select", stopId: next });
      if (next) send({ type: "focus", stopId: next });
    },
    [selectedStopId, send],
  );

  const handleHighlightRoute = useCallback(
    (routeId: string) => {
      setHighlightedRouteId(routeId);
    },
    [setHighlightedRouteId],
  );

  const handleHoverStop = useCallback(
    (stopId: string | null) => {
      setHoveredStopId(stopId);
      send({ type: "hover", stopId });
    },
    [send],
  );

  const totalStops = scheduledRows.reduce((s, r) => s + r.stops.length, 0);
  const routeRowsCount = scheduledRows.filter((r) => r.routeId !== "unplanned").length;

  if (loadingRoutes || loadingStops) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background">
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background overflow-hidden">
      <header className="h-12 border-b border-border bg-card shadow-sm backdrop-blur flex items-center px-4 shrink-0 gap-3">
        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        <span className="text-sm font-extrabold">{t("dispatch.ganttPopoutTitle")}</span>
        <span data-testid="gantt-popout-counts" className="rounded-full border border-border bg-muted/60 px-2 py-1 text-[10px] font-semibold text-foreground/70">
          {routeRowsCount} {t("dispatch.routesLabel")} · {totalStops} {t("dispatch.stopsLabel", "stopp")}
        </span>
        {(scope.planId || scope.routeId) && (
          <span data-testid="gantt-popout-plan" className="min-w-0 truncate text-xs text-muted-foreground">
            {activeRoutes[0]?.customerReference || activeRoutes[0]?.name || t("dispatch.planNotFound")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-0.5 border border-border bg-muted/40 rounded-md" role="group" aria-label={t("dispatch.density")}>
            <button
              type="button"
              onClick={() => setDensity("compact")}
              className={`h-11 w-11 flex items-center justify-center rounded-l-md ${density === "compact" ? "bg-background shadow-sm" : "hover:bg-background/60"}`}
              title={t("dispatch.densityCompact")}
              aria-label={t("dispatch.densityCompact")}
              aria-pressed={density === "compact"}
              data-testid="popout-density-compact"
            >
              <Rows4 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDensity("comfortable")}
              className={`h-11 w-11 flex items-center justify-center ${density === "comfortable" ? "bg-background shadow-sm" : "hover:bg-background/60"}`}
              title={t("dispatch.densityComfortable")}
              aria-label={t("dispatch.densityComfortable")}
              aria-pressed={density === "comfortable"}
              data-testid="popout-density-comfortable"
            >
              <Rows3 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setDensity("spacious")}
              className={`h-11 w-11 flex items-center justify-center rounded-r-md ${density === "spacious" ? "bg-background shadow-sm" : "hover:bg-background/60"}`}
              title={t("dispatch.densitySpacious")}
              aria-label={t("dispatch.densitySpacious")}
              aria-pressed={density === "spacious"}
              data-testid="popout-density-spacious"
            >
              <Rows2 className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center border border-border bg-muted/40 rounded-md">
            <button
              type="button"
              onClick={() => setZoomLevel((z) => Math.max(0.5, z - 0.25))}
              className="h-11 w-11 flex items-center justify-center rounded-l-md hover:bg-background/60"
              aria-label={t("dispatch.zoomOut", { defaultValue: "Zooma ut" })}
              title={t("dispatch.zoomOut", { defaultValue: "Zooma ut" })}
              data-testid="popout-zoom-out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="text-[10px] tabular-nums w-9 text-center text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoomLevel((z) => Math.min(3, z + 0.25))}
              className="h-11 w-11 flex items-center justify-center rounded-r-md hover:bg-background/60"
              aria-label={t("dispatch.zoomIn", { defaultValue: "Zooma in" })}
              title={t("dispatch.zoomIn", { defaultValue: "Zooma in" })}
              data-testid="popout-zoom-in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {moveFeedback && (
          <Alert
            variant={moveFeedback.type === "error" ? "destructive" : "default"}
            role={moveFeedback.type === "error" ? "alert" : "status"}
            data-testid="gantt-popout-move-feedback"
            className="m-2 flex w-auto shrink-0 items-center justify-between gap-3"
          >
            <AlertDescription>{moveFeedback.message}</AlertDescription>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMoveFeedback(null)}>
              {t("common.close")}
            </Button>
          </Alert>
        )}
        <div data-testid="gantt-popout-timeline" className="min-h-0 flex-1">
          <style>{`
            [data-testid="dispatch-multiselect-hint"] {
              display: none !important;
            }
            .gantt-interaction-hint {
              display: none !important;
            }
            [data-testid="gantt-popout-timeline"] .cursor-grab {
              cursor: ${canEdit && !movePending ? "grab" : "default"} !important;
              touch-action: ${canEdit && !movePending ? "none" : "auto"} !important;
            }
          `}</style>
          <GanttTimeline
            rows={scheduledRows}
            selectedStopId={selectedStopId}
            onSelectStop={(stopId) => handleSelectStop(stopId)}
            zoomLevel={zoomLevel}
            highlightedRouteId={highlightedRouteId}
            highlightedRouteIds={highlightedRouteIds}
            onSelectDriverRoute={selectDriverRoute}
            onClearDriverRoutes={clearDriverRoutes}
            onHighlightRoute={handleHighlightRoute}
            scrollToRouteId={scrollToRouteId}
            selectedStopIds={selectedStopIds}
            setSelectedStopIds={setSelectedStopIds}
            dragState={dragState}
            startDrag={startDrag}
            onReassignStops={canEdit ? handleReassignStops : undefined}
            dropTargetRouteId={dropTargetRouteId}
            dropTargetIndex={dropTargetIndex}
            rowHeight={rowHeight}
            hoveredStopId={hoveredStopId}
            onHoverStop={handleHoverStop}
            drivers={drivers}
            preserveRouteVisibility
            bulkActionsExternal={!canEdit}
          />
        </div>
      </div>
      <Dialog open={Boolean(forceAssignment)} onOpenChange={(open) => !open && setForceAssignment(null)}>
        <DialogContent data-testid="gantt-popout-force-assignment">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {t("dispatch.assignmentConflict")}
            </DialogTitle>
            <DialogDescription>{t("dispatch.assignmentConflictDescription")}</DialogDescription>
          </DialogHeader>
          {forceAssignment && (
            <>
              <ul className="space-y-1 text-sm">
                {forceAssignment.conflicts.map((conflict) => (
                  <li
                    key={conflict}
                    className="rounded bg-amber-50 px-2 py-1 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100"
                  >
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
              <p className="text-xs text-muted-foreground">{t("dispatch.forceAssignmentWarning")}</p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={movePending}
                  onClick={() => setForceAssignment(null)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  disabled={movePending}
                  onClick={() => {
                    const assignment = forceAssignment;
                    void performMove(
                      assignment.stopIds,
                      assignment.routeId,
                      assignment.targetIndex,
                      true,
                    );
                  }}
                >
                  {t("dispatch.forceIntoRoute")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <DispatchReauthenticationDialog
        open={reauthenticationOpen}
        onOpenChange={setReauthenticationOpen}
        onSuccess={() => {
          setMoveFeedback({
            type: "success",
            message: t("dispatch.reauthenticationRetry"),
          });
        }}
      />
    </div>
  );
}
