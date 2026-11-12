import { CheckCircle2, Clock3, Loader2, Network, Timer, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { OptimizationJobStatus, OptimizationStopReason } from "@/hooks/use-routes";

interface Props {
  stopCount: number;
  status: OptimizationJobStatus | null;
}

const phases = ["preparing", "distance_matrix", "clustering", "optimizing", "merging", "complete"] as const;
const phaseLabels = {
  preparing: "planner.phasePreparing",
  distance_matrix: "planner.phaseDistanceMatrix",
  clustering: "planner.phaseCluster",
  optimizing: "planner.phaseOptimize",
  merging: "planner.phaseMerge",
  complete: "planner.phaseComplete",
} as const;
const phaseShortLabels = {
  preparing: "planner.phaseShortPreparing",
  distance_matrix: "planner.phaseShortDistanceMatrix",
  clustering: "planner.phaseShortClustering",
  optimizing: "planner.phaseShortOptimizing",
  merging: "planner.phaseShortMerging",
  complete: "planner.phaseShortComplete",
} as const;
const stopReasonLabels: Record<OptimizationStopReason, string> = {
  time_limit: "planner.stopReasonTimeLimit",
  max_iterations: "planner.stopReasonMaxIterations",
  no_improvement: "planner.stopReasonNoImprovement",
  no_nodes: "planner.stopReasonNoNodes",
  no_vehicles: "planner.stopReasonNoVehicles",
  mixed: "planner.stopReasonMixed",
};
const stopReasons = new Set<OptimizationStopReason>(Object.keys(stopReasonLabels) as OptimizationStopReason[]);
const timingRows = [
  ["inputLoadMs", "timingInput"] as const,
  ["weatherMs", "timingWeather"] as const,
  ["distanceMatrixMs", "timingDistanceMatrix"] as const,
  ["clusteringMs", "timingClustering"] as const,
  ["alnsSearchMs", "timingRouteSearch"] as const,
  ["mergingMs", "timingMerging"] as const,
  ["persistenceMs", "timingSaving"] as const,
];

function formatDuration(ms: number) {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${ms} ms`;
}

export function LargeOptimizationProgressPanel({ stopCount, status }: Props) {
  const { t } = useTranslation();
  const progress = status?.progress;
  const timing = status?.result?.optimizationTiming;
  const isComplete = status?.status === "complete";
  const phase = progress?.phase ?? "preparing";
  const phaseIndex = phases.indexOf(phase);
  const percent = progress?.totalClusters
    ? Math.round((progress.completedClusters / progress.totalClusters) * 100)
    : Math.max(8, phaseIndex * 20);
  const terminalReason = timing?.stopReason ?? progress?.stopReason;
  const clusterStopReasons = timing?.clusterStopReasons ?? progress?.clusterStopReasons;

  return (
    <section
      className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3 animate-in fade-in"
      role="status"
      aria-live="polite"
    >
      <header className="flex gap-2 text-sm font-medium text-primary">
        {isComplete ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-500" /> : <Loader2 className="h-4 w-4 mt-0.5 animate-spin" />}
        <div>
          <p>{isComplete ? t("planner.largeOptimizationComplete") : t("planner.largeOptimization", { count: stopCount })}</p>
          <p className="text-xs font-normal text-muted-foreground">
            {t(phaseLabels[phase])}
          </p>
        </div>
      </header>

      {!isComplete && (
        <>
          <div className="grid grid-cols-6 gap-1 text-[9px] text-muted-foreground">
            {phases.map((item, index) => (
              <span key={item} className={index <= phaseIndex ? "text-primary font-medium" : ""} aria-current={item === phase ? "step" : undefined}>
                {index + 1}. {t(phaseShortLabels[item])}
              </span>
            ))}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${Math.max(5, percent)}%` }} />
          </div>
        </>
      )}

      <div className="grid grid-cols-3 gap-2 text-center">
        <Metric icon={<Network />} label={t("planner.clusters")} value={progress?.totalClusters ? `${progress.completedClusters}/${progress.totalClusters}` : "—"} />
        <Metric icon={<Timer />} label={t("planner.iterations")} value={progress?.iterations?.toLocaleString() ?? "—"} />
        <Metric icon={<TrendingUp />} label={t("planner.improvements")} value={progress?.improvements?.toLocaleString() ?? "—"} />
      </div>

      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Clock3 className="h-3.5 w-3.5" />
        {t("planner.elapsed", { time: formatDuration(timing?.totalMs ?? status?.elapsedMs ?? progress?.elapsedMs ?? 0) })}
      </p>

      {isComplete && timing && (
        <div className="border-t border-primary/20 pt-3 space-y-2">
          <p className="text-xs font-semibold">{t("planner.timingBreakdown")}</p>
          <div className="space-y-1.5">
            {timingRows.map(([field, label]) => {
              const value = timing[field as keyof typeof timing];
              const milliseconds = typeof value === "number" ? value : 0;
              return (
                <div key={field} className="flex items-center gap-2 text-xs">
                  <span className="w-28 shrink-0 text-muted-foreground">{t(`planner.${label}`)}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, (milliseconds / Math.max(timing.totalMs, 1)) * 100)}%` }} />
                  </div>
                  <span className="w-12 text-right tabular-nums">{formatDuration(milliseconds)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {isComplete && (
        <div className="border-t border-primary/20 pt-3 space-y-2">
          <div className="flex items-start justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t("planner.whyStopped")}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-right font-medium">
              {terminalReason ? t(stopReasonLabels[terminalReason]) : t("planner.stopReasonUnknown")}
            </span>
          </div>
          {clusterStopReasons && Object.keys(clusterStopReasons).length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t("planner.clusterOutcomes")}</p>
              <div className="flex flex-wrap gap-1">
                {Object.entries(clusterStopReasons).map(([reason, count]) => (
                  stopReasons.has(reason as OptimizationStopReason) && count > 0 ? (
                    <span key={reason} className="rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px]">
                      {count} × {t(stopReasonLabels[reason as OptimizationStopReason])}
                    </span>
                  ) : null
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background/60 px-1.5 py-2">
      <div className="mx-auto mb-1 h-3.5 w-3.5 text-primary [&>svg]:h-full [&>svg]:w-full">{icon}</div>
      <p className="text-xs font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}