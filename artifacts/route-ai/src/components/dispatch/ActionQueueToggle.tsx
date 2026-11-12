import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ActionQueueToggle({ open, count, onToggle }: {
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="dispatch-action-queue"
      data-testid="dispatch-action-queue-toggle"
      className={`h-7 min-h-7 gap-1.5 rounded px-2 py-0 text-[11px] shadow-none [@media(pointer:coarse)]:min-h-11 ${open ? "bg-primary/10 text-primary" : count > 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
    >
      <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
      Åtgärdskö
      {count > 0 && <span className="rounded bg-muted px-1 tabular-nums">{count > 99 ? "99+" : count}</span>}
    </Button>
  );
}
