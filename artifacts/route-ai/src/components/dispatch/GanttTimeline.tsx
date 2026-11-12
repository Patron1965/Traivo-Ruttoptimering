import { createContext, useContext, type ComponentProps, type ReactNode, useRef, useMemo, useEffect, useLayoutEffect, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { GripVertical, X, ArrowRightLeft, ChevronDown, Check, XCircle, Clock, Truck, AlertTriangle, Coffee, Zap, Warehouse, Flag, Paperclip } from "lucide-react";
import {
  getWorkdayUtilization,
  type ScheduledRow,
  type ScheduledStop,
} from "@/lib/scheduling";
import { getStopVisualStatus } from "@/lib/dispatch-status";
import { TerminalStopMarker as CompletionMarker } from "./TerminalStopMarker";
import type { DispatchDragPointer } from "@/lib/dispatch-drag";
import { isStopPrioritized } from "@/lib/dispatch-search";
import {
  Tooltip as BaseTooltip,
  TooltipContent as BaseTooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const TimelinePointerBusy = createContext(false);

function Tooltip(props: ComponentProps<typeof BaseTooltip>) {
  const busy = useContext(TimelinePointerBusy);
  return <BaseTooltip {...props} open={busy ? false : props.open} disableHoverableContent />;
}

function TooltipContent({ className, ...props }: ComponentProps<typeof BaseTooltipContent>) {
  return <BaseTooltipContent {...props} className={cn(className, "pointer-events-none bg-[#514bac] text-white [&_p]:text-white")} />;
}
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  getGetRouteAcknowledgementQueryKey,
  useGetRouteAcknowledgement,
} from "@workspace/api-client-react";
import type { Driver } from "@workspace/api-client-react";
import { DriverDetailsDialog } from "@/components/dispatch/DriverDetailsDialog";
import { routeHighlight } from "@/lib/dispatch-route-selection";
import { timelineSelectionViewport } from "@/lib/timeline-selection-viewport";
import { LockEvidenceBadges } from "./LockEvidenceBadges";
import { DropInsertionMarker } from "./DropInsertionMarker";
import { stopTileText } from "@/lib/stop-tile-contrast";
import { buildActualMarks, compactActualLabels, stockholmHour, type ActualMark } from "@/lib/timeline-actual";

interface DragState {
  stopIds: string[];
  sourceRouteId: string;
}

interface GanttTimelineProps {
  renderResourceAction?: (routeId: string) => ReactNode;
  rows: ScheduledRow[];
  selectedStopId: string | null;
  onSelectStop: (stopId: string, rowIndex: number) => void;
  startHour?: number;
  endHour?: number;
  zoomLevel?: number;
  highlightedRouteId?: string | null;
  highlightedRouteIds?: ReadonlySet<string>;
  onSelectDriverRoute?: (routeId: string, additive: boolean) => void;
  onClearDriverRoutes?: () => void;
  onHighlightRoute?: (routeId: string) => void;
  scrollToRouteId?: string | null;
  onReassignStops?: (stopIds: string[], targetRouteId: string, targetIndex?: number) => void;
  selectedStopIds: Set<string>;
  setSelectedStopIds: (s: Set<string>) => void;
  dragState: DragState | null;
  startDrag: (
    stopId: string,
    sourceRouteId: string,
    pointerDown: DispatchDragPointer,
  ) => void;
  dropTargetRouteId: string | null;
  dropTargetIndex?: number | null;
  slaCountByRoute?: Map<string, number>;
  onFocusAlerts?: () => void;
  rowHeight?: number;
  hoveredStopId?: string | null;
  onHoverStop?: (stopId: string | null) => void;
  preserveRouteVisibility?: boolean;
  drivers?: Driver[];
  bulkActionsExternal?: boolean;
  /** Live mode only: show reported actual terminal times in a separate lane. */
  showActualTimes?: boolean;
}

const ACKNOWLEDGEMENT_LABELS = {
  sent: "Skickad",
  delivered_to_app: "Levererad till app",
  opened: "Öppnad",
  accepted: "Accepterad",
  rejected: "Avvisad",
} as const;

function RouteAcknowledgementBadge({ routeId }: { routeId: string }) {
  const { data: acknowledgement } = useGetRouteAcknowledgement(routeId, {
    query: {
      queryKey: getGetRouteAcknowledgementQueryKey(routeId),
      refetchInterval: 15_000,
      retry: false,
    },
  });
  if (!acknowledgement) return null;

  const rejected = acknowledgement.status === "rejected";
  const accepted = acknowledgement.status === "accepted";
  return (
    <span
      data-testid={`route-acknowledgement-${routeId}`}
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold",
        rejected
          ? "bg-destructive/15 text-destructive"
          : accepted
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
            : "bg-primary/10 text-primary",
      )}
      title={`Chaufförskvittens: ${ACKNOWLEDGEMENT_LABELS[acknowledgement.status]}`}
    >
      {rejected ? (
        <XCircle className="h-2.5 w-2.5" />
      ) : accepted ? (
        <Check className="h-2.5 w-2.5" />
      ) : (
        <Clock className="h-2.5 w-2.5" />
      )}
      {ACKNOWLEDGEMENT_LABELS[acknowledgement.status]}
    </span>
  );
}

const BASE_HOUR_WIDTH = 120;
const DEFAULT_ROW_HEIGHT = 44;
const HEADER_HEIGHT = 36;
const LABEL_WIDTH = 260;

function formatTime(date: Date | undefined) {
  if (!date) return "—";
  return date.toLocaleTimeString("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function PriorityMarker({ priority }: { priority?: number | null }) {
  const { t } = useTranslation();
  if (!isStopPrioritized(priority)) return null;
  const level = priority === 2
    ? t("dispatch.priorityMandatory")
    : t("dispatch.priorityHigh");
  return (
    <span
      data-testid="dispatch-priority-marker"
      className={cn(
        "absolute -left-1 -top-1 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-background px-0.5 text-[8px] font-extrabold leading-none text-white shadow",
        priority === 2 ? "bg-violet-600" : "bg-amber-600",
      )}
      title={t("dispatch.priorityMarker", { level })}
      aria-label={t("dispatch.priorityMarker", { level })}
    >
      <Flag className="h-2 w-2" aria-hidden="true" />
    </span>
  );
}

function ProofMarker({ proofTypes }: { proofTypes?: string[] | null }) {
  const { t } = useTranslation();
  const photo = proofTypes?.includes("photo") ?? false;
  const signature = proofTypes?.includes("signature") ?? false;
  if (!photo && !signature) return null;
  const kinds = [photo ? t("dispatch.proofPhoto", "foto") : "", signature ? t("dispatch.proofSignature", "signatur") : ""]
    .filter(Boolean)
    .join(t("dispatch.proofJoin", " och "));
  const text = t("dispatch.proofUploaded", { kinds, defaultValue: `Bevis uppladdat: ${kinds}` });
  // One compact attachment marker, bottom-right; warnings own top-right and
  // priority owns top-left so the sequence number stays unobstructed.
  return (
    <span
      role="img"
      data-testid="dispatch-proof-marker"
      data-proof-kinds={[photo && "photo", signature && "signature"].filter(Boolean).join(",")}
      className="pointer-events-auto absolute -bottom-1 -right-1 z-10 flex h-3 w-3 items-center justify-center rounded-full border border-background bg-slate-700 text-white shadow-sm dark:bg-slate-200 dark:text-slate-900"
      title={text}
      aria-label={text}
    >
      <Paperclip className="h-2 w-2" aria-hidden="true" />
    </span>
  );
}

/**
 * Zoom-aware detail: when a service block is too short on screen for a
 * legible number, render it at its true time width without the number.
 * Depends only on on-screen (zoom) width, never on hover or selection, so the
 * marker footprint is stable; the tooltip/details reveal tiny-stop numbers.
 */
const MIN_LABEL_WIDTH_PX = 18;

/**
 * Precise hit targets. On fine pointers the invisible 44px button is
 * transparent to hits; only the visible marker (and its priority, warning
 * and proof children) receives the pointer, and events bubble to the
 * button's handlers. Coarse (touch) pointers keep the full 44px target.
 */
const STOP_HIT_TARGET_CLASS =
  "absolute flex items-center justify-center cursor-grab active:cursor-grabbing group min-h-[44px] touch-none [@media(pointer:fine)]:pointer-events-none";
const STOP_VISIBLE_MARKER_HIT_CLASS =
  "pointer-events-none [@media(pointer:fine)]:pointer-events-auto";

/** Completed: solid card rectangle framed in the vehicle colour, never faded. */
const STOP_COMPLETED_CLASS = "bg-card text-foreground";
/** Failed: solid, high-contrast status rectangle. */
const STOP_FAILED_CLASS = "bg-destructive text-destructive-foreground border-destructive";
/** Working-hours conflict keeps the vehicle fill; the edge and top-right badge carry the warning. */
const STOP_WARNING_EDGE_CLASS = "border-[1.5px]";
/** Breaks are neutral time, not customer work. */
const BREAK_BLOCK_CLASS =
  "flex items-center justify-center rounded-sm border border-border bg-muted/70 text-muted-foreground z-10";
/** Connecting route line: thin and subdued so stops stay prominent. */
const ROUTE_LINE_HEIGHT = 2;
const ROUTE_LINE_OPACITY = 0.6;
const TRAVEL_SEGMENT_HEIGHT = 3;

const STOP_TILE_SHADOW =
  "inset 1px 0 0 rgba(255, 255, 255, 0.72), inset -1px 0 0 rgba(255, 255, 255, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.34), 0 1px 2px rgba(15, 23, 42, 0.16)";

export function stopMarkerStyle(
  vehicleColor: string,
  completed: boolean,
  failed: boolean,
  warning: boolean,
  skipped = false,
): React.CSSProperties {
  if (skipped) return { backgroundColor: "#7c3aed", color: "#ffffff", borderColor: vehicleColor, boxShadow: `inset 0 0 0 1px ${vehicleColor}` };
  if (failed) return {};
  if (completed) {
    return { backgroundColor: "#047857", color: "#ffffff", borderColor: vehicleColor, boxShadow: `inset 0 0 0 1px ${vehicleColor}` };
  }
  return {
    backgroundColor: vehicleColor,
    borderColor: warning ? "#dc2626" : `color-mix(in srgb, ${vehicleColor} 55%, #0f172a)`,
    boxShadow: warning ? `0 0 0 1px #dc2626, ${STOP_TILE_SHADOW}` : STOP_TILE_SHADOW,
    // Luminance-based black/white number; overrides the base text-white class.
    ...stopTileText(vehicleColor),
  };
}
export function stopLabelVisible(blockWidth: number): boolean {
  return blockWidth >= MIN_LABEL_WIDTH_PX;
}

function rowHasAuthoritativeTiming(row: ScheduledRow): boolean {
  return row.workdayStatus === "authoritative" && Boolean(row.timeline?.length && row.summary);
}

// Shrink only the visible tile, preserving time positions and drag/touch targets.
const STOP_TILE_SCALE = 0.85;

function missingEvidenceStopWidth(stop: ScheduledStop): number {
  // Keep this as a metadata chip width, never as a time-scaled position.
  return Math.min(96, Math.max(24, stop.serviceDurationMin));
}
export function GanttTimeline({
  renderResourceAction,
  rows,
  selectedStopId,
  onSelectStop,
  startHour: requestedStartHour = 6,
  endHour: requestedEndHour = 20,
  zoomLevel = 1,
  highlightedRouteId = null,
  highlightedRouteIds,
  onSelectDriverRoute,
  onClearDriverRoutes,
  onHighlightRoute,
  scrollToRouteId = null,
  onReassignStops,
  selectedStopIds,
  setSelectedStopIds,
  dragState,
  startDrag,
  dropTargetRouteId,
  dropTargetIndex = null,
  slaCountByRoute,
  onFocusAlerts,
  rowHeight: requestedRowHeight = DEFAULT_ROW_HEIGHT,
  hoveredStopId = null,
  onHoverStop,
  preserveRouteVisibility = false,
  drivers = [],
  bulkActionsExternal = false,
  showActualTimes = false,
}: GanttTimelineProps) {
  // Keep both physical cells aligned, with a genuinely separate readable lane.
  const rowHeight = showActualTimes ? Math.max(60, requestedRowHeight) : requestedRowHeight;
  const { t } = useTranslation();
  const selectedRoutes = highlightedRouteIds ?? new Set(highlightedRouteId ? [highlightedRouteId] : []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const gridInnerRef = useRef<HTMLDivElement>(null);
  const [timelineScrollWidth, setTimelineScrollWidth] = useState(0);
  const [timelineOverflowing, setTimelineOverflowing] = useState(false);
  const [nowTick, setNowTick] = useState(() => new Date());
  const revealedSelection = useRef<string | null>(null);
  const [lasso, setLasso] = useState<{ x0: number; y0: number; x: number; y: number; additive: boolean; base: Set<string> } | null>(null);
  const [suppressedTooltipStopId, setSuppressedTooltipStopId] = useState<string | null>(null);
  const [pointerPressed, setPointerPressed] = useState(false);
  useEffect(() => {
    const release = () => setPointerPressed(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  const [driverDialogSelection, setDriverDialogSelection] = useState<{
    routeId: string;
    driverId: string;
  } | null>(null);

  const selectedDriverRow = driverDialogSelection
    ? rows.find((row) => row.routeId === driverDialogSelection.routeId) ?? null
    : null;
  const selectedDriver = driverDialogSelection
    ? drivers.find((driver) => driver.id === driverDialogSelection.driverId) ?? null
    : null;

  useEffect(() => {
    if (driverDialogSelection && !rows.some((row) => row.routeId === driverDialogSelection.routeId)) {
      setDriverDialogSelection(null);
    }
  }, [driverDialogSelection, rows]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const scrollTargetRowIndex = scrollToRouteId
    ? rows.findIndex((row) => row.routeId === scrollToRouteId)
    : -1;
  useEffect(() => {
    if (scrollTargetRowIndex < 0) return;
    const targetTop = scrollTargetRowIndex * rowHeight;
    scrollRef.current?.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [scrollToRouteId, scrollTargetRowIndex, rowHeight]);

  const HOUR_WIDTH = BASE_HOUR_WIDTH * zoomLevel;
  const evidenceHours = useMemo(() => {
    const hours = rows
      .filter(rowHasAuthoritativeTiming)
      .flatMap((row) =>
        [
          ...(row.timeline ?? []).flatMap((event) => [
            new Date(event.startAt),
            new Date(event.endAt),
          ]),
          ...(row.summary ? [new Date(row.summary.shiftEndAt)] : []),
        ],
      )
      .map((date) => stockholmHour(date))
      .filter(Number.isFinite);
    return hours.length > 0
      ? { min: Math.floor(Math.min(...hours)), max: Math.ceil(Math.max(...hours)) }
      : null;
  }, [rows]);
  const startHour = Math.min(requestedStartHour, evidenceHours?.min ?? requestedStartHour);
  const endHour = Math.max(requestedEndHour, evidenceHours?.max ?? requestedEndHour);
  const totalHours = Math.max(1, endHour - startHour);
  const gridWidth = totalHours * HOUR_WIDTH;

  // The body remains the timeline's scroll authority because it owns both the
  // vertical list and the horizontal Gantt grid. The additional top scrollbar
  // only proxies its horizontal position, leaving header/body alignment intact.
  useLayoutEffect(() => {
    const body = scrollRef.current;
    if (!body) return;

    const measure = () => {
      setTimelineScrollWidth((current) => current === body.scrollWidth ? current : body.scrollWidth);
      setTimelineOverflowing((current) => current === (body.scrollWidth > body.clientWidth) ? current : body.scrollWidth > body.clientWidth);
      if (topScrollRef.current && topScrollRef.current.scrollLeft !== body.scrollLeft) {
        topScrollRef.current.scrollLeft = body.scrollLeft;
      }
    };

    measure();
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(body);
    if (gridInnerRef.current) resizeObserver.observe(gridInnerRef.current);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [gridWidth, rows, rowHeight]);

  const hours = useMemo(() => {
    const arr: number[] = [];
    for (let h = startHour; h <= endHour; h++) arr.push(h);
    return arr;
  }, [startHour, endHour]);

  const timeToX = (date: Date | undefined) => {
    if (!date) return 0;
    // Display-only Stockholm wall clock, shared with the actual-time lane.
    const h = stockholmHour(date);
    if (!Number.isFinite(h)) return 0;
    return ((h - startHour) / totalHours) * gridWidth;
  };

  const now = nowTick;
  const nowX = timeToX(now);
  const nowHour = stockholmHour(now);
  const nowVisible = nowHour >= startHour && nowHour < endHour;

  // A click in the map or inbox must reveal the selected row AND its time.
  // Polling/hover changes must not undo a subsequent manual pan.
  useLayoutEffect(() => {
    if (!selectedStopId) {
      revealedSelection.current = null;
      return;
    }
    if (revealedSelection.current === selectedStopId) return;
    const viewport = scrollRef.current;
    const block = viewport && Array.from(viewport.querySelectorAll<HTMLElement>("[data-stop-id]"))
      .find(element => element.dataset.stopId === selectedStopId);
    if (!viewport || !block) return;
    const viewportRect = viewport.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const next = timelineSelectionViewport({
      left: viewport.scrollLeft, top: viewport.scrollTop,
      width: viewport.clientWidth, height: viewport.clientHeight,
    }, {
      left: blockRect.left - viewportRect.left + viewport.scrollLeft,
      top: blockRect.top - viewportRect.top + viewport.scrollTop,
      width: blockRect.width, height: blockRect.height,
    }, LABEL_WIDTH);
    viewport.scrollTo({ ...next, behavior: "auto" });
    revealedSelection.current = selectedStopId;
  }, [selectedStopId, rows, rowHeight, gridWidth]);

  const handleStopClick = useCallback(
    (stopId: string, rowIdx: number, routeId: string, e: React.MouseEvent) => {
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const next = new Set(selectedStopIds);
        if (next.has(stopId)) next.delete(stopId);
        else next.add(stopId);
        setSelectedStopIds(next);
      } else {
        setSelectedStopIds(new Set([stopId]));
        onSelectStop(stopId, rowIdx);
        onHighlightRoute?.(routeId);
      }
    },
    [selectedStopIds, setSelectedStopIds, onSelectStop, onHighlightRoute],
  );

  const sourceRow = dragState ? rows.find((r) => r.routeId === dragState.sourceRouteId) : null;

  const onLassoMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest("button") || tgt.closest("[data-no-lasso]")) return;
      if (!gridInnerRef.current) return;
      const rect = gridInnerRef.current.getBoundingClientRect();
      const rawX = e.clientX - rect.left - LABEL_WIDTH;
      if (rawX < 0 || rawX > gridWidth) return;
      const x = Math.max(0, Math.min(gridWidth, rawX));
      const y = e.clientY - rect.top;
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      setLasso({ x0: x, y0: y, x, y, additive, base: additive ? new Set(selectedStopIds) : new Set() });
    },
    [gridWidth, selectedStopIds],
  );

  useEffect(() => {
    if (!lasso) return;
    const onMove = (e: MouseEvent) => {
      if (!gridInnerRef.current) return;
      const rect = gridInnerRef.current.getBoundingClientRect();
      const x = Math.max(
        0,
        Math.min(gridWidth, e.clientX - rect.left - LABEL_WIDTH),
      );
      const y = e.clientY - rect.top;
      setLasso((l) => (l ? { ...l, x, y } : null));
    };
    const onUp = () => {
      setLasso((curr) => {
        if (!curr) return null;
        const minX = Math.min(curr.x0, curr.x);
        const maxX = Math.max(curr.x0, curr.x);
        const minY = Math.min(curr.y0, curr.y);
        const maxY = Math.max(curr.y0, curr.y);
        if (Math.abs(curr.x - curr.x0) < 3 && Math.abs(curr.y - curr.y0) < 3) {
          if (!curr.additive) setSelectedStopIds(new Set());
          return null;
        }
        const next = new Set(curr.base);
         rows.forEach((row, rowIdx) => {
           if (!rowHasAuthoritativeTiming(row)) return;
          const top = rowIdx * rowHeight + rowHeight / 2 - 12;
          const bot = top + 24;
          if (bot < minY || top > maxY) return;
          row.stops.forEach((stop) => {
            const sx = timeToX(stop.arrivalTime);
            const sw = Math.max(timeToX(stop.departureTime) - sx, 24);
            if (sx + sw < minX || sx > maxX) return;
            next.add(stop.stopId);
          });
        });
        setSelectedStopIds(next);
        return null;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [gridWidth, lasso, rows, rowHeight, timeToX, setSelectedStopIds]);

  return (
    <TimelinePointerBusy.Provider value={pointerPressed || Boolean(dragState) || Boolean(lasso)}>
    <div
      onPointerDownCapture={(event) => {
        if (event.button === 0) setPointerPressed(true);
      }}
      className="flex min-h-0 flex-1 flex-col h-full bg-background border-t border-border overflow-hidden">
      {selectedStopIds.size > 0 && !bulkActionsExternal && (
        <BulkActionBar
          count={selectedStopIds.size}
          rows={rows}
          selectedStopIds={selectedStopIds}
          onMove={(targetRouteId) => {
            const ordered = rows
              .flatMap((row) => row.stops.map((stop) => stop.stopId))
              .filter((stopId) => selectedStopIds.has(stopId));
            const known = new Set(ordered);
            ordered.push(...Array.from(selectedStopIds).filter((stopId) => !known.has(stopId)));
            onReassignStops?.(ordered, targetRouteId);
            setSelectedStopIds(new Set());
          }}
          onClear={() => setSelectedStopIds(new Set())}
        />
      )}
      {selectedStopIds.size === 0 && !bulkActionsExternal && (
        <div
          className="flex min-h-8 shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground"
          data-testid="dispatch-multiselect-hint"
        >
          <span className="gantt-interaction-hint">{t("dispatch.multiSelectHint", "Markera flera stopp på kartan eller med Skift+klick/dra över tidslinjen. Välj sedan Flytta till.")}</span>
        </div>
      )}

      <div
        ref={topScrollRef}
        role="region"
        aria-label={t("common.horizontalScroll")}
        tabIndex={timelineOverflowing ? 0 : -1}
        hidden={!timelineOverflowing}
        className="overflow-x-auto overflow-y-hidden border-b border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onScroll={(event) => {
          const body = scrollRef.current;
          if (body && body.scrollLeft !== event.currentTarget.scrollLeft) {
            body.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
      >
        <div aria-hidden="true" style={{ width: timelineScrollWidth, height: 16 }} />
      </div>

      <div className="flex">
        <div
          data-testid="dispatch-driver-header"
          className="shrink-0 border-r border-border bg-muted/60 backdrop-blur-sm z-10 flex items-center justify-between gap-2 px-3"
          style={{ width: LABEL_WIDTH, height: HEADER_HEIGHT }}
        >
          <div title={t("dispatch.driverSelectionHint")}>
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-foreground/75">
              {t("dispatch.driversTimeline")}
            </span>
          </div>
          {onClearDriverRoutes && (
            <button type="button" data-testid="dispatch-clear-drivers"
              className="rounded px-1.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
              disabled={selectedRoutes.size === 0} onClick={onClearDriverRoutes}>
              {t("dispatch.deselectDrivers")}
            </button>
          )}
        </div>

        <div ref={headerScrollRef} className="overflow-hidden flex-1" style={{ height: HEADER_HEIGHT }}>
          <div className="relative flex h-full" style={{ width: gridWidth }}>
            {hours.map((h) => (
              <div
                key={h}
                className="text-[11px] font-mono font-semibold text-foreground/80 border-l border-border/60 flex items-end pb-2 pl-2"
                style={{ width: HOUR_WIDTH }}
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
            {nowVisible && (
              <div
                className="absolute bottom-0 h-1.5 w-0.5 bg-destructive z-20 pointer-events-none"
                style={{ left: nowX }}
              />
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        role="region"
        aria-label={t("dispatch.driversTimeline")}
        tabIndex={0}
        // Native focus/scrollIntoView must account for the sticky driver column.
        style={{ scrollPaddingLeft: LABEL_WIDTH + 24, scrollPaddingRight: 24 }}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onScroll={() => {
          if (scrollRef.current && headerScrollRef.current
            && headerScrollRef.current.scrollLeft !== scrollRef.current.scrollLeft) {
            headerScrollRef.current.scrollLeft = scrollRef.current.scrollLeft;
          }
          if (scrollRef.current && topScrollRef.current
            && topScrollRef.current.scrollLeft !== scrollRef.current.scrollLeft) {
            topScrollRef.current.scrollLeft = scrollRef.current.scrollLeft;
          }
        }}
      >
        <div
          ref={gridInnerRef}
          data-testid="dispatch-gantt-body"
          className="relative min-h-full select-none"
          style={{ width: LABEL_WIDTH + gridWidth }}
          onMouseDown={onLassoMouseDown}
        >
            {rows.length === 0 && (
              <div data-testid="dispatch-empty-timeline-grid" aria-hidden="true" className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-y-0 left-0 border-r border-border bg-muted/20" style={{ width: LABEL_WIDTH }} />
                {hours.map((hour) => (
                  <div key={hour} className="absolute inset-y-0 border-l border-border/60"
                    style={{ left: LABEL_WIDTH + (hour - startHour) * HOUR_WIDTH }} />
                ))}
              </div>
            )}
            {nowVisible && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-destructive/60 z-10 pointer-events-none"
                style={{ left: LABEL_WIDTH + nowX }}
              >
                <div className="absolute top-0 -left-1 w-2.5 h-2.5 rounded-full bg-destructive" />
              </div>
            )}
            {lasso && (Math.abs(lasso.x - lasso.x0) > 2 || Math.abs(lasso.y - lasso.y0) > 2) && (
              <div
                className="absolute pointer-events-none border border-primary bg-primary/15 z-30 rounded-sm"
                style={{
                  left: LABEL_WIDTH + Math.min(lasso.x0, lasso.x),
                  top: Math.min(lasso.y0, lasso.y),
                  width: Math.abs(lasso.x - lasso.x0),
                  height: Math.abs(lasso.y - lasso.y0),
                }}
              />
            )}
            {rows.map((row, rowIdx) => (
              <div
                key={row.routeId}
                data-testid="dispatch-gantt-row"
                data-route-row-id={row.routeId}
                className="grid"
                style={{
                  width: LABEL_WIDTH + gridWidth,
                  height: rowHeight,
                  gridTemplateColumns: `${LABEL_WIDTH}px ${gridWidth}px`,
                }}
              >
                <RouteLabelRow
                  renderResourceAction={renderResourceAction}
                  row={row}
                  rowIdx={rowIdx}
                  rowHeight={rowHeight}
                  highlightedRouteId={highlightedRouteId}
                  selectedRoutes={selectedRoutes}
                  onSelectDriverRoute={onSelectDriverRoute}
                  dropTargetRouteId={dropTargetRouteId}
                  slaCountByRoute={slaCountByRoute}
                  onHighlightRoute={onHighlightRoute}
                  onHoverStop={onHoverStop}
                  onFocusAlerts={onFocusAlerts}
                  preserveRouteVisibility={preserveRouteVisibility}
                   onDriverClick={(selectedRow) => {
                     if (selectedRow.driverId) {
                       setDriverDialogSelection({
                         routeId: selectedRow.routeId,
                         driverId: selectedRow.driverId,
                       });
                     }
                   }}
                />
                <GanttRow
                  row={row}
                  rowIdx={rowIdx}
                  gridWidth={gridWidth}
                  hours={hours}
                  timeToX={timeToX}
                  selectedStopId={selectedStopId}
                  selectedStopIds={selectedStopIds}
                  onStopClick={handleStopClick}
                  startDrag={startDrag}
                  rowHeight={rowHeight}
                  hoveredStopId={hoveredStopId}
                  onHoverStop={onHoverStop}
                   suppressedTooltipStopId={suppressedTooltipStopId}
                   onSuppressTooltip={setSuppressedTooltipStopId}
                  {...routeHighlight(row.routeId, selectedRoutes, preserveRouteVisibility)}
                  isDropTarget={dropTargetRouteId === row.routeId}
                  dropTargetIndex={dropTargetRouteId === row.routeId ? dropTargetIndex : null}
                  isDragging={!!dragState}
                  dragCount={dragState?.stopIds.length ?? 0}
                  showActualTimes={showActualTimes}
                  startHour={startHour}
                  endHour={endHour}
                />
              </div>
            ))}
        </div>
      </div>

      {dragState && <DragGhost dragState={dragState} color={sourceRow?.color ?? "#3b82f6"} />}
      <DriverDetailsDialog
        open={Boolean(driverDialogSelection)}
        onOpenChange={(open) => {
          if (!open) setDriverDialogSelection(null);
        }}
        driver={selectedDriver}
        row={selectedDriverRow}
      />
    </div>
    </TimelinePointerBusy.Provider>
  );
}

function RouteLabelRow({
  row,
  rowIdx,
  rowHeight,
  highlightedRouteId,
  selectedRoutes,
  onSelectDriverRoute,
  dropTargetRouteId,
  slaCountByRoute,
  onHighlightRoute,
  onHoverStop,
  onFocusAlerts,
  preserveRouteVisibility,
  onDriverClick,
  renderResourceAction,
}: {
  renderResourceAction?: (routeId: string) => ReactNode;
  row: ScheduledRow;
  rowIdx: number;
  rowHeight: number;
  highlightedRouteId: string | null;
  selectedRoutes: ReadonlySet<string>;
  onSelectDriverRoute?: (routeId: string, additive: boolean) => void;
  dropTargetRouteId: string | null;
  slaCountByRoute?: Map<string, number>;
  onHighlightRoute?: (routeId: string) => void;
  onHoverStop?: (stopId: string | null) => void;
  onFocusAlerts?: () => void;
  preserveRouteVisibility: boolean;
  onDriverClick?: (row: ScheduledRow) => void;
}) {
  const { t } = useTranslation();
  const overCapacity = row.capacityPercent > 100;
  const { isDimmed, isHighlighted } = routeHighlight(row.routeId, selectedRoutes, preserveRouteVisibility);
  const isDropTarget = dropTargetRouteId === row.routeId;
  const isUnplanned = row.routeId === "unplanned";
  const timingIsAuthoritative = rowHasAuthoritativeTiming(row);
  const firstTimelineEvent = timingIsAuthoritative ? row.timeline?.[0] : undefined;
  const lastTimelineEvent = timingIsAuthoritative ? row.timeline?.at(-1) : undefined;
  const startTime = firstTimelineEvent ? new Date(firstTimelineEvent.startAt) : undefined;
  const endTime = lastTimelineEvent ? new Date(lastTimelineEvent.endAt) : undefined;
  const scheduleWindow =
    startTime && endTime
      ? `${formatTime(startTime)}–${formatTime(endTime)}`
      : null;
  const endsLate = !isUnplanned && timingIsAuthoritative && (row.summary?.overtimeMin ?? 0) > 0;
  const utilization = getWorkdayUtilization(row);
  const utilizationPercent = utilization.percent;
  const utilizationOverShift = utilizationPercent !== null && utilizationPercent > 100;
  const workdayTitle = timingIsAuthoritative && row.summary
    ? [
        `Planerat ${Math.round(row.summary.totalMin)} av ${Math.round(row.summary.shiftMin)} min`,
        `Körning ${Math.round(row.summary.nonReturnDrivingMin)} min`,
         `Körreserv ${Math.round(row.summary.travelReserveMin ?? 0)} min`,
        `Service ${Math.round(row.summary.serviceMin)} min`,
         `Stoppreserv ${Math.round(row.summary.stopReserveMin ?? 0)} min`,
        `Väntan ${Math.round(row.summary.waitingMin)} min`,
        `Rast ${Math.round(row.summary.breakMin)} min`,
        `Återresa ${Math.round(row.summary.returnMin)} min`,
         `Skiftslut ${formatTime(new Date(row.summary.shiftEndAt))}`,
        row.summary.overtimeMin > 0
          ? `Övertid ${Math.round(row.summary.overtimeMin)} min`
           : `Tidsmarginal ${Math.round(row.summary.marginMin)} min`,
      ].join(" · ")
    : undefined;
  const utilizationTitle = utilizationPercent !== null
    ? [
        t("dispatch.utilizationLabel", { percent: Math.round(utilizationPercent) }),
        scheduleWindow ? `Planerad depot–depot ${scheduleWindow}` : null,
        workdayTitle,
      ].filter(Boolean).join(" · ")
    : utilization.unavailableReason === "missing_or_invalid_shift"
      ? `${t("dispatch.utilizationUnavailable")} · ${t("dispatch.utilizationShiftUnavailable")}`
      : `${t("dispatch.utilizationUnavailable")} · ${t("dispatch.utilizationEvidenceUnavailable")}`;
  const utilizationAriaLabel = utilizationPercent !== null
    ? utilizationTitle
    : `${t("dispatch.utilizationUnavailable")} · ${utilizationTitle}`;
  const slaCount = isUnplanned ? 0 : slaCountByRoute?.get(row.routeId) ?? 0;

  return (
    <div
      data-testid="dispatch-route-label"
      data-route-label-id={row.routeId}
      data-no-lasso
      data-drop-route-id={row.routeId}
      className={cn(
        "sticky left-0 z-20 flex flex-col justify-center gap-1 px-3 border-r border-b border-border bg-card backdrop-blur-sm transition-all cursor-pointer hover:bg-muted/60",
        rowIdx % 2 === 1 && "bg-muted/40",
        isDimmed && "opacity-60",
        isHighlighted &&
          "bg-primary/10 border-l-4 border-l-primary px-2",
        isDropTarget && "bg-primary/25 ring-2 ring-inset ring-primary",
      )}
      style={{
        height: rowHeight,
        boxShadow:
          isHighlighted
            ? undefined
            : `inset 4px 0 0 ${row.color}`,
      }}
      onClick={(event) => {
        if (onSelectDriverRoute) onSelectDriverRoute(row.routeId, event.shiftKey || event.ctrlKey || event.metaKey);
        else onHighlightRoute?.(row.routeId);
      }}
      onMouseEnter={() => onHoverStop?.(isUnplanned ? null : `route:${row.routeId}`)}
      onMouseLeave={() => onHoverStop?.(null)}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {onSelectDriverRoute && !isUnplanned && (
          <input type="checkbox" data-testid={`dispatch-driver-select-${row.routeId}`}
            checked={isHighlighted}
            aria-label={t("dispatch.selectDriverRoute", { name: row.driverName, route: row.routeName })}
            title={t("dispatch.driverSelectionHint")}
            className="h-3.5 w-3.5 shrink-0 accent-primary"
            onClick={(event) => event.stopPropagation()}
            onChange={() => onSelectDriverRoute(row.routeId, true)}
          />
        )}
        <div className="flex-1 min-w-0" title={`${row.routeName}${row.routeDate ? ` · ${row.routeDate.slice(0, 10)}` : ""}`}>
          <div className="flex h-[18px] min-w-0 items-center justify-between gap-2">
            {isUnplanned || !row.driverId ? (
              <p
                data-testid="dispatch-driver-name"
                className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[18px] text-foreground"
                title={isUnplanned ? t("dispatch.unplannedStops") : row.driverName}
              >
                {isUnplanned ? t("dispatch.unplannedStops") : row.driverName}
              </p>
            ) : (
              <button
                type="button"
                data-testid="dispatch-driver-name"
                className="flex-1 min-w-0 truncate text-left text-[13px] font-semibold leading-[18px] text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                title={t("dispatch.openDriverDetails", { name: row.driverName })}
                aria-label={t("dispatch.openDriverDetails", { name: row.driverName })}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onDriverClick?.(row);
                }}
              >
                {row.driverName}
              </button>
            )}
            {!isUnplanned && utilizationPercent !== null && (
              <span
                data-testid="dispatch-utilization-badge"
                className={cn(
                  "flex h-[18px] shrink-0 items-center gap-1 rounded px-1 text-[10px] font-semibold leading-none tabular-nums",
                  endsLate || utilizationOverShift
                    ? "border-red-500/30 bg-red-500/15 text-red-700 dark:text-red-300"
                    : utilizationPercent === null
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                )}
                title={utilizationTitle}
                aria-label={utilizationAriaLabel}
              >
                {utilizationPercent === null ? "—" : `${Math.round(utilizationPercent)}%`}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex h-[18px] min-w-0 items-center gap-1.5 overflow-hidden text-[10px] leading-[18px] text-muted-foreground">
            {!isUnplanned && row.capacityKg > 0 && (
              <span
                className={cn(
                  "shrink-0 tabular-nums font-mono",
                  overCapacity
                    ? "text-destructive font-bold"
                    : row.capacityPercent >= 85
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {Math.round(row.capacityPercent)}%
              </span>
            )}
            {(slaCount > 0 || overCapacity) && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onFocusAlerts?.();
                }}
                className="flex shrink-0 items-center justify-center h-5 cursor-pointer group focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={
                  overCapacity
                    ? t("dispatch.inlineOverloadBadge")
                    : t("dispatch.inlineSlaBadge", { count: slaCount })
                }
                title={
                  overCapacity
                    ? t("dispatch.inlineOverloadBadge")
                    : t("dispatch.inlineSlaBadge", { count: slaCount })
                }
              >
                <div className={cn(
                  "flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-bold leading-none transition-colors",
                  overCapacity
                    ? "bg-destructive/20 text-destructive group-hover:bg-destructive/30"
                    : "bg-amber-500/20 text-amber-700 dark:text-amber-500 group-hover:bg-amber-500/30",
                )}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  <span className="tabular-nums">
                    {overCapacity
                      ? t("dispatch.inlineOverloadBadge")
                      : t("dispatch.inlineSlaBadge", { count: slaCount })}
                  </span>
                </div>
              </button>
            )}
            {(isUnplanned || row.vehicleName?.trim().toLocaleLowerCase() !== row.driverName?.trim().toLocaleLowerCase()) && <span className="min-w-0 truncate" title={isUnplanned ? row.routeName : `${row.vehicleName} · ${row.routeName}`}>
              {isUnplanned ? row.routeName : row.vehicleName}
            </span>}
            {!isUnplanned && (
              <>
                {row.routeDate && <span className="shrink-0 tabular-nums text-foreground/70" title={`Ruttdatum ${row.routeDate}`}>
                  {/^\d{4}-\d{2}-\d{2}/.test(row.routeDate) ? row.routeDate.slice(0, 10).split("-").reverse().join("/") : "—"}
                </span>}
                <RouteAcknowledgementBadge routeId={row.routeId} />
              </>
            )}
          </div>
        </div>
        {!isUnplanned && !timingIsAuthoritative && (
          <span
            data-testid="dispatch-schedule-needs-recalculation"
            className="flex h-7 w-[18px] shrink-0 items-center justify-center text-amber-700 dark:text-amber-300"
            title={t("dispatch.scheduleNeedsRecalculation")}
          >
            <AlertTriangle className="h-3 w-3" />
            <span className="sr-only">{t("dispatch.scheduleNeedsRecalculationShort")}</span>
          </span>
        )}
        {!isUnplanned && renderResourceAction && (
          <span className="flex w-10 shrink-0 items-center justify-end" onPointerDown={event => event.stopPropagation()}
            onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
            {renderResourceAction(row.routeId)}
          </span>
        )}
      </div>
    </div>
  );
}

function DragGhost({ dragState, color }: { dragState: DragState; color: string }) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);
  if (!pos) return null;
  return (
    <div
      className="fixed z-[9999] pointer-events-none"
      style={{ left: pos.x + 12, top: pos.y - 12 }}
    >
      <div
        className="px-2.5 py-1 rounded-md text-[10px] font-bold shadow-md flex items-center gap-1.5 border border-primary/20 bg-card text-foreground"
      >
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        {dragState.stopIds.length === 1
          ? t("dispatch.moveStop")
          : t("dispatch.moveStops", { count: dragState.stopIds.length })}
      </div>
    </div>
  );
}

function BulkActionBar({
  count,
  rows,
  selectedStopIds,
  onMove,
  onClear,
}: {
  count: number;
  rows: ScheduledRow[];
  selectedStopIds: Set<string>;
  onMove: (targetRouteId: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const sourceRouteIds = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      r.stops.forEach((s) => {
        if (selectedStopIds.has(s.stopId)) set.add(r.routeId);
      });
    });
    return set;
  }, [rows, selectedStopIds]);

  const routeTargets = rows.filter((r) => r.routeId !== "unplanned");
  const unplannedRow = rows.find((r) => r.routeId === "unplanned");

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-primary/10 border-b border-primary/30 shrink-0">
      <ArrowRightLeft className="h-3.5 w-3.5 text-primary" />
      <span className="text-xs font-semibold text-primary">
        {t("dispatch.selectedCount", { count, defaultValue: "{{count}} markerade" })}
      </span>
      <span className="text-[10px] text-muted-foreground ml-1">
        {t("dispatch.bulkHint", "Dra lasso, shift+klick eller dra till en rutt")}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center justify-center gap-1.5 min-h-[44px] px-3 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors cursor-pointer"
              data-testid="dispatch-move-to-trigger"
            >
              {t("dispatch.moveTo", "Flytta till")}
              <ChevronDown className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto w-64">
            {routeTargets.map((r) => {
              const isSource = sourceRouteIds.has(r.routeId);
              return (
                <DropdownMenuItem
                  key={r.routeId}
                  disabled={isSource && sourceRouteIds.size === 1}
                  onClick={() => onMove(r.routeId)}
                  className="gap-2 min-h-[44px]"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: r.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold truncate">{r.routeName}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {r.driverName} · {r.stops.length} {t("common.stops")}
                    </p>
                  </div>
                  {isSource && (
                    <span className="text-[9px] uppercase text-muted-foreground">
                      {t("dispatch.current", "Aktuell")}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onMove("unplanned")}
              className="gap-2 min-h-[44px]"
              data-testid="dispatch-move-to-unplanned"
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-destructive" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate text-destructive">
                  {t("dispatch.unplannedStops")}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {t("dispatch.unassignHint", "Avschemalägg stopp")}
                </p>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center justify-center gap-1 min-h-[44px] px-3 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors cursor-pointer"
        >
          <X className="h-4 w-4" />
          {t("dispatch.clearSelection", "Avmarkera")}
        </button>
      </div>
    </div>
  );
}

function GanttRowAccumulated({
  row,
  rowIdx,
  gridWidth,
  hours,
  timeToX,
  selectedStopId,
  selectedStopIds,
  onStopClick,
  startDrag,
  isDimmed,
  isHighlighted,
  isDropTarget,
  dropTargetIndex,
  dragCount = 0,
  isDragging,
  rowHeight,
  hoveredStopId,
  onHoverStop,
  suppressedTooltipStopId,
  onSuppressTooltip,
}: {
  row: ScheduledRow;
  rowIdx: number;
  gridWidth: number;
  hours: number[];
  timeToX: (d: Date | undefined) => number;
  selectedStopId: string | null;
  selectedStopIds: Set<string>;
  onStopClick: (stopId: string, rowIdx: number, routeId: string, e: React.MouseEvent) => void;
  startDrag: (
    stopId: string,
    sourceRouteId: string,
    pointerDown: DispatchDragPointer,
  ) => void;
  isDimmed: boolean;
  isHighlighted: boolean;
  isDropTarget: boolean;
  dropTargetIndex: number | null;
  dragCount?: number;
  isDragging: boolean;
  rowHeight: number;
  hoveredStopId: string | null;
  onHoverStop?: (stopId: string | null) => void;
  suppressedTooltipStopId: string | null;
  onSuppressTooltip: (stopId: string | null) => void;
}) {
  const { t } = useTranslation();
  const [dockHoveredStopId, setDockHoveredStopId] = useState<string | null>(null);
  const isRouteHovered = hoveredStopId === `route:${row.routeId}`;
  const stopIndexById = useMemo(
    () => new Map(row.stops.map((stop, index) => [stop.stopId, index])),
    [row.stops],
  );
  const dockHoveredIndex = dockHoveredStopId
    ? (stopIndexById.get(dockHoveredStopId) ?? -1)
    : -1;
  // Stable footprint: hover and selection are shown by outline only. No dock
  // magnification of the hovered stop or its neighbours.
  const getDockScale = (_stopId: string, _selected: boolean, _multiSelected: boolean) => 1;
  const timingIsAuthoritative = rowHasAuthoritativeTiming(row);
  const routeStartTime = timingIsAuthoritative && row.timeline?.[0]
    ? new Date(row.timeline[0].startAt)
    : undefined;
  const routeEndTime = timingIsAuthoritative && row.timeline?.at(-1)
    ? new Date(row.timeline.at(-1)!.endAt)
    : undefined;
  const shiftEndTime = timingIsAuthoritative && row.summary
    ? new Date(row.summary.shiftEndAt)
    : undefined;
  const rawRouteStart = routeStartTime ? timeToX(routeStartTime) : 0;
  const rawRouteEnd = routeEndTime ? timeToX(routeEndTime) : 0;
  const clampToGrid = (value: number) => Math.max(0, Math.min(gridWidth, value));
  const routeCrossesMidnight =
    routeStartTime !== undefined &&
    routeEndTime !== undefined &&
    routeEndTime.getTime() > routeStartTime.getTime() &&
    rawRouteEnd < rawRouteStart;
  const routeSpans = routeCrossesMidnight
    ? [
        {
          start: clampToGrid(rawRouteStart),
          end: gridWidth,
        },
        {
          start: 0,
          end: clampToGrid(rawRouteEnd),
        },
      ]
    : [
        {
          start: clampToGrid(Math.min(rawRouteStart, rawRouteEnd)),
          end: clampToGrid(Math.max(rawRouteStart, rawRouteEnd)),
        },
      ];
  const routeMarkerX = clampToGrid(rawRouteStart);
  const shiftEndX = shiftEndTime ? clampToGrid(timeToX(shiftEndTime)) : null;
  const remainingStops = row.stops.filter((stop) => !selectedStopIds.has(stop.stopId));
  const metadataSlotWidth = gridWidth / Math.max(remainingStops.length + 1, 1);
  const insertionX = (() => {
    if (dropTargetIndex == null) return null;
    if (!timingIsAuthoritative) {
      const index = Math.max(0, Math.min(dropTargetIndex, remainingStops.length));
      return clampToGrid((index + 0.5) * metadataSlotWidth);
    }
    if (dropTargetIndex <= 0) {
      const firstArrival = remainingStops[0]?.arrivalTime;
      return clampToGrid((firstArrival ? timeToX(firstArrival) : 8) - 8);
    }
    if (dropTargetIndex >= remainingStops.length) {
      const lastDeparture = remainingStops.at(-1)?.departureTime;
      return clampToGrid((lastDeparture ? timeToX(lastDeparture) : 8) + 8);
    }
    const previousDeparture = remainingStops[dropTargetIndex - 1]?.departureTime;
    const nextArrival = remainingStops[dropTargetIndex]?.arrivalTime;
    if (!previousDeparture || !nextArrival) return null;
    return clampToGrid(
      (timeToX(previousDeparture) + timeToX(nextArrival)) / 2,
    );
  })();
  return (
    <div
      data-testid="dispatch-timeline-row"
      data-timeline-route-id={row.routeId}
      data-drop-route-id={row.routeId}
      className={cn(
        "relative border-b border-border transition-all group",
        rowIdx % 2 === 1 && "bg-muted/40",
        isDimmed && "opacity-55",
        isHighlighted && "bg-primary/10",
        isDropTarget && "bg-primary/20 ring-2 ring-inset ring-primary",
        isDragging && !isDropTarget && "hover:bg-primary/10",
      )}
      style={{ height: rowHeight, width: gridWidth }}
    >
      {hours.map((h) => (
        <div
          key={h}
          className="absolute top-0 bottom-0 border-l border-border/60"
          style={{ left: ((h - hours[0]) / (hours.length - 1)) * gridWidth }}
        />
      ))}

      {routeStartTime && routeEndTime && (
        <>
          {routeSpans.map((span, index) => {
            const spanWidth = Math.max(0, span.end - span.start);
            if (spanWidth === 0) return null;
            return (
              <div
                key={`${row.routeId}-span-${index}`}
                data-testid="dispatch-route-span"
                className="absolute pointer-events-none z-[1] rounded-full shadow-sm"
                style={{
                  left: span.start,
                  width: spanWidth,
                  top: rowHeight / 2 - 1,
                  height: ROUTE_LINE_HEIGHT,
                  backgroundColor: row.color,
                  opacity: ROUTE_LINE_OPACITY,
                }}
              />
            );
          })}
          {routeMarkerX >= 12 && routeMarkerX < gridWidth && (
            <div
              className="absolute z-[2] flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border-2 border-background shadow-sm"
              style={{
                left: routeMarkerX - 12,
                top: rowHeight / 2 - 10,
                backgroundColor: row.color,
              }}
              title={t("dispatch.routeStarts", {
                time: formatTime(routeStartTime),
              })}
            >
              <Truck className="h-2.5 w-2.5 text-white" />
            </div>
          )}
        </>
      )}
      {shiftEndX !== null && (
        <div
          className="absolute inset-y-1 z-[2] border-l border-dashed border-foreground/30 pointer-events-none"
          style={{ left: shiftEndX }}
          title={t("dispatch.shiftEnd", { time: formatTime(shiftEndTime) })}
        />
      )}

      {isDropTarget && (
        <DropInsertionMarker
          x={insertionX}
          index={dropTargetIndex}
          remainingStops={remainingStops}
          gridWidth={gridWidth}
          routeName={row.routeName}
          dragCount={dragCount}
          compact={rowHeight < 36}
        />
      )}

      {timingIsAuthoritative && row.timeline ? (
        row.timeline.map((item, idx) => {
          const start = new Date(item.startAt);
          const end = new Date(item.endAt);
          const x = timeToX(start);
          const w = timeToX(end) - x;

          if (item.type === "service" && item.stopId) {
            const stop = row.stops.find((s) => s.stopId === item.stopId);
            if (!stop) return null;
            const blockW = Math.max(w, 12);
            const isSelected = stop.stopId === selectedStopId;
            const isMultiSelected = selectedStopIds.has(stop.stopId);
            const isHovered = hoveredStopId === stop.stopId || isRouteHovered;
            const dockScale = getDockScale(stop.stopId, isSelected, isMultiSelected);
            const showStopLabel = stopLabelVisible(blockW);
            const dockDistance = dockHoveredIndex < 0
              ? Number.POSITIVE_INFINITY
              : Math.abs((stopIndexById.get(stop.stopId) ?? -1) - dockHoveredIndex);
            const visualStatus = getStopVisualStatus(stop);
            const isCompleted = visualStatus === "completed";
            const isFailed = visualStatus === "failed";
            const isSlaRisk = visualStatus === "sla_risk";
            const isForcedOutsideWorkingHours = stop.assignmentOverrideReasonCodes?.includes("WORKING_HOURS") ?? false;
            const stopFill = isCompleted ? "#10b981" : isFailed ? "#ef4444" : row.color;

            return (
              <div key={`timeline-${idx}-${item.stopId}`}>
                <Tooltip open={isSelected || isMultiSelected || suppressedTooltipStopId === stop.stopId ? false : undefined}>
                  <TooltipTrigger asChild>
                    <button
                      data-testid="dispatch-stop-block"
                      data-stop-id={stop.stopId}
                      className={STOP_HIT_TARGET_CLASS}
                      style={{
                        left: x - (blockW < 44 ? (44 - blockW) / 2 : 0),
                        width: Math.max(44, blockW),
                        top: rowHeight / 2 - 22,
                        zIndex: dockDistance <= 2 ? 30 - dockDistance : 10,
                      }}
                      onClick={(e) => {
                        onSuppressTooltip(stop.stopId);
                        onStopClick(stop.stopId, rowIdx, row.routeId, e);
                      }}
                      onMouseEnter={() => {
                        setDockHoveredStopId(stop.stopId);
                        onHoverStop?.(stop.stopId);
                      }}
                      onMouseLeave={() => {
                        setDockHoveredStopId(null);
                        onHoverStop?.(null);
                        if (suppressedTooltipStopId === stop.stopId) onSuppressTooltip(null);
                      }}
                      onFocus={() => {
                        setDockHoveredStopId(stop.stopId);
                        onHoverStop?.(stop.stopId);
                      }}
                      onBlur={() => {
                        setDockHoveredStopId(null);
                        onHoverStop?.(null);
                      }}
                      onMouseDown={(e) => {
                        if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                          e.preventDefault();
                          startDrag(stop.stopId, row.routeId, {
                            clientX: e.clientX,
                            clientY: e.clientY,
                          });
                        }
                      }}
                      onTouchStart={(e) => {
                        const touch = e.touches[0];
                        if (touch) {
                          startDrag(stop.stopId, row.routeId, {
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                          });
                        }
                      }}
                      aria-label={`#${stop.sequenceOrder} ${stop.customerName || stop.address}`}
                    >
                      <div
                        className={cn(
                          STOP_VISIBLE_MARKER_HIT_CLASS, "flex items-center justify-center text-[10px] font-extrabold font-mono tabular-nums transition-[transform,filter,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none group-hover:z-20 border rounded-[3px]",
                          isSelected && "outline outline-2 outline-offset-1 outline-foreground z-20 !opacity-100",
                          isMultiSelected && !isSelected && "outline outline-2 outline-offset-1 outline-primary z-20 !opacity-100",
                          isCompleted
                                ? STOP_COMPLETED_CLASS
                                : isFailed
                                  ? STOP_FAILED_CLASS
                                  : "text-white group-hover:brightness-110 group-hover:shadow-md",
                          isForcedOutsideWorkingHours && !isCompleted && !isFailed && STOP_WARNING_EDGE_CLASS,
                          isHovered && !isSelected && !isMultiSelected && "outline outline-1 outline-offset-1 outline-primary/70 z-20",
                        )}
                        style={{
                          width: showStopLabel ? Math.max(blockW, 24) : blockW,
                          height: 24,
                          transform: `scale(${dockScale * STOP_TILE_SCALE})`,
                          transformOrigin: "50% 100%",
                          ...stopMarkerStyle(row.color, isCompleted, isFailed, isForcedOutsideWorkingHours, stop.status === "skipped"),
                        }}
                      >
                        <PriorityMarker priority={stop.priority} />
<ProofMarker proofTypes={stop.proofTypes} /><CompletionMarker stop={stop} />
                        {stop.assignmentOverrideAt && (
                          <span
                            data-testid={isForcedOutsideWorkingHours ? "working-hours-override-warning" : undefined}
                            className={`absolute -right-1 -top-1 z-20 rounded-full p-0.5 text-white shadow ${isForcedOutsideWorkingHours ? "bg-red-600" : "bg-amber-500"}`}
                            title={isForcedOutsideWorkingHours ? t("dispatch.reasonWorkingHours") : t("dispatch.forcedAssignmentMarker")}
                          >
                            <AlertTriangle className="h-2 w-2" />
                          </span>
                        )}
                        {showStopLabel && <span data-testid="dispatch-stop-sequence">{stop.sequenceOrder}</span>}
                        {(stop.lockedVehicleId || stop.lockedServiceStartAt || row.optimizationFrozen) && <span title="Planeringslås" aria-label="Planeringslås">L</span>}
                        {(isSlaRisk || isForcedOutsideWorkingHours) && !isCompleted && !isFailed && !stop.assignmentOverrideAt && (
                           <div className="absolute -top-1 -right-1 z-20 w-2 h-2 rounded-full bg-destructive border border-background shadow-sm" />
                        )}
                      </div>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center" sideOffset={8} collisionPadding={12} className="max-w-[240px]">
                    <p className="font-bold text-xs">#{stop.sequenceOrder} {stop.customerName || stop.address}</p>
                    {stop.terminalAt && <p className="text-xs font-semibold text-emerald-600">
                      {stop.status === "skipped" ? "Hoppat över" : isCompleted ? "Genomfört" : "Rapporterat"} {new Date(stop.terminalAt).toLocaleTimeString("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" })} · faktisk tid
                    </p>}
                    <LockEvidenceBadges route={row} stop={{ ...stop, id: stop.stopId }} compact />
                    <p className="text-[10px] text-muted-foreground mt-0.5">{formatTime(stop.arrivalTime)} – {formatTime(stop.departureTime)}</p>
                    <p className="text-[10px] text-muted-foreground">{(stop.distanceFromPrevKm ?? 0).toFixed(1)} km · {Math.round(stop.travelTimeMin ?? 0)} min · {stop.serviceDurationMin} min service</p>
                    {isStopPrioritized(stop.priority) && (
                      <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                        {t("dispatch.priorityMarker", {
                          level: stop.priority === 2
                            ? t("dispatch.priorityMandatory")
                            : t("dispatch.priorityHigh"),
                        })}
                      </p>
                    )}
                    <p className="gantt-interaction-hint text-[10px] text-primary mt-1">{selectedStopIds.size > 0 ? "Shift+klick för fler · Dra för att flytta" : "Dra för att flytta · Shift+klick för fler"}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          }

          if (item.type === "driving" || item.type === "return" || item.type === "travel_reserve" || item.type === "stop_reserve") {
            if (w < 2) return null;
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center min-h-[44px]"
                    style={{
                      left: x - (w < 44 ? (44 - w) / 2 : 0),
                      width: Math.max(44, w),
                      top: rowHeight / 2 - 22,
                    }}
                  >
                    <div
                      className={cn(
                        "rounded-sm opacity-55",
                        (item.type === "travel_reserve" || item.type === "stop_reserve") && "border border-dashed opacity-70",
                      )}
                      style={{ width: w, height: TRAVEL_SEGMENT_HEIGHT, backgroundColor: row.color }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                   <p className="text-[10px] font-mono">
                     {item.type === "travel_reserve"
                       ? t("dispatch.travelReserve", { min: Math.round(item.durationMin) })
                       : item.type === "stop_reserve"
                         ? t("dispatch.stopReserve", { min: Math.round(item.durationMin) })
                         : t("dispatch.driveSegment", { min: Math.round(item.durationMin), km: item.distanceKm?.toFixed(1) || "0" })}
                   </p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "waiting") {
            if (w < 2) return null;
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center min-h-[44px]"
                    style={{
                      left: x - (w < 44 ? (44 - w) / 2 : 0),
                      width: Math.max(44, w),
                      top: rowHeight / 2 - 22,
                    }}
                  >
                    <div className="rounded-sm bg-muted-foreground/30" style={{ width: w, height: 6 }} />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">Väntetid ({Math.round(item.durationMin)} min)</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "break") {
            const blockW = Math.max(w, 8);
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center cursor-help min-h-[44px]"
                    style={{ left: x, width: blockW, top: rowHeight / 2 - 22 }}
                  >
                    <div data-testid="dispatch-break-block" className={BREAK_BLOCK_CLASS} style={{ width: blockW, height: 20 }}>
                      {blockW >= 16 && <Coffee className="h-3 w-3" aria-hidden="true" />}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">Rast ({Math.round(item.durationMin)} min)</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "charging") {
            const blockW = Math.max(w, 8);
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center cursor-help min-h-[44px]"
                    style={{ left: x, width: blockW, top: rowHeight / 2 - 22 }}
                  >
                    <div className="flex items-center justify-center rounded-sm bg-emerald-500/20 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 z-10" style={{ width: blockW, height: 20 }}>
                      {blockW >= 24 && <Zap className="h-3 w-3" />}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">Laddning ({Math.round(item.durationMin)} min)</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "depot_start" || item.type === "depot_end") {
            // At colocated stops the depot can overlap service: keep the
            // actionable stop above this informational marker.
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center z-[5]"
                    style={{ left: x - 10, width: 20, top: rowHeight / 2 - 10 }}
                  >
                    <div className="w-5 h-5 rounded-full bg-background border-2 shadow-sm flex items-center justify-center text-muted-foreground" style={{ borderColor: row.color }}>
                      <Warehouse className="w-2.5 h-2.5" />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">{item.type === "depot_start" ? "Startdepå" : "Slutdepå"}</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          return null;
        })
      ) : !timingIsAuthoritative ? (
        <div
          data-testid="dispatch-recalculation-lane"
          className="absolute inset-0 flex items-center gap-2 overflow-hidden px-3 text-[10px] text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-semibold">{t("dispatch.scheduleNeedsRecalculation")}</span>
          <span className="text-muted-foreground">
            {t("dispatch.stopCount", { count: row.stops.length })}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {row.stops.map((stop) => (
              <button
                key={stop.stopId}
                type="button"
                data-testid="dispatch-stop-block"
                data-stop-id={stop.stopId}
                className={cn(
                  "flex h-6 min-w-6 items-center justify-center rounded border px-1 font-mono text-[9px] font-bold",
                  selectedStopIds.has(stop.stopId)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
                )}
                style={{
                  ...(stop.status === "skipped" ? stopMarkerStyle(row.color, false, false, false, true) : {}),
                  minWidth: Math.max(
                    24,
                    Math.min(80, Math.round(stop.serviceDurationMin * 2)),
                  ),
                }}
                title={`${stop.status === "skipped" ? "Hoppat över · " : ""}${stop.address}\n#${stop.sequenceOrder}${stop.trackingCode || stop.externalRef ? ` · ${stop.trackingCode || stop.externalRef}` : ""}\n${t("dispatch.scheduleNeedsRecalculation")}`}
                aria-label={`#${stop.sequenceOrder} ${stop.customerName || stop.address}`}
                onClick={(event) => {
                  onSuppressTooltip(stop.stopId);
                  onStopClick(stop.stopId, rowIdx, row.routeId, event);
                }}
                onMouseDown={(event) => {
                  if (event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    startDrag(stop.stopId, row.routeId, {
                      clientX: event.clientX,
                      clientY: event.clientY,
                    });
                  }
                }}
                onTouchStart={(event) => {
                  const touch = event.touches[0];
                  if (touch) {
                    startDrag(stop.stopId, row.routeId, {
                      clientX: touch.clientX,
                      clientY: touch.clientY,
                    });
                  }
                }}
              >
                {stop.sequenceOrder}
                {(stop.lockedVehicleId || stop.lockedServiceStartAt || row.optimizationFrozen) && <span title="Planeringslås" aria-label="Planeringslås"> · L</span>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        row.stops.map((stop, idx) => {
          const x = timeToX(stop.arrivalTime);
          const w = timeToX(stop.departureTime) - x;
          const blockW = Math.max(w, 12);
          const isSelected = stop.stopId === selectedStopId;
          const isMultiSelected = selectedStopIds.has(stop.stopId);
          const isHovered = hoveredStopId === stop.stopId || isRouteHovered;
          const dockScale = getDockScale(stop.stopId, isSelected, isMultiSelected);
          const showStopLabel = stopLabelVisible(blockW);
          const dockDistance = dockHoveredIndex < 0
            ? Number.POSITIVE_INFINITY
            : Math.abs(idx - dockHoveredIndex);

          const visualStatus = getStopVisualStatus(stop);
          const isCompleted = visualStatus === "completed";
          const isFailed = visualStatus === "failed";
          const isSlaRisk = visualStatus === "sla_risk";
          const isForcedOutsideWorkingHours =
            stop.assignmentOverrideReasonCodes?.includes("WORKING_HOURS") ?? false;

          const stopFill = isCompleted
            ? "#10b981"
            : isFailed
              ? "#ef4444"
              : row.color;

          const prevStop: ScheduledStop | undefined = row.stops[idx - 1];
          let driveX = 0;
          let driveW = 0;
          if (prevStop) {
            driveX = timeToX(prevStop.departureTime);
            driveW = x - driveX;
          }

          return (
            <div key={stop.stopId}>
              {prevStop && driveW > 2 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="absolute flex items-center justify-center cursor-pointer min-h-[44px]"
                      style={{
                        left: driveX - (driveW < 44 ? (44 - driveW) / 2 : 0),
                        width: Math.max(44, driveW),
                        top: rowHeight / 2 - 22,
                      }}
                      aria-label={t("dispatch.driveSegment", {
                        min: Math.round(stop.travelTimeMin ?? 0),
                        km: (stop.distanceFromPrevKm ?? 0).toFixed(1),
                      })}
                    >
                      <div
                        className="rounded-sm opacity-55 hover:opacity-80 transition-opacity"
                        style={{ width: driveW, height: TRAVEL_SEGMENT_HEIGHT, backgroundColor: stopFill }}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-[10px] font-mono">
                      {t("dispatch.driveSegment", {
                        min: Math.round(stop.travelTimeMin ?? 0),
                        km: (stop.distanceFromPrevKm ?? 0).toFixed(1),
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip
                open={
                  isSelected ||
                  isMultiSelected ||
                  suppressedTooltipStopId === stop.stopId
                    ? false
                    : undefined
                }
              >
                <TooltipTrigger asChild>
                  <button
                    data-testid="dispatch-stop-block"
                    data-stop-id={stop.stopId}
                    className={STOP_HIT_TARGET_CLASS}
                    style={{
                      left: x - (blockW < 44 ? (44 - blockW) / 2 : 0),
                      width: Math.max(44, blockW),
                      top: rowHeight / 2 - 22,
                      zIndex: dockDistance <= 2 ? 30 - dockDistance : 10,
                    }}
                    onClick={(e) => {
                      onSuppressTooltip(stop.stopId);
                      onStopClick(stop.stopId, rowIdx, row.routeId, e);
                    }}
                    onMouseEnter={() => {
                      setDockHoveredStopId(stop.stopId);
                      onHoverStop?.(stop.stopId);
                    }}
                    onMouseLeave={() => {
                      setDockHoveredStopId(null);
                      onHoverStop?.(null);
                      if (suppressedTooltipStopId === stop.stopId) {
                        onSuppressTooltip(null);
                      }
                    }}
                    onFocus={() => {
                      setDockHoveredStopId(stop.stopId);
                      onHoverStop?.(stop.stopId);
                    }}
                    onBlur={() => {
                      setDockHoveredStopId(null);
                      onHoverStop?.(null);
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        startDrag(stop.stopId, row.routeId, {
                          clientX: e.clientX,
                          clientY: e.clientY,
                        });
                      }
                    }}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (touch) {
                        startDrag(stop.stopId, row.routeId, {
                          clientX: touch.clientX,
                          clientY: touch.clientY,
                        });
                      }
                    }}
                    aria-label={`#${stop.sequenceOrder} ${stop.customerName || stop.address}`}
                  >
                    <div
                      className={cn(
                        STOP_VISIBLE_MARKER_HIT_CLASS, "flex items-center justify-center text-[10px] font-extrabold font-mono tabular-nums transition-[transform,filter,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none group-hover:z-20 border rounded-[3px]",
                        isSelected && "outline outline-2 outline-offset-1 outline-foreground z-20 !opacity-100",
                          isMultiSelected && !isSelected && "outline outline-2 outline-offset-1 outline-primary z-20 !opacity-100",
                          isCompleted
                              ? STOP_COMPLETED_CLASS
                              : isFailed
                                ? STOP_FAILED_CLASS
                                : "text-white group-hover:brightness-110 group-hover:shadow-md",
                        isForcedOutsideWorkingHours && !isCompleted && !isFailed && STOP_WARNING_EDGE_CLASS,
                        isHovered && !isSelected && !isMultiSelected && "outline outline-1 outline-offset-1 outline-primary/70 z-20",
                      )}
                      style={{
                        width: showStopLabel ? Math.max(blockW, 24) : blockW,
                        height: 24,
                        transform: `scale(${dockScale * STOP_TILE_SCALE})`,
                        transformOrigin: "50% 100%",
                        ...stopMarkerStyle(row.color, isCompleted, isFailed, isForcedOutsideWorkingHours, stop.status === "skipped"),
                      }}
                    >
                      {stop.assignmentOverrideAt && (
                        <span
                          data-testid={isForcedOutsideWorkingHours ? "working-hours-override-warning" : undefined}
                          className={`absolute -right-1 -top-1 z-20 rounded-full p-0.5 text-white shadow ${
                            isForcedOutsideWorkingHours ? "bg-red-600" : "bg-amber-500"
                          }`}
                          title={
                            isForcedOutsideWorkingHours
                              ? t("dispatch.reasonWorkingHours")
                              : t("dispatch.forcedAssignmentMarker")
                          }
                        >
                          <AlertTriangle className="h-2 w-2" />
                        </span>
                      )}
                      {showStopLabel && <span data-testid="dispatch-stop-sequence">{stop.sequenceOrder ?? idx + 1}</span>}
                      <CompletionMarker stop={stop} />
                      {(isSlaRisk || isForcedOutsideWorkingHours) && !isCompleted && !isFailed && !stop.assignmentOverrideAt && (
                         <div className="absolute -top-1 -right-1 z-20 w-2 h-2 rounded-full bg-destructive border border-background shadow-sm" />
                      )}
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="center"
                  sideOffset={8}
                  collisionPadding={12}
                  className="max-w-[240px]"
                >
                  <p className="font-bold text-xs">
                    #{stop.sequenceOrder} {stop.customerName || stop.address}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {formatTime(stop.arrivalTime)} – {formatTime(stop.departureTime)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {(stop.distanceFromPrevKm ?? 0).toFixed(1)} km ·{" "}
                    {Math.round(stop.travelTimeMin ?? 0)} min · {stop.serviceDurationMin} min service
                  </p>
                  <p className="gantt-interaction-hint text-[10px] text-primary mt-1">
                    {selectedStopIds.size > 0
                      ? "Shift+klick för fler · Dra för att flytta"
                      : "Dra för att flytta · Shift+klick för fler"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })
      )}
    </div>
  );
}
function GanttRow({
  row,
  rowIdx,
  gridWidth,
  hours,
  timeToX,
  selectedStopId,
  selectedStopIds,
  onStopClick,
  startDrag,
  isDimmed,
  isHighlighted,
  isDropTarget,
  dropTargetIndex,
  dragCount = 0,
  isDragging,
  rowHeight,
  hoveredStopId,
  onHoverStop,
  suppressedTooltipStopId,
  onSuppressTooltip,
  showActualTimes = false,
  startHour,
  endHour,
}: {
  row: ScheduledRow;
  rowIdx: number;
  gridWidth: number;
  hours: number[];
  timeToX: (d: Date | undefined) => number;
  selectedStopId: string | null;
  selectedStopIds: Set<string>;
  onStopClick: (stopId: string, rowIdx: number, routeId: string, e: React.MouseEvent) => void;
  startDrag: (
    stopId: string,
    sourceRouteId: string,
    pointerDown: DispatchDragPointer,
  ) => void;
  isDimmed: boolean;
  isHighlighted: boolean;
  isDropTarget: boolean;
  dropTargetIndex: number | null;
  dragCount?: number;
  isDragging: boolean;
  rowHeight: number;
  hoveredStopId: string | null;
  onHoverStop?: (stopId: string | null) => void;
  suppressedTooltipStopId: string | null;
  onSuppressTooltip: (stopId: string | null) => void;
  showActualTimes?: boolean;
  startHour: number;
  endHour: number;
}) {
  const { t } = useTranslation();
  const [dockHoveredStopId, setDockHoveredStopId] = useState<string | null>(null);
  const isRouteHovered = hoveredStopId === `route:${row.routeId}`;
  const stopIndexById = useMemo(
    () => new Map(row.stops.map((stop, index) => [stop.stopId, index])),
    [row.stops],
  );
  const dockHoveredIndex = dockHoveredStopId
    ? (stopIndexById.get(dockHoveredStopId) ?? -1)
    : -1;
  // Stable footprint: hover and selection are shown by outline only. No dock
  // magnification of the hovered stop or its neighbours.
  const getDockScale = (_stopId: string, _selected: boolean, _multiSelected: boolean) => 1;
  const timingIsAuthoritative = rowHasAuthoritativeTiming(row);
  const routeStartTime = timingIsAuthoritative && row.timeline?.[0]
    ? new Date(row.timeline[0].startAt)
    : undefined;
  const routeEndTime = timingIsAuthoritative && row.timeline?.at(-1)
    ? new Date(row.timeline.at(-1)!.endAt)
    : undefined;
  const shiftEndTime = timingIsAuthoritative && row.summary
    ? new Date(row.summary.shiftEndAt)
    : undefined;
  const rawRouteStart = routeStartTime ? timeToX(routeStartTime) : 0;
  const rawRouteEnd = routeEndTime ? timeToX(routeEndTime) : 0;
  const clampToGrid = (value: number) => Math.max(0, Math.min(gridWidth, value));
  const routeCrossesMidnight =
    routeStartTime !== undefined &&
    routeEndTime !== undefined &&
    routeEndTime.getTime() > routeStartTime.getTime() &&
    rawRouteEnd < rawRouteStart;
  const routeSpans = routeCrossesMidnight
    ? [
        {
          start: clampToGrid(rawRouteStart),
          end: gridWidth,
        },
        {
          start: 0,
          end: clampToGrid(rawRouteEnd),
        },
      ]
    : [
        {
          start: clampToGrid(Math.min(rawRouteStart, rawRouteEnd)),
          end: clampToGrid(Math.max(rawRouteStart, rawRouteEnd)),
        },
      ];
  const routeMarkerX = clampToGrid(rawRouteStart);
  const shiftEndX = shiftEndTime ? clampToGrid(timeToX(shiftEndTime)) : null;
  const remainingStops = row.stops.filter((stop) => !selectedStopIds.has(stop.stopId));
  const metadataSlotWidth = gridWidth / Math.max(remainingStops.length + 1, 1);
  const insertionX = (() => {
    if (dropTargetIndex == null) return null;
    if (!timingIsAuthoritative) {
      const index = Math.max(0, Math.min(dropTargetIndex, remainingStops.length));
      return clampToGrid((index + 0.5) * metadataSlotWidth);
    }
    if (dropTargetIndex <= 0) {
      const firstArrival = remainingStops[0]?.arrivalTime;
      return clampToGrid((firstArrival ? timeToX(firstArrival) : 8) - 8);
    }
    if (dropTargetIndex >= remainingStops.length) {
      const lastDeparture = remainingStops.at(-1)?.departureTime;
      return clampToGrid((lastDeparture ? timeToX(lastDeparture) : 8) + 8);
    }
    const previousDeparture = remainingStops[dropTargetIndex - 1]?.departureTime;
    const nextArrival = remainingStops[dropTargetIndex]?.arrivalTime;
    if (!previousDeparture || !nextArrival) return null;
    return clampToGrid(
      (timeToX(previousDeparture) + timeToX(nextArrival)) / 2,
    );
  })();
  const missingEvidenceInsertionX = (() => {
    if (dropTargetIndex == null || timingIsAuthoritative) return null;
    const visualStops = row.stops;
    const targetStops = visualStops.filter(
      (stop) => !selectedStopIds.has(stop.stopId),
    );
    const targetStop = targetStops[dropTargetIndex];
    const visualWidth = (stop: ScheduledStop) =>
      missingEvidenceStopWidth(stop) + 10;
    const totalWidth =
      visualStops.reduce((total, stop) => total + visualWidth(stop), 0) +
      Math.max(0, visualStops.length - 1) * 4;
    const laneStart = Math.max(0, gridWidth - 12 - totalWidth);
    if (!targetStop) return clampToGrid(laneStart + totalWidth);
    const targetVisualIndex = visualStops.findIndex(
      (stop) => stop.stopId === targetStop.stopId,
    );
    const precedingWidth = visualStops
      .slice(0, targetVisualIndex)
      .reduce((total, stop) => total + visualWidth(stop) + 4, 0);
    return clampToGrid(laneStart + precedingWidth);
  })();
  const dropInsertionX = insertionX ?? missingEvidenceInsertionX;
  return (
    <div
      data-testid="dispatch-timeline-row"
      data-timeline-route-id={row.routeId}
      data-drop-route-id={row.routeId}
      className={cn(
        "relative border-b border-border transition-all group",
        rowIdx % 2 === 1 && "bg-muted/40",
        isDimmed && "opacity-55",
        isHighlighted && "bg-primary/10",
        isDropTarget && "bg-primary/20 ring-2 ring-inset ring-primary",
        isDragging && !isDropTarget && "hover:bg-primary/10",
      )}
      style={{ height: rowHeight, width: gridWidth }}
    >
      {hours.map((h) => (
        <div
          key={h}
          className="absolute top-0 bottom-0 border-l border-border/60"
          style={{ left: ((h - hours[0]) / (hours.length - 1)) * gridWidth }}
        />
      ))}

      {routeStartTime && routeEndTime && (
        <>
          {routeSpans.map((span, index) => {
            const spanWidth = Math.max(0, span.end - span.start);
            if (spanWidth === 0) return null;
            return (
              <div
                key={`${row.routeId}-span-${index}`}
                data-testid="dispatch-route-span"
                className="absolute pointer-events-none z-[1] rounded-full shadow-sm"
                style={{
                  left: span.start,
                  width: spanWidth,
                  top: rowHeight / 2 - 1,
                  height: ROUTE_LINE_HEIGHT,
                  backgroundColor: row.color,
                  opacity: ROUTE_LINE_OPACITY,
                }}
              />
            );
          })}
          {routeMarkerX >= 12 && routeMarkerX < gridWidth && (
            <div
              className="absolute z-[2] flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border-2 border-background shadow-sm"
              style={{
                left: routeMarkerX - 12,
                top: rowHeight / 2 - 10,
                backgroundColor: row.color,
              }}
              title={t("dispatch.routeStarts", {
                time: formatTime(routeStartTime),
              })}
            >
              <Truck className="h-2.5 w-2.5 text-white" />
            </div>
          )}
        </>
      )}
      {shiftEndX !== null && (
        <div
          className="absolute inset-y-1 z-[2] border-l border-dashed border-foreground/30 pointer-events-none"
          style={{ left: shiftEndX }}
          title={t("dispatch.shiftEnd", { time: formatTime(shiftEndTime) })}
        />
      )}

      {isDropTarget && (
        <DropInsertionMarker
          x={dropInsertionX}
          index={dropTargetIndex}
          remainingStops={remainingStops}
          gridWidth={gridWidth}
          routeName={row.routeName}
          dragCount={dragCount}
          compact={rowHeight < 36}
        />
      )}

      {timingIsAuthoritative && row.timeline ? (
        row.timeline.map((item, idx) => {
          const start = new Date(item.startAt);
          const end = new Date(item.endAt);
          const x = timeToX(start);
          const w = timeToX(end) - x;

          if (item.type === "service" && item.stopId) {
            const stop = row.stops.find((s) => s.stopId === item.stopId);
            if (!stop) return null;
            const blockW = Math.max(w, 12);
            const isSelected = stop.stopId === selectedStopId;
            const isMultiSelected = selectedStopIds.has(stop.stopId);
            const isHovered = hoveredStopId === stop.stopId || isRouteHovered;
            const dockScale = getDockScale(stop.stopId, isSelected, isMultiSelected);
            const showStopLabel = stopLabelVisible(blockW);
            const dockDistance = dockHoveredIndex < 0
              ? Number.POSITIVE_INFINITY
              : Math.abs((stopIndexById.get(stop.stopId) ?? -1) - dockHoveredIndex);
            const visualStatus = getStopVisualStatus(stop);
            const isCompleted = visualStatus === "completed";
            const isFailed = visualStatus === "failed";
            const isSlaRisk = visualStatus === "sla_risk";
            const isForcedOutsideWorkingHours = stop.assignmentOverrideReasonCodes?.includes("WORKING_HOURS") ?? false;
            const stopFill = isCompleted ? "#10b981" : isFailed ? "#ef4444" : row.color;

            return (
              <div key={`timeline-${idx}-${item.stopId}`}>
                <Tooltip open={isSelected || isMultiSelected || suppressedTooltipStopId === stop.stopId ? false : undefined}>
                  <TooltipTrigger asChild>
                    <button
                      data-testid="dispatch-stop-block"
                      data-stop-id={stop.stopId}
                      className={STOP_HIT_TARGET_CLASS}
                      style={{
                        left: x - (blockW < 44 ? (44 - blockW) / 2 : 0),
                        width: Math.max(44, blockW),
                        top: rowHeight / 2 - 22,
                        zIndex: dockDistance <= 2 ? 30 - dockDistance : 10,
                      }}
                      onClick={(e) => {
                        onSuppressTooltip(stop.stopId);
                        onStopClick(stop.stopId, rowIdx, row.routeId, e);
                      }}
                      onMouseEnter={() => {
                        setDockHoveredStopId(stop.stopId);
                        onHoverStop?.(stop.stopId);
                      }}
                      onMouseLeave={() => {
                        setDockHoveredStopId(null);
                        onHoverStop?.(null);
                        if (suppressedTooltipStopId === stop.stopId) onSuppressTooltip(null);
                      }}
                      onFocus={() => {
                        setDockHoveredStopId(stop.stopId);
                        onHoverStop?.(stop.stopId);
                      }}
                      onBlur={() => {
                        setDockHoveredStopId(null);
                        onHoverStop?.(null);
                      }}
                      onMouseDown={(e) => {
                        if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                          e.preventDefault();
                          startDrag(stop.stopId, row.routeId, {
                            clientX: e.clientX,
                            clientY: e.clientY,
                          });
                        }
                      }}
                      onTouchStart={(e) => {
                        const touch = e.touches[0];
                        if (touch) {
                          startDrag(stop.stopId, row.routeId, {
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                          });
                        }
                      }}
                      aria-label={`#${stop.sequenceOrder} ${stop.customerName || stop.address}`}
                    >
                      <div
                        className={cn(
                          STOP_VISIBLE_MARKER_HIT_CLASS, "flex items-center justify-center text-[10px] font-extrabold font-mono tabular-nums transition-[transform,filter,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none group-hover:z-20 border rounded-[3px]",
                          isSelected && "outline outline-2 outline-offset-1 outline-foreground z-20 !opacity-100",
                          isMultiSelected && !isSelected && "outline outline-2 outline-offset-1 outline-primary z-20 !opacity-100",
                          isCompleted
                                ? STOP_COMPLETED_CLASS
                                : isFailed
                                  ? STOP_FAILED_CLASS
                                  : "text-white group-hover:brightness-110 group-hover:shadow-md",
                          isForcedOutsideWorkingHours && !isCompleted && !isFailed && STOP_WARNING_EDGE_CLASS,
                          isHovered && !isSelected && !isMultiSelected && "outline outline-1 outline-offset-1 outline-primary/70 z-20",
                        )}
                        style={{
                          width: showStopLabel ? Math.max(blockW, 24) : blockW,
                          height: 24,
                          transform: `scale(${dockScale * STOP_TILE_SCALE})`,
                          transformOrigin: "50% 100%",
                          ...stopMarkerStyle(row.color, isCompleted, isFailed, isForcedOutsideWorkingHours, stop.status === "skipped"),
                        }}
                      >
                        <PriorityMarker priority={stop.priority} />
<ProofMarker proofTypes={stop.proofTypes} /><CompletionMarker stop={stop} />
                        {stop.assignmentOverrideAt && (
                          <span
                            data-testid={isForcedOutsideWorkingHours ? "working-hours-override-warning" : undefined}
                            className={`absolute -right-1 -top-1 z-20 rounded-full p-0.5 text-white shadow ${isForcedOutsideWorkingHours ? "bg-red-600" : "bg-amber-500"}`}
                            title={isForcedOutsideWorkingHours ? t("dispatch.reasonWorkingHours") : t("dispatch.forcedAssignmentMarker")}
                          >
                            <AlertTriangle className="h-2 w-2" />
                          </span>
                        )}
                        {showStopLabel && <span data-testid="dispatch-stop-sequence">{stop.sequenceOrder}</span>}
                        {(isSlaRisk || isForcedOutsideWorkingHours) && !isCompleted && !isFailed && !stop.assignmentOverrideAt && (
                           <div className="absolute -top-1 -right-1 z-20 w-2 h-2 rounded-full bg-destructive border border-background shadow-sm" />
                        )}
                      </div>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" align="center" sideOffset={8} collisionPadding={12} className="max-w-[240px]">
                    <p className="font-bold text-xs">#{stop.sequenceOrder} {stop.customerName || stop.address}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{formatTime(stop.arrivalTime)} – {formatTime(stop.departureTime)}</p>
                     <p className="text-[10px] text-muted-foreground">{(stop.distanceFromPrevKm ?? 0).toFixed(1)} km · {Math.round(stop.travelTimeMin ?? 0)} min · {stop.serviceDurationMin} min service</p>
                     {isStopPrioritized(stop.priority) && (
                       <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                         {t("dispatch.priorityMarker", {
                           level: stop.priority === 2
                             ? t("dispatch.priorityMandatory")
                             : t("dispatch.priorityHigh"),
                         })}
                       </p>
                     )}
                    <p className="gantt-interaction-hint text-[10px] text-primary mt-1">{selectedStopIds.size > 0 ? "Shift+klick för fler · Dra för att flytta" : "Dra för att flytta · Shift+klick för fler"}</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          }

          if (item.type === "driving" || item.type === "return" || item.type === "travel_reserve" || item.type === "stop_reserve") {
            if (w < 2) return null;
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center min-h-[44px]"
                    style={{
                      left: x - (w < 44 ? (44 - w) / 2 : 0),
                      width: Math.max(44, w),
                      top: rowHeight / 2 - 22,
                    }}
                  >
                    <div
                      className={cn(
                        "rounded-sm opacity-55",
                        (item.type === "travel_reserve" || item.type === "stop_reserve") && "border border-dashed opacity-70",
                      )}
                      style={{ width: w, height: TRAVEL_SEGMENT_HEIGHT, backgroundColor: row.color }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                   <p className="text-[10px] font-mono">
                     {item.type === "travel_reserve"
                       ? t("dispatch.travelReserve", { min: Math.round(item.durationMin) })
                       : item.type === "stop_reserve"
                         ? t("dispatch.stopReserve", { min: Math.round(item.durationMin) })
                         : t("dispatch.driveSegment", { min: Math.round(item.durationMin), km: item.distanceKm?.toFixed(1) || "0" })}
                   </p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "waiting") {
            if (w < 2) return null;
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center min-h-[44px]"
                    style={{
                      left: x - (w < 44 ? (44 - w) / 2 : 0),
                      width: Math.max(44, w),
                      top: rowHeight / 2 - 22,
                    }}
                  >
                    <div className="rounded-sm bg-muted-foreground/30" style={{ width: w, height: 6 }} />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">Väntetid ({Math.round(item.durationMin)} min)</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "break") {
            const blockW = Math.max(w, 8);
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center cursor-help min-h-[44px]"
                    style={{ left: x, width: blockW, top: rowHeight / 2 - 22 }}
                  >
                    <div data-testid="dispatch-break-block" className={BREAK_BLOCK_CLASS} style={{ width: blockW, height: 20 }}>
                      {blockW >= 16 && <Coffee className="h-3 w-3" aria-hidden="true" />}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">Rast ({Math.round(item.durationMin)} min)</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "charging") {
            const blockW = Math.max(w, 8);
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center cursor-help min-h-[44px]"
                    style={{ left: x, width: blockW, top: rowHeight / 2 - 22 }}
                  >
                    <div className="flex items-center justify-center rounded-sm bg-emerald-500/20 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 z-10" style={{ width: blockW, height: 20 }}>
                      {blockW >= 24 && <Zap className="h-3 w-3" />}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">Laddning ({Math.round(item.durationMin)} min)</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          if (item.type === "depot_start" || item.type === "depot_end") {
            // Match the compact row: depot markers never cover stop actions.
            return (
              <Tooltip key={`timeline-${idx}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute flex items-center justify-center z-[5]"
                    style={{ left: x - 10, width: 20, top: rowHeight / 2 - 10 }}
                  >
                    <div className="w-5 h-5 rounded-full bg-background border-2 shadow-sm flex items-center justify-center text-muted-foreground" style={{ borderColor: row.color }}>
                      <Warehouse className="w-2.5 h-2.5" />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-[10px] font-mono">{item.type === "depot_start" ? "Startdepå" : "Slutdepå"}</p>
                </TooltipContent>
              </Tooltip>
            );
          }

          return null;
        })
      ) : !timingIsAuthoritative ? (
        <div
          data-testid="dispatch-recalculation-lane"
          className="absolute inset-0 flex items-center gap-2 overflow-hidden px-3 text-[10px] text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-semibold">{t("dispatch.scheduleNeedsRecalculation")}</span>
          <span className="text-muted-foreground">
            {t("dispatch.stopCount", { count: row.stops.length })}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {row.stops.map((stop) => {
              const orderReference =
                stop.trackingCode || stop.externalRef || stop.shopifyOrderName;
              const metadataBlockWidth = missingEvidenceStopWidth(stop);
              const isForcedOutsideWorkingHours =
                stop.assignmentOverrideReasonCodes?.includes("WORKING_HOURS") ?? false;
              return (
                <Tooltip
                  key={stop.stopId}
                  open={
                    selectedStopIds.has(stop.stopId) ||
                    suppressedTooltipStopId === stop.stopId
                      ? false
                      : undefined
                  }
                >
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="dispatch-stop-block"
                      data-stop-id={stop.stopId}
                      className={cn(
                        "relative flex h-6 min-w-6 items-center justify-center rounded border px-1 font-mono text-[9px] font-bold",
                        selectedStopIds.has(stop.stopId)
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
                      )}
                      aria-label={`#${stop.sequenceOrder} ${stop.customerName || stop.address} ${stop.address}`}
                      style={stop.status === "skipped" ? stopMarkerStyle(row.color, false, false, false, true) : undefined}
                      onClick={(event) => {
                        onSuppressTooltip(stop.stopId);
                        onStopClick(stop.stopId, rowIdx, row.routeId, event);
                      }}
                      onMouseDown={(event) => {
                        if (event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                          event.preventDefault();
                          startDrag(stop.stopId, row.routeId, {
                            clientX: event.clientX,
                            clientY: event.clientY,
                          });
                        }
                      }}
                      onTouchStart={(event) => {
                        const touch = event.touches[0];
                        if (touch) {
                          startDrag(stop.stopId, row.routeId, {
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                          });
                        }
                      }}
                    >
                      <div
                        className="relative flex h-5 items-center justify-center"
                        style={{ width: metadataBlockWidth }}
                      >
                        <PriorityMarker priority={stop.priority} />
<ProofMarker proofTypes={stop.proofTypes} /><CompletionMarker stop={stop} />
                        {stop.assignmentOverrideAt && (
                          <span
                            data-testid={isForcedOutsideWorkingHours ? "working-hours-override-warning" : undefined}
                            className={`absolute -right-1 -top-1 z-20 rounded-full p-0.5 text-white shadow ${
                              isForcedOutsideWorkingHours ? "bg-red-600" : "bg-amber-500"
                            }`}
                            title={isForcedOutsideWorkingHours
                              ? t("dispatch.reasonWorkingHours")
                              : t("dispatch.forcedAssignmentMarker")}
                          >
                            <AlertTriangle className="h-2 w-2" />
                          </span>
                        )}
                        {stop.sequenceOrder}
                      </div>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="right"
                    align="center"
                    sideOffset={8}
                    collisionPadding={12}
                    className="max-w-[260px]"
                  >
                    <p className="font-bold text-xs">
                      #{stop.sequenceOrder} {stop.customerName || stop.address}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {stop.address}
                    </p>
                    {orderReference && (
                      <p className="text-[10px] text-muted-foreground">
                        {orderReference}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {stop.weightKg} kg · {stop.volumeM3} m³ ·{" "}
                      {t("dispatch.serviceTime")} {stop.serviceDurationMin} min
                    </p>
                    {isStopPrioritized(stop.priority) && (
                      <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                        {t("dispatch.priorityMarker", {
                          level: stop.priority === 2
                            ? t("dispatch.priorityMandatory")
                            : t("dispatch.priorityHigh"),
                        })}
                      </p>
                    )}
                    <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 mt-1">
                      {t("dispatch.scheduleNeedsRecalculation")}
                    </p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      ) : (
        row.stops.map((stop, idx) => {
          const x = timeToX(stop.arrivalTime);
          const w = timeToX(stop.departureTime) - x;
          const blockW = Math.max(w, 12);
          const isSelected = stop.stopId === selectedStopId;
          const isMultiSelected = selectedStopIds.has(stop.stopId);
          const isHovered = hoveredStopId === stop.stopId || isRouteHovered;
          const dockScale = getDockScale(stop.stopId, isSelected, isMultiSelected);
          const showStopLabel = stopLabelVisible(blockW);
          const dockDistance = dockHoveredIndex < 0
            ? Number.POSITIVE_INFINITY
            : Math.abs(idx - dockHoveredIndex);

          const visualStatus = getStopVisualStatus(stop);
          const isCompleted = visualStatus === "completed";
          const isFailed = visualStatus === "failed";
          const isSlaRisk = visualStatus === "sla_risk";
          const isForcedOutsideWorkingHours =
            stop.assignmentOverrideReasonCodes?.includes("WORKING_HOURS") ?? false;

          const stopFill = isCompleted
            ? "#10b981"
            : isFailed
              ? "#ef4444"
              : row.color;

          const prevStop: ScheduledStop | undefined = row.stops[idx - 1];
          let driveX = 0;
          let driveW = 0;
          if (prevStop) {
            driveX = timeToX(prevStop.departureTime);
            driveW = x - driveX;
          }

          return (
            <div key={stop.stopId}>
              {prevStop && driveW > 2 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="absolute flex items-center justify-center cursor-pointer min-h-[44px]"
                      style={{
                        left: driveX - (driveW < 44 ? (44 - driveW) / 2 : 0),
                        width: Math.max(44, driveW),
                        top: rowHeight / 2 - 22,
                      }}
                      aria-label={t("dispatch.driveSegment", {
                        min: Math.round(stop.travelTimeMin ?? 0),
                        km: (stop.distanceFromPrevKm ?? 0).toFixed(1),
                      })}
                    >
                      <div
                        className="rounded-sm opacity-55 hover:opacity-80 transition-opacity"
                        style={{ width: driveW, height: TRAVEL_SEGMENT_HEIGHT, backgroundColor: stopFill }}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-[10px] font-mono">
                      {t("dispatch.driveSegment", {
                        min: Math.round(stop.travelTimeMin ?? 0),
                        km: (stop.distanceFromPrevKm ?? 0).toFixed(1),
                      })}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip
                open={
                  isSelected ||
                  isMultiSelected ||
                  suppressedTooltipStopId === stop.stopId
                    ? false
                    : undefined
                }
              >
                <TooltipTrigger asChild>
                  <button
                    data-testid="dispatch-stop-block"
                    data-stop-id={stop.stopId}
                    className={STOP_HIT_TARGET_CLASS}
                    style={{
                      left: x - (blockW < 44 ? (44 - blockW) / 2 : 0),
                      width: Math.max(44, blockW),
                      top: rowHeight / 2 - 22,
                      zIndex: dockDistance <= 2 ? 30 - dockDistance : 10,
                    }}
                    onClick={(e) => {
                      onSuppressTooltip(stop.stopId);
                      onStopClick(stop.stopId, rowIdx, row.routeId, e);
                    }}
                    onMouseEnter={() => {
                      setDockHoveredStopId(stop.stopId);
                      onHoverStop?.(stop.stopId);
                    }}
                    onMouseLeave={() => {
                      setDockHoveredStopId(null);
                      onHoverStop?.(null);
                      if (suppressedTooltipStopId === stop.stopId) {
                        onSuppressTooltip(null);
                      }
                    }}
                    onFocus={() => {
                      setDockHoveredStopId(stop.stopId);
                      onHoverStop?.(stop.stopId);
                    }}
                    onBlur={() => {
                      setDockHoveredStopId(null);
                      onHoverStop?.(null);
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        startDrag(stop.stopId, row.routeId, {
                          clientX: e.clientX,
                          clientY: e.clientY,
                        });
                      }
                    }}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (touch) {
                        startDrag(stop.stopId, row.routeId, {
                          clientX: touch.clientX,
                          clientY: touch.clientY,
                        });
                      }
                    }}
                    aria-label={`#${stop.sequenceOrder} ${stop.customerName || stop.address}`}
                  >
                    <div
                      className={cn(
                        STOP_VISIBLE_MARKER_HIT_CLASS, "flex items-center justify-center text-[10px] font-extrabold font-mono tabular-nums transition-[transform,filter,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none group-hover:z-20 border rounded-[3px]",
                        isSelected && "outline outline-2 outline-offset-1 outline-foreground z-20 !opacity-100",
                          isMultiSelected && !isSelected && "outline outline-2 outline-offset-1 outline-primary z-20 !opacity-100",
                          isCompleted
                              ? STOP_COMPLETED_CLASS
                              : isFailed
                                ? STOP_FAILED_CLASS
                                : "text-white group-hover:brightness-110 group-hover:shadow-md",
                        isForcedOutsideWorkingHours && !isCompleted && !isFailed && STOP_WARNING_EDGE_CLASS,
                        isHovered && !isSelected && !isMultiSelected && "outline outline-1 outline-offset-1 outline-primary/70 z-20",
                      )}
                      style={{
                        width: showStopLabel ? Math.max(blockW, 24) : blockW,
                        height: 24,
                        transform: `scale(${dockScale * STOP_TILE_SCALE})`,
                        transformOrigin: "50% 100%",
                        ...stopMarkerStyle(row.color, isCompleted, isFailed, isForcedOutsideWorkingHours, stop.status === "skipped"),
                      }}
                    >
                       <PriorityMarker priority={stop.priority} />
<ProofMarker proofTypes={stop.proofTypes} /><CompletionMarker stop={stop} />
                      {stop.assignmentOverrideAt && (
                        <span
                          data-testid={isForcedOutsideWorkingHours ? "working-hours-override-warning" : undefined}
                          className={`absolute -right-1 -top-1 z-20 rounded-full p-0.5 text-white shadow ${
                            isForcedOutsideWorkingHours ? "bg-red-600" : "bg-amber-500"
                          }`}
                          title={
                            isForcedOutsideWorkingHours
                              ? t("dispatch.reasonWorkingHours")
                              : t("dispatch.forcedAssignmentMarker")
                          }
                        >
                          <AlertTriangle className="h-2 w-2" />
                        </span>
                      )}
                      {showStopLabel && <span data-testid="dispatch-stop-sequence">{stop.sequenceOrder ?? idx + 1}</span>}
                      {(isSlaRisk || isForcedOutsideWorkingHours) && !isCompleted && !isFailed && !stop.assignmentOverrideAt && (
                         <div className="absolute -top-1 -right-1 z-20 w-2 h-2 rounded-full bg-destructive border border-background shadow-sm" />
                      )}
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="center"
                  sideOffset={8}
                  collisionPadding={12}
                  className="max-w-[240px]"
                >
                  <p className="font-bold text-xs">
                    #{stop.sequenceOrder} {stop.customerName || stop.address}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {formatTime(stop.arrivalTime)} – {formatTime(stop.departureTime)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {(stop.distanceFromPrevKm ?? 0).toFixed(1)} km ·{" "}
                    {Math.round(stop.travelTimeMin ?? 0)} min · {stop.serviceDurationMin} min service
                  </p>
                  {isStopPrioritized(stop.priority) && (
                    <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                      {t("dispatch.priorityMarker", {
                        level: stop.priority === 2
                          ? t("dispatch.priorityMandatory")
                          : t("dispatch.priorityHigh"),
                      })}
                    </p>
                  )}
                  <p className="gantt-interaction-hint text-[10px] text-primary mt-1">
                    {selectedStopIds.size > 0
                      ? "Shift+klick för fler · Dra för att flytta"
                      : "Dra för att flytta · Shift+klick för fler"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })
      )}
      {showActualTimes && <ActualTerminalLane row={row} rowIdx={rowIdx} startHour={startHour} endHour={endHour} gridWidth={gridWidth} selectedStopId={selectedStopId} onStopClick={onStopClick} />}
    </div>
  );
}

const ACTUAL_KIND_CLASS: Record<ActualMark["kind"], string> = {
  completed: "bg-emerald-700 text-white",
  failed: "bg-destructive text-destructive-foreground",
  skipped: "bg-violet-600 text-white",
};

/**
 * Separate live lane for reported terminal times (Stockholm). Plan tiles are
 * untouched; marks are never arrival times and pending stops get no mark.
 */
function ActualTerminalLane({ row, rowIdx, startHour, endHour, gridWidth, selectedStopId, onStopClick }: {
  row: ScheduledRow;
  rowIdx: number;
  startHour: number;
  endHour: number;
  gridWidth: number;
  selectedStopId: string | null;
  onStopClick: (stopId: string, rowIdx: number, routeId: string, e: React.MouseEvent) => void;
}) {
  const marks = useMemo(() => buildActualMarks(row.stops, row.routeDate, {
    startHour, endHour, width: gridWidth,
  }), [row.stops, row.routeDate, startHour, endHour, gridWidth]);
  const shownLabels = useMemo(() => compactActualLabels(marks), [marks]);
  if (marks.length === 0) return null;
  const inGrid = marks.filter((m) => m.placement === "in_grid");
  const edge = (side: "left" | "right") => {
    const list = marks.filter((m) => side === "left"
      ? m.placement === "before_grid" || m.placement === "invalid_time"
      : m.placement === "after_grid");
    if (list.length === 0) return null;
    const first = list[0];
    const text = list.length === 1 ? first.label : `${list.length} Fakt. utanför`;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-no-lasso data-testid={`actual-edge-${side}-${row.routeId}`}
            aria-label={`Faktiska tider utanför tidsaxeln: ${list.map((m) => m.description).join("; ")}`}
            onMouseDown={(e) => e.stopPropagation()}
            className={cn("pointer-events-auto absolute bottom-0 flex h-[14px] items-center gap-0.5 rounded-sm border border-dashed border-foreground/50 bg-background/95 px-1 font-mono text-[10px] font-semibold leading-none text-foreground/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
              side === "left" ? "left-0.5" : "right-0.5")}>
            {side === "left" ? "\u2190 " : ""}{text}{side === "right" ? " \u2192" : ""}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={side === "left" ? "start" : "end"} className="max-w-[300px]">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Faktiska rapporter (Stockholm)</p>
          {list.map((m) => (
            <DropdownMenuItem key={m.stopId} data-testid={`actual-edge-item-${m.stopId}`}
              onSelect={() => onStopClick(m.stopId, rowIdx, row.routeId, { shiftKey: false, metaKey: false, ctrlKey: false } as React.MouseEvent)}
              className="flex items-center gap-2 text-xs">
              <span className={cn("h-2 w-2 shrink-0 rounded-[1px]", ACTUAL_KIND_CLASS[m.kind])} />
              <span className="font-mono">{m.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };
  return (
    <div data-testid={`actual-lane-${row.routeId}`} aria-label="Faktiska rapporterade tider" className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-[14px]">
      {inGrid.map((m) => {
        const selected = selectedStopId === m.stopId;
        const showLabel = shownLabels.has(m.stopId) || selected;
        return (
          <button key={m.stopId} type="button" data-no-lasso
            data-testid={`actual-mark-${m.stopId}`} data-actual-kind={m.kind}
            title={m.description} aria-label={m.description}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onStopClick(m.stopId, rowIdx, row.routeId, e); }}
            className="pointer-events-auto absolute bottom-0 flex h-[14px] -translate-x-1/2 items-end"
            style={{ left: m.x ?? 0 }}>
            {showLabel ? (
              <span className={cn("rounded-[2px] px-[3px] whitespace-nowrap font-mono text-[10px] font-bold leading-[14px] tabular-nums", ACTUAL_KIND_CLASS[m.kind], selected && "ring-1 ring-foreground")}>
                {m.label}
              </span>
            ) : (
              <span className={cn("block h-[8px] w-[3px] rounded-[1px]", ACTUAL_KIND_CLASS[m.kind])} />
            )}
          </button>
        );
      })}
      {edge("left")}
      {edge("right")}
    </div>
  );
}
