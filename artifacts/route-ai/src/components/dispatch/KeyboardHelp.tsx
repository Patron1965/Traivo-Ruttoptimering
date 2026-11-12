import { useTranslation } from "react-i18next";
import { X, Keyboard } from "lucide-react";

interface KeyboardHelpProps {
  open: boolean;
  onClose: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded border border-border bg-muted/80 text-[11px] font-mono font-semibold text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function KeyboardHelp({ open, onClose }: KeyboardHelpProps) {
  const { t } = useTranslation();
  if (!open) return null;
  const rows: Array<{ keys: React.ReactNode; desc: string }> = [
    { keys: <Kbd>/</Kbd>, desc: t("dispatch.kbdSearch") },
    {
      keys: (
        <span className="flex gap-1">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
        </span>
      ),
      desc: t("dispatch.kbdNavStops"),
    },
    {
      keys: (
        <span className="flex gap-1">
          <Kbd>1</Kbd>…<Kbd>9</Kbd>
        </span>
      ),
      desc: t("dispatch.kbdJumpRoute"),
    },
    { keys: <Kbd>Esc</Kbd>, desc: t("dispatch.kbdClear") },
    {
      keys: (
        <span className="flex gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </span>
      ),
      desc: t("dispatch.kbdDispatch"),
    },
    { keys: <Kbd>Shift</Kbd>, desc: t("dispatch.kbdMultiSelect") },
    { keys: <Kbd>F</Kbd>, desc: t("dispatch.kbdFocus") },
    { keys: <Kbd>?</Kbd>, desc: t("dispatch.kbdHelp") },
  ];
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Keyboard className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-bold flex-1">{t("dispatch.kbdTitle")}</h2>
          <button
            type="button"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="p-4 space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground flex-1">{r.desc}</span>
              <span className="shrink-0">{r.keys}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
