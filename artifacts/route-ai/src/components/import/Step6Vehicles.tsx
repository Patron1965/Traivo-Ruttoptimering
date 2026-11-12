import { ImportInfoSection } from "./ImportInfoDisclosure";
import { ResourceSelectionMode } from "./ResourceSelectionMode";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ImportRoutePlanResult,
  type PlanningInputs,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  BatteryCharging,
  Check,
  Loader2,
  Package,
  Truck,
  User,
  Clock,
  MapPin,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { ImportDriver, ImportVehicle } from "./types";
import { localizeError } from "@/lib/localize-error";
import { PLANNING_OBJECTIVES, objectiveTranslationSuffix, type RoutePlanningObjective } from "@/lib/planning-objectives";
import { getInitialPlanReadiness } from "@/lib/import-planning-readiness";
import { useRoutes } from "@/hooks/use-routes";
import {
  useImportRoutePlanMonitor,
  type ImportRoutePlanMonitorScope,
} from "@/lib/import-route-plan-progress";
import { OptimizationProgressCard } from "@/components/import/OptimizationProgressCard";
import { shouldShowStepError } from "@/lib/compact-layout";
import { PlanningAllowanceSettings, usePlanningAllowanceDefaults } from "./PlanningAllowanceSettings";
import { effectivePlanningAllowances, planningAllowancesKnown } from "@/lib/planning-allowances";

import type { Stop } from "@workspace/api-client-react";

interface Step6VehiclesProps {
  draftId?: string;
  stopIds: string[];
  stops?: Stop[];
  vehicles: ImportVehicle[];
  drivers: ImportDriver[];
  date: string;
  depotLatitude: number;
  depotLongitude: number;
  onNext: (result: ImportRoutePlanResult) => Promise<void> | void;
  /**
   * Flush the draft's debounced planning-input write before the plan becomes
   * immutable. Without this barrier, a fast optimize click can let the plan
   * request win the draft race and the subsequent UI transition is rejected
   * as a frozen draft update.
   */
  onBeforePlan?: () => Promise<void>;
  onBack: () => void;
  selectedPairValues: string[];
  onChangeSelectedPairValues: (values: string[]) => void;
  planningInputs: PlanningInputs;
  planningMetadata: PlanningMetadata;
  onChangePlanningInputs?: (inputs: PlanningInputs) => void;
  onChangePlanningMetadata?: (meta: PlanningMetadata) => void;
  organizationId?: string;
  userId?: string;
}

export type PlanningMetadata = {
  customerReference: string | null;
  sharedInstructions: string | null;
};

interface VehicleDriverPair {
  vehicle: ImportVehicle;
  driver: ImportDriver;
}

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type OptimizationProfile = RoutePlanningObjective;

function pairValue(pair: VehicleDriverPair): string {
  return `${pair.vehicle.id}|${pair.driver.id}`;
}

function canonicalPairValue(value: string): string {
  return value.replace("|", ":");
}

function effectiveStopPriority(
  stop: Stop,
  priorities: PlanningInputs["stopPriorities"],
): 0 | 1 | 2 {
  const override = priorities[stop.id];
  if (override != null) return override;
  return stop.priority === 2 ? 2 : stop.priority === 1 ? 1 : 0;
}

function assignmentDate(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("A valid planning date is required.");
  }
  return parsed.toISOString();
}

type VehiclePlanConflict = {
  vehicleId: string;
  vehicleName?: string | null;
  routeId?: string | null;
  planId?: string | null;
  draftId?: string | null;
  draftName?: string | null;
  date?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function getVehiclePlanConflicts(error: unknown): VehiclePlanConflict[] {
  const root = asRecord(error);
  const response = asRecord(root?.response);
  const data = asRecord(root?.data) ?? asRecord(root?.body);
  const responseData = asRecord(response?.data);
  const roots = [root, data, response, responseData].filter(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate),
  );
  const hasConflictCode = roots.some((candidate) => (
    candidate.code === "VEHICLE_ALREADY_PLANNED"
    || candidate.code === "vehicle_already_planned"
  ));
  if (!hasConflictCode) return [];
  const details = roots
    .map((candidate) => asRecord(candidate.details))
    .find((candidate) => Array.isArray(candidate?.conflicts));
  if (!details || !Array.isArray(details.conflicts)) return [];
  return details.conflicts.flatMap((candidate) => {
    const conflict = asRecord(candidate);
    if (!conflict || typeof conflict.vehicleId !== "string") return [];
    return [{
      vehicleId: conflict.vehicleId,
      vehicleName: typeof conflict.vehicleName === "string" ? conflict.vehicleName : null,
      routeId: typeof conflict.routeId === "string" ? conflict.routeId : null,
      planId: typeof conflict.planId === "string" ? conflict.planId : null,
      draftId: typeof conflict.draftId === "string" ? conflict.draftId : null,
      draftName: typeof conflict.draftName === "string" ? conflict.draftName : null,
      date: typeof conflict.date === "string" ? conflict.date : null,
    }];
  });
}

export function Step6Vehicles({
  draftId,
  stopIds,
  stops,
  vehicles,
  drivers,
  date,
  depotLatitude,
  depotLongitude,
  onNext,
  onBeforePlan,
  onBack,
  selectedPairValues: savedSelectedPairValues,
  onChangeSelectedPairValues,
  planningInputs,
  planningMetadata,
  onChangePlanningInputs,
  onChangePlanningMetadata,
  organizationId,
  userId,
}: Step6VehiclesProps) {
  const { t } = useTranslation();
  const allowanceDefaults = usePlanningAllowanceDefaults();
  const currentAllowanceCeilings = allowanceDefaults.isError ? undefined : allowanceDefaults.data;
  const effectiveAllowances = effectivePlanningAllowances(planningInputs, currentAllowanceCeilings);

  const availablePairs = useMemo<VehicleDriverPair[]>(() => {
    const activeVehicles = vehicles.filter((vehicle) => vehicle.isActive);
    const activeDrivers = drivers.filter(
      (driver) => driver.isActive && driver.vehicleId,
    );
    return activeVehicles.flatMap((vehicle) => {
      const profiles = activeDrivers.filter((driver) => driver.vehicleId === vehicle.id);
      return profiles.length === 1 ? [{ vehicle, driver: profiles[0] }] : [];
    });
  }, [drivers, vehicles]);

  const selectedPairValues = useMemo(
    () => new Set(savedSelectedPairValues),
    [savedSelectedPairValues],
  );
  const optimizationProfile = planningInputs.objective;
  const travelReservePercent = planningInputs.travelReservePercent;
  const stopReserveMin = planningInputs.stopReserveMin;

  const updateInputs = (patch: Partial<PlanningInputs>) => {
    const next = { ...planningInputs, ...patch };
    if (onChangePlanningInputs) onChangePlanningInputs(next);
  };

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [vehiclePlanConflicts, setVehiclePlanConflicts] = useState<VehiclePlanConflict[]>([]);
  const { data: existingRoutes } = useRoutes();
  const progressScope = useMemo<ImportRoutePlanMonitorScope | undefined>(
    () =>
      draftId && organizationId && userId
        ? { draftId, organizationId, userId }
        : undefined,
    [draftId, organizationId, userId],
  );
  const handleMonitorError = useCallback((error: { message: string; details?: unknown }) => {
    const conflicts = getVehiclePlanConflicts({
      data: { details: error.details },
    });
    if (conflicts.length > 0) {
      setVehiclePlanConflicts(conflicts);
    }
    setErrorMessage(error.message);
  }, []);
  const progressMonitor = useImportRoutePlanMonitor({
    scope: progressScope,
    onComplete: onNext,
    onTerminalError: handleMonitorError,
  });

  const selectedPairs = useMemo(
    () =>
      availablePairs.filter((pair) => selectedPairValues.has(pairValue(pair))),
    [availablePairs, selectedPairValues],
  );
  const stopReadiness = useMemo(
    () => getInitialPlanReadiness(stopIds, stops),
    [stopIds, stops],
  );

  const isPending = progressMonitor.isBusy;
  const verifiedRouteDepotOptions = useMemo(
    () =>
      (existingRoutes ?? []).flatMap((route) => {
        const depotSnapshot = route.depotSnapshot;
        if (
          !depotSnapshot?.start.address ||
          !depotSnapshot.start.verifiedAt ||
          !depotSnapshot.end?.verifiedAt
        ) {
          return [];
        }
        const vehicle = vehicles.find(
          (candidate) => candidate.id === route.vehicleId,
        );
        return [
          {
            value: `route:${route.id}`,
            label: `${vehicle?.name ?? route.name} — ${depotSnapshot.start.address}`,
          },
        ];
      }),
    [existingRoutes, vehicles],
  );

  const togglePair = (value: string) => {
    const next = new Set<string>(selectedPairValues);
    if (next.has(value)) {
      next.delete(value);
    } else {
      const pair = availablePairs.find(
        (candidate) => pairValue(candidate) === value,
      );
      if (!pair) return;
      for (const candidate of availablePairs) {
        if (
          candidate.vehicle.id === pair.vehicle.id ||
          candidate.driver.id === pair.driver.id
        ) {
          next.delete(pairValue(candidate));
        }
      }
      next.add(value);
    }
    onChangeSelectedPairValues(Array.from(next));
  };

  const toggleDailyPairExclusion = (value: string) => {
    const canonicalValue = canonicalPairValue(value);
    const excluded = new Set(planningInputs.excludedPairValues);
    if (excluded.has(canonicalValue)) {
      excluded.delete(canonicalValue);
    } else {
      excluded.add(canonicalValue);
    }
    updateInputs({ excludedPairValues: Array.from(excluded) });
  };

  const handleOptimizationChange = (val: string) => {
    updateInputs({ objective: val as PlanningInputs["objective"] });
  };

  const handleAssign = async () => {
    setErrorMessage(null);
    setVehiclePlanConflicts([]);
    if (!planningAllowancesKnown(effectiveAllowances)) {
      setErrorMessage("Kontrollera tillåten övertid och försening före beräkningen. Gränserna kunde inte hämtas; ange dem i planeringsinställningarna nedan.");
      return;
    }
    if (!stopReadiness.ready) {
      setErrorMessage(t("import.planStopsNotReady"));
      return;
    }
    try {
      // The monitor creates one client-owned progress identity and never
      // replays this POST after a timeout or gateway response.
      void progressMonitor.start({
        stopIds,
        pairs: selectedPairs.map((p) => ({
          vehicleId: p.vehicle.id,
          driverId: p.driver.id,
        })),
        date: assignmentDate(date),
        depotLatitude,
        depotLongitude,
        draftId,
        planningInputs,
        customerReference: planningMetadata?.customerReference || null,
        sharedInstructions: planningMetadata?.sharedInstructions || null,
      }, async () => {
        await onBeforePlan?.();
      });
    } catch (error) {
      const conflicts = getVehiclePlanConflicts(error);
      if (conflicts.length > 0) {
        setVehiclePlanConflicts(conflicts);
        return;
      }
      setErrorMessage(localizeError(
        error,
        t,
        { fallbackKey: "import.assignRoutesFailed" },
      ));
    }
  };

  const unselectConflictingVehicles = () => {
    const conflictingVehicleIds = new Set(vehiclePlanConflicts.map((conflict) => conflict.vehicleId));
    onChangeSelectedPairValues(
      Array.from(selectedPairValues).filter((value) => {
        const pair = availablePairs.find((candidate) => pairValue(candidate) === value);
        return !pair || !conflictingVehicleIds.has(pair.vehicle.id);
      }),
    );
    setVehiclePlanConflicts([]);
    setErrorMessage(null);
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t("import.vehicleSelectionTitle")}
        </h2>
        <ImportInfoSection category="help" title="Hjälptext" className="mt-1">
          <p className="text-sm text-muted-foreground">
            {t("import.vehicleSelectionDescription")}
          </p>
        </ImportInfoSection>
      </div>

      {availablePairs.length === 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t("import.noAvailableVehiclePairs")}
          </AlertDescription>
        </Alert>
      )}

      {shouldShowStepError(errorMessage, {
        visible: Boolean(progressMonitor.state.progressId),
        status: progressMonitor.state.status,
        errorMessage: progressMonitor.state.error?.message,
      }) && (
        <Alert variant="destructive" data-testid="planning-step-error">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p>{errorMessage}</p>
          </AlertDescription>
        </Alert>
      )}

      {vehiclePlanConflicts.length > 0 && (
        <Alert variant="destructive" data-testid="vehicle-plan-conflict">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p>{t("import.vehicleAlreadyPlanned")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {vehiclePlanConflicts.map((conflict) => (
                <li key={`${conflict.vehicleId}:${conflict.routeId ?? conflict.planId ?? "plan"}`}>
                  <span className="font-medium">
                    {conflict.vehicleName
                      ?? vehicles.find((vehicle) => vehicle.id === conflict.vehicleId)?.name
                      ?? t("import.unknownVehicle")}
                  </span>
                  {(conflict.draftName || conflict.planId) && (
                    <> — {conflict.draftName ?? t("import.existingPlan")}</>
                  )}
                  {conflict.date && <> ({conflict.date.slice(0, 10)})</>}
                  {conflict.planId && (
                    <>
                      {" "}
                      <a
                        className="font-semibold underline"
                        href={`/dispatch?planId=${encodeURIComponent(conflict.planId)}`}
                      >
                        {t("import.openExistingPlan")}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={unselectConflictingVehicles}
            >
              {t("import.unselectBookedVehicles")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {progressMonitor.state.progressId && (
        <OptimizationProgressCard
          phase={progressMonitor.state.phase}
          status={progressMonitor.state.status === "complete" ? "running" : progressMonitor.state.status}
          stopCount={stopIds.length}
          resourceCount={selectedPairs.length}
          objectiveLabel={t(`import.optimization${objectiveTranslationSuffix(optimizationProfile)}`)}
          elapsedMs={progressMonitor.state.elapsedMs}
          estimatedRemainingMs={progressMonitor.state.estimatedRemainingMs}
          errorMessage={progressMonitor.state.error?.message ?? undefined}
          onRetry={progressMonitor.state.status === "reconnecting" ||
            progressMonitor.state.status === "error"
            ? progressMonitor.retryChecking
            : undefined}
        />
      )}

      {!isPending && (
      <div>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
          <div>
            <p className="font-medium">{t("import.availableVehicles")}</p>
            <p className="text-xs text-muted-foreground">
              {t("import.selectedResourcesCount", {
                selected: selectedPairs.length,
              })}
            </p>
          </div>
          {selectedPairs.length > 0 && (
            <Badge className="gap-1 bg-emerald-600">
              <Check className="h-3 w-3" />
              {t("import.selectedResources", { count: selectedPairs.length })}
            </Badge>
          )}
        </div>
        <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
          {availablePairs.map((pair) => {
            const value = pairValue(pair);
            const checked = selectedPairValues.has(value);
            return (
              <label
                key={value}
                htmlFor={`pair-${pair.vehicle.id}-${pair.driver.id}`}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors ${
                  checked
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <Checkbox
                  id={`pair-${pair.vehicle.id}-${pair.driver.id}`}
                  data-testid={`planning-draft-vehicle-pair-${pair.vehicle.id}-${pair.driver.id}`}
                  checked={checked}
                  disabled={isPending}
                  onCheckedChange={() => togglePair(value)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {pair.vehicle.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {pair.vehicle.licensePlate || "Resurs"}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Package className="h-3.5 w-3.5" />
                      {pair.vehicle.capacityKg} kg
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Truck className="h-3.5 w-3.5" />
                      {pair.vehicle.capacityVolume} m³
                    </span>
                    {pair.vehicle.vehicleType === "electric" &&
                      pair.vehicle.rangeKm != null && (
                        <span className="inline-flex items-center gap-1">
                          <BatteryCharging className="h-3.5 w-3.5" />
                          {pair.vehicle.rangeKm} km
                        </span>
                      )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Card>

      <details className="mt-3 rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold">
          {t("import.dailyPairExclusions")}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("import.dailyPairExclusionsDescription")}
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {availablePairs.map((pair) => {
            const value = pairValue(pair);
            const excluded = planningInputs.excludedPairValues.includes(
              canonicalPairValue(value),
            );
            return (
              <label
                key={value}
                className="flex items-center gap-3 rounded-lg border p-3 text-sm"
              >
                <Checkbox
                  data-testid={`planning-draft-daily-pair-exclusion-${pair.vehicle.id}-${pair.driver.id}`}
                  checked={excluded}
                  disabled={isPending}
                  onCheckedChange={() => toggleDailyPairExclusion(value)}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {pair.vehicle.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {pair.vehicle.licensePlate || "Resurs"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </details>

      <fieldset className="mt-3">
        <legend className="mb-2 text-sm font-semibold">
          {t("import.optimizationGoal")}
        </legend>
        <RadioGroup
          value={optimizationProfile}
          onValueChange={handleOptimizationChange}
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          {PLANNING_OBJECTIVES.map((profile) => (
            <label
              key={profile}
              htmlFor={`import-optimization-profile-${profile}`}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors ${
                optimizationProfile === profile
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/40"
              }`}
            >
              <RadioGroupItem
                value={profile}
                id={`import-optimization-profile-${profile}`}
                className="mt-0.5 shrink-0"
              />
              <span>
                <span className="block text-sm font-medium">{t(`import.optimization${objectiveTranslationSuffix(profile)}`)}</span>
                <span className="mt-0.5 block text-xs leading-tight text-muted-foreground">
                  {t(`import.optimization${objectiveTranslationSuffix(profile)}Description`)}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <ResourceSelectionMode inputs={planningInputs} onChange={updateInputs} />
      </fieldset>

      <PlanningAllowanceSettings inputs={planningInputs} defaults={currentAllowanceCeilings}
        loadFailed={allowanceDefaults.isError} onChange={updateInputs} />
      <fieldset className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-3">
          <div>
            <Label
              htmlFor="travelReservePercent"
              className="text-sm font-semibold flex items-center gap-1.5"
            >
              <Clock className="h-4 w-4" />
              {t("import.travelReserve")}
            </Label>
            <p className="mt-1 mb-2 text-xs text-muted-foreground">
              {t("import.travelReserveDescription")}
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="travelReservePercent"
                type="number"
                min={0}
                max={100}
                value={travelReservePercent}
                onChange={(e) =>
                  updateInputs({
                    travelReservePercent: parseInt(e.target.value) || 0,
                  })
                }
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <Label
              htmlFor="stopReserveMin"
              className="text-sm font-semibold flex items-center gap-1.5"
            >
              <Clock className="h-4 w-4" />
              {t("import.stopReserve")}
            </Label>
            <p className="mt-1 mb-2 text-xs text-muted-foreground">
              {t("import.stopReserveDescription")}
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="stopReserveMin"
                type="number"
                min={0}
                max={120}
                value={stopReserveMin}
                onChange={(e) =>
                  updateInputs({
                    stopReserveMin: parseInt(e.target.value) || 0,
                  })
                }
                className="w-24"
              />
              <span className="text-sm text-muted-foreground">
                {t("import.minutes")}
              </span>
            </div>
          </div>
        </div>
      </fieldset>

      <div className="mt-3 space-y-3 pt-3 border-t border-border/50">
        <div>
          <Label className="text-sm font-semibold flex items-center gap-1.5">
            <Package className="h-4 w-4" />
            {t("import.stopPriority")}
          </Label>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">
            {t("import.stopPriorityDescription")}
          </p>
          {stops && stops.length > 0 && (
            <div className="max-h-60 [@media(max-height:820px)]:max-h-44 overflow-y-auto rounded-md border border-border bg-card divide-y divide-border">
              {stops.map((stop) => (
                <div
                  key={stop.id}
                  className="flex items-center justify-between p-2.5 text-sm"
                >
                  <div className="min-w-0 flex-1 pr-4">
                    <p className="truncate font-medium">{stop.address}</p>
                    {stop.contactName && (
                      <p className="text-xs text-muted-foreground truncate">
                        {stop.contactName}
                      </p>
                    )}
                  </div>
                  <Select
                    value={String(
                      effectiveStopPriority(
                        stop,
                        planningInputs.stopPriorities,
                      ),
                    )}
                    onValueChange={(val) => {
                      updateInputs({
                        stopPriorities: {
                          ...planningInputs.stopPriorities,
                          [stop.id]: Number(val) as 0 | 1 | 2,
                        },
                      });
                    }}
                  >
                    <SelectTrigger className="w-[140px] h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">
                        {t("import.priorityNormal")}
                      </SelectItem>
                      <SelectItem value="1">
                        {t("import.priorityHigh")}
                      </SelectItem>
                      <SelectItem value="2">
                        {t("import.priorityMandatory")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 space-y-3 pt-3 border-t border-border/50">
        <div>
          <Label className="text-sm font-semibold flex items-center gap-1.5">
            <MapPin className="h-4 w-4" />
            {t("import.depotOverride")}
          </Label>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">
            {t("import.depotOverrideDescription")}
          </p>
          <div className="flex items-center gap-4">
            <Select
              value={planningInputs.depotOverride?.scope || "none"}
              onValueChange={(val) => {
                if (val === "none") {
                  updateInputs({ depotOverride: null });
                } else if (val === "plan") {
                  updateInputs({
                    depotOverride: {
                      scope: "plan",
                      verifiedDepotId:
                        planningInputs.depotOverride?.verifiedDepotId ??
                        "organization-default",
                    },
                  });
                } else if (val === "pair") {
                  updateInputs({
                    depotOverride: {
                      scope: "pair",
                      vehicleId: selectedPairs[0]?.vehicle.id,
                      verifiedDepotId:
                        planningInputs.depotOverride?.verifiedDepotId ??
                        "organization-default",
                    },
                  });
                }
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder={t("import.noDepotOverride")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("import.noDepotOverride")}
                </SelectItem>
                <SelectItem value="plan">
                  {t("import.depotOverridePlan")}
                </SelectItem>
                <SelectItem value="pair">
                  {t("import.depotOverridePair")}
                </SelectItem>
              </SelectContent>
            </Select>

            {planningInputs.depotOverride?.scope === "pair" && (
              <Select
                value={planningInputs.depotOverride.vehicleId || ""}
                onValueChange={(val) => {
                  updateInputs({
                    depotOverride: {
                      scope: "pair",
                      vehicleId: val,
                      verifiedDepotId:
                        planningInputs.depotOverride?.verifiedDepotId ??
                        "organization-default",
                    },
                  });
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder={t("import.selectVehicle")} />
                </SelectTrigger>
                <SelectContent>
                  {selectedPairs.map((p) => (
                    <SelectItem key={p.vehicle.id} value={p.vehicle.id}>
                      {p.vehicle.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {planningInputs.depotOverride && (
              <Select
                value={planningInputs.depotOverride.verifiedDepotId}
                onValueChange={(verifiedDepotId) => {
                  updateInputs({
                    depotOverride: {
                      ...planningInputs.depotOverride!,
                      verifiedDepotId,
                    },
                  });
                }}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder={t("import.verifiedDepot")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="organization-default">
                    {t("import.organizationDefaultDepot")}
                  </SelectItem>
                  {verifiedRouteDepotOptions.map((depot) => (
                    <SelectItem key={depot.value} value={depot.value}>
                      {depot.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </div>
      </div>
      )}

      <div className="sticky bottom-0 z-20 -mx-1 border-t bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex items-center justify-between" data-testid="import-vehicles-actions">
        <Button variant="ghost" onClick={onBack} disabled={isPending}>
          {t("common.back")}
        </Button>
        <Button
          data-testid="planning-draft-optimize"
          onClick={() => void handleAssign()}
          disabled={selectedPairs.length === 0 || isPending || !stopReadiness.ready}
        >
          {isPending && progressMonitor.state.status === "running" && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
          {isPending
            ? t(progressMonitor.state.status === "starting"
              ? "import.optimizationProgress.preparing"
              : progressMonitor.state.status === "running"
                ? "import.optimizationProgress.optimizingButton"
                : "import.optimizationProgress.checkingStatus")
            : t("import.optimizationProgress.startOptimization")}
        </Button>
      </div>
    </div>
  );
}
