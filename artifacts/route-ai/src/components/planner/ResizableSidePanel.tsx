import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "traivo.planner.sidePanel";
const MIN = 320;
const MAX = 640;

function readStored(): { width: number; collapsed: boolean } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw.width === "number") return { width: Math.min(MAX, Math.max(MIN, raw.width)), collapsed: !!raw.collapsed };
  } catch { /* ignore malformed preference */ }
  return { width: 400, collapsed: false };
}

/** Side panel the dispatcher can drag wider/narrower or fold away for the map. */
export function ResizableSidePanel({ children, collapsedLabel }: { children: ReactNode; collapsedLabel: string }) {
  const [state, setState] = useState(readStored);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    const width = Math.min(MAX, Math.max(MIN, d.startWidth + e.clientX - d.startX));
    setState((s) => ({ ...s, width }));
  }, []);
  const onPointerUp = useCallback(() => {
    dragging.current = null;
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove, onPointerUp]);

  if (state.collapsed) {
    return (
      <button type="button" data-testid="button-expand-panel" onClick={() => setState((s) => ({ ...s, collapsed: false }))}
        className="hidden w-9 shrink-0 flex-col items-center gap-3 border-r border-border bg-card/60 py-3 text-muted-foreground hover:text-foreground lg:flex">
        <PanelLeftOpen className="h-4 w-4" />
        <span className="text-[11px] font-semibold [writing-mode:vertical-rl]">{collapsedLabel}</span>
      </button>
    );
  }

  return (
    <aside
      style={{ "--panel-w": `${state.width}px` } as CSSProperties}
      className={cn("relative z-10 flex max-h-[55vh] w-full shrink-0 flex-col border-b border-border bg-card/40 lg:h-full lg:max-h-none lg:w-[var(--panel-w)] lg:border-b-0 lg:border-r")}
      data-testid="planner-side-panel"
    >
      <button type="button" aria-label="Fäll ihop panelen" data-testid="button-collapse-panel"
        onClick={() => setState((s) => ({ ...s, collapsed: true }))}
        className="absolute right-1.5 top-1.5 z-20 hidden rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground lg:block">
        <PanelLeftClose className="h-3.5 w-3.5" />
      </button>
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Ändra panelens bredd"
        data-testid="handle-resize-panel"
        onPointerDown={(e) => {
          dragging.current = { startX: e.clientX, startWidth: state.width };
          document.body.style.cursor = "col-resize";
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
        }}
        className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize lg:block [&:hover>span]:bg-primary/50"
      >
        <span className="mx-auto block h-full w-px bg-transparent transition-colors" />
      </div>
    </aside>
  );
}
