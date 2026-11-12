import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  IMPORT_INFO_CATEGORIES,
  IMPORT_INFO_LABELS,
  defaultImportInfoVisibility,
  toggleImportInfo,
  type ImportInfoCategory,
  type ImportInfoVisibility,
} from "@/lib/import-info-disclosure";

type Ctx = { visible: ImportInfoVisibility; set: (c: ImportInfoCategory, open?: boolean) => void };
const ImportInfoContext = createContext<Ctx | null>(null);

export function ImportInfoProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState<ImportInfoVisibility>(defaultImportInfoVisibility);
  const value = useMemo<Ctx>(() => ({ visible, set: (c, open) => setVisible((s) => toggleImportInfo(s, c, open)) }), [visible]);
  return <ImportInfoContext.Provider value={value}>{children}</ImportInfoContext.Provider>;
}

/** Outside the import flow (e.g. Dispatch), everything stays expanded. */
export function useImportInfo(): Ctx & { inImportFlow: boolean } {
  const ctx = useContext(ImportInfoContext);
  if (!ctx) return { visible: { overview: true, stats: true, limits: true, help: true }, set: () => {}, inImportFlow: false };
  return { ...ctx, inImportFlow: true };
}

export function ImportInfoMenu({ className }: { className?: string }) {
  const { visible, set, inImportFlow } = useImportInfo();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  if (!inImportFlow) return null;
  const activeCount = IMPORT_INFO_CATEGORIES.filter((c) => visible[c]).length;
  return (
    <div ref={ref} className={cn("relative inline-block", className)}
      onKeyDownCapture={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
        data-testid="import-info-menu"
      >
        <Eye className="h-4 w-4" />
        Visa information{activeCount > 0 ? ` (${activeCount})` : ""}
        <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div id={menuId} role="group" aria-label="Visa information" className="absolute right-0 z-40 mt-1 w-56 rounded-md border border-border bg-popover p-2 shadow-md">
          {IMPORT_INFO_CATEGORIES.map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={visible[c]} onChange={(e) => set(c, e.target.checked)} data-testid={`import-info-toggle-${c}`} />
              {IMPORT_INFO_LABELS[c]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible section: content stays mounted (hidden) so state and hooks are preserved. */
export function ImportInfoSection({ category, title, children, className }: {
  category: ImportInfoCategory; title?: string; children: ReactNode; className?: string;
}) {
  const { visible, set, inImportFlow } = useImportInfo();
  const contentId = useId();
  if (!inImportFlow) return <>{children}</>;
  const open = visible[category];
  return (
    <div className={className} data-testid={`import-info-section-${category}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => set(category)}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        {title ?? IMPORT_INFO_LABELS[category]}
      </button>
      <div id={contentId} hidden={!open} className="mt-1.5">{children}</div>
    </div>
  );
}
