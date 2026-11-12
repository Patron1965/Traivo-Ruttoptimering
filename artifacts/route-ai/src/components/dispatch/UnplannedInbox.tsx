import { useState, useMemo, forwardRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  Package,
  Search,
  Clock,
  GripVertical,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ArrowUpDown,
  AlertTriangle,
  Layers3,
} from "lucide-react";
import type { Stop } from "@workspace/api-client-react";
import { extractPostcodePrefix } from "@/lib/dispatch-status";
import type { DispatchDragPointer } from "@/lib/dispatch-drag";
import { getUnplannedReasonEvidence } from "@/lib/unplanned-reasons";

type DensityMode = "compact" | "comfortable" | "spacious";

interface UnplannedInboxProps {
  stops: Stop[];
  selectedStopIds: Set<string>;
  setSelectedStopIds: (next: Set<string>) => void;
  startDrag: (
    stopId: string,
    sourceRouteId: string,
    pointerDown: DispatchDragPointer,
  ) => void;
  dropTargetRouteId: string | null;
  isDragging: boolean;
  onFocusStop: (stopId: string) => void;
  onHoverStop?: (stopId: string | null) => void;
  density?: DensityMode;
  lastImportAt?: string | null;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  diagnostics?: ReadonlyMap<string, string>;
}

type SortMode = "tw" | "postcode" | "newest";

function formatTimeWindow(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return end ? `${fmt(start)}–${fmt(end)}` : `${fmt(start)}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function densityPx(density: DensityMode): { row: number; pyClass: string } {
  switch (density) {
    case "compact":
      return { row: 28, pyClass: "py-0.5" };
    case "spacious":
      return { row: 56, pyClass: "py-2.5" };
    default:
      return { row: 40, pyClass: "py-1.5" };
  }
}

function hasGeocodeError(stop: Stop) {
  const valid = (lat: number | null | undefined, lon: number | null | undefined) =>
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat ?? 0) <= 90 && Math.abs(lon ?? 0) <= 180;
  return !stop.address?.trim()
    || !valid(stop.latitude, stop.longitude)
    || Boolean(stop.pickupAddress && !valid(stop.pickupLatitude, stop.pickupLongitude));
}

export const UnplannedInbox = forwardRef<HTMLDivElement, UnplannedInboxProps>(
  function UnplannedInbox(
    {
      stops,
      selectedStopIds,
      setSelectedStopIds,
      startDrag,
      dropTargetRouteId,
      isDragging,
      onFocusStop,
      onHoverStop,
      density = "comfortable",
      lastImportAt,
      searchInputRef,
      diagnostics,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const [search, setSearch] = useState("");
    const [sortMode, setSortMode] = useState<SortMode>("tw");
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

    const filtered = useMemo(() => {
      if (!search.trim()) return stops;
      const q = search.toLowerCase();
      return stops.filter(
        (s) =>
          s.address?.toLowerCase().includes(q) ||
          s.trackingCode?.toLowerCase().includes(q),
      );
    }, [stops, search]);

    const sorted = useMemo(() => {
      const arr = [...filtered];
      if (sortMode === "tw") {
        arr.sort((a, b) => {
          const aStart = a.timeWindowStart ? new Date(a.timeWindowStart).getTime() : Number.MAX_SAFE_INTEGER;
          const bStart = b.timeWindowStart ? new Date(b.timeWindowStart).getTime() : Number.MAX_SAFE_INTEGER;
          return aStart - bStart;
        });
      } else if (sortMode === "postcode") {
        arr.sort((a, b) => extractPostcodePrefix(a.address).localeCompare(extractPostcodePrefix(b.address)));
      } else if (sortMode === "newest") {
        arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }
      return arr;
    }, [filtered, sortMode]);

    const groups = useMemo(() => {
      if (sortMode !== "postcode") return [{ prefix: null as string | null, stops: sorted }];
      const map = new Map<string, Stop[]>();
      for (const s of sorted) {
        const prefix = extractPostcodePrefix(s.address);
        const arr = map.get(prefix) ?? [];
        arr.push(s);
        map.set(prefix, arr);
      }
      return Array.from(map.entries()).map(([prefix, stops]) => ({ prefix, stops }));
    }, [sorted, sortMode]);

    const isDropHere = dropTargetRouteId === "unplanned";
    const { row: rowPx, pyClass } = densityPx(density);

    const toggleGroup = (prefix: string) => {
      const next = new Set(collapsed);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      setCollapsed(next);
    };

    const toggleSelection = (id: string) => {
      const next = new Set(selectedStopIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedStopIds(next);
    };

    return (
      <div
        ref={ref}
        data-drop-route-id="unplanned"
        className={cn(
          "w-full min-w-0 min-h-0 flex flex-col overflow-hidden border-r border-border bg-card text-card-foreground transition-colors",
          isDropHere && "ring-2 ring-inset ring-destructive",
        )}
      >
        <div className="shrink-0 px-3 py-3 border-b border-border bg-card">
          <div className="flex items-center gap-2 mb-2">
            <div className="relative">
              <Package className="h-4 w-4 text-destructive" />
              {stops.length > 0 && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-destructive rounded-full animate-pulse" />
              )}
            </div>
            <h2 className="text-sm font-bold flex-1">{t("dispatch.unplannedStops")}</h2>
            <span
              className={cn(
                "text-xs font-bold px-2 py-0.5 rounded-full tabular-nums",
                stops.length > 0
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {stops.length}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("dispatch.searchPlaceholder", "Sök adress… ( / )")}
                className="w-full h-7 pl-7 pr-2 text-xs bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="relative">
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="appearance-none h-7 pl-6 pr-5 text-[10px] font-semibold bg-background border border-border rounded-md cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
                aria-label={t("dispatch.sortBy")}
                title={t("dispatch.sortBy")}
              >
                <option value="tw">{t("dispatch.sortTw")}</option>
                <option value="postcode">{t("dispatch.sortPostcode")}</option>
                <option value="newest">{t("dispatch.sortNewest")}</option>
              </select>
              <ArrowUpDown className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            </div>
          </div>
          {isDragging && (
            <p className="text-[10px] text-muted-foreground mt-1.5 italic">
              {t("dispatch.unplannedHint")}
            </p>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center">
              {stops.length === 0 ? (
                <>
                  <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center mb-2">
                    <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                  </div>
                  <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    {t("dispatch.allPlanned")}
                  </p>
                  {lastImportAt && (
                    <p className="text-[10px] text-muted-foreground/70 mt-1">
                      {t("dispatch.lastImport", { when: formatDateTime(lastImportAt) })}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{t("common.noResults", "Inga träffar")}</p>
              )}
            </div>
          ) : (
            <ul className="py-1">
              {groups.map((group) => {
                const isCollapsed = group.prefix !== null && collapsed.has(group.prefix);
                return (
                  <li key={group.prefix ?? "all"}>
                    {group.prefix !== null && (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.prefix!)}
                        className="w-full flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-muted/40 cursor-pointer"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        <span>{group.prefix}</span>
                        <span className="text-muted-foreground/60 ml-1">({group.stops.length})</span>
                      </button>
                    )}
                    {!isCollapsed && (
                      <ul>
                        {group.stops.map((stop) => {
                          const isSelected = selectedStopIds.has(stop.id);
                          const tw = formatTimeWindow(
                            stop.timeWindowStart ?? null,
                            stop.timeWindowEnd ?? null,
                          );
                          const twShort = stop.timeWindowStart
                            ? new Date(stop.timeWindowStart).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : null;
                          const reasonEvidence = getUnplannedReasonEvidence(
                            stop,
                            new Date(),
                          );
                          const reason = reasonEvidence.kind === "stored"
                            ? reasonEvidence.value
                            : reasonEvidence.kind === "invalid_coordinates"
                              ? t("dispatch.reasonInvalidCoordinates")
                              : reasonEvidence.kind === "expired_time_window"
                                ? t("dispatch.reasonTimeWindow")
                                : t("dispatch.reasonEvidenceMissing");
                          return (
                            <li
                              key={stop.id}
                              role="button"
                              tabIndex={0}
                              aria-pressed={isSelected}
                              style={{ minHeight: rowPx }}
                              className={cn(
                                "group mx-1.5 my-0.5 px-2 rounded-md cursor-grab active:cursor-grabbing border border-transparent transition-all select-none touch-none",
                                pyClass,
                                "hover:bg-muted/60 hover:border-border focus:outline-none focus:ring-1 focus:ring-primary",
                                isSelected &&
                                  "bg-primary/10 border-primary/40 hover:bg-primary/15",
                              )}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                if (e.shiftKey || e.metaKey || e.ctrlKey) return;
                                e.preventDefault();
                                startDrag(stop.id, "unplanned", {
                                  clientX: e.clientX,
                                  clientY: e.clientY,
                                });
                              }}
                              onTouchStart={(e) => {
                                const touch = e.touches[0];
                                if (touch) {
                                  startDrag(stop.id, "unplanned", {
                                    clientX: touch.clientX,
                                    clientY: touch.clientY,
                                  });
                                }
                              }}
                              onMouseEnter={() => onHoverStop?.(stop.id)}
                              onMouseLeave={() => onHoverStop?.(null)}
                              onClick={(e) => {
                                if (e.shiftKey) {
                                  toggleSelection(stop.id);
                                } else {
                                  onFocusStop(stop.id);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  onFocusStop(stop.id);
                                } else if (e.key === " ") {
                                  e.preventDefault();
                                  toggleSelection(stop.id);
                                }
                              }}
                            >
                              {density === "compact" ? (
                                <div className="flex items-center gap-1.5">
                                  <GripVertical className="h-3 w-3 text-muted-foreground/40 shrink-0 group-hover:text-muted-foreground" />
                                  {twShort ? (
                                    <span className="text-[10px] font-mono tabular-nums text-muted-foreground shrink-0 w-10">
                                      {twShort}
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-mono text-muted-foreground/40 shrink-0 w-10">
                                      —:—
                                    </span>
                                  )}
                                  <span className="text-xs font-medium truncate flex-1">
                                    {stop.address}
                                  </span>
                                   <span
                                     className="max-w-24 truncate text-[9px] font-semibold text-amber-700 dark:text-amber-300"
                                     title={`${t("dispatch.unplannedReasonLabel")}: ${reason}`}
                                   >
                                     {reason}
                                   </span>
                                  {stop.trackingCode && (
                                    <span className="text-[9px] font-mono text-muted-foreground/70 shrink-0">
                                      {stop.trackingCode.slice(-6)}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-start gap-1.5">
                                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 mt-0.5 shrink-0 group-hover:text-muted-foreground" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold leading-5 break-words">{stop.address}</p>
                                     <p className="mt-1 break-words text-xs leading-5 text-amber-800 dark:text-amber-200">
                                       {t("dispatch.unplannedReasonLabel")}: {reason}
                                     </p>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                                       <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                                         <Layers3 className="h-2.5 w-2.5" />
                                         {stop.pickupAddress ? t("stops.typePD") : t("stops.singleStop")}
                                       </span>
                                       {hasGeocodeError(stop) && (
                                         <span className="text-[9px] font-semibold text-destructive flex items-center gap-0.5">
                                           <AlertTriangle className="h-2.5 w-2.5" />
                                           {t("stops.geocodeError")}
                                         </span>
                                       )}
                                      {tw && (
                                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                                          <Clock className="h-2.5 w-2.5" />
                                          {tw}
                                        </span>
                                      )}
                                      {stop.trackingCode && (
                                        <span className="text-xs text-muted-foreground font-mono break-all">
                                          {stop.trackingCode}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  },
);
