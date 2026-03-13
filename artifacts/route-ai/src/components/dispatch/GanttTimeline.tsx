import { useRef, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Truck, User, AlertTriangle } from "lucide-react";
import type { ScheduledRow, ScheduledStop } from "@/lib/scheduling";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface GanttTimelineProps {
  rows: ScheduledRow[];
  selectedStopId: string | null;
  onSelectStop: (stopId: string, rowIndex: number) => void;
  startHour?: number;
  endHour?: number;
  zoomLevel?: number;
  highlightedRouteId?: string | null;
  onHighlightRoute?: (routeId: string) => void;
  scrollToRouteId?: string | null;
}

const BASE_HOUR_WIDTH = 120;
const ROW_HEIGHT = 44;
const HEADER_HEIGHT = 36;
const LABEL_WIDTH = 220;

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function GanttTimeline({
  rows,
  selectedStopId,
  onSelectStop,
  startHour = 6,
  endHour = 20,
  zoomLevel = 1,
  highlightedRouteId = null,
  onHighlightRoute,
  scrollToRouteId = null,
}: GanttTimelineProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const labelScrollRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollToRouteId) return;
    const rowIndex = rows.findIndex((r) => r.routeId === scrollToRouteId);
    if (rowIndex < 0) return;
    const targetTop = rowIndex * ROW_HEIGHT;
    scrollRef.current?.scrollTo({ top: targetTop, behavior: "smooth" });
    labelScrollRef.current?.scrollTo({ top: targetTop, behavior: "smooth" });
  }, [scrollToRouteId, rows]);

  const HOUR_WIDTH = BASE_HOUR_WIDTH * zoomLevel;
  const totalHours = endHour - startHour;
  const gridWidth = totalHours * HOUR_WIDTH;

  const hours = useMemo(() => {
    const arr: number[] = [];
    for (let h = startHour; h <= endHour; h++) arr.push(h);
    return arr;
  }, [startHour, endHour]);

  const timeToX = (date: Date) => {
    const h = date.getHours() + date.getMinutes() / 60;
    return ((h - startHour) / totalHours) * gridWidth;
  };

  const now = new Date();
  const nowX = timeToX(now);
  const nowVisible =
    now.getHours() >= startHour && now.getHours() < endHour;

  return (
    <div className="flex flex-col h-full bg-card/50 border-t border-border overflow-hidden">
      <div className="flex">
        <div
          className="shrink-0 border-r border-border bg-card/80 backdrop-blur-sm z-10 flex items-end px-3 pb-1"
          style={{ width: LABEL_WIDTH, height: HEADER_HEIGHT }}
        >
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {t("dispatch.drivers")}
          </span>
        </div>

        <div ref={headerScrollRef} className="overflow-hidden flex-1" style={{ height: HEADER_HEIGHT }}>
          <div className="relative flex" style={{ width: gridWidth }}>
            {hours.map((h) => (
              <div
                key={h}
                className="text-[10px] font-mono text-muted-foreground border-l border-border/40 flex items-end pb-1 pl-1"
                style={{ width: HOUR_WIDTH }}
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
            {nowVisible && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-destructive z-20"
                style={{ left: nowX }}
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          ref={labelScrollRef}
          className="shrink-0 border-r border-border bg-card/80 backdrop-blur-sm z-10 overflow-y-auto"
          style={{ width: LABEL_WIDTH }}
          onScroll={() => {
            if (scrollRef.current && labelScrollRef.current) {
              scrollRef.current.scrollTop = labelScrollRef.current.scrollTop;
            }
          }}
        >
          {rows.map((row, rowIdx) => {
            const overCap = row.capacityPercent > 100;
            const isDimmed =
              highlightedRouteId !== null &&
              highlightedRouteId !== row.routeId;
            return (
              <div
                key={row.routeId}
                className={cn(
                  "flex items-center gap-2 px-3 border-b border-border/30 transition-all cursor-pointer hover:bg-muted/40",
                  rowIdx % 2 === 1 && "bg-muted/10",
                  isDimmed && "opacity-40",
                  highlightedRouteId === row.routeId && "bg-primary/10",
                )}
                style={{ height: ROW_HEIGHT }}
                onClick={() => onHighlightRoute?.(row.routeId)}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: row.color }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold truncate flex items-center gap-1">
                    <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                    {row.driverName}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
                    <Truck className="h-3 w-3 shrink-0" />
                    {row.vehicleName}
                  </p>
                </div>
                <div
                  className={cn(
                    "text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0",
                    overCap
                      ? "bg-destructive/20 text-destructive"
                      : "bg-primary/10 text-primary",
                  )}
                >
                  {overCap && (
                    <AlertTriangle className="h-2.5 w-2.5 inline mr-0.5" />
                  )}
                  {row.capacityPercent.toFixed(0)}%
                </div>
              </div>
            );
          })}
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-auto"
          onScroll={() => {
            if (scrollRef.current) {
              if (labelScrollRef.current) {
                labelScrollRef.current.scrollTop = scrollRef.current.scrollTop;
              }
              if (headerScrollRef.current) {
                headerScrollRef.current.scrollLeft = scrollRef.current.scrollLeft;
              }
            }
          }}
        >
          <div className="relative" style={{ width: gridWidth, minHeight: "100%" }}>
            {nowVisible && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-destructive/60 z-10 pointer-events-none"
                style={{ left: nowX }}
              >
                <div className="absolute -top-0.5 -left-1 w-2.5 h-2.5 rounded-full bg-destructive" />
              </div>
            )}
            {rows.map((row, rowIdx) => (
              <GanttRow
                key={row.routeId}
                row={row}
                rowIdx={rowIdx}
                gridWidth={gridWidth}
                hours={hours}
                timeToX={timeToX}
                selectedStopId={selectedStopId}
                onSelectStop={onSelectStop}
                isDimmed={
                  highlightedRouteId !== null &&
                  highlightedRouteId !== row.routeId
                }
                isHighlighted={highlightedRouteId === row.routeId}
                onHighlightRoute={onHighlightRoute}
              />
            ))}
          </div>
        </div>
      </div>
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
  onSelectStop,
  isDimmed,
  isHighlighted,
  onHighlightRoute,
}: {
  row: ScheduledRow;
  rowIdx: number;
  gridWidth: number;
  hours: number[];
  timeToX: (d: Date) => number;
  selectedStopId: string | null;
  onSelectStop: (stopId: string, rowIndex: number) => void;
  isDimmed: boolean;
  isHighlighted: boolean;
  onHighlightRoute?: (routeId: string) => void;
}) {
  return (
    <div
      className={cn(
        "relative border-b border-border/30 transition-all group hover:bg-muted/20",
        rowIdx % 2 === 1 && "bg-muted/10",
        isDimmed && "opacity-40",
        isHighlighted && "bg-primary/5",
      )}
      style={{ height: ROW_HEIGHT, width: gridWidth }}
    >
      {hours.map((h) => (
        <div
          key={h}
          className="absolute top-0 bottom-0 border-l border-border/20"
          style={{ left: ((h - hours[0]) / (hours.length - 1)) * gridWidth }}
        />
      ))}

      {row.stops.map((stop, idx) => {
        const x = timeToX(stop.arrivalTime);
        const w = timeToX(stop.departureTime) - x;
        const blockW = Math.max(w, 24);
        const isSelected = stop.stopId === selectedStopId;

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
              <div
                className="absolute rounded-sm opacity-30"
                style={{
                  left: driveX,
                  width: driveW,
                  top: ROW_HEIGHT / 2 - 3,
                  height: 6,
                  backgroundColor: row.color,
                }}
              />
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "absolute rounded-md flex items-center justify-center text-white text-[11px] font-bold transition-all duration-150 cursor-pointer border-2 hover:scale-105 hover:z-20",
                    isSelected
                      ? "ring-2 ring-white shadow-lg shadow-black/30 scale-110 z-20 border-white"
                      : "border-transparent hover:border-white/50",
                  )}
                  style={{
                    left: x,
                    width: blockW,
                    top: ROW_HEIGHT / 2 - 12,
                    height: 24,
                    backgroundColor: row.color,
                  }}
                  onClick={() => {
                    onSelectStop(stop.stopId, rowIdx);
                    onHighlightRoute?.(row.routeId);
                  }}
                >
                  {stop.sequenceOrder}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px]">
                <p className="font-bold text-xs">
                  #{stop.sequenceOrder} {stop.customerName || stop.address}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {formatTime(stop.arrivalTime)} –{" "}
                  {formatTime(stop.departureTime)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {stop.distanceFromPrevKm.toFixed(1)} km ·{" "}
                  {Math.round(stop.travelTimeMin)} min travel ·{" "}
                  {stop.serviceDurationMin} min service
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
