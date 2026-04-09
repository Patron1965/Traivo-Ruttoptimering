import { useState, useEffect, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ORG_ID } from "@/lib/constants";
import { onWsMessage } from "@/lib/ws-client";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Play,
  Square,
  Zap,
  TrendingDown,
  Activity,
  Timer,
  Gauge,
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
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [improvements, setImprovements] = useState<ImprovementEvent[]>([]);
  const [liveStatus, setLiveStatus] = useState<{
    running: boolean;
    iteration: number;
    totalImprovementPercent: number;
    bestCost: number;
    initialCost: number;
  } | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const { data: status } = useQuery<OptimizerStatus>({
    queryKey: ["continuous-optimizer-status", ORG_ID],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/optimize/continuous/status?organizationId=${ORG_ID}`
      );
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
    refetchInterval: 3000,
  });

  const isRunning = liveStatus?.running ?? status?.running ?? false;
  const maxTotalMinutes = status?.maxTotalMinutes ?? 30;
  const maxIdleMinutes = status?.maxIdleMinutes ?? 5;
  const maxTotalSeconds = maxTotalMinutes * 60;

  useEffect(() => {
    if (status?.running && status.startedAt) {
      startTimeRef.current = status.startedAt;
      setLiveStatus({
        running: true,
        iteration: status.iteration,
        totalImprovementPercent: status.totalImprovementPercent,
        bestCost: status.bestCost,
        initialCost: status.initialCost,
      });
    }
  }, [status]);

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
      };
      setLiveStatus(null);
      startTimeRef.current = null;
      setElapsed(0);
      queryClient.invalidateQueries({
        queryKey: ["continuous-optimizer-status"],
      });
      queryClient.invalidateQueries({ queryKey: ["routes"] });
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
  }, [toast, t, queryClient]);

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/optimize/continuous/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: ORG_ID }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          err.error || `Failed to start (${res.status})`
        );
      }
      return res.json();
    },
    onSuccess: (data) => {
      startTimeRef.current = data.status?.startedAt ?? Date.now();
      setImprovements([]);
      setLiveStatus({
        running: true,
        iteration: 0,
        totalImprovementPercent: 0,
        bestCost: data.status?.bestCost ?? 0,
        initialCost: data.status?.initialCost ?? 0,
      });
      queryClient.invalidateQueries({
        queryKey: ["continuous-optimizer-status"],
      });
    },
    onError: (err: Error) => {
      const description = err.message?.includes("No pending stops")
        ? t("continuousOpt.noPendingStops")
        : err.message;
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
        body: JSON.stringify({ organizationId: ORG_ID }),
      });
      if (!res.ok) throw new Error("Failed to stop");
      return res.json();
    },
    onSuccess: () => {
      setLiveStatus(null);
      startTimeRef.current = null;
      setElapsed(0);
      queryClient.invalidateQueries({
        queryKey: ["continuous-optimizer-status"],
      });
      queryClient.invalidateQueries({ queryKey: ["routes"] });
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

  const progressPercent = isRunning
    ? Math.min(100, (elapsed / maxTotalSeconds) * 100)
    : 0;

  const getPhaseLabel = (): string => {
    if (!isRunning) return "";
    if (currentIteration === 0) return t("continuousOpt.phaseInit");
    if (currentIteration <= 3) return t("continuousOpt.phaseExploring");
    const lastImpTime = status?.lastImprovementAt;
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
              isRunning
                ? "bg-emerald-500/15"
                : "bg-primary/10"
            )}
          >
            {isRunning ? (
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
              {isRunning
                ? t("continuousOpt.runningDesc")
                : t("continuousOpt.idleDesc")}
            </p>
          </div>
        </div>

        <Button
          onClick={() =>
            isRunning ? stopMutation.mutate() : startMutation.mutate()
          }
          disabled={startMutation.isPending || stopMutation.isPending}
          variant={isRunning ? "destructive" : "default"}
          size="sm"
          className="gap-2"
        >
          {isRunning ? (
            <>
              <Square className="h-3.5 w-3.5" />
              {t("continuousOpt.stop")}
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              {t("continuousOpt.start")}
            </>
          )}
        </Button>
      </div>

      {isRunning && (
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
                {t("continuousOpt.iterations")}
              </div>
              <p className="text-lg font-bold tabular-nums">
                {currentIteration}
              </p>
            </div>

            <div className="p-3 rounded-xl bg-muted/30 border border-border/50">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <TrendingDown className="h-3 w-3" />
                {t("continuousOpt.improvement")}
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
                {t("continuousOpt.elapsed")}
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

      {isRunning && improvements.length > 0 && (
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
