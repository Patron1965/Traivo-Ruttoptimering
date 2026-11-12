import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlannerStep } from "@/lib/planner-workflow";

const STEPS: { step: PlannerStep; label: string }[] = [
  { step: 1, label: "Välj underlag" },
  { step: 2, label: "Bygg och granska" },
  { step: 3, label: "Kontrollera och skicka" },
];

export function PlannerStepRail({ current, availability, completed, onSelect }: {
  current: PlannerStep;
  availability: Record<PlannerStep, { enabled: boolean; reason: string | null }>;
  completed: Record<PlannerStep, boolean>;
  onSelect: (step: PlannerStep) => void;
}) {
  return (
    <nav aria-label="Planeringssteg" className="flex items-stretch gap-0.5 rounded-lg bg-muted/60 p-0.5" data-testid="planner-step-rail">
      {STEPS.map(({ step, label }) => {
        const active = step === current;
        const gate = availability[step];
        return (
          <button
            key={step}
            type="button"
            data-testid={`button-step-${step}`}
            aria-current={active ? "step" : undefined}
            disabled={!gate.enabled}
            title={gate.reason ?? undefined}
            onClick={() => onSelect(step)}
            className={cn(
              "group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
              active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              !gate.enabled && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
            )}
          >
            <span className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] tabular-nums",
              active ? "bg-primary text-primary-foreground"
                : completed[step] ? "bg-primary/15 text-primary" : "bg-background text-muted-foreground ring-1 ring-border",
            )}>
              {completed[step] && !active ? <Check className="h-3 w-3" /> : step}
            </span>
            <span className={cn("whitespace-nowrap", !active && "hidden xl:inline")}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
