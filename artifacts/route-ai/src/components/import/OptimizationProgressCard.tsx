import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCcw,
  Check,
  WifiOff,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type OptimizationDisplayPhase =
  | "preparing"
  | "distance_matrix"
  | "clustering"
  | "optimizing"
  | "merging"
  | "saving"
  | "complete";

export interface OptimizationProgressCardProps {
  phase: OptimizationDisplayPhase;
  status: "starting" | "running" | "reconnecting" | "error";
  stopCount: number;
  resourceCount: number;
  objectiveLabel: string;
  elapsedMs: number | null;
  estimatedRemainingMs: number | null;
  errorMessage?: string | null;
  onRetry?: () => void;
}

export interface OptimizationResultSummaryProps {
  routesCount: number;
  plannedStopsCount: number;
  unplannedStopsCount: number;
  onViewUnplanned: () => void;
}

function formatTimeElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m} min ${s} s`;
}

function formatTimeRemainingInterval(ms: number | null): string | null {
  if (ms === null || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  
  if (totalSeconds < 60) return "< 1 min";
  
  const m = Math.floor(totalSeconds / 60);
  return `${Math.max(1, Math.floor(m * 0.8))}–${Math.max(m + 1, Math.ceil(m * 1.2))} min`;
}

export function OptimizationProgressCard({
  phase,
  status,
  stopCount,
  resourceCount,
  objectiveLabel,
  elapsedMs,
  estimatedRemainingMs,
  errorMessage,
  onRetry,
}: OptimizationProgressCardProps) {
  const { t } = useTranslation();

  const getStepIndex = () => {
    switch (phase) {
      case "preparing":
      case "distance_matrix":
        return 0;
      case "clustering":
        return 1;
      case "optimizing":
      case "merging":
        return 2;
      case "saving":
      case "complete":
        return 3;
      default:
        return 0;
    }
  };

  const currentStepIndex = getStepIndex();

  const steps = [
    t("import.optimizationProgress.phase1"),
    t("import.optimizationProgress.phase2"),
    t("import.optimizationProgress.phase3"),
    t("import.optimizationProgress.phase4"),
  ];

  return (
    <Card className="w-full max-w-3xl mx-auto shadow-sm border-border" data-testid="optimization-progress-card">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-lg font-semibold flex items-center justify-between">
          <span>{t("import.optimizationProgress.title")}</span>
          {status === "running" && phase !== "complete" && (
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden="true" />
          )}
          {phase === "complete" && (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
          )}
        </CardTitle>
        <div className="text-sm text-muted-foreground">
          {t("import.optimizationProgress.detailFormat", {
            stops: stopCount,
            resources: resourceCount,
            objective: objectiveLabel,
          })}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <p role="status" aria-live="polite" className="text-sm font-medium">
          {status === "reconnecting"
            ? t("import.optimizationProgress.checkingStatus")
            : phase === "preparing"
              ? t("import.optimizationProgress.preparing")
              : steps[currentStepIndex]}
        </p>
        {status === "reconnecting" && (
          <Alert className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200">
            <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <AlertDescription className="ml-2 font-medium flex flex-col gap-3">
              <p>{t("import.optimizationProgress.reconnecting")}</p>
              {onRetry && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={onRetry} 
                  className="w-fit bg-amber-100/50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-800"
                >
                  <RefreshCcw className="mr-2 h-3 w-3" aria-hidden="true" />
                  {t("import.optimizationProgress.retryStatus")}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {status === "error" && errorMessage && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="mt-1 flex flex-col gap-3 font-medium">
              <p>{errorMessage}</p>
              {onRetry && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={onRetry} 
                  className="w-fit bg-background text-foreground"
                >
                  <RefreshCcw className="mr-2 h-3 w-3" aria-hidden="true" />
                  {t("import.optimizationProgress.retryStatus")}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((stepText, idx) => {
              const isPast = idx < currentStepIndex || phase === "complete";
              const isCurrent = idx === currentStepIndex && phase !== "complete" && status !== "error";
              
              return (
                <div 
                  key={idx} 
                  className="flex items-center gap-3"
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <div 
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                      isPast
                        ? "bg-primary border-primary text-primary-foreground"
                        : isCurrent
                        ? "border-primary text-primary"
                        : "border-muted-foreground/30 text-muted-foreground"
                    )}
                    aria-hidden="true"
                  >
                    {isPast ? <Check className="h-3.5 w-3.5" /> : idx + 1}
                  </div>
                  <div className="flex flex-col">
                    <span 
                      className={cn(
                        "text-sm font-medium transition-colors",
                        isPast || isCurrent ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {stepText}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          
          <div 
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between pt-3 border-t gap-2 text-sm text-muted-foreground"
          >
            <span>
              {elapsedMs !== null
                ? t("import.optimizationProgress.timeElapsed", { time: formatTimeElapsed(elapsedMs) })
                : t("import.optimizationProgress.timeElapsedUnknown")}
            </span>
            
            <span>
              {status === "reconnecting"
                ? t("import.optimizationProgress.reconnectingTimeUnknown")
                : estimatedRemainingMs !== null
                ? t("import.optimizationProgress.timeRemaining", { 
                    time: formatTimeRemainingInterval(estimatedRemainingMs) 
                  })
                : t("import.optimizationProgress.timeRemainingUnknown")}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function OptimizationResultSummary({
  routesCount,
  plannedStopsCount,
  unplannedStopsCount,
  onViewUnplanned,
}: OptimizationResultSummaryProps) {
  const { t } = useTranslation();

  return (
    <Card className="w-full shadow-sm border-border">
      <CardHeader className="pb-3 flex flex-row items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
        <CardTitle className="text-lg m-0 leading-none">
          {t("import.optimizationProgress.resultTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-4 text-sm mb-4">
          <div className="font-medium">
            {t("import.optimizationProgress.resultRoutes", { count: routesCount })}
          </div>
          <div className="text-muted-foreground">•</div>
          <div className="font-medium text-emerald-600 dark:text-emerald-500">
            {t("import.optimizationProgress.resultPlanned", { count: plannedStopsCount })}
          </div>
          {unplannedStopsCount > 0 && (
            <>
              <div className="text-muted-foreground">•</div>
              <div className="font-medium text-amber-600 dark:text-amber-500">
                {t("import.optimizationProgress.resultUnplanned", { count: unplannedStopsCount })}
              </div>
            </>
          )}
        </div>
        
        {unplannedStopsCount > 0 && (
          <Button 
            variant="outline" 
            className="w-full sm:w-auto bg-amber-50 hover:bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/30 dark:hover:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/50"
            onClick={onViewUnplanned}
          >
            {t("import.optimizationProgress.viewUnplanned")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
