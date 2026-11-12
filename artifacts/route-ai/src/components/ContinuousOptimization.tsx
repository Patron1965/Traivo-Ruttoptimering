import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { onWsMessage } from "@/lib/ws-client";
import { reconcileContinuousOptimizationStatus } from "@/lib/continuous-optimization-lifecycle";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { localizeError } from "@/lib/localize-error";
import {
  Play,
  Square,
  Zap,
  TrendingDown,
  Activity,
  Timer,
  Gauge,
  Info,
  Loader2,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

interface ImprovementEvent {
  iteration: number;
  cost: number;
  previousCost: number;
  deltaPercent: number;
  totalImprovementPercent: number;
  costBreakdown: {
    distanceCost: number;
    co2Cost: number;
    etaPrecisionCost: number;
    totalDistanceKm: number;
    totalCo2Kg: number;
    totalTimeWindowSlackMin: number;
  };
  startedAt?: number;
}

interface OptimizerStatus {
  running: boolean;
  organizationId: string;
  iteration: number;
  bestCost: number;
  initialCost: number;
  totalImprovementPercent: number;
  lastImprovementAt: number | null;
  startedAt: number;
  maxTotalMinutes?: number;
  maxIdleMinutes?: number;
  elapsedMs?: number;
  idleMs?: number;
}

export function ContinuousOptimization() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [improvements, setImprovements] = useState<ImprovementEvent[]>([]);
  const [liveStatus, setLiveStatus] = useState<{
    running: boolean;
    iteration: number;
    totalImprovementPercent: number;
    bestCost: number;
    initialCost: number;
    maxTotalMinutes?: number;
    maxIdleMinutes?: number;
  } | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  const [optimisticRunning, setOptimisticRunning] = useState(false);
  const optimisticRunningRef = useRef(false);
  const startPendingRef = useRef(false);
  const lifecycleVersionRef = useRef(0);
  const [stoppedRunStartedAt, setStoppedRunStartedAt] = useState<number | null>(null);
  const stoppedRunStartedAtRef = useRef<number | null>(null);

  const setStopIntent = useCallback((requested: boolean) => {
    stopRequestedRef.current = requested;
    setStopRequested(requested);
  }, []);

  const setOptimisticRunState = useCallback((running: boolean) => {
    optimisticRunningRef.current = running;
    setOptimisticRunning(running);
  }, []);

  const markStoppedRun = useCallback((startedAt: number | null) => {
    stoppedRunStartedAtRef.current = startedAt;
    setStoppedRunStartedAt((previous) =>
      previous === startedAt ? previous : startedAt,
    );
  }, []);

  const confirmStopped = useCallback(
    (confirmedStatus?: Partial<OptimizerStatus>) => {
      const stoppedStartedAt =
        confirmedStatus?.startedAt ?? startTimeRef.current;
      if (stoppedStartedAt) {
        markStoppedRun(stoppedStartedAt);
      }
      setStopIntent(false);
      setOptimisticRunState(false);
      startTimeRef.current = null;
      setElapsed(0);
      setLiveStatus(null);
      queryClient.setQueryData(
        ["continuous-optimizer-status", organizationId],
        (previous: OptimizerStatus | undefined) => ({
          ...previous,
          ...confirmedStatus,
          running: false,
          organizationId,
        }) as OptimizerStatus,
      );
      queryClient.invalidateQueries({
        queryKey: ["continuous-optimizer-status", organizationId],
      });
      queryClient.invalidateQueries({ queryKey: ["routes"] });
    },
    [
      organizationId,
      queryClient,
      setOptimisticRunState,
      setStopIntent,
      markStoppedRun,
    ],
  );

  const { data: status } = useQuery<OptimizerStatus>({
    queryKey: ["continuous-optimizer-status", organizationId],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/optimize/continuous/status?organizationId=${organizationId}`,
        { credentials: "include" },
      );
       if (!res.ok) {
         const error = new Error("Failed to fetch status");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    enabled: !!organizationId,
    refetchInterval: 3000,
  });

  const reconciledStatus = reconcileContinuousOptimizationStatus(
    status,
    stoppedRunStartedAt,
  );
  const isRunning = optimisticRunning || reconciledStatus?.running === true;
  const maxTotalMinutes = liveStatus?.maxTotalMinutes ?? reconciledStatus?.maxTotalMinutes ?? 5;
  const maxIdleMinutes = liveStatus?.maxIdleMinutes ?? reconciledStatus?.maxIdleMinutes ?? 1;
  const maxTotalSeconds = maxTotalMinutes * 60;

  useEffect(() => {
    if (!status) return;
    const currentStatus = reconcileContinuousOptimizationStatus(
      status,
      stoppedRunStartedAt,
    );
    if (!currentStatus?.running) {
      if (startPendingRef.current) return;
      if (currentStatus?.startedAt) {
        markStoppedRun(currentStatus.startedAt);
      }
      setStopIntent(false);
      if (optimisticRunningRef.current || liveStatus?.running) {
        setOptimisticRunState(false);
        setLiveStatus(null);
      }
      startTimeRef.current = null;
      setElapsed(0);
      return;
    }
    if (stopRequestedRef.current) {
      return;
    }
    if (currentStatus.startedAt) {
      setOptimisticRunState(true);
      startTimeRef.current = currentStatus.startedAt;
      setLiveStatus({
        running: true,
        iteration: currentStatus.iteration,
        totalImprovementPercent: currentStatus.totalImprovementPercent,
        bestCost: currentStatus.bestCost,
        initialCost: currentStatus.initialCost,
      });
    }
  }, [
    liveStatus?.running,
    markStoppedRun,
    setOptimisticRunState,
    setStopIntent,
    stoppedRunStartedAt,
    status,
  ]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      if (startTimeRef.current) {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    const unsub1 = onWsMessage(
      "optimization:improvement",
      (data: unknown) => {
        const event = data as ImprovementEvent;
        if (
          stopRequestedRef.current ||
          (event.startedAt != null &&
            stoppedRunStartedAtRef.current != null &&
            event.startedAt <= stoppedRunStartedAtRef.current)
        ) {
          return;
        }
        setOptimisticRunState(true);
        setImprovements((prev) => [...prev.slice(-9), event]);
        setLiveStatus((prev) => ({
          running: true,
          iteration: event.iteration,
          totalImprovementPercent: event.totalImprovementPercent,
          bestCost: event.cost,
          initialCost: prev?.initialCost ?? event.previousCost,
        }));

        if (event.deltaPercent > 5) {
          toast({
            title: t("continuousOpt.significantImprovement"),
            description: t("continuousOpt.costReduced", {
              percent: event.deltaPercent.toFixed(1),
            }),
          });
        }
      }
    );

    const unsub2 = onWsMessage("optimization:stopped", (data: unknown) => {
      const d = data as {
        reason?: string;
        totalImprovementPercent: number;
        iterations: number;
        startedAt?: number;
      };
      if (
        !stopRequestedRef.current &&
        d.startedAt != null &&
        startTimeRef.current != null &&
        d.startedAt < startTimeRef.current
      ) {
        return;
      }
      confirmStopped({ ...d, running: false });
      toast({
        title: t("continuousOpt.stopped"),
        description: t("continuousOpt.stoppedDesc", {
          iterations: d.iterations,
          percent: d.totalImprovementPercent.toFixed(1),
        }),
      });
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, [confirmStopped, setOptimisticRunState, t, toast]);

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/optimize/continuous/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ organizationId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const error = new Error(data?.error || `Failed to start (${res.status})`);
        Object.assign(error, { status: res.status, data });
        throw error;
      }
      return res.json();
    },
    onMutate: () => {
      const requestVersion = ++lifecycleVersionRef.current;
      startPendingRef.current = true;
      markStoppedRun(null);
      setOptimisticRunState(true);
      startTimeRef.current = Date.now();
      setImprovements([]);
      setLiveStatus({
        running: true,
        iteration: 0,
        totalImprovementPercent: 0,
        bestCost: 0,
        initialCost: 0,
      });
      return requestVersion;
    },
    onSuccess: (data, _variables, requestVersion) => {
      startPendingRef.current = false;
      if (
        requestVersion !== lifecycleVersionRef.current ||
        stopRequestedRef.current ||
        (data.status?.running &&
          data.status.startedAt != null &&
          stoppedRunStartedAtRef.current != null &&
          data.status.startedAt <= stoppedRunStartedAtRef.current)
      ) {
        if (
          !data.status?.running &&
          requestVersion === lifecycleVersionRef.current
        ) {
          confirmStopped(data.status);
        }
        return;
      }
      if (!data.status?.running) {
        confirmStopped(data.status);
        return;
      }
      setOptimisticRunState(true);
      startTimeRef.current = data.status.startedAt ?? Date.now();
      setLiveStatus({
        running: true,
        iteration: 0,
        totalImprovementPercent: 0,
        bestCost: data.status?.bestCost ?? 0,
        initialCost: data.status?.initialCost ?? 0,
        maxTotalMinutes: data.status?.maxTotalMinutes,
        maxIdleMinutes: data.status?.maxIdleMinutes,
      });
      queryClient.invalidateQueries({
        queryKey: ["continuous-optimizer-status", organizationId],
      });
    },
    onError: (err: Error, _variables, requestVersion) => {
      startPendingRef.current = false;
      if (
        requestVersion !== lifecycleVersionRef.current ||
        stopRequestedRef.current
      ) {
        return;
      }
      setOptimisticRunState(false);
      startTimeRef.current = null;
      setElapsed(0);
      setLiveStatus(null);
      const description = err.message?.includes("No pending stops")
        ? t("continuousOpt.noPendingStops")
        : localizeError(err, t, { fallbackKey: "continuousOpt.startErrorDesc" });
      toast({
        title: t("continuousOpt.startError"),
        description,
        variant: "destructive",
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/optimize/continuous/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ organizationId }),
      });
       if (!res.ok) {
         const error = new Error("Failed to stop");
         Object.assign(error, { status: res.status });
         throw error;
       }
      return res.json();
    },
    onMutate: () => {
      const requestVersion = ++lifecycleVersionRef.current;
      setStopIntent(true);
      return requestVersion;
    },
    onSuccess: (data, _variables, requestVersion) => {
      if (requestVersion !== lifecycleVersionRef.current) return;
      if (data.status?.running === false) {
        confirmStopped(data.status);
        return;
      }
      queryClient.invalidateQueries({
        queryKey: ["continuous-optimizer-status", organizationId],
      });
    },
    onError: (_err, _variables, requestVersion) => {
      if (requestVersion === lifecycleVersionRef.current) {
        setStopIntent(false);
      }
      toast({
        title: t("continuousOpt.stopError"),
        description: t("continuousOpt.stopErrorDesc"),
        variant: "destructive",
      });
    },
  });

  const formatTime = useCallback((s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }, []);

  const currentImprovement =
    liveStatus?.totalImprovementPercent ?? 0;
  const currentIteration = liveStatus?.iteration ?? 0;
  const currentBestCost = liveStatus?.bestCost ?? 0;
  const currentInitialCost = liveStatus?.initialCost ?? 0;
  const isStopping = stopMutation.isPending || stopRequested;
  const showsOptimizerState = isRunning || isStopping;

  const progressPercent = isRunning
    ? Math.min(100, (elapsed / maxTotalSeconds) * 100)
    : 0;

  const getPhaseLabel = (): string => {
    if (!isRunning) return "";
    if (currentIteration === 0) return t("continuousOpt.phaseInit");
    if (currentIteration <= 3) return t("continuousOpt.phaseExploring");
    const lastImpTime = reconciledStatus?.lastImprovementAt;
    if (lastImpTime && Date.now() - lastImpTime > maxIdleMinutes * 60_000 * 0.5) {
      return t("continuousOpt.phaseConverging");
    }
    return t("continuousOpt.phaseOptimizing");
  };

  return (
    <div className="bg-card border border-border rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "h-10 w-10 rounded-xl flex items-center justify-center transition-colors",
              showsOptimizerState
                ? "bg-emerald-500/15"
                : "bg-primary/10"
            )}
          >
            {showsOptimizerState ? (
              <Activity className="h-5 w-5 text-emerald-400 animate-pulse" />
            ) : (
              <Zap className="h-5 w-5 text-primary" />
            )}
          </div>
          <div>
            <h3 className="font-bold text-base">
              {t("continuousOpt.title")}
            </h3>
            <p className="text-xs text-muted-foreground">
                {showsOptimizerState
                ? t("continuousOpt.runningDesc")
                : t("continuousOpt.idleDesc")}
            </p>
          </div>
        </div>

        <Button
          onClick={() => {
            if (showsOptimizerState) {
              setStopIntent(true);
              stopMutation.mutate();
              return;
            }
            startMutation.mutate();
          }}
          disabled={isStopping || (!showsOptimizerState && startMutation.isPending)}
          variant={showsOptimizerState ? "destructive" : "default"}
          size="sm"
          className={cn("gap-2", !showsOptimizerState && "bg-orange-500 hover:bg-orange-600 text-white")}
        >
          {showsOptimizerState ? (
            <>
              {isStopping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {isStopping ? t("continuousOpt.stopping") : t("continuousOpt.stop")}
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              {t("continuousOpt.start")}
            </>
          )}
        </Button>
      </div>

      <div className="rounded-xl border border-border/60 bg-muted/25 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
          <Info className="h-3.5 w-3.5 text-primary" />
          {t("continuousOpt.whatItDoesTitle")}
        </div>
        <p>{t("continuousOpt.whatItDoes")}</p>
        <p className="mt-1.5 text-muted-foreground/90">{t("continuousOpt.safeToRun")}</p>
        {isStopping && (
          <p className="mt-2 font-medium text-foreground">{t("continuousOpt.stoppingHint")}</p>
        )}
      </div>

      {showsOptimizerState && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Gauge className="h-3 w-3" />
                {getPhaseLabel()}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {formatTime(elapsed)} / {formatTime(maxTotalSeconds)}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted/50 overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-1000 ease-linear",
                  currentImprovement > 0
                    ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                    : "bg-gradient-to-r from-primary/70 to-primary"
                )}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-xl bg-muted/30 border border-border/50">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Activity className="h-3 w-3" />
                {t("continuousOpt.alternativesTested")}
              </div>
              <p className="text-lg font-bold tabular-nums">
                {currentIteration}
              </p>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/50">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <TrendingDown className="h-3 w-3" />
                {t("continuousOpt.potentialImprovement")}
              </div>
              <p
                className={cn(
                  "text-lg font-bold tabular-nums",
                  currentImprovement > 0
                    ? "text-emerald-400"
                    : "text-muted-foreground"
                )}
              >
                {currentImprovement > 0 ? "-" : ""}
                {currentImprovement.toFixed(1)}%
              </p>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/50">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Timer className="h-3 w-3" />
                {t("continuousOpt.searchTime")}
              </div>
              <p className="text-lg font-bold tabular-nums">
                {formatTime(elapsed)}
              </p>
            </div>
          </div>

          {currentInitialCost > 0 && (
            <div className="p-3 rounded-xl bg-muted/30 border border-border/50">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                <span>{t("continuousOpt.costProgress")}</span>
                <span className="tabular-nums">
                  {currentBestCost.toFixed(0)} / {currentInitialCost.toFixed(0)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
                  style={{
                    width: `${Math.max(5, currentInitialCost > 0 ? (currentBestCost / currentInitialCost) * 100 : 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {showsOptimizerState && improvements.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground font-medium">
            {t("continuousOpt.recentImprovements")}
          </p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {[...improvements].reverse().map((imp, i) => (
              <div
                key={`${imp.iteration}-${i}`}
                className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg bg-emerald-500/5 border border-emerald-500/10"
              >
                <span className="text-muted-foreground">
                  #{imp.iteration}
                </span>
                <span className="text-emerald-400 font-medium">
                  -{imp.deltaPercent.toFixed(2)}%
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {t("continuousOpt.costValue", {
                    value: imp.cost.toFixed(0),
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
