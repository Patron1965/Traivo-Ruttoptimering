type BooleanSetter = (value: boolean | ((current: boolean) => boolean)) => void;

export interface DispatchKeyboardContext {
  kbdHelpOpen: boolean;
  focusMode: boolean;
  overviewOpen: boolean;
  selectedStopId: string | null;
  inboxRailOpen: boolean;
  actionQueueOpen: boolean;
  scheduledRows: readonly { routeId: string }[];
  flatStopList: readonly { stopId: string; rowIdx: number }[];
  searchInputRef: { current: { focus(): void } | null };
  dispatchAllRef: { current: (() => void) | null };
  setKbdHelpOpen: BooleanSetter;
  setFocusMode: BooleanSetter;
  setOverviewOpen: BooleanSetter;
  setSelectedStopId: (value: string | null) => void;
  setInboxRailOpen: BooleanSetter;
  setActionQueueOpen: BooleanSetter;
  setSelectedStopIds: (value: Set<string>) => void;
  setHighlightedRouteId: (value: string | null) => void;
  setSelectedRowIdx: (value: number) => void;
  setFocusStopId: (value: string | null) => void;
}

/** Shared global shortcuts; drag cancellation and local controls keep their own handlers. */
export function createDispatchKeyboardHandler(context: DispatchKeyboardContext) {
  return (e: KeyboardEvent) => {
    // Local handlers (for example map selection) must retain ownership of handled keys.
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const isEditable =
      tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;

    // Escape also applies in editable controls, closing only the highest-priority layer.
    if (e.key === "Escape") {
      if (context.kbdHelpOpen) {
        context.setKbdHelpOpen(false);
        return;
      }
      if (context.focusMode) {
        context.setFocusMode(false);
        return;
      }
      if (context.overviewOpen) {
        context.setOverviewOpen(false);
        return;
      }
      if (context.selectedStopId) {
        context.setSelectedStopId(null);
        return;
      }
      if (context.inboxRailOpen || context.actionQueueOpen) {
        context.setInboxRailOpen(false);
        context.setActionQueueOpen(false);
        return;
      }
      context.setSelectedStopIds(new Set());
      context.setHighlightedRouteId(null);
      return;
    }

    if (isEditable) return;

    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      context.setFocusMode((v) => !v);
      return;
    }

    if (e.key === "/" || e.key === "?") {
      e.preventDefault();
      if (e.key === "?") context.setKbdHelpOpen((v) => !v);
      else context.searchInputRef.current?.focus();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      context.dispatchAllRef.current?.();
      return;
    }

    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      const routeRows = context.scheduledRows.filter((r) => r.routeId !== "unplanned");
      const row = routeRows[idx];
      if (row) context.setHighlightedRouteId(row.routeId);
      return;
    }

    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      if (context.flatStopList.length === 0) return;
      const currentIdx = context.flatStopList.findIndex((s) => s.stopId === context.selectedStopId);
      const nextIdx =
        e.key === "j"
          ? Math.min(context.flatStopList.length - 1, currentIdx < 0 ? 0 : currentIdx + 1)
          : Math.max(0, currentIdx < 0 ? 0 : currentIdx - 1);
      const next = context.flatStopList[nextIdx];
      if (next) {
        context.setSelectedStopId(next.stopId);
        context.setSelectedRowIdx(next.rowIdx);
        context.setFocusStopId(next.stopId);
      }
    }
  };
}
