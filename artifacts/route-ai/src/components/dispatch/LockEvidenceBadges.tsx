import { Clock, Snowflake, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatStockholm,
  lockEvidence,
  type PlanningLockRoute,
  type PlanningLockStop,
} from "@/lib/planning-locks";

export interface LockEvidenceBadgesProps {
  route?: Pick<PlanningLockRoute, "optimizationFrozen"> | null;
  stop?: PlanningLockStop | null;
  /** Icon + short text only; full meaning stays in the accessible label. */
  compact?: boolean;
  className?: string;
}

/** Text-labelled lock evidence for lists, timelines and map popups. */
export function LockEvidenceBadges({ route, stop, compact = false, className }: LockEvidenceBadgesProps) {
  const kinds = lockEvidence(route, stop);
  if (!kinds.length) return null;
  const id = stop?.id ?? "route";
  return (
    <ul className={cn("inline-flex flex-wrap items-center gap-1", className)} aria-label="Planeringslås" data-testid={`lock-evidence-${id}`}>
      {kinds.map((kind) => {
        const full = kind === "frozen"
          ? "Rutten fryst"
          : kind === "resource"
            ? "Resurs låst"
            : `Servicestart låst ${formatStockholm(stop?.lockedServiceStartAt)}`;
        const short = kind === "frozen" ? "Fryst" : kind === "resource" ? "Resurs" : "Tid";
        const Icon = kind === "frozen" ? Snowflake : kind === "resource" ? Truck : Clock;
        return (
          <li
            key={kind}
            className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
            title={full}
            data-testid={`badge-lock-${kind}-${id}`}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">{full}</span>
            <span aria-hidden="true">{compact ? short : full}</span>
          </li>
        );
      })}
    </ul>
  );
}
