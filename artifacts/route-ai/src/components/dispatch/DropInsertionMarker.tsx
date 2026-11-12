import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { describeInsertion, insertionLabelSide } from "@/lib/dispatch-insertion-marker";

/**
 * Anchored insertion caret for timeline drag-and-drop. Entirely
 * pointer-events-none so it never steals hit-testing from stops or rows.
 */
export function DropInsertionMarker({
  x,
  index,
  remainingStops,
  gridWidth,
  routeName,
  dragCount,
  compact,
}: {
  x: number | null;
  index: number | null;
  remainingStops: ReadonlyArray<{ sequenceOrder?: number | null }>;
  gridWidth: number;
  routeName: string;
  dragCount: number;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const info = describeInsertion(index ?? remainingStops.length, remainingStops);
  const placementText =
    info.placement === "empty"
      ? t("dispatch.insertEmpty")
      : info.placement === "last"
        ? t("dispatch.insertLast")
        : info.beforeOrder == null
          ? t(info.placement === "first" ? "dispatch.insertFirstNoOrder" : "dispatch.insertBeforeNext")
          : t(info.placement === "first" ? "dispatch.insertFirst" : "dispatch.insertBefore", { before: info.beforeOrder });
  const countText = t("dispatch.insertCount", { count: Math.max(1, dragCount) });
  const fullLabel = `${placementText} · ${countText} → ${routeName}`;
  const side = x == null ? "right" : insertionLabelSide(x, gridWidth);
  return (
    <div
      className="absolute inset-0 z-40 pointer-events-none"
      data-testid="dispatch-drop-target-overlay"
      data-insert-placement={info.placement}
      data-insert-before-order={info.beforeOrder ?? undefined}
      aria-hidden="true"
    >
      {/* Target row edge accents */}
      <span className="absolute inset-y-0 left-0 w-1 bg-primary" />
      {x != null ? (
        <>
          <span
            data-testid="dispatch-drop-insertion-marker"
            className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-primary shadow-[0_0_0_1.5px_hsl(var(--background))]"
            style={{ left: x }}
          />
          <span
            className="absolute top-0 h-0 w-0 -translate-x-1/2 border-x-[6px] border-t-[7px] border-x-transparent border-t-primary"
            style={{ left: x }}
          />
          <span
            className="absolute bottom-0 h-0 w-0 -translate-x-1/2 border-x-[6px] border-b-[7px] border-x-transparent border-b-primary"
            style={{ left: x }}
          />
          <span
            data-testid="dispatch-drop-insertion-label"
            className={cn(
              "absolute top-0.5 max-w-[168px] truncate whitespace-nowrap rounded-sm bg-primary px-1.5 py-px font-semibold leading-tight text-primary-foreground shadow",
              compact ? "text-[9px]" : "text-[10px]",
            )}
            style={side === "right" ? { left: x + 6 } : { right: gridWidth - x + 6 }}
            title={fullLabel}
          >
            <span className="font-bold">{placementText}</span>
            {!compact && <span className="block truncate font-medium opacity-90">{countText} → {routeName}</span>}
          </span>
        </>
      ) : (
        <span
          data-testid="dispatch-drop-insertion-label"
          className="absolute left-2 top-0.5 max-w-[220px] truncate rounded-sm bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground shadow"
        >
          <span className="font-bold">{placementText}</span> · {countText} → {routeName}
        </span>
      )}
    </div>
  );
}
