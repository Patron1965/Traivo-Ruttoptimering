import { useSustainabilityStats } from "@/hooks/use-sustainability";
import { useBulkDeleteRoutes, useRoutes } from "@/hooks/use-routes";
import { useDrivers } from "@/hooks/use-drivers";
import { useVehicles } from "@/hooks/use-vehicles";
import { useStops } from "@/hooks/use-stops";
import { usePlanningDrafts, type PlanningDraft } from "@/hooks/use-planning-drafts";
import { AppLayout } from "@/components/layout/AppLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ProjectRoutesTable, type ProjectRow } from "@/components/routes/ProjectRoutesTable";
import { RoutesListToolbar } from "@/components/routes/RoutesListToolbar";
import { RoutesBulkDeleteDialog } from "@/components/routes/RoutesBulkDeleteDialog";
import { RoutesMapPanel, type MapStop } from "@/components/routes/RoutesMapPanel";
import { Route as RouteIcon, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { format } from "date-fns";
import { sv, enUS } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { type Route } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupRoutesByPlan, isTerminalRouteStatus } from "@/lib/route-plan-groups";
import {
  createRouteDeletionSnapshot,
  MAX_BULK_ROUTE_DELETE,
  isRouteDeletionEligible,
  routeDeletionSnapshotChanged,
  setVisibleRouteSelection,
  selectedRouteIdsForGroups,
  type RouteDeletionSnapshotItem,
  type RouteSelection,
} from "@/lib/route-selection";
import { filterRoutePlanGroups } from "@/lib/route-filters";
import { localizeError } from "@/lib/localize-error";
import {
  aggregateRouteMetrics,
  distinctDriverSummary,
  filterGroupsByDay,
  groupDays,
  groupStatus,
  parseRoutesListFilters,
  parseRoutesListViewState,
  projectOpenTarget,
  routeDay,
  routeMetrics,
  routeOpenHref,
  routesListStorageKey,
  serializeRoutesListFilters,
  sortGroupsByLatestDay,
  DEFAULT_ROUTES_LIST_FILTERS,
  type OptionalRouteColumn,
  type RoutesListFilters,
} from "@/lib/route-project-table";

function planningSnapshotDriverId(route: Route): string | null {
  const snapshot = (route as Route & { optimizationResourceSnapshot?: unknown }).optimizationResourceSnapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  const driver = record.driver;
  if (typeof record.driverId === "string") return record.driverId;
  if (driver && typeof driver === "object" && typeof (driver as Record<string, unknown>).id === "string") {
    return (driver as Record<string, unknown>).id as string;
  }
  return null;
}

function readStorage(storage: "session" | "local", key: string | null): string | null {
  if (!key) return null;
  try {
    return (storage === "session" ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: "session" | "local", key: string | null, value: string) {
  if (!key) return;
  try {
    (storage === "session" ? window.sessionStorage : window.localStorage).setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode); list state is a convenience.
  }
}

export default function Routes() {
  const { user, hasRole } = useAuth();
  const organizationId = user?.organizationId;
  const storageKey = routesListStorageKey(organizationId, user?.id);
  const { data: routes, isLoading, isFetching, error, refetch, dataUpdatedAt } = useRoutes();
  const { data: drivers } = useDrivers();
  const { data: vehicles } = useVehicles();
  const { data: stops, isLoading: isStopsLoading, error: stopsError } = useStops();
  const { data: planningDrafts } = usePlanningDrafts();
  const { data: sustainabilityStats } = useSustainabilityStats();
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "sv" ? sv : enUS;
  const canWrite = hasRole("admin", "dispatcher");

  // ---------------------------------------------------------------- filters (URL)
  const search = useSearch();
  const [, navigate] = useLocation();
  const filters = useMemo(() => parseRoutesListFilters(search), [search]);
  const updateFilters = useCallback((next: Partial<RoutesListFilters>) => {
    const merged = { ...parseRoutesListFilters(window.location.search), ...next };
    navigate(`/routes${serializeRoutesListFilters(merged)}`, { replace: true });
  }, [navigate]);

  // ---------------------------------------------------------------- view state (scoped storage)
  const [expandedPlanKeys, setExpandedPlanKeys] = useState<Set<string>>(() => new Set());
  const [columns, setColumns] = useState<OptionalRouteColumn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const pendingScrollRestore = useRef<number | null>(null);
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const view = parseRoutesListViewState(readStorage("session", storageKey));
    const prefs = parseRoutesListViewState(readStorage("local", storageKey ? `${storageKey}:columns` : null));
    setExpandedPlanKeys(new Set(view.expanded));
    setColumns(prefs.columns);
    scrollTopRef.current = view.scrollTop;
    pendingScrollRestore.current = view.scrollTop;
    loadedKeyRef.current = storageKey;
  }, [storageKey]);

  const persistView = useCallback((expanded: Set<string>) => {
    if (loadedKeyRef.current !== storageKey) return;
    writeStorage("session", storageKey, JSON.stringify({
      expanded: [...expanded],
      scrollTop: scrollTopRef.current,
      columns: [],
    }));
  }, [storageKey]);

  useEffect(() => { persistView(expandedPlanKeys); }, [expandedPlanKeys, persistView]);

  const expandedRef = useRef(expandedPlanKeys);
  expandedRef.current = expandedPlanKeys;
  const persistViewRef = useRef(persistView);
  persistViewRef.current = persistView;
  useEffect(() => () => persistViewRef.current(expandedRef.current), []);

  const changeColumns = (next: OptionalRouteColumn[]) => {
    setColumns(next);
    writeStorage("local", storageKey ? `${storageKey}:columns` : null, JSON.stringify({ columns: next }));
  };

  // ---------------------------------------------------------------- selection
  const [selection, setSelection] = useState<RouteSelection | null>(null);
  const [deleteSelection, setDeleteSelection] = useState<Set<string>>(() => new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteSnapshot, setBulkDeleteSnapshot] = useState<RouteDeletionSnapshotItem[]>([]);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [bulkLiveAcknowledged, setBulkLiveAcknowledged] = useState(false);
  const [selectionLimitMessage, setSelectionLimitMessage] = useState<string | null>(null);
  const bulkDelete = useBulkDeleteRoutes();
  const bulkDeleteInFlight = useRef(false);

  // An organization switch never carries list state, filters or selections.
  const previousOrgRef = useRef(organizationId);
  useEffect(() => {
    setSelection(null);
    setDeleteSelection(new Set());
    setBulkDeleteOpen(false);
    setBulkDeleteSnapshot([]);
    setBulkDeleteError(null);
    setBulkLiveAcknowledged(false);
    if (previousOrgRef.current && previousOrgRef.current !== organizationId) {
      navigate(`/routes${serializeRoutesListFilters(DEFAULT_ROUTES_LIST_FILTERS)}`, { replace: true });
    }
    previousOrgRef.current = organizationId;
  }, [organizationId, navigate]);

  // Filtering changes (search, status and date) never retain a hidden
  // destructive selection.
  useEffect(() => {
    setSelection(null);
    setDeleteSelection(new Set());
    setBulkDeleteOpen(false);
    setBulkDeleteSnapshot([]);
    setBulkDeleteError(null);
    setBulkLiveAcknowledged(false);
    setSelectionLimitMessage(null);
  }, [filters.status, filters.q, filters.date]);

  useEffect(() => {
    if (!routes) return;
    const routeIds = new Set(routes.filter((route) => isRouteDeletionEligible(route.status)).map((route) => route.id));
    setDeleteSelection((current) => {
      const visible = new Set([...current].filter((id) => routeIds.has(id)));
      return visible.size === current.size ? current : visible;
    });
  }, [routes]);

  useEffect(() => {
    if (bulkDeleteInFlight.current || !bulkDeleteOpen || !routes || bulkDeleteSnapshot.length === 0) return;
    if (!routeDeletionSnapshotChanged(bulkDeleteSnapshot, routes)) return;
    setBulkDeleteOpen(false);
    setBulkDeleteSnapshot([]);
    setBulkLiveAcknowledged(false);
    setBulkDeleteError(t("routes.bulkDeleteChanged"));
  }, [bulkDeleteOpen, bulkDeleteSnapshot, routes, t]);

  // ---------------------------------------------------------------- lookups
  const routePlanGroups = useMemo(() => groupRoutesByPlan(routes ?? []), [routes]);

  const driverById = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    drivers?.forEach((d) => map.set(d.id, { id: d.id, name: d.name }));
    return map;
  }, [drivers]);
  const driverByVehicleId = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    drivers?.filter((driver) => driver.isActive).forEach((d) => {
      if (d.vehicleId) map.set(d.vehicleId, { id: d.id, name: d.name });
    });
    return map;
  }, [drivers]);
  const vehicleById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof vehicles>[number]>();
    vehicles?.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);
  const draftNameById = useMemo(() => {
    const map = new Map<string, string>();
    planningDrafts?.forEach((draft: PlanningDraft) => {
      const name = draft.name?.trim();
      if (!name) return;
      map.set(draft.id, name);
      if (draft.planId) map.set(draft.planId, name);
    });
    return map;
  }, [planningDrafts]);
  const stopsByRouteId = useMemo(() => {
    const map = new Map<string, MapStop[]>();
    stops?.forEach((s) => {
      if (!s.routeId) return;
      if (!map.has(s.routeId)) map.set(s.routeId, []);
      map.get(s.routeId)!.push({
        id: s.id, address: s.address, latitude: s.latitude, longitude: s.longitude,
        notes: s.notes ?? null, sequenceOrder: s.sequenceOrder,
      });
    });
    return map;
  }, [stops]);

  const getPlanTitle = (group: (typeof routePlanGroups)[number]) => {
    const draftName = group.routes
      .map((route) => route.draftId ? draftNameById.get(route.draftId) : undefined)
      .find((name): name is string => !!name);
    const planName = draftName || (group.planId ? draftNameById.get(group.planId) : undefined);
    if (planName) return planName;
    const routeNames = group.routes.map((route) => route.name?.trim()).filter((name): name is string => !!name);
    const shared = routeNames.length > 0 && routeNames.every((name) => name === routeNames[0]) ? routeNames[0] : undefined;
    if (shared) return shared;
    return t(group.planId ? "routes.unnamedPlan" : "routes.legacyPlan", { id: group.fallbackId });
  };

  const getRouteDriver = (route: Route) => {
    // Handoff identity is immutable route history; a terminal route never
    // shows whoever drives its vehicle today.
    if (route.handoffDriverId) return driverById.get(route.handoffDriverId);
    const snapshotDriverId = planningSnapshotDriverId(route);
    if (snapshotDriverId) return driverById.get(snapshotDriverId);
    if (isTerminalRouteStatus(route.status)) return undefined;
    return route.vehicleId ? driverByVehicleId.get(route.vehicleId) : undefined;
  };

  const visiblePlanGroups = useMemo(() => {
    const filtered = filterRoutePlanGroups<Route, (typeof routePlanGroups)[number]>(routePlanGroups, {
      query: filters.q,
      status: filters.status,
      getPlanTitle,
      getSearchFields: (route) => {
        const vehicle = route.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
        return { vehicleName: vehicle?.name, vehicleLicense: vehicle?.licensePlate, driverName: vehicle?.name ?? getRouteDriver(route)?.name };
      },
    });
    return sortGroupsByLatestDay(filterGroupsByDay(filtered, filters.date));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePlanGroups, filters, draftNameById, vehicleById, driverById, driverByVehicleId, t]);

  const envScoreByRouteId = useMemo(() => {
    const map = new Map<string, { score: number; isNight: boolean }>();
    sustainabilityStats?.routeEnvironmentalScores?.forEach((s) => map.set(s.routeId, { score: s.environmentalScore, isNight: s.isNightRoute }));
    return map;
  }, [sustainabilityStats]);
  const returnTo = `/routes${serializeRoutesListFilters(filters)}`;

  const formatDay = useCallback((day: string) => {
    const parsed = new Date(`${day}T12:00:00`);
    return Number.isNaN(parsed.getTime()) ? day : format(parsed, "EEE d MMM yyyy", { locale: dateLocale });
  }, [dateLocale]);

  const projectRows = useMemo<ProjectRow[]>(() => visiblePlanGroups.map((group) => {
    const title = getPlanTitle(group);
    const children = group.routes.map((route) => {
      const vehicle = route.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
      const driver = getRouteDriver(route);
      const day = routeDay(route);
      const vehicleLabel = vehicle?.name || vehicle?.licensePlate || null;
      return {
        route,
        driverId: driver?.id ?? null,
        row: {
          route,
          name: route.name?.trim() || title,
          vehicleLabel,
          driverName: null,
          day,
          metrics: routeMetrics(route),
          href: routeOpenHref(route, returnTo),
          envScore: envScoreByRouteId.get(route.id) ?? null,
          canDelete: isRouteDeletionEligible(route.status),
          identity: `${route.name || title} · ${vehicleLabel ?? t("routes.missingData")} · ${day ?? t("common.noDate")} · ID: ${route.id}`,
        },
      };
    });
    return {
      key: group.key,
      planId: group.planId,
      title,
      days: groupDays(group.routes),
      status: groupStatus(group.routes),
      drivers: distinctDriverSummary(children.map((c) => c.driverId)),
      metrics: aggregateRouteMetrics(group.routes),
      open: projectOpenTarget(group.planId, group.routes, returnTo),
      routes: children.map((c) => c.row),
      eligibleIds: group.routes.filter((r) => isRouteDeletionEligible(r.status)).map((r) => r.id),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [visiblePlanGroups, vehicleById, driverById, driverByVehicleId, draftNameById, envScoreByRouteId, returnTo, t]);

  // Restore scroll once the rows for this scope are rendered.
  useEffect(() => {
    if (pendingScrollRestore.current === null || !routes || !scrollRef.current) return;
    scrollRef.current.scrollTop = pendingScrollRestore.current;
    pendingScrollRestore.current = null;
  }, [routes, projectRows]);

  // ---------------------------------------------------------------- map selection
  const routeSelectionGroups = useMemo(
    () => routePlanGroups.map((group) => ({ key: group.key, routeIds: group.routes.map((route) => route.id) })),
    [routePlanGroups],
  );
  const visibleGroupKeys = useMemo(() => new Set(routePlanGroups.map((group) => group.key)), [routePlanGroups]);
  const selectedRouteIdsForMap = useMemo(
    () => selectedRouteIdsForGroups(selection, routeSelectionGroups, visibleGroupKeys),
    [routeSelectionGroups, selection, visibleGroupKeys],
  );
  useEffect(() => {
    if (selection && selectedRouteIdsForMap.length === 0) setSelection(null);
  }, [selectedRouteIdsForMap, selection]);
  const selectedRoutes = useMemo(
    () => (routes ?? []).filter((route) => selectedRouteIdsForMap.includes(route.id)),
    [routes, selectedRouteIdsForMap],
  );

  // ---------------------------------------------------------------- deletion
  const visibleEligibleRouteIds = useMemo(() => projectRows.flatMap((row) => row.eligibleIds), [projectRows]);
  const selectedVisibleRouteCount = visibleEligibleRouteIds.filter((id) => deleteSelection.has(id)).length;
  const allVisibleRoutesSelected = visibleEligibleRouteIds.length > 0 && selectedVisibleRouteCount === visibleEligibleRouteIds.length;
  const someVisibleRoutesSelected = selectedVisibleRouteCount > 0 && !allVisibleRoutesSelected;
  const destructiveActionDisabled = !canWrite || isFetching || !!error || bulkDelete.isPending || bulkDeleteOpen;

  const updateVisibleDeletionSelection = (routeIds: readonly string[], selected: boolean) => {
    if (!canWrite || destructiveActionDisabled) return;
    const result = setVisibleRouteSelection(deleteSelection, routeIds, selected);
    setDeleteSelection(result.selection);
    setSelectionLimitMessage(result.omittedCount > 0
      ? t("routes.selectionLimit", { limit: MAX_BULK_ROUTE_DELETE, count: result.omittedCount })
      : null);
  };
  const clearDeletionSelection = () => {
    setDeleteSelection(new Set());
    setSelectionLimitMessage(null);
  };
  const openBulkDeleteConfirmation = () => {
    if (deleteSelection.size === 0 || destructiveActionDisabled) return;
    const snapshot = createRouteDeletionSnapshot(routes ?? [], [...deleteSelection]);
    if (!snapshot) {
      setBulkDeleteError(t("routes.bulkDeleteChanged"));
      return;
    }
    setBulkDeleteError(null);
    setBulkLiveAcknowledged(false);
    setBulkDeleteSnapshot(snapshot);
    setBulkDeleteOpen(true);
  };
  const confirmBulkDelete = async () => {
    if (bulkDeleteSnapshot.length === 0 || bulkDelete.isPending || !canWrite || isFetching || !!error) return;
    setBulkDeleteError(null);
    bulkDeleteInFlight.current = true;
    try {
      await bulkDelete.mutateAsync({
        routeIds: bulkDeleteSnapshot.map((item) => item.routeId),
        confirmLiveRouteRemoval: bulkLiveAcknowledged,
      });
      setBulkDeleteOpen(false);
      setBulkDeleteSnapshot([]);
      setBulkDeleteError(null);
      clearDeletionSelection();
    } catch (cause) {
      // Keep the selection and dialog open; a failed atomic request must be
      // reviewed and retried explicitly.
      setBulkDeleteError(localizeError(cause, t, { fallbackKey: "routes.bulkDeleteError" }));
    } finally {
      bulkDeleteInFlight.current = false;
    }
  };

  const togglePlan = (key: string, open: boolean) => {
    setExpandedPlanKeys((current) => {
      const next = new Set(current);
      if (open) next.add(key); else next.delete(key);
      return next;
    });
  };

  const hasFilters = !!filters.q || !!filters.date;

  return (
    <AppLayout>
      <div className="flex h-full min-h-0 overflow-hidden flex-col xl:flex-row">
        <div
          ref={scrollRef}
          onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop; }}
          className="flex-1 min-h-0 overflow-y-auto"
          data-testid="routes-list-scroll"
        >
          <div className="p-3 md:p-5 space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 id="routes-heading" tabIndex={-1} className="text-xl font-bold tracking-tight">{t("routes.title")}</h1>
                <p className="text-muted-foreground text-xs mt-0.5">{t("routes.subtitle")}</p>
              </div>
              {canWrite && <Link
                href="/routes/create"
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="link-create-route"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("routes.newProject")}
              </Link>}
            </div>

            <RoutesListToolbar filters={filters} onChange={updateFilters} columns={columns} onColumnsChange={changeColumns} />

            {canWrite && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5" aria-live="polite">
                <Checkbox
                  checked={someVisibleRoutesSelected ? "indeterminate" : allVisibleRoutesSelected}
                  onCheckedChange={(checked) => updateVisibleDeletionSelection(visibleEligibleRouteIds, checked === true)}
                  disabled={destructiveActionDisabled || visibleEligibleRouteIds.length === 0}
                  aria-label={t("routes.selectVisible")}
                  data-testid="checkbox-select-visible"
                />
                <span className="text-xs text-muted-foreground">
                  {t("routes.selectedCount", { count: deleteSelection.size })} · {t("routes.visibleSelectableCount", { count: visibleEligibleRouteIds.length })}
                </span>
                <span className="text-xs text-muted-foreground">{t("routes.table.unknownHint")}</span>
                {deleteSelection.size > 0 && (
                  <Button type="button" variant="ghost" size="sm" className="h-7 gap-1" onClick={clearDeletionSelection} disabled={destructiveActionDisabled} data-testid="button-clear-selection">
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("routes.clearSelection")}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="ml-auto h-7 gap-1"
                  onClick={openBulkDeleteConfirmation}
                  disabled={destructiveActionDisabled || deleteSelection.size === 0}
                  data-testid="button-delete-selected"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("routes.deleteSelected", { count: deleteSelection.size })}
                </Button>
                {selectionLimitMessage && <p className="basis-full text-xs text-amber-600 dark:text-amber-400" role="status">{selectionLimitMessage}</p>}
                {bulkDeleteError && !bulkDeleteOpen && <p className="basis-full text-xs text-destructive" role="alert">{bulkDeleteError}</p>}
              </div>
            )}

            <RoutesBulkDeleteDialog
              open={bulkDeleteOpen}
              onOpenChange={(open) => {
                if (bulkDelete.isPending) return;
                setBulkDeleteOpen(open);
                if (!open) {
                  setBulkDeleteSnapshot([]);
                  setBulkDeleteError(null);
                  setBulkLiveAcknowledged(false);
                }
              }}
              snapshot={bulkDeleteSnapshot}
              error={bulkDeleteError}
              acknowledged={bulkLiveAcknowledged}
              onAcknowledgedChange={setBulkLiveAcknowledged}
              pending={bulkDelete.isPending}
              blocked={isFetching || !!error || !canWrite}
              onConfirm={() => void confirmBulkDelete()}
            />

            {isLoading && !routes && (
              <div className="space-y-1.5 rounded-lg border border-border bg-card p-2" aria-label={t("routes.loadingRoutes")}>
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            )}
            {error && routes && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300" role="alert">
                <span>
                  {t("routes.showingLastLoaded", {
                    time: dataUpdatedAt > 0 ? format(new Date(dataUpdatedAt), "Pp", { locale: dateLocale }) : t("routes.lastLoadedUnknown"),
                  })}
                </span>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={() => void refetch()} disabled={isFetching}>
                  <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden="true" />
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {error && !routes && !isLoading && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                <p>{t("routes.failedToLoad")}</p>
                <Button type="button" variant="outline" size="sm" className="mt-2 gap-1" onClick={() => void refetch()} disabled={isFetching}>
                  <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden="true" />
                  {t("common.retry")}
                </Button>
              </div>
            )}

            {!isLoading && routes && projectRows.length === 0 && (
              <div className="rounded-lg border border-dashed border-border py-12 text-center text-muted-foreground">
                <RouteIcon className="mx-auto mb-3 h-10 w-10 opacity-30" aria-hidden="true" />
                <p className="text-sm">
                  {hasFilters ? t("routes.noSearchResults") : filters.status === "completed" ? t("routeHistory.noCompleted") : t("routes.noRoutes")}
                </p>
                {hasFilters && (
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => updateFilters({ q: "", date: null })} data-testid="button-clear-filters">
                    {t("routes.clearSearch")}
                  </Button>
                )}
              </div>
            )}

            {selection && (
              <Button type="button" variant="outline" size="sm" onClick={() => setSelection(null)}>
                <X className="mr-1 h-4 w-4" />{t("common.close")}
              </Button>
            )}
            {projectRows.length > 0 && (
              <ProjectRoutesTable
                rows={projectRows}
                columns={columns}
                expanded={expandedPlanKeys}
                onToggle={togglePlan}
                canWrite={canWrite}
                deleteSelection={deleteSelection}
                selectionDisabled={destructiveActionDisabled}
                deleteDisabled={destructiveActionDisabled}
                onSelectIds={updateVisibleDeletionSelection}
                previewKey={selection?.kind === "plan" ? selection.key : null}
                onPreviewPlan={(key) => setSelection({ kind: "plan", key })}
                onPreviewRoute={(id) => setSelection({ kind: "route", id })}
                onRouteDeleted={(key) => {
                  requestAnimationFrame(() => {
                    const toggle = document.querySelector<HTMLButtonElement>(`button[data-testid="button-toggle-plan-${CSS.escape(key)}"]`);
                    (toggle || document.getElementById("routes-heading"))?.focus();
                  });
                }}
                formatDay={formatDay}
                onNavigate={() => persistView(expandedPlanKeys)}
              />
            )}
          </div>
        </div>

        {selection && <RoutesMapPanel
          allRoutes={routes ?? []}
          selectedRoutes={selectedRoutes}
          hasSelection={!!selection}
          stopsByRouteId={stopsByRouteId}
          isStopsLoading={isStopsLoading}
          stopsError={stopsError}
          vehicleById={vehicleById}
        />}
      </div>
    </AppLayout>
  );
}
