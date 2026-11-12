import type { Stop } from "@workspace/api-client-react";
import { AlertTriangle, Flag, GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DispatchDragPointer } from "@/lib/dispatch-drag";
import { getUnplannedReasonEvidence } from "@/lib/unplanned-reasons";
import { DualHorizontalScroll } from "@/components/ui/dual-horizontal-scroll";
import { isStopPrioritized } from "@/lib/dispatch-search";

type Props = {
  stops: Stop[];
  selectedStopIds: Set<string>;
  selectedStopId: string | null;
  setSelectedStopIds: (ids: Set<string>) => void;
  onSelectStop: (stopId: string) => void;
  startDrag: (
    stopId: string,
    sourceRouteId: string,
    pointerDown: DispatchDragPointer,
  ) => void;
};

export function UnscheduledStopsLane({
  stops,
  selectedStopIds,
  selectedStopId,
  setSelectedStopIds,
  onSelectStop,
  startDrag,
}: Props) {
  const { t } = useTranslation();
  if (stops.length === 0) return null;

  const toggle = (id: string) => {
    const next = new Set(selectedStopIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedStopIds(next);
  };

  return (
    <section
      className="flex shrink-0 items-center border-b border-amber-300/60 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/20"
      aria-label={t("dispatch.unscheduledSection")}
      data-testid="unscheduled-stops-lane"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1" title={t("dispatch.unscheduledDescription")}>
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
          <div className="min-w-0">
            <h2 className="text-xs font-semibold">{t("dispatch.unscheduledSection")}</h2>
            <p className="sr-only">{t("dispatch.unscheduledDescription")}</p>
          </div>
        </div>
        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-bold text-amber-950 dark:bg-amber-900 dark:text-amber-100">
          {stops.length}
        </span>
      </div>
      <div className="min-w-0 flex-1 border-l border-border/50">
        <DualHorizontalScroll
        label={t("common.horizontalScroll")}
        contentProps={{ className: "flex items-center gap-2 px-3 py-2" }}
      >
        {stops.map((stop, index) => {
          const isSelected = selectedStopId === stop.id || selectedStopIds.has(stop.id);
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
          <div
            key={stop.id}
            className="group flex shrink-0 items-center"
          >
            <div className="relative">
              {isStopPrioritized(stop.priority) && (
                <span
                  data-testid="dispatch-priority-marker"
                  className={`absolute -right-1 -top-2 z-10 flex h-4 min-w-4 items-center justify-center rounded-full border border-background px-0.5 text-white shadow ${
                    stop.priority === 2 ? "bg-violet-600" : "bg-amber-600"
                  }`}
                  title={t("dispatch.priorityMarker", {
                    level: stop.priority === 2
                      ? t("dispatch.priorityMandatory")
                      : t("dispatch.priorityHigh"),
                  })}
                  aria-label={t("dispatch.priorityMarker", {
                    level: stop.priority === 2
                      ? t("dispatch.priorityMandatory")
                      : t("dispatch.priorityHigh"),
                  })}
                >
                  <Flag className="h-2.5 w-2.5" aria-hidden="true" />
                </span>
              )}
              <button
                type="button"
                data-testid="unscheduled-stop-node"
                data-stop-id={stop.id}
                onClick={(event) => {
                  if (event.shiftKey || event.metaKey || event.ctrlKey) {
                    toggle(stop.id);
                  } else {
                    onSelectStop(stop.id);
                  }
                }}
                onMouseDown={(event) => {
                  if (event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                    event.preventDefault();
                    startDrag(stop.id, "unplanned", {
                      clientX: event.clientX,
                      clientY: event.clientY,
                    });
                  }
                }}
                onTouchStart={(event) => {
                  const touch = event.touches[0];
                  if (touch) {
                    startDrag(stop.id, "unplanned", {
                      clientX: touch.clientX,
                      clientY: touch.clientY,
                    });
                  }
                }}
                className={`flex h-7 min-w-8 cursor-grab touch-none items-center justify-center rounded border-2 bg-cyan-500 px-1.5 font-mono text-xs font-bold text-white shadow-sm transition-transform hover:scale-105 active:cursor-grabbing ${
                  isSelected
                    ? "border-amber-400 ring-2 ring-amber-500/70 ring-offset-1 ring-offset-background"
                    : "border-cyan-300"
                }`}
                aria-pressed={isSelected}
                aria-label={`${index + 1}. ${stop.address}. ${reason}`}
                title={`${stop.address}\n${stop.trackingCode || stop.externalRef || t("dispatch.noOrderData")}\n${reason}`}
              >
                {index + 1}
              </button>
              <button
                type="button"
                className="absolute -left-2 -top-2 flex h-5 w-5 cursor-grab touch-none items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing"
                onMouseDown={(event) => {
                  if (event.button === 0) {
                    event.preventDefault();
                    startDrag(stop.id, "unplanned", {
                      clientX: event.clientX,
                      clientY: event.clientY,
                    });
                  }
                }}
                onTouchStart={(event) => {
                  const touch = event.touches[0];
                  if (touch) {
                    startDrag(stop.id, "unplanned", {
                      clientX: touch.clientX,
                      clientY: touch.clientY,
                    });
                  }
                }}
                aria-label={t("dispatch.dragUnscheduledStop")}
                title={t("dispatch.dragUnscheduledStop")}
              >
                <GripVertical className="h-3 w-3" />
              </button>
            </div>
          </div>
          );
        })}
      </DualHorizontalScroll>
      </div>
    </section>
  );
}