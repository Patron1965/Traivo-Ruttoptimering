import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export function OptimizationProgressPanel({ stopCount, t }: { stopCount: number; t: (key: string, opts?: Record<string, unknown>) => string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startTime = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-2.5 animate-in fade-in" role="status">
      <div className="flex items-center gap-2 text-xs font-semibold text-primary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {stopCount > 100 ? t("planner.largeOptimization", { count: stopCount }) : t("planner.optimizingRoutes")}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full w-full rounded-full bg-primary" style={{ animation: "pulse 1.5s infinite" }} />
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        {elapsed}s {t("planner.estimatedTime", { seconds: Math.max(1, Math.ceil(stopCount / 10) - elapsed) })}
      </p>
    </div>
  );
}
