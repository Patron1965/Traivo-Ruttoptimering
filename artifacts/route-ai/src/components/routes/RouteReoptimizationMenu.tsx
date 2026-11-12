import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Driver,
  type Route,
  type RouteReoptimizationResult,
  type Stop,
  type Vehicle,
  type WholePlanReoptimizationResult,
  getRoute,
  useApplyImportRoutePlanReoptimization,
  useApplyRouteReoptimization,
  usePreviewImportRoutePlanReoptimization,
  usePreviewRouteReoptimization,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ChevronDown,
  Route as RouteIcon,
  Zap,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { usePlanningDraft } from "@/hooks/use-planning-drafts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hasErrorCode, localizeError } from "@/lib/localize-error";
import { previewCurrentRoute, routePreviewFailure } from "@/lib/reoptimization-preview";

export type ReoptimizationRouteLike = Pick<
  Route,
  | "id"
  | "planId"
  | "planRevision"
  | "status"
  | "vehicleId"
  | "draftId"
  | "name"
  | "handoffStatus"
  | "handoffDriverId"
  | "lockedFirstStopId"
  | "planningSummary"
> & {
  totalStops?: number;
  totalDistanceKm?: number | null;
  totalDurationMin?: number | null;
  depotSnapshot?: Route["depotSnapshot"];
  plannerItinerary?: Route["plannerItinerary"];
};

type PreviewState =
  | {
      scope: "route";
      result: RouteReoptimizationResult;
      route: ReoptimizationRouteLike;
    }
  | {
      scope: "plan";
      result: WholePlanReoptimizationResult;
      routes: ReoptimizationRouteLike[];
    };

export interface RouteReoptimizationMenuProps {
  route: ReoptimizationRouteLike;
  planRoutes: ReoptimizationRouteLike[];
  drivers: Driver[];
  vehicles?: Vehicle[];
  stops?: Stop[];
  depotLatitude: number;
  depotLongitude: number;
  onSaved?: (planId: string) => void | Promise<void>;
  className?: string;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof candidate.status === "number") return candidate.status;
  return typeof candidate.response?.status === "number"
    ? candidate.response.status
    : undefined;
}

function driverIdForRoute(
  route: ReoptimizationRouteLike,
  drivers: Driver[],
): string | undefined {
  if (route.vehicleId) {
    const persistedPair = route.planningSummary?.selectedPairValues?.find(
      (pairValue) => pairValue.startsWith(`${route.vehicleId}:`),
    );
    if (persistedPair) {
      const [, driverId] = persistedPair.split(":");
      if (driverId) return driverId;
    }
  }
  return drivers.find(
    (driver) =>
      driver.id === route.handoffDriverId ||
      (driver.vehicleId === route.vehicleId && driver.isActive),
  )?.id;
}

function Metric({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-muted/20 p-3"
      data-testid={testId}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}

function formatMetric(
  value: number | null | undefined,
  suffix: string,
): string {
  return value == null ? "–" : `${Math.round(value * 10) / 10}${suffix}`;
}

export function RouteReoptimizationMenu({
  route,
  planRoutes,
  drivers,
  vehicles = [],
  stops = [],
  depotLatitude,
  depotLongitude,
  onSaved,
  className,
}: RouteReoptimizationMenuProps) {
  const { t } = useTranslation();
  const { hasRole } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = hasRole("admin", "dispatcher");
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scope, setScope] = useState<"route" | "plan">("route");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refreshingRoute, setRefreshingRoute] = useState(false);

  const draftId =
    route.draftId ??
    planRoutes.find((candidate) => candidate.draftId)?.draftId ??
    null;
  const { data: draft, isLoading: draftLoading } = usePlanningDraft(draftId);
  const planRouteIds = useMemo(
    () => new Set(planRoutes.map((candidate) => candidate.id)),
    [planRoutes],
  );
  const planPairs = useMemo(() => {
    const persistedPairValues = planRoutes.flatMap(
      (candidate) => candidate.planningSummary?.selectedPairValues ?? [],
    );
    const pairsFromSummary = persistedPairValues
      .map((pairValue) => {
        const [vehicleId, driverId] = pairValue.split(":");
        return vehicleId && driverId ? { vehicleId, driverId } : null;
      })
      .filter(
        (pair): pair is { vehicleId: string; driverId: string } =>
          pair != null,
      );
    const pairs =
      pairsFromSummary.length > 0
        ? pairsFromSummary
        : planRoutes.flatMap((candidate) => {
            if (!candidate.vehicleId) return [];
            const driverId = driverIdForRoute(candidate, drivers);
            return driverId
              ? [{ vehicleId: candidate.vehicleId, driverId }]
              : [];
          });
    return [
      ...new Map(
        pairs.map((pair) => [`${pair.vehicleId}:${pair.driverId}`, pair]),
      ).values(),
    ];
  }, [drivers, planRoutes]);
  const selectedPairs = planPairs;
  const activePlan =
    planRoutes.length > 0 &&
    planRoutes.every((candidate) => candidate.status === "optimized");
  const lockedPlanStopCount = stops.filter(
    (candidate) =>
      planRouteIds.has(candidate.routeId ?? "") &&
      candidate.status !== "pending",
  ).length;
  const lockedFirstStopCount = planRoutes.filter(
    (candidate) => candidate.lockedFirstStopId != null,
  ).length;
  const missingResource =
    planPairs.length === 0 ||
    planPairs.some((pair) => {
      const vehicle = vehicles.find((candidate) => candidate.id === pair.vehicleId);
      const driver = drivers.find((candidate) => candidate.id === pair.driverId);
      return (
        !vehicle?.isActive ||
        !driver?.isActive ||
        driver.vehicleId !== pair.vehicleId
      );
    });
  const wholePlanDisabled =
    !activePlan ||
    lockedFirstStopCount > 0 ||
    lockedPlanStopCount > 0 ||
    missingResource ||
    draftLoading ||
    (draftId != null && !draft);
  const wholePlanDisabledReason = !activePlan
    ? "Planen är pågående eller avslutad"
    : lockedFirstStopCount > 0
      ? t("routeLock.wholePlanBlocked")
    : lockedPlanStopCount > 0
      ? `${lockedPlanStopCount} stopp är redan låsta`
      : missingResource
        ? "Aktiva resurser saknas"
        : draftLoading || (draftId != null && !draft)
          ? "Planeringsutkastet laddas"
          : null;

  const routePreview = usePreviewRouteReoptimization();
  const routeApply = useApplyRouteReoptimization();
  const planPreview = usePreviewImportRoutePlanReoptimization();
  const planApply = useApplyImportRoutePlanReoptimization();
  const working =
    refreshingRoute ||
    routePreview.isPending ||
    routeApply.isPending ||
    planPreview.isPending ||
    planApply.isPending;

  if (!canWrite) return null;

  const openDialog = (nextScope: "route" | "plan") => {
    setScope(nextScope);
    setPreview(null);
    setError(null);
    setConflict(false);
    setMenuOpen(false);
    setDialogOpen(true);
  };

  const previewRoute = async () => {
    setError(null);
    setConflict(false);
    setRefreshingRoute(true);
    try {
      const current = await previewCurrentRoute(route.id, getRoute, (latest) =>
        routePreview.mutateAsync({
          id: latest.id,
          data: {
            planRevision: latest.planRevision,
            depotLatitude,
            depotLongitude,
          },
        }),
      );
      setPreview({ scope: "route", ...current });
    } catch (cause) {
      const lockedFirstStopConflict = hasErrorCode(
        cause,
        "LOCKED_FIRST_STOP_CONFLICT",
      );
      const reason = routePreviewFailure(cause);
      const stale = errorStatus(cause) === 409 && !lockedFirstStopConflict && !reason;
      setError(
        reason ?? (lockedFirstStopConflict
          ? localizeError(cause, t, {
              fallbackKey: "common.errorRequestFailed",
            })
          : stale
          ? "Omruttningen blockerades av ruttens aktuella underlag. Kontrollera planens resurser och låsningar. Inget har sparats."
          : localizeError(cause, t, {
              fallbackKey: "common.errorRequestFailed",
            })),
      );
      setConflict(stale);
    } finally {
      setRefreshingRoute(false);
    }
  };

  const previewPlan = async () => {
    if (wholePlanDisabled || selectedPairs.length === 0) return;
    setError(null);
    setConflict(false);
    try {
      const result = await planPreview.mutateAsync({
        planId: route.planId,
        data: {
          ...(draftId ? { draftId, draftRevision: draft?.revision } : {}),
          routes: planRoutes.map((candidate) => {
            return {
              routeId: candidate.id,
              driverId: driverIdForRoute(candidate, drivers) ?? "",
              planRevision: candidate.planRevision,
            };
          }),
          pairs: selectedPairs,
          depotLatitude,
          depotLongitude,
        },
      });
      setPreview({ scope: "plan", result, routes: planRoutes });
    } catch (cause) {
      const lockedFirstStopConflict = hasErrorCode(
        cause,
        "LOCKED_FIRST_STOP_CONFLICT",
      );
      const stale = errorStatus(cause) === 409 && !lockedFirstStopConflict;
      setError(
        lockedFirstStopConflict
          ? localizeError(cause, t, {
              fallbackKey: "common.errorRequestFailed",
            })
          : stale
          ? "Planen eller resurserna ändrades. Skapa en ny förhandsvisning innan du sparar."
          : localizeError(cause, t, {
              fallbackKey: "common.errorRequestFailed",
            }),
      );
      setConflict(stale);
    }
  };

  const applyPreview = async () => {
    if (!preview) return;
    setError(null);
    try {
      if (preview.scope === "route") {
        await routeApply.mutateAsync({
          id: preview.route.id,
          data: {
            planRevision: preview.result.planRevision,
            depotLatitude,
            depotLongitude,
            optimizedStopIds: preview.result.optimizedStopIds,
          },
        });
      } else {
        const result = preview.result;
        await planApply.mutateAsync({
          planId: result.planId,
          data: {
            ...(draftId ? { draftId, draftRevision: draft?.revision } : {}),
            routes: preview.routes.map((candidate) => {
            return {
              routeId: candidate.id,
              driverId: driverIdForRoute(candidate, drivers) ?? "",
              planRevision: candidate.planRevision,
            };
          }),
            pairs: selectedPairs,
            depotLatitude,
            depotLongitude,
            proposalHash: result.proposalHash,
          },
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
        queryClient.invalidateQueries({ queryKey: ["planning-drafts"] }),
      ]);
      const savedPlanId =
        preview.scope === "plan" ? preview.result.planId : preview.route.planId;
      setPreview(null);
      setDialogOpen(false);
      await onSaved?.(savedPlanId);
    } catch (cause) {
      const lockedFirstStopConflict = hasErrorCode(
        cause,
        "LOCKED_FIRST_STOP_CONFLICT",
      );
      const stale = errorStatus(cause) === 409 && !lockedFirstStopConflict;
      setError(
        lockedFirstStopConflict
          ? localizeError(cause, t, {
              fallbackKey: "common.errorRequestFailed",
            })
          : stale
          ? "Planen eller resursunderlaget ändrades. Förhandsvisningen har blivit inaktuell – skapa en ny."
          : localizeError(cause, t, {
              fallbackKey: "common.errorRequestFailed",
            }),
      );
      setConflict(stale);
      if (stale) setPreview(null);
    }
  };

  const previewMetrics =
    preview?.scope === "route"
      ? {
          beforeStops:
            route.totalStops ??
            preview.result.pendingStopIds.length +
              preview.result.lockedStopIds.length,
          afterStops: preview.result.totalStops,
          beforeDistance: route.totalDistanceKm,
          afterDistance: preview.result.totalDistanceKm,
          beforeDuration: route.totalDurationMin,
          afterDuration: preview.result.totalDurationMin,
          moved: preview.result.optimizedStopIds.reduce(
            (count, stopId, index) =>
              preview.result.pendingStopIds[index] !== stopId
                ? count + 1
                : count,
            0,
          ),
          locked: preview.result.lockedStopIds.length,
        }
      : preview
        ? {
            beforeStops: preview.result.routes.reduce(
              (sum, candidate) => sum + candidate.before.stopCount,
              0,
            ),
            afterStops: preview.result.routes.reduce(
              (sum, candidate) => sum + candidate.after.stopCount,
              0,
            ),
            beforeDistance: preview.result.routes.reduce(
              (sum, candidate) => sum + (candidate.before.distanceKm ?? 0),
              0,
            ),
            afterDistance: preview.result.routes.reduce(
              (sum, candidate) => sum + (candidate.after.distanceKm ?? 0),
              0,
            ),
            beforeDuration: preview.result.routes.reduce(
              (sum, candidate) => sum + (candidate.before.durationMin ?? 0),
              0,
            ),
            afterDuration: preview.result.routes.reduce(
              (sum, candidate) => sum + (candidate.after.durationMin ?? 0),
              0,
            ),
            moved: preview.result.movedStopCount,
            locked: preview.result.lockedStopCount,
          }
        : null;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="reroute"
            size="sm"
            className={className}
            data-testid={`button-reoptimization-menu-${route.id}`}
            aria-label={`Optimeringsåtgärder för ${route.name}`}
          >
            <Zap className="mr-1.5 h-4 w-4" />
            Rutta om
            <ChevronDown className="ml-1.5 h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64">
          <DropdownMenuItem
            onSelect={() => openDialog("route")}
            data-testid={`preview-remaining-route-${route.id}`}
          >
            <RouteIcon className="mr-2 h-4 w-4" />
            Optimera återstående stopp i denna rutt
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={wholePlanDisabled}
            onSelect={() => openDialog("plan")}
            data-testid={`button-preview-whole-plan-${route.planId}`}
            title={
              !activePlan
                ? "Hela planen kan bara optimeras innan körningen startar."
                : lockedPlanStopCount > 0
                  ? "Hela planen kan inte optimeras när stopp redan har påbörjats."
                  : missingResource
                    ? "Alla rutter måste ha en aktiv resurs."
                    : undefined
            }
          >
            <Zap className="mr-2 h-4 w-4" />
            <span className="flex flex-col">
              <span>Optimera hela planen</span>
              {wholePlanDisabledReason && (
                <span className="text-[10px] text-muted-foreground">
                  {wholePlanDisabledReason}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!working) {
            setDialogOpen(open);
            if (!open) setPreview(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[90vh] max-w-3xl overflow-y-auto"
          data-testid={
            preview?.scope === "route"
              ? "remaining-route-preview-dialog"
              : "reoptimization-dialog"
          }
        >
          <DialogHeader>
            <DialogTitle>
              {scope === "route"
                ? "Optimera återstående stopp"
                : "Optimera hela planen"}
            </DialogTitle>
            <DialogDescription>
              Förhandsgranska ändringen först. Inget sparas förrän du väljer
              Spara.
            </DialogDescription>
          </DialogHeader>

          {(route.planningSummary?.objective === "areas_worktime" ||
            route.planningSummary?.optimizationEvidence?.effectiveObjective === "areas_worktime") && (
            <p className="rounded-lg border border-border bg-muted/10 p-3 text-sm text-muted-foreground" data-testid="areas-worktime-repartition-guidance">
              {t("import.optimizationAreasWorktimeScopeGuidance")}
            </p>
          )}

          {scope === "plan" && !preview && (
            <div
              className="space-y-3 rounded-lg border border-border bg-muted/10 p-3"
              data-testid="whole-plan-resource-selection"
            >
              <div>
                <p className="text-sm font-semibold">Valda resurser</p>
                <p className="text-xs text-muted-foreground">
                  Planens befintliga resurser används. Stopp kan flyttas
                  mellan dessa par, men inga resurser utanför planen läggs till.
                </p>
              </div>
              {planPairs.map((pair) => {
                const vehicle =
                  vehicles.find(
                    (candidate) => candidate.id === pair.vehicleId,
                  ) ??
                  planRoutes.find(
                    (candidate) => candidate.vehicleId === pair.vehicleId,
                  );
                const driver = drivers.find(
                  (candidate) => candidate.id === pair.driverId,
                );
                return (
                  <div
                    key={`${pair.vehicleId}:${pair.driverId}`}
                    className="flex items-center gap-2 text-sm"
                    data-testid={`resource-pair-${pair.vehicleId}-${pair.driverId}`}
                  >
                    <span aria-hidden="true">•</span>
                    <span>
                      {vehicle?.name ?? driver?.name ?? pair.vehicleId}
                    </span>
                  </div>
                );
              })}
              {wholePlanDisabled && (
                <p
                  className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
                  data-testid="whole-plan-disabled-reason"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {!activePlan
                    ? "Planen är pågående eller avslutad."
                    : lockedPlanStopCount > 0
                      ? `${lockedPlanStopCount} stopp är redan låsta. Optimera återstående rutt i stället.`
                      : "Aktiva resurser saknas eller planeringsutkastet laddas fortfarande."}
                </p>
              )}
              {error && (
                <p
                  className="text-sm text-destructive"
                  role="alert"
                  data-testid="reoptimization-error"
                >
                  {error}
                </p>
              )}
              <Button
                onClick={() => void previewPlan()}
                disabled={
                  working || wholePlanDisabled || selectedPairs.length === 0
                }
                data-testid="button-create-whole-plan-preview"
              >
                {planPreview.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Optimera och förhandsgranska
              </Button>
            </div>
          )}

          {scope === "route" && !preview && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Aktiva och avslutade stopp behåller sin plats. Endast
                återstående stopp kan flyttas.
              </p>
              {error && (
                <p
                  className="text-sm text-destructive"
                  role="alert"
                  data-testid="reoptimization-error"
                >
                  {error}
                </p>
              )}
              <Button
                onClick={() => void previewRoute()}
                disabled={working}
                data-testid="button-create-route-preview"
              >
                {routePreview.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Optimera och förhandsgranska
              </Button>
            </div>
          )}

          {preview && previewMetrics && (
            <div
              className="space-y-4"
              data-testid={`reoptimization-preview-${preview.scope}`}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric
                  label="Stopp före → efter"
                  value={`${previewMetrics.beforeStops} → ${previewMetrics.afterStops}`}
                  testId="metric-stop-count"
                />
                <Metric
                  label="Distans före → efter"
                  value={`${formatMetric(previewMetrics.beforeDistance, " km")} → ${formatMetric(previewMetrics.afterDistance, " km")}`}
                  testId="metric-distance"
                />
                <Metric
                  label="Tid före → efter"
                  value={`${formatMetric(previewMetrics.beforeDuration, " min")} → ${formatMetric(previewMetrics.afterDuration, " min")}`}
                  testId="metric-duration"
                />
                <Metric
                  label="Flyttade / låsta"
                  value={`${previewMetrics.moved} / ${previewMetrics.locked}`}
                  testId="metric-moved-locked"
                />
              </div>
              {preview.scope === "route" &&
                preview.result.lockedStopIds.length > 0 && (
                  <div
                    className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
                    data-testid="remaining-route-locked-summary"
                  >
                    <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                      {preview.result.lockedStopIds.length} låsta stopp
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Slutförda och pågående stopp behåller sin plats.
                    </p>
                  </div>
                )}
              {preview.scope === "route" && (
                <ol
                  className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2"
                  data-testid="remaining-route-preview-order"
                >
                  {preview.result.optimizedStopIds.map((stopId, index) => (
                    <li
                      key={stopId}
                      data-stop-id={stopId}
                      className="flex items-center gap-2 rounded px-2 py-1 text-sm"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="truncate">
                        {stops.find((candidate) => candidate.id === stopId)
                          ?.address ?? stopId}
                      </span>
                      {preview.result.lockedStopIds.includes(stopId) && (
                        <span className="ml-auto text-xs font-semibold text-emerald-600">
                          Låst
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {conflict && (
                <p
                  className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                  data-testid="reoptimization-conflict"
                >
                  <AlertTriangle className="h-4 w-4" /> {error}
                </p>
              )}
              {error && !conflict && (
                <p
                  className="text-sm text-destructive"
                  role="alert"
                  data-testid="reoptimization-error"
                >
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreview(null);
                    setError(null);
                    setConflict(false);
                  }}
                  disabled={working}
                  data-testid="button-cancel-reoptimization"
                >
                  Avbryt
                </Button>
                <Button
                  onClick={() => void applyPreview()}
                  disabled={working || conflict}
                  data-testid={
                    preview.scope === "route"
                      ? "apply-remaining-route-preview"
                      : "button-apply-reoptimization"
                  }
                >
                  {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Spara optimering
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
