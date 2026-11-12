import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  getGetRouteStopsQueryKey,
  getGetStopQueryKey,
  getGetRouteQueryKey,
  getGetImportRoutePlanApprovalQueryKey,
  getStop,
  getRoute,
  getRouteStops,
  useAdjustAssignedRoutes,
  usePreviewAssignedRouteAdjustments,
  type RouteAdjustmentInput,
  type RouteAdjustmentPreview,
  useReoptimizeImportRoutePlan,
  useReoptimizeImportRoutePlanPlanningInputs,
  useGetImportRoutePlanPlanningSummary,
  type ImportRoutePlanDiagnostic,
  type PlanningInputs,
  type PlanningInputsReoptimizationResult,
  type PlanningSummaryResponse,
  type Route,
} from "@workspace/api-client-react";
import { Textarea } from "@/components/ui/textarea";
import { PLANNING_OBJECTIVES, objectiveTranslationSuffix } from "@/lib/planning-objectives";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Loader2,
  LockKeyhole,
  MapPin,
  Truck,
  Save,
  Info,
  AlertCircle,
  User,
  Palette,
  WandSparkles,
  MessageSquare,
  ListChecks,
  Target,
  Clock,
  Package,
  CircleHelp,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RouteMap } from "@/components/map/RouteMap";
import type {
  ImportAssignedRoute,
  ImportDriver,
  ImportStop,
  ImportVehicle,
} from "./types";
import { getApiErrorMessage } from "./types";
import type { PlanningMetadata } from "./Step6Vehicles";
import { cn } from "@/lib/utils";
import { useUpdateVehicle } from "@/hooks/use-vehicles";
import { ROUTE_COLORS } from "@/lib/constants";
import { localizeError, TrustedLocalizedError } from "@/lib/localize-error";
import { useRoutes } from "@/hooks/use-routes";
import { LockedFirstStopControl } from "@/components/routes/LockedFirstStopControl";
import { OptimizationResultSummary } from "@/components/import/OptimizationProgressCard";
import { unplannedStopDiagnosticPresentation } from "@/lib/unplanned-stop-diagnostic";
import { routeAdjustmentAction, runRouteAdjustment } from "@/lib/route-adjustment-workflow";
import { captureAdjustmentDraft, sameAdjustmentDraft, boundAdjustmentConfirmation } from "@/lib/combined-adjustment-review";
import { metricText } from "@/lib/planner-corrections";
import { PlanningAllowanceSettings, usePlanningAllowanceDefaults } from "./PlanningAllowanceSettings";
import { ImportInfoSection, useImportInfo } from "./ImportInfoDisclosure";
import { effectivePlanningAllowances, planningAllowanceText, planningAllowancesKnown } from "@/lib/planning-allowances";
import {
  normalizeRouteOverlapExplanation,
  routeOverlapReasonKey,
  type NormalizedRouteOverlapExplanation,
} from "@/lib/route-overlap-explanation";

interface Step7AdjustProps {
  draftId?: string;
  planId?: string;
  routes: ImportAssignedRoute[];
  unplannedStops: ImportStop[];
  /**
   * The list view can be stale while a plan is being resumed from a fixture
   * or another planning tab. Keep the authoritative stop ids separate and
   * use this list only as a local detail cache; the per-stop reads below
   * remain the fallback for newly created stops.
   */
  availableStops?: ImportStop[];
  unplannedStopIds?: string[];
  unplannedDiagnostics: ImportRoutePlanDiagnostic[];
  vehicles: ImportVehicle[];
  drivers: ImportDriver[];
  depotLatitude?: number;
  depotLongitude?: number;
  /** Started or terminal routes can be inspected, but server constraints forbid edits. */
  readOnly?: boolean;
  onNext: (routes: ImportAssignedRoute[]) => void;
  onValidated: (routes: ImportAssignedRoute[]) => Promise<void>;
  onBack?: () => void;
  allowResourceSelection?: boolean;
  draftRevision?: number;
  planningInputs?: PlanningInputs;
  focusOptimization?: boolean;
  planningMetadata?: PlanningMetadata;
  onChangePlanningInputs?: (inputs: PlanningInputs) => void;
  onChangePlanningMetadata?: (meta: PlanningMetadata) => void;
  onSaveCustomerReference?: (meta: PlanningMetadata) => Promise<void>;
  onPlanningReoptimized?: (
    result: PlanningInputsReoptimizationResult,
    summary: PlanningSummaryResponse,
  ) => Promise<ImportAssignedRoute[]>;
}

type LocalRoute = ImportAssignedRoute & { stops: ImportStop[] };

function canonicalPairValue(value: string): string {
  return value.replace("|", ":");
}

function resourcePairLabel(
  pairValue: string,
  vehicles: ImportVehicle[],
  drivers: ImportDriver[],
): string {
  const [vehicleId, driverId] = pairValue.split(":");
  const vehicle = vehicles.find((candidate) => candidate.id === vehicleId);
  return vehicle?.name || vehicle?.licensePlate
    || drivers.find((candidate) => candidate.id === driverId)?.name
    || "Okänd resurs";
}

function objectiveLabel(
  objective: PlanningInputs["objective"] | null | undefined,
  t: (key: string) => string,
): string {
  if (!objective) return t("import.optimizationEvidenceUnknown");
  return t(`import.optimization${objectiveTranslationSuffix(objective)}`);
}

function weightLabel(
  weights:
    | {
        distanceWeight?: number;
        co2Weight?: number;
        etaPrecisionWeight?: number;
        driverHappinessWeight?: number;
        geographicCohesionWeight?: number;
      }
    | null
    | undefined,
): string {
  if (!weights) return "—";
  return [
    `D ${(weights.distanceWeight ?? 0).toFixed(2)}`,
    `CO₂ ${(weights.co2Weight ?? 0).toFixed(2)}`,
    `ETA ${(weights.etaPrecisionWeight ?? 0).toFixed(2)}`,
    `Driver ${(weights.driverHappinessWeight ?? 0).toFixed(2)}`,
    `Geo ${(weights.geographicCohesionWeight ?? 0).toFixed(2)}`,
  ].join(" · ");
}

function planningInputsSignature(
  inputs: PlanningInputs | null | undefined,
): string {
  if (!inputs) return "";
  // Policy fields were added after the original draft shape. The API
  // normalizes an omitted legacy value to its zero default, so compare the
  // semantic value rather than treating an omitted optional field as a
  // different plan.
  // The server also materializes Normal (0) for every selected stop; omit
  // those entries so a sparse browser draft has the same semantic inputs.
  return JSON.stringify({
    version: inputs.version,
    objective: inputs.objective,
    travelReservePercent: inputs.travelReservePercent,
    stopReserveMin: inputs.stopReserveMin,
    stopPriorities: Object.fromEntries(
      Object.entries(inputs.stopPriorities)
        .filter(([, priority]) => priority !== 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    excludedPairValues: [...inputs.excludedPairValues].sort(),
    depotOverride: inputs.depotOverride,
    vehicleSelectionMode: inputs.vehicleSelectionMode,
    maxDriverOvertimeMin: inputs.maxDriverOvertimeMin ?? null,
    allowLateStopsMin: inputs.allowLateStopsMin ?? null,
  });
}

function sameStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function overlapStatusClass(status: NormalizedRouteOverlapExplanation["status"]): string {
  if (status === "verified") {
    return "border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-100";
  }
  if (status === "incomplete") {
    return "border-orange-500/30 bg-orange-500/5 text-orange-900 dark:text-orange-100";
  }
  return "border-slate-400/30 bg-slate-500/5 text-slate-800 dark:text-slate-100";
}

function overlapStatusIcon(status: NormalizedRouteOverlapExplanation["status"]) {
  return status === "verified" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />;
}

function RouteOverlapExplanationPanel({
  explanation,
  routeId,
  routeNamesById,
  routeIdsByVehicleId,
  stopAddressesById,
  t,
}: {
  explanation: NormalizedRouteOverlapExplanation;
  routeId: string;
  routeNamesById: Map<string, string>;
  routeIdsByVehicleId: Map<string, string>;
  stopAddressesById: Map<string, string>;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const reasonKey = routeOverlapReasonKey(explanation.reasonCode);
  const affectedRouteIds = Array.from(
    new Set([
      routeId,
      ...explanation.affectedVehicleIds
        .map((vehicleId) => routeIdsByVehicleId.get(vehicleId))
        .filter((value): value is string => Boolean(value)),
    ]),
  );
  const affectedStopIds = explanation.affectedStopIds;
  const statusLabel =
    explanation.status === "verified"
      ? t("import.overlapVerifiedConstraint")
      : explanation.status === "incomplete"
        ? t("import.overlapAnalysisIncomplete")
        : t("import.overlapNoVerifiedConstraint");

  return (
    <details
      className={cn(
        "group border-b px-3 py-2 text-xs",
        overlapStatusClass(explanation.status),
      )}
      data-testid={`geographic-overlap-explanation-${routeId}`}
    >
      <summary
        className="flex cursor-pointer list-none items-start gap-2 rounded-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden"
        data-testid={`button-geographic-overlap-explanation-${routeId}`}
      >
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="flex-1">{t("import.whyAreaShared")}</span>
        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-3 space-y-2 pl-6">
        <p className="font-medium">{statusLabel}</p>
        {explanation.status === "verified" && reasonKey ? (
          <p data-testid={`text-geographic-overlap-reason-${routeId}`}>{t(reasonKey)}</p>
        ) : (
          <p data-testid={`text-geographic-overlap-reason-${routeId}`}>
            {t("import.overlapNoVerifiedConstraintDescription")}
          </p>
        )}
        {explanation.serverMessage && (
          <p
            className="text-[11px] opacity-80"
            data-testid={`text-geographic-overlap-server-message-${routeId}`}
          >
            {explanation.serverMessage}
          </p>
        )}
        {explanation.analyzedPairCount != null && (
          <p
            className="text-[11px] opacity-80"
            data-testid={`text-geographic-overlap-pair-count-${routeId}`}
          >
            {t("import.overlapAnalyzedPairs", {
              count: explanation.analyzedPairCount,
            })}
          </p>
        )}
        <div className="space-y-1">
          <p className="font-medium">{t("import.overlapAffectedRoutes")}</p>
          <div className="flex flex-wrap gap-1.5">
            {affectedRouteIds.map((affectedRouteId) => (
              <a
                key={affectedRouteId}
                href={`#planning-draft-route-${affectedRouteId}`}
                className="rounded border border-current/20 px-1.5 py-0.5 underline underline-offset-2 hover:bg-background/70"
                data-testid={`link-geographic-overlap-route-${routeId}-${affectedRouteId}`}
              >
                {routeNamesById.get(affectedRouteId) ?? affectedRouteId}
              </a>
            ))}
          </div>
        </div>
        {affectedStopIds.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium">{t("import.overlapAffectedStops")}</p>
            <div className="flex flex-wrap gap-1.5">
              {affectedStopIds.map((stopId) => (
                <a
                  key={stopId}
                  href={`#planning-draft-stop-${stopId}`}
                  className="rounded border border-current/20 px-1.5 py-0.5 underline underline-offset-2 hover:bg-background/70"
                  data-testid={`link-geographic-overlap-stop-${routeId}-${stopId}`}
                >
                  {stopAddressesById.get(stopId) ?? stopId}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

export function Step7Adjust({
  draftId,
  planId,
  routes,
  unplannedStops,
  availableStops = [],
  unplannedStopIds: propUnplannedStopIds = [],
  unplannedDiagnostics,
  vehicles,
  drivers,
  depotLatitude,
  depotLongitude,
  readOnly: readOnlyProp = false,
  onNext,
  onValidated,
  onBack,
  allowResourceSelection = false,
  draftRevision,
  planningInputs,
  planningMetadata,
  onChangePlanningInputs,
  onChangePlanningMetadata,
  onSaveCustomerReference,
  onPlanningReoptimized,
  focusOptimization = false,
}: Step7AdjustProps) {
  const { t } = useTranslation();
  const { visible: importInfoVisible } = useImportInfo();
  const [planningToolsOpen, setPlanningToolsOpen] = useState(focusOptimization);
  const depotUnavailable =
    !Number.isFinite(depotLatitude) || !Number.isFinite(depotLongitude);
  const readOnly = readOnlyProp || depotUnavailable;
  const [localRoutes, setLocalRoutes] = useState<LocalRoute[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [validatedRoutes, setValidatedRoutes] = useState<
    ImportAssignedRoute[] | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isRefreshingSavedPlan, setIsRefreshingSavedPlan] = useState(false);
  const [requiresPlanReload, setRequiresPlanReload] = useState(false);
  const [isOpeningPlanner, setIsOpeningPlanner] = useState(false);
  const [adjustmentReview, setAdjustmentReview] = useState<{
    input: RouteAdjustmentInput; result: RouteAdjustmentPreview;
  } | null>(null);
  const [adjustmentReviewed, setAdjustmentReviewed] = useState(false);
  const previewGeneration = useRef(0);
  const [serviceDurationMin, setServiceDurationMin] = useState(5);
  const [serviceTimeStrategy, setServiceTimeStrategy] = useState<
    "preserve_individual" | "replace_all"
  >("preserve_individual");
  const [selectedPairValues, setSelectedPairValues] = useState<Set<string>>(
    () =>
      new Set(routes.map((route) => `${route.vehicleId}|${route.driverId}`)),
  );
  const [routeColorOverrides, setRouteColorOverrides] = useState<
    Record<string, string>
  >({});
  const [savingColorVehicleIds, setSavingColorVehicleIds] = useState<
    Set<string>
  >(new Set());
  const [isSavingCustomerReference, setIsSavingCustomerReference] =
    useState(false);
  const [savedCustomerReference, setSavedCustomerReference] = useState<
    string | null
  >(planningMetadata?.customerReference ?? null);
  const queryClient = useQueryClient();
  const viewUnplannedStops = () => {
    document
      .getElementById("import-unplanned-stops")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const stopQueries = useQueries({
    queries: routes.map((r) => ({
      queryKey: getGetRouteStopsQueryKey(r.routeId),
      queryFn: () => getRouteStops(r.routeId),
    })),
  });
  const routeQueries = useQueries({
    queries: routes.map((r) => ({
      queryKey: getGetRouteQueryKey(r.routeId),
      queryFn: () => getRoute(r.routeId),
    })),
  });
  const isLoading = stopQueries.some((q) => q.isLoading);
  const isError = stopQueries.some((q) => q.isError);
  const routeDataById = useMemo(
    () =>
      new Map(
        routes.map((route, index) => [route.routeId, routeQueries[index]?.data]),
      ),
    [routeQueries, routes],
  );

  useEffect(() => {
    if (
      routes.length > 0 &&
      !isLoading &&
      !isError &&
      localRoutes.length === 0 &&
      stopQueries.every((q) => q.data)
    ) {
      setLocalRoutes(
        routes.map((r, i) => ({
          ...r,
          stops: stopQueries[i].data || [],
        })),
      );
    }
  }, [isLoading, isError, routes, stopQueries, localRoutes.length]);

  const routeRevisionSignature = routes
    .map((route) => `${route.routeId}:${route.planRevision}`)
    .join(",");
  const loadedRouteRevisionSignature = useRef("");

  useEffect(() => {
    if (
      routes.length > 0 &&
      !isLoading &&
      !isError &&
      stopQueries.every((query) => query.data) &&
      loadedRouteRevisionSignature.current !== routeRevisionSignature
    ) {
      setLocalRoutes(
        routes.map((route, index) => ({
          ...route,
          stops: stopQueries[index].data ?? [],
        })),
      );
      loadedRouteRevisionSignature.current = routeRevisionSignature;
    }
  }, [isError, isLoading, routeRevisionSignature, routes, stopQueries]);

  const adjustMutation = useAdjustAssignedRoutes({ mutation: { retry: false } });
  const previewAdjustment = usePreviewAssignedRouteAdjustments({ mutation: { retry: false } });
  const currentAdjustment: RouteAdjustmentInput = {
    planId: localRoutes[0]?.planId ?? "",
    routes: localRoutes.map(route => ({ routeId: route.routeId, driverId: route.driverId,
      planRevision: route.planRevision, stopIds: route.stops.map(stop => stop.id) })),
    depotLatitude: depotLatitude ?? 0, depotLongitude: depotLongitude ?? 0,
  };
  const currentAdjustmentRef = useRef(currentAdjustment);
  currentAdjustmentRef.current = currentAdjustment;
  const adjustmentIdentity = JSON.stringify(currentAdjustment);
  const reoptimizeMutation = useReoptimizeImportRoutePlan({ mutation: { retry: false } });
  const reoptimizeInputsMutation = useReoptimizeImportRoutePlanPlanningInputs({ mutation: { retry: false } });
  const updateVehicleMutation = useUpdateVehicle();
  const { data: existingRoutes } = useRoutes();
  const refreshLockedRoute = async (savedRoute: Route) => {
    try {
      const [freshRoute, freshStops] = await Promise.all([
        getRoute(savedRoute.id),
        getRouteStops(savedRoute.id),
      ]);
      setLocalRoutes((previous) =>
        previous.map((route) =>
          route.routeId === savedRoute.id
            ? {
                ...route,
                planRevision: freshRoute.planRevision,
                totalDistanceKm: freshRoute.totalDistanceKm ?? route.totalDistanceKm,
                totalDurationMin: freshRoute.totalDurationMin ?? route.totalDurationMin,
                stops: freshStops,
              }
            : route,
        ),
      );
      setValidatedRoutes(null);
      setIsDirty(false);
    } catch {
      setErrorMessage(t("import.loadRoutesFailed"));
    }
  };

  const activePlanId = planId ?? routes[0]?.planId;
  const { data: summaryData, refetch: refetchSummary } =
    useGetImportRoutePlanPlanningSummary(activePlanId ?? "", {
      query: {
        enabled: Boolean(activePlanId),
        queryKey: ["getImportRoutePlanPlanningSummary", activePlanId],
      },
    });

  const summarySelectedPairValues =
    summaryData?.planningSummary?.selectedPairValues;
  useEffect(() => {
    if (!summarySelectedPairValues) return;
    setSelectedPairValues(
      new Set(
        summarySelectedPairValues.map((value) => value.replace(":", "|")),
      ),
    );
  }, [summarySelectedPairValues]);

  const activePlanningInputs = summaryData?.planningInputs || planningInputs;
  const allowanceDefaults = usePlanningAllowanceDefaults();
  const currentAllowanceCeilings = allowanceDefaults.isError ? undefined : allowanceDefaults.data;
  const savedAllowances = effectivePlanningAllowances(activePlanningInputs, currentAllowanceCeilings);
  const nextAllowances = effectivePlanningAllowances(planningInputs ?? activePlanningInputs, currentAllowanceCeilings);
  const optimizationEvidence =
    summaryData?.planningSummary?.optimizationEvidence;
  const unplannedStopIds =
    summaryData?.planningSummary?.unplanned.map((item) => item.stopId) ??
    propUnplannedStopIds;
  const unplannedStopQueries = useQueries({
    queries: unplannedStopIds.map((stopId) => ({
      queryKey: getGetStopQueryKey(stopId),
      queryFn: () => getStop(stopId),
    })),
  });

  const authoritativePairValues =
    summaryData?.planningSummary?.selectedPairValues;
  const summaryRevisionsMatch = Boolean(
    summaryData?.routes &&
      summaryData.routes.length === localRoutes.length &&
      localRoutes.every((route) => {
        const summaryRoute = summaryData.routes.find(
          (candidate) => candidate.routeId === route.routeId,
        );
        return summaryRoute?.planRevision === route.planRevision;
      }),
  );
  const planningInputsMatch =
    !planningInputs ||
    !summaryData?.planningInputs ||
    planningInputsSignature({ ...planningInputs, ...nextAllowances }) ===
      planningInputsSignature({ ...summaryData.planningInputs, ...savedAllowances });
  const sharedInstructionsMatch =
    !summaryData ||
    (planningMetadata?.sharedInstructions ?? null) ===
      (summaryData.sharedInstructions ?? null);
  const resourceSelectionMatch =
    authoritativePairValues == null ||
    sameStringSet(
      selectedPairValues,
      authoritativePairValues.map((value) => value.replace(":", "|")),
    );
  const routeDataRevisionsMatch =
    localRoutes.length > 0 &&
    localRoutes.every(
      (route) => routeDataById.get(route.routeId)?.planRevision === route.planRevision,
    );
  useEffect(() => {
    previewGeneration.current++;
    setAdjustmentReview(null);
    setAdjustmentReviewed(false);
  }, [adjustmentIdentity, planningInputsMatch, sharedInstructionsMatch, routeDataRevisionsMatch, routeRevisionSignature]);
  /**
   * Explanations and optimization evidence are immutable evidence for one
   * protected plan version. Do not render cached evidence while a local
   * adjustment/resource change is waiting for server validation.
   */
  const isCurrentPlanEvidence =
    !isDirty &&
    summaryRevisionsMatch &&
    planningInputsMatch &&
    resourceSelectionMatch &&
    routeDataRevisionsMatch;

  const currentOverlapExplanations = useMemo(() => {
    const result = new Map<string, NormalizedRouteOverlapExplanation>();
    if (!isCurrentPlanEvidence) return result;
    for (const route of localRoutes) {
      const serverRoute = routeDataById.get(route.routeId);
      const explanation = normalizeRouteOverlapExplanation(
        serverRoute?.geographicOverlapExplanation,
      );
      if (explanation) result.set(route.routeId, explanation);
    }
    return result;
  }, [isCurrentPlanEvidence, localRoutes, routeDataById]);
  const resolvedUnplannedStops = useMemo(() => {
    const byId = new Map(
      [...availableStops, ...unplannedStops]
        .filter((stop) => unplannedStopIds.includes(stop.id))
        .map((stop) => [stop.id, stop]),
    );
    for (const query of unplannedStopQueries) {
      if (query.data) byId.set(query.data.id, query.data);
    }
    return Array.from(byId.values());
  }, [availableStops, unplannedStopQueries, unplannedStopIds, unplannedStops]);
  // Derive the completion evidence from the current authoritative route/stop
  // projections rather than retaining a one-shot POST response in wizard
  // state. This keeps the notice correct after reloads and manual moves.
  const currentOptimizationSummary = useMemo(() => {
    const unplannedIds = new Set(unplannedStopIds);
    const plannedIds = new Set(
      localRoutes.flatMap((route) => route.stops.map((stop) => stop.id)),
    );
    for (const stopId of unplannedIds) plannedIds.delete(stopId);
    if (routes.length === 0 && unplannedIds.size === 0) return null;
    return {
      routesCount: routes.length,
      plannedStopsCount: plannedIds.size,
      unplannedStopsCount: unplannedIds.size,
    };
  }, [localRoutes, routes.length, unplannedStopIds]);

  const diagnosticByStopId = useMemo(
    () =>
      new Map(
        unplannedDiagnostics.map((diagnostic) => [
          diagnostic.stopId,
          diagnostic,
        ]),
      ),
    [unplannedDiagnostics],
  );

  const hasUnplannedMandatory = summaryData?.planningSummary
    ? summaryData.planningSummary.mandatoryUnplannedStopIds.length > 0
    : resolvedUnplannedStops.some(
        (stop) => activePlanningInputs?.stopPriorities?.[stop.id] === 2,
      );

  const availablePairs = useMemo(
    () =>
      vehicles
        .filter((vehicle) => vehicle.isActive)
        .flatMap((vehicle) =>
          drivers
            .filter(
              (driver) => driver.isActive && driver.vehicleId === vehicle.id,
            )
            .map((driver) => ({
              vehicle,
              driver,
              value: `${vehicle.id}|${driver.id}`,
            })),
        ),
    [drivers, vehicles],
  );
  const selectedPairs = useMemo(
    () => availablePairs.filter((pair) => selectedPairValues.has(pair.value)),
    [availablePairs, selectedPairValues],
  );
  const planningCandidatePairs = useMemo(() => {
    const planningSummary = summaryData?.planningSummary;
    const selectedValues = planningSummary
      ? new Set(
          planningSummary.selectedPairValues.map((value) =>
            value.replace(":", "|"),
          ),
        )
      : new Set(
          localRoutes.map((route) => `${route.vehicleId}|${route.driverId}`),
        );
    return availablePairs.filter((pair) => selectedValues.has(pair.value));
  }, [availablePairs, localRoutes, summaryData?.planningSummary]);
  const planningCandidateVehicles = useMemo(() => {
    const excluded = new Set(activePlanningInputs?.excludedPairValues ?? []);
    const vehiclesById = new Map<string, ImportVehicle>();
    for (const pair of planningCandidatePairs) {
      if (!excluded.has(canonicalPairValue(pair.value))) {
        vehiclesById.set(pair.vehicle.id, pair.vehicle);
      }
    }
    return Array.from(vehiclesById.values());
  }, [activePlanningInputs?.excludedPairValues, planningCandidatePairs]);

  const planningStops = useMemo(() => {
    const byId = new Map<string, ImportStop>();
    for (const stop of resolvedUnplannedStops) byId.set(stop.id, stop);
    for (const route of localRoutes) {
      for (const stop of route.stops) byId.set(stop.id, stop);
    }
    return Array.from(byId.values());
  }, [localRoutes, resolvedUnplannedStops]);

  const routeDepotOptions = useMemo(
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

  const markChanged = () => {
    if (readOnly) return;
    setErrorMessage(null);
    setSavedMessage(null);
    setIsDirty(true);
    setValidatedRoutes(null);
    previewGeneration.current++;
    setAdjustmentReview(null);
    setAdjustmentReviewed(false);
  };

  const invalidateRouteEvidence = async (routeIds: string[]) => {
    await Promise.all(
      routeIds.flatMap((routeId) => [
        queryClient.invalidateQueries({
          queryKey: getGetRouteQueryKey(routeId),
        }),
        queryClient.invalidateQueries({
          queryKey: getGetRouteStopsQueryKey(routeId),
        }),
      ]),
    );
  };

  const updatePlanningInputs = (patch: Partial<PlanningInputs>) => {
    if (readOnly) return;
    if (!planningInputs || !onChangePlanningInputs) return;
    onChangePlanningInputs({ ...planningInputs, ...patch });
    markChanged();
    setErrorMessage(null);
  };

  const isPlanningInputEditingEnabled = Boolean(
    draftId &&
    draftRevision != null &&
    planningInputs &&
    onChangePlanningInputs &&
    onPlanningReoptimized,
  );
  const optimizationGoalRef = useRef<HTMLFieldSetElement>(null);
  const focusedOptimization = useRef(false);
  useEffect(() => {
    if (focusOptimization) setPlanningToolsOpen(true);
  }, [focusOptimization]);
  useEffect(() => {
    if (!focusOptimization || isLoading || isError || !isPlanningInputEditingEnabled || focusedOptimization.current) return;
    setPlanningToolsOpen(true);
    const frame = requestAnimationFrame(() => {
      if (!optimizationGoalRef.current) return;
      optimizationGoalRef.current.scrollIntoView({ block: "start" });
      optimizationGoalRef.current.focus({ preventScroll: true });
      focusedOptimization.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusOptimization, isPlanningInputEditingEnabled, isLoading, isError]);
  const hasUnsavedCustomerReference =
    (planningMetadata?.customerReference ?? null) !== savedCustomerReference;

  const toggleResourcePair = (value: string) => {
    if (readOnly) return;
    const pair = availablePairs.find((candidate) => candidate.value === value);
    if (!pair) return;
    setSelectedPairValues((previous) => {
      const next = new Set(previous);
      if (next.has(value)) {
        next.delete(value);
      } else {
        for (const candidate of availablePairs) {
          if (
            candidate.vehicle.id === pair.vehicle.id ||
            candidate.driver.id === pair.driver.id
          )
            next.delete(candidate.value);
        }
        if (
          next.size <
          localRoutes.reduce((sum, route) => sum + route.stops.length, unplannedStops.length)
        ) {
          next.add(value);
        }
      }
      return next;
    });
    markChanged();
  };

  const togglePlanningPair = (value: string) => {
    if (readOnly) return;
    if (!planningInputs) return;
    const canonicalValue = canonicalPairValue(value);
    const excluded = new Set(planningInputs.excludedPairValues);
    if (excluded.has(canonicalValue)) {
      excluded.delete(canonicalValue);
    } else {
      excluded.add(canonicalValue);
    }
    updatePlanningInputs({
      excludedPairValues: Array.from(excluded),
    });
  };

  const handleReorder = (
    routeId: string,
    stopIndex: number,
    direction: -1 | 1,
  ) => {
    if (readOnly) return;
    setLocalRoutes((previous) =>
      previous.map((route) => {
        if (route.routeId !== routeId) return route;
        const nextIndex = stopIndex + direction;
        if (nextIndex < 0 || nextIndex >= route.stops.length) return route;
        const stops = [...route.stops];
        [stops[stopIndex], stops[nextIndex]] = [
          stops[nextIndex],
          stops[stopIndex],
        ];
        return { ...route, stops };
      }),
    );
    markChanged();
  };

  const handleMove = (
    sourceRouteId: string,
    destinationRouteId: string,
    stopId: string,
  ) => {
    if (readOnly) return;
    const source = localRoutes.find((route) => route.routeId === sourceRouteId);
    if (!source || sourceRouteId === destinationRouteId) return;
    if (source.stops.length <= 1) {
      setErrorMessage(t("import.routeMustRetainStop"));
      return;
    }

    setLocalRoutes((previous) => {
      const movedStop = previous
        .find((route) => route.routeId === sourceRouteId)
        ?.stops.find((stop) => stop.id === stopId);
      if (!movedStop) return previous;

      return previous.map((route) => {
        if (route.routeId === sourceRouteId) {
          return {
            ...route,
            stops: route.stops.filter((stop) => stop.id !== stopId),
          };
        }
        if (route.routeId === destinationRouteId) {
          return { ...route, stops: [...route.stops, movedStop] };
        }
        return route;
      });
    });
    markChanged();
  };

  const handleValidate = async () => {
    if (readOnly || depotLatitude == null || depotLongitude == null) return;
    setErrorMessage(null);
    const action = routeAdjustmentAction({
      hasValidatedResult: Boolean(validatedRoutes),
      hasPersistedPlan: localRoutes.length > 0,
      isDirty,
      planningInputsMatch,
      sharedInstructionsMatch,
    });
    if (action === "adjust" && (!adjustmentReview || !sameAdjustmentDraft(adjustmentReview.input, currentAdjustment))) {
      const input = captureAdjustmentDraft(currentAdjustment);
      const requestId = ++previewGeneration.current;
      setAdjustmentReview(null);
      setAdjustmentReviewed(false);
      try {
        const result = await previewAdjustment.mutateAsync({ data: input });
        if (requestId === previewGeneration.current && sameAdjustmentDraft(input, currentAdjustmentRef.current)) {
          setAdjustmentReview({ input, result });
        }
      } catch (error) {
        if (requestId === previewGeneration.current) setErrorMessage(
          `Förhandsgranskningen kunde inte slutföras. Inga lokala ändringar sparades av förhandsgranskningen. ${localizeError(error, t, { fallbackKey: "import.adjustRoutesFailed" })} Öppna den sparade planen på nytt om versionen har ändrats.`,
        );
      }
      return;
    }
    if (action === "adjust" && (!adjustmentReviewed || !adjustmentReview?.result.canApply)) {
      setErrorMessage("Granska och bekräfta konsekvenserna före sparande.");
      return;
    }
    setIsOpeningPlanner(true);
    const outcome = await runRouteAdjustment<ImportAssignedRoute[]>({
      action,
      validatedResult: validatedRoutes ?? localRoutes,
      adjust: async () => {
        if (localRoutes.length === 0)
          throw new TrustedLocalizedError(t("import.noRoutesToPublish"));
        const confirmedDraft = adjustmentReview && boundAdjustmentConfirmation(
          adjustmentReview.input, currentAdjustmentRef.current, adjustmentReview.result, adjustmentReviewed,
        );
        if (!confirmedDraft) throw new TrustedLocalizedError("Förslaget har ändrats. Granska hela ändringen igen.");
        const result = await adjustMutation.mutateAsync({
          data: confirmedDraft,
        });
        const updatedById = new Map(
          result.routes.map((route) => [route.routeId, route]),
        );
        setLocalRoutes((previous) =>
          previous.map((route) => ({
            ...route,
            ...updatedById.get(route.routeId),
          })),
        );
        // Retain the authoritative result before refreshing or navigating:
        // retrying navigation must never replay a successful adjustment.
        setValidatedRoutes(result.routes);
        setSavedMessage("Arbetsplanen är sparad. Den är inte godkänd eller skickad till förare. Att stänga denna vy ångrar inte sparandet.");
        setAdjustmentReview(null);
        setAdjustmentReviewed(false);
        setIsDirty(false);
        // Dispatch compares live route revisions with the approval endpoint.
        // Refresh the shared route list before navigating, otherwise a cached
        // pre-adjustment revision incorrectly blocks approval as stale.
        void invalidateRouteEvidence(
          result.routes.map((route) => route.routeId),
        ).catch(() => undefined);
        void refetchSummary().catch(() => undefined);
        return result.routes;
      },
      open: async (savedRoutes) => {
        // This is post-save synchronization/navigation. Its failure must not
        // be reported as a failed mutation or trigger another save on retry.
        await queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        await onValidated(savedRoutes);
      },
    });
    if (outcome.kind === "blocked") {
      setErrorMessage(t("import.planningInputsChangedAfterPlan"));
    } else if (outcome.kind === "adjustment-failed") {
      setAdjustmentReview(null);
      setAdjustmentReviewed(false);
      setErrorMessage(
        localizeError(outcome.error, t, { fallbackKey: "import.adjustRoutesFailed" }),
      );
    } else if (outcome.kind === "open-failed") {
      setErrorMessage(
        t("import.routeAdjustmentSavedOpenPlannerFailed", {
          reason: localizeError(outcome.error, t, {
            fallbackKey: "import.openTrafficPlannerFailed",
          }),
        }),
      );
    }
    setIsOpeningPlanner(false);
  };

  const handleServiceTimeReoptimization = async () => {
    if (readOnly || depotLatitude == null || depotLongitude == null) return;
    if (!planningInputsMatch || !sharedInstructionsMatch) {
      setErrorMessage("Planeringsinställningarna har ändrats. Använd ”Beräkna om med valt optimeringsmål” för att spara dem tillsammans med omberäkningen.");
      return;
    }
    if (localRoutes.length === 0) return;
    if (!planningAllowancesKnown(savedAllowances)) {
      setErrorMessage("Planens tillåtna övertid och försening är okända. Hämta planeringsinställningarna innan du beräknar om.");
      return;
    }
    if (!window.confirm(
      `${planningAllowanceText(savedAllowances)}\nEffektiva gränser för denna beräkning: den sparade arbetsplanens gränser begränsas av företagets aktuella tak. Skärpta företagstak kan minska tidigare undantag. Ändra och spara planeringsinställningarna separat om du vill använda andra önskade gränser.\n\n` +
      `Beräkna om och spara arbetsplanen?\n\nServicetid: ${serviceTimeStrategy === "replace_all" ? `ersätt alla med ${serviceDurationMin} min` : "behåll individuella tider"}.\nResurser: ${selectedPairs.map(pair => `${pair.vehicle.name}`).join(", ")}.\n\nDetta är inte en förhandsgranskning. Stopp kan flyttas eller bli oplanerade. Den befintliga arbetsplanen ersätts direkt efter beräkningen och lokala stoppändringar ersätts. Stängning ångrar inte sparandet. Inget godkänns eller skickas till förare. Bekräfta endast om du har granskat dessa inställningar.`,
    )) return;
    setErrorMessage(null);
    markChanged();
    setIsRefreshingSavedPlan(true);
    let persisted = false;
    try {
      const planId = localRoutes[0].planId;
      const result = await reoptimizeMutation.mutateAsync({
        planId,
        data: {
          serviceDurationMin,
          serviceTimeStrategy,
          routes: localRoutes.map((route) => ({
            routeId: route.routeId,
            driverId: route.driverId,
            planRevision: route.planRevision,
          })),
          ...(allowResourceSelection
            ? {
                pairs: selectedPairs.map((pair) => ({
                  vehicleId: pair.vehicle.id,
                  driverId: pair.driver.id,
                })),
              }
            : {}),
          depotLatitude,
          depotLongitude,
        },
      });
      persisted = true;
      setValidatedRoutes(result.routes);
      setIsDirty(false);
      setSavedMessage("Omberäkningen är sparad som arbetsplan, inte godkänd eller skickad. Granska resultatet och oplanerade stopp. Stängning ångrar inte sparandet.");
      const refreshedStops = await Promise.all(
        result.routes.map((route) => getRouteStops(route.routeId)),
      );
      const updatedById = new Map(
        result.routes.map((route, index) => [
          route.routeId,
          { ...route, stops: refreshedStops[index] },
        ]),
      );
      setLocalRoutes(
        result.routes.map((route) => ({
          ...route,
          stops: updatedById.get(route.routeId)?.stops ?? [],
        })),
      );
      await invalidateRouteEvidence(result.routes.map((route) => route.routeId));
      // Route revisions come from the mutation response; effective objective
      // and vehicle-selection evidence come from the authoritative summary.
      const summaryResult = await refetchSummary();
      if (summaryResult.error) throw summaryResult.error;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        queryClient.invalidateQueries({ queryKey: getGetImportRoutePlanApprovalQueryKey(planId) }),
      ]);
      setValidatedRoutes(result.routes);
      setIsDirty(false);
    } catch (error) {
      setRequiresPlanReload(true);
      setErrorMessage(
        (persisted ? "Arbetsplanen ÄR sparad, men vyn kunde inte uppdateras. Öppna planen på nytt; kör inte om sparandet. " : "Sparandet kunde inte bekräftas. Öppna den aktuella planen och kontrollera versionen innan du försöker igen. ") + getApiErrorMessage(
          error,
          new TrustedLocalizedError(t("import.serviceTimeUpdateFailed")),
        ),
      );
    } finally {
      setIsRefreshingSavedPlan(false);
    }
  };

  const handlePlanningInputsReoptimization = async () => {
    if (readOnly || depotLatitude == null || depotLongitude == null) return;
    if (
      !activePlanId ||
      !draftId ||
      draftRevision == null ||
      !planningInputs ||
      !onPlanningReoptimized
    ) {
      setErrorMessage(t("import.draftNotReady"));
      return;
    }
    if (hasUnsavedCustomerReference) {
      setErrorMessage(t("import.saveCustomerReferenceFirst"));
      return;
    }
    if (!planningAllowancesKnown(nextAllowances)) {
      setErrorMessage("Kontrollera tillåten övertid och försening i planeringsinställningarna innan du beräknar om.");
      return;
    }
    if (!window.confirm(
      `${planningAllowanceText(nextAllowances)}\nEffektiva gränser begränsas av företagets aktuella tak. Skärpta företagstak kan minska tidigare undantag. Ändra önskade gränser i planeringsinställningarna om dessa inte stämmer.\n\n` +
      `Beräkna om och spara arbetsplanen?\n\nMål: ${objectiveLabel(planningInputs.objective, t)}.\n\nDen aktuella arbetsplanen ersätts med en ny beräkning enligt de planeringsinställningar och gemensamma instruktioner som visas. Lokala stoppändringar ersätts. Stopp kan flyttas eller bli oplanerade. Detta är inte en förhandsgranskning och stängning ångrar inte sparandet. Inget godkänns eller skickas till förare.\n\nJag har granskat inställningarna och vill spara omberäkningen.`,
    )) return;

    setErrorMessage(null);
    markChanged();
    setIsRefreshingSavedPlan(true);
    let persisted = false;
    try {
      const result = await reoptimizeInputsMutation.mutateAsync({
        planId: activePlanId,
        data: {
          draftId,
          draftRevision,
          planningInputs,
          sharedInstructions: planningMetadata?.sharedInstructions ?? null,
        },
      });
      persisted = true;
      setSavedMessage("Omberäkningen är sparad som arbetsplan, inte godkänd eller skickad. Granska resultatet och oplanerade stopp. Stängning ångrar inte sparandet.");
      // The mutation result carries revisions, while this read is the
      // authoritative source for recipient assignments and all unplanned
      // outcomes. Refetch only after the protected mutation has completed.
      const summaryResult = await refetchSummary();
      if (summaryResult.error || !summaryResult.data) {
        throw new Error(t("import.planningSummaryLoadFailed"));
      }
      const savedRevisions = new Map(result.routes.map(route => [route.routeId, route.planRevision]));
      if (
        summaryResult.data.routes.length !== result.routes.length ||
        summaryResult.data.routes.some(route => savedRevisions.get(route.routeId) !== route.planRevision)
      ) {
        throw new TrustedLocalizedError("Arbetsplanens version har ändrats efter sparandet. Öppna den aktuella planen på nytt.");
      }
      const canonicalRoutes = await onPlanningReoptimized(
        result,
        summaryResult.data,
      );
      const refreshedStops = await Promise.all(
        canonicalRoutes.map(async (route) => ({
          routeId: route.routeId,
          stops: await getRouteStops(route.routeId),
        })),
      );
      const stopsByRouteId = new Map(
        refreshedStops.map((route) => [route.routeId, route.stops]),
      );
      setLocalRoutes(
        canonicalRoutes.map((route) => ({
          ...route,
          stops: stopsByRouteId.get(route.routeId) ?? [],
        })),
      );
      loadedRouteRevisionSignature.current = canonicalRoutes
        .map((route) => `${route.routeId}:${route.planRevision}`)
        .join(",");
      await invalidateRouteEvidence(canonicalRoutes.map((route) => route.routeId));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] }),
        queryClient.invalidateQueries({ queryKey: getGetImportRoutePlanApprovalQueryKey(activePlanId) }),
      ]);
      setValidatedRoutes(canonicalRoutes);
      setIsDirty(false);
    } catch (error) {
      setRequiresPlanReload(true);
      setErrorMessage(
        (persisted ? "Arbetsplanen ÄR sparad, men vyn kunde inte uppdateras. Öppna planen på nytt; kör inte om sparandet. " : "Sparandet kunde inte bekräftas. Öppna den aktuella planen och kontrollera versionen innan du försöker igen. ") + localizeError(error, t, {
          fallbackKey: "import.planningInputsReoptimizationFailed",
        }),
      );
    } finally {
      setIsRefreshingSavedPlan(false);
    }
  };

  const handleSaveCustomerReference = async () => {
    if (readOnly) return;
    if (!planningMetadata || !onSaveCustomerReference) return;
    setErrorMessage(null);
    setIsSavingCustomerReference(true);
    try {
      await onSaveCustomerReference(planningMetadata);
      setSavedCustomerReference(planningMetadata.customerReference);
    } catch (error) {
      setErrorMessage(
        getApiErrorMessage(
          error,
          new TrustedLocalizedError(t("common.errorRequestFailed")),
        ),
      );
    } finally {
      setIsSavingCustomerReference(false);
    }
  };

  const saveVehicleColor = async (vehicleId: string, color: string) => {
    if (readOnly) return;
    const normalizedColor = color.toUpperCase();
    setRouteColorOverrides((previous) => ({
      ...previous,
      [vehicleId]: normalizedColor,
    }));
    setSavingColorVehicleIds((previous) => new Set(previous).add(vehicleId));
    setErrorMessage(null);
    try {
      await updateVehicleMutation.mutateAsync({
        id: vehicleId,
        data: { routeColor: normalizedColor },
      });
    } catch (error) {
      setRouteColorOverrides((previous) => {
        const next = { ...previous };
        delete next[vehicleId];
        return next;
      });
      setErrorMessage(
        getApiErrorMessage(
          error,
          new TrustedLocalizedError(t("import.routeColorSaveFailed")),
        ),
      );
    } finally {
      setSavingColorVehicleIds((previous) => {
        const next = new Set(previous);
        next.delete(vehicleId);
        return next;
      });
    }
  };

  const assignDistinctRouteColors = async () => {
    if (readOnly) return;
    setErrorMessage(null);
    for (const [index, route] of localRoutes.entries()) {
      await saveVehicleColor(
        route.vehicleId,
        ROUTE_COLORS[index % ROUTE_COLORS.length],
      );
    }
  };

  const routeNamesById = useMemo(
    () => new Map(localRoutes.map((route) => [route.routeId, route.name])),
    [localRoutes],
  );
  const routeIdsByVehicleId = useMemo(
    () => new Map(localRoutes.map((route) => [route.vehicleId, route.routeId])),
    [localRoutes],
  );
  const stopAddressesById = useMemo(() => {
    const result = new Map<string, string>();
    for (const route of localRoutes) {
      for (const stop of route.stops) result.set(stop.id, stop.address);
    }
    for (const stop of resolvedUnplannedStops) result.set(stop.id, stop.address);
    return result;
  }, [localRoutes, resolvedUnplannedStops]);

  const mapRoutes = useMemo<
    (Route & { stopsList: ImportStop[]; routeColor?: string })[]
  >(() => {
    const vehicleById = new Map(
      vehicles.map((vehicle) => [vehicle.id, vehicle]),
    );
    return localRoutes.map(
      (r): Route & { stopsList: ImportStop[]; routeColor?: string } => ({
        id: r.routeId,
        planId: r.planId,
        organizationId: "",
        vehicleId: r.vehicleId,
        name: r.name,
        status: r.status,
        manualReviewRequired: true,
        manualReviewedAt: validatedRoutes ? new Date().toISOString() : null,
        planRevision: r.planRevision,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null,
        receivedAt: null,
        openedAt: null,
        acceptedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        date: new Date().toISOString(),
        totalDistanceKm: r.totalDistanceKm,
        totalDurationMin: r.totalDurationMin,
        totalStops: r.stops.length,
        geographicOverlapExplanation:
          isCurrentPlanEvidence
            ? routeDataById.get(r.routeId)?.geographicOverlapExplanation ?? null
            : null,
        routeColor:
          routeColorOverrides[r.vehicleId] ??
          vehicleById.get(r.vehicleId)?.routeColor,
        createdAt: "",
        updatedAt: "",
        stopsList: r.stops.map((s, idx) => ({ ...s, sequenceOrder: idx + 1 })),
      }),
    );
  }, [
    isCurrentPlanEvidence,
    localRoutes,
    routeColorOverrides,
    routeDataById,
    vehicles,
  ]);

  if (isLoading) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center p-8">
        <Loader2 className="mb-4 h-10 w-10 animate-spin text-primary" />
        <p className="font-medium">{t("import.loadingRoutesAndStops")}</p>
      </Card>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>{t("import.loadRoutesFailed")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <fieldset
      disabled={isOpeningPlanner || previewAdjustment.isPending || isRefreshingSavedPlan || requiresPlanReload || readOnly}
      aria-busy={isOpeningPlanner || previewAdjustment.isPending || isRefreshingSavedPlan}
      className="min-w-0 space-y-2"
    >
      <ImportInfoSection category="limits" title="Planeringsgränser (sparad plan)">
        <PlanningAllowanceSettings inputs={summaryData?.planningInputs ?? undefined} historical
          title="Sparad arbetsplan — historiska gränser" />
      </ImportInfoSection>
      {currentOptimizationSummary && (
        <ImportInfoSection category="stats" title={t("import.optimizationResultTitle")}>
        <OptimizationResultSummary
          routesCount={currentOptimizationSummary.routesCount}
          plannedStopsCount={currentOptimizationSummary.plannedStopsCount}
          unplannedStopsCount={currentOptimizationSummary.unplannedStopsCount}
          onViewUnplanned={viewUnplannedStops}
        />
        </ImportInfoSection>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            {t("import.reviewAndAdjustRoutes")}
            {isDirty && (
              <Badge
                variant="secondary"
                className="bg-amber-500/15 text-amber-600 border-amber-500/30"
              >
                {t("import.unsavedChanges")}
              </Badge>
            )}
          </h2>
          {importInfoVisible.help && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t("import.reviewAndAdjustDescription")}
            </p>
          )}
          {readOnly && (
            <Alert className="mt-3 border-amber-500/30 bg-amber-500/5 py-2" data-testid="plan-review-read-only">
              <Info className="h-4 w-4" />
              <AlertDescription>
                {depotUnavailable
                  ? t("dispatch.adjustPlanRecoveryError")
                  : t("import.planReviewReadOnly")}
              </AlertDescription>
            </Alert>
          )}
          {!isDirty && localRoutes.length > 0 && (
            <p className="mt-2 text-xs font-medium text-emerald-600">
              {t("import.savedVersion", {
                version:
                  Math.max(...localRoutes.map((route) => route.planRevision)) +
                  1,
              })}
            </p>
          )}
        </div>
      </div>


      {hasUnplannedMandatory && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {t("import.unplannedMandatoryWarning")}
          </AlertDescription>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {validatedRoutes && !isDirty && (
        <Alert className="border-emerald-500/30 bg-emerald-500/5">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <AlertDescription>{t("import.finalPlanValidated")}</AlertDescription>
        </Alert>
      )}


      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)] md:h-[clamp(320px,calc(100dvh-22rem),650px)]" data-testid="import-adjust-workspace">
        <Card className="flex min-h-0 max-h-[60dvh] flex-col bg-muted/10 border-border shadow-sm md:max-h-none md:h-full">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2" data-testid="import-adjust-route-list">
            {localRoutes.map((route) => {
              const vehicle = vehicles.find(
                (candidate) => candidate.id === route.vehicleId,
              );
              const driver = drivers.find(
                (candidate) => candidate.id === route.driverId,
              );
              const routeColor =
                routeColorOverrides[route.vehicleId] ??
                vehicle?.routeColor ??
                ROUTE_COLORS[0];
              const isSavingColor = savingColorVehicleIds.has(route.vehicleId);
              const serverRoute = routeDataById.get(route.routeId);
              return (
                <div
                  data-testid="planning-draft-route"
                  id={`planning-draft-route-${route.routeId}`}
                  key={route.routeId}
                  className="bg-card rounded-lg border shadow-sm flex flex-col"
                >
                  <div className="p-3 border-b bg-muted/30 flex items-center justify-between sticky top-0 z-10 backdrop-blur-sm">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Truck className="h-4 w-4 text-primary shrink-0" />
                        <h3 className="font-bold text-sm truncate">
                          {route.name}
                        </h3>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-medium">
                        <span>
                          {t("import.stopCount", { count: route.stops.length })}
                        </span>
                        <span>•</span>
                        <span>{route.totalDistanceKm.toFixed(1)} km</span>
                        <span>•</span>
                        <span>{Math.round(route.totalDurationMin)} min</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                        {vehicle && (
                          <span className="flex items-center gap-1">
                            <Truck className="h-3 w-3" />
                            {vehicle.licensePlate}
                          </span>
                        )}
                      </div>
                    </div>
                    <label className="ml-3 flex shrink-0 items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-[10px] font-medium text-muted-foreground">
                      <span>{t("import.routeColor")}</span>
                      <span
                        className="h-5 w-5 rounded-full border border-black/15 shadow-sm"
                        style={{ backgroundColor: routeColor }}
                      />
                      <input
                        type="color"
                        value={routeColor}
                        disabled={isSavingColor}
                        onChange={(event) =>
                          void saveVehicleColor(
                            route.vehicleId,
                            event.target.value,
                          )
                        }
                        className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0 disabled:cursor-wait disabled:opacity-60"
                        aria-label={t("import.changeRouteColor", {
                          route: route.name,
                        })}
                        title={t("import.changeRouteColor", {
                          route: route.name,
                        })}
                      />
                      {isSavingColor && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                    </label>
                  </div>
                  {currentOverlapExplanations.get(route.routeId) && (
                    <RouteOverlapExplanationPanel
                      explanation={currentOverlapExplanations.get(route.routeId)!}
                      routeId={route.routeId}
                      routeNamesById={routeNamesById}
                      routeIdsByVehicleId={routeIdsByVehicleId}
                      stopAddressesById={stopAddressesById}
                      t={t}
                    />
                  )}
                  <div className="min-h-[60px] space-y-2 p-2">
                    {route.stops.map((stop, index) => (
                      <div
                        key={stop.id}
                        id={`planning-draft-stop-${stop.id}`}
                        className="group flex items-stretch gap-2 rounded-md border bg-background p-2.5 shadow-sm transition-colors hover:border-primary/50"
                      >
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center self-center rounded bg-primary/10 text-[10px] font-bold text-primary">
                          {index + 1}
                        </div>
                        <div className="flex flex-col justify-center flex-1 min-w-0">
                          <p
                            className="text-xs font-semibold truncate"
                            title={stop.address}
                          >
                            {stop.address}
                          </p>
                          {stop.pickupAddress ? (
                            <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1.5 mt-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                              {t("import.pickupAddress", {
                                address: stop.pickupAddress,
                              })}
                            </p>
                          ) : stop.notes ? (
                            <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                              {stop.notes}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <LockedFirstStopControl
                            routeId={route.routeId}
                            planRevision={serverRoute?.planRevision ?? route.planRevision}
                            routeStatus={serverRoute?.status ?? route.status}
                            lockedFirstStopId={
                              serverRoute?.lockedFirstStopId
                            }
                            stopId={stop.id}
                            stopStatus={stop.status}
                            stopRouteId={stop.routeId}
                            hasUnsavedLocalChanges={isDirty}
                            onSaved={refreshLockedRoute}
                            compact
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={t("import.moveStopUp", {
                              address: stop.address,
                            })}
                            disabled={index === 0}
                            onClick={() =>
                              handleReorder(route.routeId, index, -1)
                            }
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={t("import.moveStopDown", {
                              address: stop.address,
                            })}
                            disabled={index === route.stops.length - 1}
                            onClick={() =>
                              handleReorder(route.routeId, index, 1)
                            }
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                          {localRoutes.length > 1 && route.stops.length > 1 ? (
                            <label className="relative flex h-7 items-center">
                              <ArrowRightLeft className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
                              <select
                                aria-label={t("import.moveStopToAnotherRoute", {
                                  address: stop.address,
                                })}
                                className="h-7 w-9 cursor-pointer appearance-none rounded-md border border-input bg-background pl-7 pr-1 text-transparent hover:border-primary"
                                value=""
                                onChange={(event) => {
                                  if (event.target.value) {
                                    handleMove(
                                      route.routeId,
                                      event.target.value,
                                      stop.id,
                                    );
                                  }
                                }}
                              >
                                <option value="">
                                  {t("import.moveToAnotherRoute")}
                                </option>
                                {localRoutes
                                  .filter(
                                    (candidate) =>
                                      candidate.routeId !== route.routeId,
                                  )
                                  .map((candidate) => (
                                    <option
                                      key={candidate.routeId}
                                      value={candidate.routeId}
                                    >
                                      {candidate.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={t("import.routeMustRetainStop")}
                              title={t("import.routeMustRetainStop")}
                              disabled
                            >
                              <LockKeyhole className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                    {route.stops.length === 1 && (
                      <p className="px-1 pb-1 text-[10px] text-amber-600">
                        {t("import.routeMustRetainStop")}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="relative h-[320px] min-h-0 overflow-hidden shadow-sm sm:h-[380px] md:h-full">
          {mapRoutes.length > 0 || resolvedUnplannedStops.length > 0 ? (
            <RouteMap
              routes={mapRoutes}
              unassignedStops={resolvedUnplannedStops}
              interactive
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-muted/5">
              <MapPin className="h-8 w-8 text-muted-foreground/30" />
            </div>
          )}
        </Card>
      </div>

      {unplannedStopIds.length > 0 && (
        <Card
          id="import-unplanned-stops"
          className="border-amber-500/40 bg-amber-500/5"
        >
          <div className="border-b border-amber-500/20 p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <h3 className="font-semibold">
                {t("import.unplannedStops", {
                  count: resolvedUnplannedStops.length,
                })}
              </h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("import.unplannedStopsDescription")}
            </p>
          </div>
          <div className="grid gap-2 p-3 md:grid-cols-2">
            {resolvedUnplannedStops.map((stop) => {
              const diagnostic = diagnosticByStopId.get(stop.id);
              const diagnosticPresentation =
                unplannedStopDiagnosticPresentation(diagnostic?.code);
              return (
                <div
                  key={stop.id}
                  data-testid={`unplanned-stop-diagnostic-${stop.id}`}
                  className="rounded-md border bg-background p-3"
                >
                  <p className="text-sm font-medium">{stop.address}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={diagnosticPresentation.exact ? "outline" : "secondary"}
                      data-testid={`unplanned-stop-diagnostic-source-${stop.id}`}
                    >
                      {t(diagnosticPresentation.sourceLabelKey)}
                    </Badge>
                    {!diagnosticPresentation.exact && (
                      <span className="text-[11px] text-muted-foreground">
                        {t("import.unplannedDiagnosticNotExact")}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-1.5 text-xs">
                    <p
                      className="text-amber-800 dark:text-amber-300"
                      data-testid={`unplanned-stop-diagnostic-reason-${stop.id}`}
                    >
                      {diagnosticPresentation.exact && diagnostic
                        ? diagnostic.detail
                        : t("import.unplannedStopDefaultReason")}
                    </p>
                    <p className="text-muted-foreground">
                      <span className="font-semibold">
                        {t("import.unplannedDiagnosticRecommendationLabel")}{" "}
                      </span>
                      {t(diagnosticPresentation.recommendationKey)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
      {(localRoutes.length > 0 || isPlanningInputEditingEnabled) && (
        <details
          open={planningToolsOpen}
          onToggle={(event) => setPlanningToolsOpen(event.currentTarget.open)}
          className="group rounded-lg border border-border bg-card"
          data-testid="import-adjust-planning-tools"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
            <span className="flex-1">{t("import.planningToolsTitle")}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {selectedPairValues.size} valda resurser
            </span>
          </summary>
          <div className="space-y-3 border-t p-3">
        <>
          <Card className="border-primary/20 bg-primary/[0.03] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <Palette className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">
                    {t("import.routeColorsTitle")}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("import.routeColorsDescription")}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="shrink-0 gap-2"
                disabled={savingColorVehicleIds.size > 0}
                onClick={() => void assignDistinctRouteColors()}
              >
                {savingColorVehicleIds.size > 0 ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <WandSparkles className="h-4 w-4" />
                )}
                {t("import.makeColorsDistinct")}
              </Button>
            </div>
          </Card>
          {allowResourceSelection && (
            <Card className="overflow-hidden">
              <div className="border-b bg-muted/30 p-4">
                <h3 className="font-semibold">
                  {t("import.replanResourcesTitle")}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("import.replanResourcesDescription")}
                </p>
              </div>
              <div className="grid gap-2 p-4 md:grid-cols-2">
                {availablePairs.map(({ vehicle, driver, value }) => {
                  const checked = selectedPairValues.has(value);
                  const stopCount = localRoutes.reduce(
                    (sum, route) => sum + route.stops.length,
                    unplannedStops.length,
                  );
                  const atLimit =
                    !checked && selectedPairValues.size >= stopCount;
                  return (
                    <label
                      key={value}
                      className={`flex items-center gap-3 rounded-lg border p-3 ${
                        checked ? "border-primary bg-primary/5" : ""
                      } ${atLimit ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                    >
                      <Checkbox
                        data-testid={`checkbox-replan-resource-${vehicle.id}-${driver.id}`}
                        checked={checked}
                        disabled={atLimit || reoptimizeMutation.isPending}
                        onCheckedChange={() => toggleResourcePair(value)}
                      />
                      <span className="min-w-0 text-sm">
                        <span className="block truncate font-medium">
                          {vehicle.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {vehicle.licensePlate || "Resurs"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </Card>
          )}
          <Card className="p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h3 className="font-semibold">
                  {t("import.replanServiceTitle")}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("import.replanServiceDescription")}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[140px_minmax(260px,1fr)_auto] sm:items-end">
                <label className="space-y-1 text-xs font-medium">
                  {t("import.newSharedServiceTime")}
                  <div className="flex items-center gap-2">
                    <input
                      data-testid="input-replan-service-duration"
                      type="number"
                      min={0}
                      max={1440}
                      value={serviceDurationMin}
                       onChange={(event) => {
                         if (!readOnly) setServiceDurationMin(Number(event.target.value));
                       }}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    />
                    <span className="text-muted-foreground">
                      {t("common.mins")}
                    </span>
                  </div>
                </label>
                <fieldset className="space-y-1">
                  <legend className="text-xs font-medium">
                    {t("import.existingIndividualTimes")}
                  </legend>
                  <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-3 py-2 text-xs">
                    <label className="flex items-center gap-2">
                      <input
                        data-testid="radio-replan-preserve-service-times"
                        type="radio"
                        name="service-time-strategy"
                        checked={serviceTimeStrategy === "preserve_individual"}
                        onChange={() => {
                          if (!readOnly) setServiceTimeStrategy("preserve_individual");
                        }}
                      />
                      {t("import.preserveDifferentTimes")}
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        data-testid="radio-replan-replace-service-times"
                        type="radio"
                        name="service-time-strategy"
                        checked={serviceTimeStrategy === "replace_all"}
                        onChange={() => {
                          if (!readOnly) setServiceTimeStrategy("replace_all");
                        }}
                      />
                      {t("import.replaceAllTimes")}
                    </label>
                  </div>
                </fieldset>
                <Button
                  data-testid="button-replan-selected-resources"
                  type="button"
                  variant="default"
                  disabled={
                    reoptimizeMutation.isPending ||
                    !planningInputsMatch ||
                    !sharedInstructionsMatch ||
                    (allowResourceSelection && selectedPairs.length === 0) ||
                    !Number.isInteger(serviceDurationMin) ||
                    serviceDurationMin < 0 ||
                    serviceDurationMin > 1440
                  }
                  onClick={() => void handleServiceTimeReoptimization()}
                >
                  {reoptimizeMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Beräkna om resurser och servicetid…
                </Button>
              </div>
            </div>
          </Card>
          {isPlanningInputEditingEnabled && planningInputs && (
            <Card className="p-3 space-y-3">
              <div>
                <h3 className="font-semibold">{t("import.planningInputs")}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("import.planningInputsReoptimizationDescription")}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex-1 space-y-1">
                  <Label htmlFor="review-customer-reference">
                    {t("createRoute.customerReference")}
                  </Label>
                  <Input
                    id="review-customer-reference"
                    value={planningMetadata?.customerReference ?? ""}
                    maxLength={200}
                    onChange={(event) => {
                      if (readOnly) return;
                      onChangePlanningMetadata?.({
                          customerReference: event.target.value || null,
                          sharedInstructions:
                            planningMetadata?.sharedInstructions ?? null,
                        });
                    }}
                  />
                </label>
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !onSaveCustomerReference || isSavingCustomerReference
                  }
                  onClick={() => void handleSaveCustomerReference()}
                >
                  {isSavingCustomerReference && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t("common.save")}
                </Button>
              </div>

              <fieldset ref={optimizationGoalRef} tabIndex={-1} className="scroll-mt-4">
                <legend className="mb-2 text-sm font-semibold">
                  {t("import.optimizationGoal")}
                </legend>
                <RadioGroup
                  value={planningInputs.objective}
                  onValueChange={(objective) =>
                    updatePlanningInputs(
                      objective === "minimize_vehicles"
                        ? {
                            objective,
                            vehicleSelectionMode: "minimize_vehicles",
                          }
                        : {
                            objective: objective as Exclude<
                              PlanningInputs["objective"],
                              "minimize_vehicles"
                            >,
                            vehicleSelectionMode: "use_all_selected_pairs",
                          },
                    )
                  }
                  className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
                >
                  {PLANNING_OBJECTIVES.map((objective) => (
                    <label
                      key={objective}
                      htmlFor={`review-optimization-profile-${objective}`}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm",
                        planningInputs.objective === objective &&
                          "border-primary bg-primary/5",
                      )}
                    >
                      <RadioGroupItem
                        value={objective}
                        id={`review-optimization-profile-${objective}`}
                      />
                      {objectiveLabel(objective, t)}
                    </label>
                  ))}
                </RadioGroup>
                {(planningInputs.objective === "geographic" || planningInputs.objective === "balanced" || planningInputs.objective === "areas_worktime") && (
                  <p className="mt-2 text-sm text-muted-foreground" data-testid="review-optimization-area-guidance">
                    {t(`import.optimization${objectiveTranslationSuffix(planningInputs.objective)}Description`)}
                  </p>
                )}
              </fieldset>

              <PlanningAllowanceSettings inputs={planningInputs} defaults={currentAllowanceCeilings}
                loadFailed={allowanceDefaults.isError} onChange={updatePlanningInputs}
                title="Nästa beräkning — tillåtna undantag" />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1">
                  <Label htmlFor="review-travel-reserve">
                    {t("import.travelReserve")}
                  </Label>
                  <Input
                    id="review-travel-reserve"
                    data-testid="planning-input-travel-reserve"
                    type="number"
                    min={0}
                    max={100}
                    value={planningInputs.travelReservePercent}
                    onChange={(event) =>
                      updatePlanningInputs({
                        travelReservePercent: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="space-y-1">
                  <Label htmlFor="review-stop-reserve">
                    {t("import.stopReserve")}
                  </Label>
                  <Input
                    id="review-stop-reserve"
                    data-testid="planning-input-stop-reserve"
                    type="number"
                    min={0}
                    max={120}
                    value={planningInputs.stopReserveMin}
                    onChange={(event) =>
                      updatePlanningInputs({
                        stopReserveMin: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>

              <div>
                <Label className="text-sm font-semibold">
                  {t("import.stopPriority")}
                </Label>
                <p className="mt-1 mb-3 text-xs text-muted-foreground">
                  {t("import.stopPriorityDescription")}
                </p>
                <div className="max-h-60 overflow-y-auto rounded-md border divide-y">
                  {planningStops.map((stop) => (
                    <div
                      key={stop.id}
                      className="flex items-center justify-between gap-3 p-2.5 text-sm"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {stop.address}
                      </span>
                      <Select
                        value={String(
                          planningInputs.stopPriorities[stop.id] ?? 0,
                        )}
                        onValueChange={(value) =>
                          updatePlanningInputs({
                            stopPriorities: {
                              ...planningInputs.stopPriorities,
                              [stop.id]: Number(value) as 0 | 1 | 2,
                            },
                          })
                        }
                      >
                        <SelectTrigger className="h-8 w-36 text-xs">
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
              </div>

              <div>
                <Label className="text-sm font-semibold">
                  {t("import.availableVehicles")}
                </Label>
                <p className="mt-1 mb-3 text-xs text-muted-foreground">
                  {t("import.planningPairExclusionsDescription")}
                </p>
                <div className="grid gap-2 md:grid-cols-2">
                  {planningCandidatePairs.map(({ vehicle, driver, value }) => {
                    const checked = !planningInputs.excludedPairValues.includes(
                      canonicalPairValue(value),
                    );
                    return (
                      <label
                        key={value}
                        className="flex items-center gap-3 rounded-lg border p-3 text-sm"
                      >
                        <Checkbox
                          data-testid={`planning-input-pair-${vehicle.id}-${driver.id}`}
                          checked={checked}
                          onCheckedChange={() => togglePlanningPair(value)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {vehicle.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {vehicle.licensePlate || "Resurs"}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <Label>{t("import.depotOverride")}</Label>
                  <Select
                    value={planningInputs.depotOverride?.scope ?? "none"}
                    onValueChange={(scope) => {
                      if (scope === "none") {
                        updatePlanningInputs({ depotOverride: null });
                      } else if (scope === "plan") {
                        updatePlanningInputs({
                          depotOverride: {
                            scope,
                            verifiedDepotId: "organization-default",
                          },
                        });
                      } else {
                        updatePlanningInputs({
                          depotOverride: {
                            scope: "pair",
                            vehicleId: planningCandidateVehicles[0]?.id,
                            verifiedDepotId: "organization-default",
                          },
                        });
                      }
                    }}
                  >
                    <SelectTrigger className="w-52">
                      <SelectValue />
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
                </label>
                {planningInputs.depotOverride?.scope === "pair" && (
                  <label className="space-y-1">
                    <Label>{t("import.selectVehicle")}</Label>
                    <Select
                      value={planningInputs.depotOverride.vehicleId ?? ""}
                      onValueChange={(vehicleId) =>
                        updatePlanningInputs({
                          depotOverride: {
                            ...planningInputs.depotOverride!,
                            vehicleId,
                          },
                        })
                      }
                    >
                      <SelectTrigger className="w-52">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {planningCandidateVehicles.map((vehicle) => (
                          <SelectItem key={vehicle.id} value={vehicle.id}>
                            {vehicle.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                )}
                {planningInputs.depotOverride && (
                  <label className="space-y-1">
                    <Label>{t("import.verifiedDepot")}</Label>
                    <Select
                      data-testid="planning-input-depot-selector"
                      value={planningInputs.depotOverride.verifiedDepotId}
                      onValueChange={(verifiedDepotId) =>
                        updatePlanningInputs({
                          depotOverride: {
                            ...planningInputs.depotOverride!,
                            verifiedDepotId,
                          },
                        })
                      }
                    >
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="organization-default">
                          {t("import.organizationDefaultDepot")}
                        </SelectItem>
                        {routeDepotOptions.map((depot) => (
                          <SelectItem key={depot.value} value={depot.value}>
                            {depot.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                )}
                <Button
                  data-testid="planning-input-replan"
                  type="button"
                  disabled={
                    reoptimizeInputsMutation.isPending ||
                    hasUnsavedCustomerReference
                  }
                  onClick={() => void handlePlanningInputsReoptimization()}
                >
                  {reoptimizeInputsMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Beräkna om med valt optimeringsmål…
                </Button>
              </div>
            </Card>
          )}
          {isPlanningInputEditingEnabled && (
            <Card className="p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex-1 max-w-2xl">
                  <h3 className="font-semibold flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    {t("import.sharedInstructions")}
                    <span className="text-muted-foreground font-normal text-xs ml-1">
                      ({t("common.optional")})
                    </span>
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground mb-3">
                    {t("import.sharedInstructionsDescription")}
                  </p>
                  <div className="flex items-start gap-3">
                    <Textarea
                      aria-label={t("import.sharedInstructions")}
                      data-testid="planning-draft-shared-instructions"
                      value={planningMetadata?.sharedInstructions || ""}
                      onChange={(e) => {
                        if (readOnly) return;
                        if (onChangePlanningMetadata) {
                          onChangePlanningMetadata({
                            customerReference:
                              planningMetadata?.customerReference ?? null,
                            sharedInstructions: e.target.value || null,
                          });
                        }
                      }}
                      placeholder={t("import.sharedInstructionsPlaceholder")}
                      className="min-h-[80px] flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        reoptimizeInputsMutation.isPending ||
                        hasUnsavedCustomerReference
                      }
                      onClick={() => void handlePlanningInputsReoptimization()}
                    >
                      {reoptimizeInputsMutation.isPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Granska och spara arbetsplan…
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          )}
        </>
                </div>
        </details>
      )}
      {summaryData?.planningInputs && summaryData.planningSummary && !isCurrentPlanEvidence && (
        <Alert
          className="border-amber-500/30 bg-amber-500/5 py-2"
          data-testid="status-optimization-evidence-stale"
        >
          <Info className="h-4 w-4" />
          <AlertDescription>{t("import.optimizationEvidenceStale")}</AlertDescription>
        </Alert>
      )}
      {summaryData?.planningInputs && summaryData.planningSummary && (
        <ImportInfoSection category="stats" title={t("import.planningSummary")}>
        <Card className="p-4 bg-muted/20 border-border shadow-sm text-xs">
          <h3 className="font-semibold flex items-center gap-1.5 mb-3 text-sm">
            <ListChecks className="h-4 w-4" />
            {t("import.planningSummary")}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Target className="h-3 w-3" />{" "}
                {t("import.requestedOptimization")}
              </span>
              <span className="font-medium">
                {isCurrentPlanEvidence
                  ? objectiveLabel(optimizationEvidence?.requestedObjective, t)
                  : t("import.optimizationEvidenceUnknown")}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Target className="h-3 w-3" />{" "}
                {t("import.effectiveOptimization")}
              </span>
              <span className="font-medium">
                {isCurrentPlanEvidence
                  ? objectiveLabel(optimizationEvidence?.effectiveObjective, t)
                  : t("import.optimizationEvidenceUnknown")}
              </span>
            </div>
            <div className="md:col-span-2">
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Info className="h-3 w-3" /> {t("import.requestedWeights")}
              </span>
              <span className="font-medium">
                {isCurrentPlanEvidence
                  ? weightLabel(optimizationEvidence?.requestedWeights)
                  : t("import.optimizationEvidenceUnknown")}
              </span>
            </div>
            <div className="md:col-span-2">
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Info className="h-3 w-3" /> {t("import.effectiveWeights")}
              </span>
              <span className="font-medium">
                {isCurrentPlanEvidence ? (
                  <>
                    {weightLabel(optimizationEvidence?.effectiveWeights)}
                    {" · "}
                    {optimizationEvidence?.source === "planningInputs"
                      ? t("import.evidenceSourcePlanningInputs")
                      : optimizationEvidence?.source === "legacy"
                        ? t("import.evidenceSourceLegacy")
                        : t("import.optimizationEvidenceUnknown")}
                  </>
                ) : (
                  t("import.optimizationEvidenceUnknown")
                )}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Clock className="h-3 w-3" /> {t("import.reserves")}
              </span>
              <span className="font-medium">
                {isCurrentPlanEvidence &&
                summaryData.planningInputs.travelReservePercent > 0
                  ? `${summaryData.planningInputs.travelReservePercent}% ${t("import.travelReserve").toLowerCase()}`
                  : ""}
                {isCurrentPlanEvidence &&
                summaryData.planningInputs.travelReservePercent > 0 &&
                summaryData.planningInputs.stopReserveMin > 0
                  ? " + "
                  : ""}
                {isCurrentPlanEvidence && summaryData.planningInputs.stopReserveMin > 0
                  ? `${summaryData.planningInputs.stopReserveMin} min ${t("import.stopReserve").toLowerCase()}`
                  : ""}
                {!isCurrentPlanEvidence
                  ? t("import.optimizationEvidenceUnknown")
                  : !summaryData.planningInputs.travelReservePercent &&
                !summaryData.planningInputs.stopReserveMin
                  ? t("common.none")
                  : ""}
              </span>
            </div>
            <div className="mt-4 pt-4 border-t border-border/50">
              <span className="text-muted-foreground flex items-center gap-1.5 mb-2 font-medium">
                <Truck className="h-3 w-3" />{" "}
                {t("import.vehicleSelectionSemantics")}
              </span>
              <p className="font-medium">
                {!isCurrentPlanEvidence
                  ? t("import.optimizationEvidenceUnknown")
                  : optimizationEvidence?.vehicleSelectionMode ===
                "use_all_selected_pairs"
                  ? t("import.useAllSelectedPairs")
                  : optimizationEvidence?.vehicleSelectionMode ===
                      "minimize_vehicles"
                    ? t("import.minimizeSelectedVehicles")
                    : t("import.optimizationEvidenceUnknown")}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Truck className="h-3 w-3" /> {t("import.vehicleDistribution")}
              </span>
              <span className="font-medium">
                {!isCurrentPlanEvidence
                  ? t("import.optimizationEvidenceUnknown")
                  : optimizationEvidence?.vehicleDistributionMode === "balance"
                    ? t("import.vehicleDistributionBalance")
                    : optimizationEvidence?.vehicleDistributionMode === "minimize"
                      ? t("import.vehicleDistributionMinimize")
                      : t("import.optimizationEvidenceUnknown")}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <Package className="h-3 w-3" /> {t("import.stopPriority")}
              </span>
              <span className="font-medium">
                {!isCurrentPlanEvidence
                  ? t("import.optimizationEvidenceUnknown")
                  : Object.keys(summaryData.planningInputs.stopPriorities).length >
                0
                  ? t("import.prioritiesSet", {
                      count: Object.keys(
                        summaryData.planningInputs.stopPriorities,
                      ).length,
                    })
                  : t("common.none")}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                <MapPin className="h-3 w-3" /> {t("import.depotOverride")}
              </span>
              <span className="font-medium">
                {!isCurrentPlanEvidence
                  ? t("import.optimizationEvidenceUnknown")
                  : summaryData.planningInputs.depotOverride?.scope === "plan"
                  ? t("import.depotOverridePlan")
                  : summaryData.planningInputs.depotOverride?.scope === "pair"
                    ? t("import.depotOverridePair")
                    : t("import.noDepotOverride")}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground flex items-center gap-1.5 mb-1">
                {t("createRoute.customerReference")}
              </span>
              <span className="font-medium">
                {summaryData.customerReference ?? t("common.none")}
              </span>
            </div>
          </div>

          {isCurrentPlanEvidence &&
            summaryData.planningSummary.usedPairValues.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <span className="text-muted-foreground flex items-center gap-1.5 mb-2 font-medium">
                <CheckCircle2 className="h-3 w-3" /> {t("import.usedResources")}
              </span>
              <div className="flex flex-wrap gap-2">
                {summaryData.planningSummary.usedPairValues.map((pair) => (
                  <Badge
                    key={pair}
                    variant="secondary"
                    className="bg-background"
                  >
                    {resourcePairLabel(pair, vehicles, drivers)}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {isCurrentPlanEvidence &&
            summaryData.planningSummary.unusedPairValues.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <span className="text-muted-foreground flex items-center gap-1.5 mb-2 font-medium">
                <Info className="h-3 w-3" /> {t("import.unusedResources")}
              </span>
              <div className="flex flex-wrap gap-2">
                {summaryData.planningSummary.unusedPairValues.map((up) => (
                  <Badge
                    key={up.pairValue}
                    variant="secondary"
                    className="bg-background"
                  >
                    {resourcePairLabel(up.pairValue, vehicles, drivers)} —{" "}
                    {up.reason}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {summaryData.planningSummary.unplanned.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <span className="text-muted-foreground flex items-center gap-1.5 mb-2 font-medium">
                <AlertTriangle className="h-3 w-3" />{" "}
                {t("import.unplannedStops", {
                  count: summaryData.planningSummary.unplanned.length,
                })}
              </span>
              <div className="space-y-1">
                {summaryData.planningSummary.unplanned.map((item) => (
                  <p
                    key={item.stopId}
                    className="text-amber-700 dark:text-amber-400"
                  >
                    {planningStops.find((stop) => stop.id === item.stopId)
                      ?.address ?? item.stopId}{" "}
                    — {item.reason}
                  </p>
                ))}
              </div>
            </div>
          )}
        </Card>
        </ImportInfoSection>
      )}

      <div className="space-y-2 pt-1" data-testid="planning-adjust-review-area">
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none font-medium">Om arbetsplan och godkännande</summary>
          <p className="mt-1">Arbetsplan och godkännande är separata. Sparade ändringar finns kvar när du stänger. Godkännande och utskick görs i trafikplaneraren.</p>
        </details>
        {savedMessage && <p role="status" className="text-sm">{savedMessage}</p>}
        {previewAdjustment.isPending && <p role="status">Beräknar konsekvens… Inga lokala ändringar sparas ännu.</p>}
        {!previewAdjustment.isPending && !isOpeningPlanner && adjustmentReview && <section className="space-y-2 rounded border p-3 text-sm" aria-label="Granska hela planändringen">
          <h3 className="font-medium">Granska hela planändringen före sparande</h3>
          <p>Förslaget omfattar samtliga lokala stoppflyttar, ordningar och förarval. Det är ännu inte sparat.</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">{adjustmentReview.result.consequences.routes.map(item => <div key={item.routeId} className="rounded border p-2">
            <p className="font-medium">{item.routeName}</p>
            <p>Körning: {metricText(item.before.driveMin, " min")} → {metricText(item.after.driveMin, " min")}</p>
            <p>Arbetstid: {metricText(item.before.workMin, " min")} → {metricText(item.after.workMin, " min")}</p>
            <p>Sluttid: {metricText(item.before.endAt)} → {metricText(item.after.endAt)}</p>
            <p>Tidsfönsteravvikelser: {metricText(item.before.windowViolations)} → {metricText(item.after.windowViolations)}</p>
            <p>Antal uppdrag: {item.before.stopCount} → {item.after.stopCount}</p>
          </div>)}</div>
          {adjustmentReview.result.consequences.reason && <p>{adjustmentReview.result.consequences.reason}</p>}
          <p>Ej planerade i ändringen: {adjustmentReview.result.consequences.unplanned.before} → {adjustmentReview.result.consequences.unplanned.after}</p>
          <label className="flex items-start gap-2"><input type="checkbox" checked={adjustmentReviewed}
            onChange={event => setAdjustmentReviewed(event.target.checked)} />Jag har granskat hela förslaget och före/efter, inklusive okända mått.</label>
          <Button size="sm" variant="ghost" onClick={() => { setAdjustmentReview(null); setAdjustmentReviewed(false); }}>Avbryt granskning — behåll lokala ändringar</Button>
        </section>}
        {errorMessage && (
          <Alert variant="destructive" data-testid="planning-validation-error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}
      </div>
      <div className="sticky bottom-0 z-20 -mx-3 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-3 py-2 shadow-[0_-6px_12px_-10px_hsl(var(--foreground)/0.35)] backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6" data-testid="planning-adjust-actions">
          <div className="flex items-center gap-3">
            {onBack && (
              <Button
                variant="ghost"
                onClick={onBack}
                disabled={adjustMutation.isPending || isOpeningPlanner || previewAdjustment.isPending}
              >
                Tillbaka
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isDirty && (
              <span className="text-xs text-muted-foreground hidden sm:inline-flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5" />
                {t("import.confirmToValidateChanges")}
              </span>
            )}
            {localRoutes.length === 0 ? (
              <Button
                disabled={hasUnplannedMandatory}
                onClick={() => onNext([])}
              >
                {t("import.continueWithUnplannedStops")}
              </Button>
            ) : (
              <Button
                data-testid="planning-draft-save-review"
                onClick={() => void handleValidate()}
                disabled={isRefreshingSavedPlan || adjustMutation.isPending || isOpeningPlanner || previewAdjustment.isPending || Boolean(adjustmentReview && !adjustmentReviewed)}
                className={cn(
                  isDirty && "bg-amber-600 hover:bg-amber-700 text-white",
                )}
              >
                {adjustMutation.isPending || isOpeningPlanner ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {previewAdjustment.isPending ? "Beräknar konsekvens…"
                  : isOpeningPlanner
                  ? (adjustMutation.isPending ? t("import.validatingAndSaving") : "Öppnar sparad arbetsplan…")
                  : adjustmentReview ? "Bekräfta och spara hela ändringen"
                  : !isDirty
                    ? "Öppna sparad arbetsplan"
                    : "Förhandsgranska hela ändringen"}
              </Button>
            )}
          </div>
      </div>
    </fieldset>
  );
}
