import { Link } from "wouter";
import { ChevronRight, ExternalLink, MapPinned, CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Route } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RouteActionsMenu } from "@/components/routes/RouteActionsMenu";
import { cn } from "@/lib/utils";
import {
  formatCount,
  formatKm,
  formatMinutes,
  formatPercent,
  UNKNOWN,
  type OptionalRouteColumn,
  type ProjectOpenTarget,
  type RouteMetrics,
} from "@/lib/route-project-table";

export interface ProjectRouteRow {
  route: Route;
  name: string;
  vehicleLabel: string | null;
  driverName: string | null;
  day: string | null;
  metrics: RouteMetrics;
  href: string;
  canDelete: boolean;
  identity: string;
  envScore: { score: number; isNight: boolean } | null;
}

export interface ProjectRow {
  key: string;
  planId: string | null;
  title: string;
  days: string[];
  status: string | null;
  drivers: { count: number; missing: number };
  metrics: RouteMetrics;
  open: ProjectOpenTarget;
  routes: ProjectRouteRow[];
  eligibleIds: string[];
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  optimized: "bg-primary/15 text-primary",
  in_progress: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-destructive/15 text-destructive",
  mixed: "bg-muted text-foreground",
};

export function statusTranslationKey(status: string) {
  if (status === "mixed") return "routes.statusMixed";
  return `routes.status${status.charAt(0).toUpperCase()}${status.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

function StatusPill({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-muted-foreground">{UNKNOWN}</span>;
  return (
    <span className={cn("inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium", STATUS_STYLES[status] ?? STATUS_STYLES.draft)}>
      {t(statusTranslationKey(status))}
    </span>
  );
}

function EnvScore({ value }: { value: { score: number; isNight: boolean } | null }) {
  const { t } = useTranslation();
  if (!value) return <span className="text-muted-foreground">{UNKNOWN}</span>;
  const tone = value.score >= 70
    ? "text-emerald-700 dark:text-emerald-400"
    : value.score >= 40 ? "text-amber-700 dark:text-amber-400" : "text-destructive";
  return (
    <span className={cn("font-medium", tone)} title={t("env.envScore")}>
      {value.score}
      {value.isNight && <span className="ml-1 text-[10px] text-muted-foreground">N</span>}
    </span>
  );
}

function OptionalCells({ metrics, columns, locale, env }: { metrics: RouteMetrics; columns: OptionalRouteColumn[]; locale: string; env?: { score: number; isNight: boolean } | null | "parent" }) {
  return (
    <>
      {columns.includes("distance") && <td className="px-2 py-1.5 text-right tabular-nums">{formatKm(metrics.distanceKm, locale)}</td>}
      {columns.includes("travel") && <td className="px-2 py-1.5 text-right tabular-nums">{formatMinutes(metrics.travelMin)}</td>}
      {columns.includes("service") && <td className="px-2 py-1.5 text-right tabular-nums">{formatMinutes(metrics.serviceMin)}</td>}
      {columns.includes("utilization") && <td className="px-2 py-1.5 text-right tabular-nums">{formatPercent(metrics.utilization)}</td>}
      {columns.includes("environment") && (
        <td className="px-2 py-1.5 text-right tabular-nums">
          {env === "parent" ? <span className="text-muted-foreground">{UNKNOWN}</span> : <EnvScore value={env ?? null} />}
        </td>
      )}
    </>
  );
}

interface ProjectRoutesTableProps {
  rows: ProjectRow[];
  columns: OptionalRouteColumn[];
  expanded: ReadonlySet<string>;
  onToggle: (key: string, open: boolean) => void;
  canWrite: boolean;
  deleteSelection: ReadonlySet<string>;
  selectionDisabled: boolean;
  deleteDisabled: boolean;
  onSelectIds: (ids: readonly string[], selected: boolean) => void;
  previewKey: string | null;
  onPreviewPlan: (key: string) => void;
  onPreviewRoute: (routeId: string) => void;
  onRouteDeleted: (planKey: string) => void;
  formatDay: (day: string) => string;
  onNavigate: () => void;
}

export function ProjectRoutesTable({
  rows,
  columns,
  expanded,
  onToggle,
  canWrite,
  deleteSelection,
  selectionDisabled,
  deleteDisabled,
  onSelectIds,
  previewKey,
  onPreviewPlan,
  onPreviewRoute,
  onRouteDeleted,
  formatDay,
  onNavigate,
}: ProjectRoutesTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith("sv") ? "sv-SE" : "en-GB";
  const colLabel: Record<OptionalRouteColumn, string> = {
    distance: t("routes.table.colDistance"),
    travel: t("routes.table.colTravel"),
    service: t("routes.table.colService"),
    utilization: t("routes.table.colUtilization"),
    environment: t("routes.table.colEnvironment"),
  };

  const dateLabel = (days: string[]) => {
    if (days.length === 0) return t("common.noDate");
    if (days.length === 1) return formatDay(days[0]);
    return `${formatDay(days[0])} – ${formatDay(days[days.length - 1])}`;
  };

  const th = "px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap";

  return (
    <div tabIndex={0} role="region" aria-label={t("routes.title")} className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[760px] border-collapse text-[13px]" data-testid="table-projects">
        <thead className="sticky top-0 z-10 bg-muted/70 backdrop-blur-sm">
          <tr className="border-b border-border">
            {canWrite && <th className="w-8 px-2 py-2"><span className="sr-only">{t("routes.selectVisible")}</span></th>}
            <th className={cn(th, "w-full")}>{t("routes.table.colName")}</th>
            <th className={th}>{t("routes.table.colDate")}</th>
            <th className={th}>{t("routes.table.colDriver")}</th>
            <th className={cn(th, "text-right")}>{t("routes.table.colStops")}</th>
            <th className={cn(th, "text-right")}>{t("routes.table.colWork")}</th>
            {columns.map((c) => <th key={c} className={cn(th, "text-right")}>{colLabel[c]}</th>)}
            <th className={th}>{t("routes.table.colStatus")}</th>
            <th className={cn(th, "text-right")}>{t("routes.table.colOpen")}</th>
          </tr>
        </thead>
          {rows.map((row) => {
            const isOpen = expanded.has(row.key);
            const selectedCount = row.eligibleIds.filter((id) => deleteSelection.has(id)).length;
            const all = row.eligibleIds.length > 0 && selectedCount === row.eligibleIds.length;
            const some = selectedCount > 0 && !all;
            const childPanelId = `project-${row.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return (
              <tbody key={row.key}>
                <tr
                  className={cn(
                    "border-b border-border/70 transition-colors hover:bg-muted/40",
                    isOpen && "bg-muted/30",
                    previewKey === row.key && "bg-primary/5",
                  )}
                  data-testid={`row-project-${row.key}`}
                  data-plan-key={row.key}
                >
                  {canWrite && (
                    <td className="px-2 py-1.5 align-middle">
                      <Checkbox
                        checked={some ? "indeterminate" : all}
                        onCheckedChange={(checked) => onSelectIds(row.eligibleIds, checked === true)}
                        disabled={selectionDisabled || row.eligibleIds.length === 0}
                        aria-label={t("routes.selectPlanForDeletion", { name: row.title })}
                        data-testid={`checkbox-project-${row.key}`}
                      />
                    </td>
                  )}
                  <td className="px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onToggle(row.key, !isOpen)}
                        aria-expanded={isOpen}
                        aria-controls={childPanelId}
                        aria-label={t(isOpen ? "routes.table.collapse" : "routes.table.expand", { name: row.title })}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        data-testid={`button-toggle-plan-${row.key}`}
                      >
                        <ChevronRight className={cn("h-4 w-4 transition-transform duration-150", isOpen && "rotate-90")} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggle(row.key, !isOpen)}
                        className="min-w-0 truncate text-left font-semibold hover:underline focus-visible:outline-none focus-visible:underline"
                        title={row.title}
                        tabIndex={-1}
                      >
                        {row.title}
                      </button>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        ({t("routes.table.routeCountShort", { count: row.routes.length })})
                      </span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                    {dateLabel(row.days)}
                    {row.days.length > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">({t("routes.table.daysCount", { count: row.days.length })})</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {t("routes.table.driverCount", { count: row.drivers.count })}
                    {row.drivers.missing > 0 && (
                      <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">
                        · {t("routes.table.driversMissing", { count: row.drivers.missing })}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCount(row.metrics.stops)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatMinutes(row.metrics.workMin)}</td>
                  <OptionalCells metrics={row.metrics} columns={columns} locale={locale} env="parent" />
                  <td className="px-2 py-1.5"><StatusPill status={row.status} /></td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={() => onPreviewPlan(row.key)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={`${t("routes.table.showOnMap")}: ${row.title}`}
                        title={t("routes.table.showOnMap")}
                        data-testid={`button-preview-plan-${row.key}`}
                      >
                        <MapPinned className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      {row.open.kind === "single" ? (
                        <Link
                          href={row.open.href}
                          onClick={onNavigate}
                          className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label={t("routes.table.openProject", { name: row.title })}
                          data-testid={`link-open-plan-${row.key}`}
                        >
                          {t("routes.table.open")}
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                              aria-label={`${t("routes.table.openProject", { name: row.title })}: ${t("routes.table.openDay")}`}
                              data-testid={`button-open-plan-day-${row.key}`}
                            >
                              <CalendarDays className="h-3 w-3" aria-hidden="true" />
                              {t("routes.table.openDay")}
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel className="text-xs">{row.title}</DropdownMenuLabel>
                            {row.open.options.map((option) => (
                              <DropdownMenuItem key={option.day} asChild>
                                <Link href={option.href} onClick={onNavigate} data-testid={`link-open-plan-${row.key}-${option.day}`}>
                                  {formatDay(option.day)}
                                </Link>
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && row.routes.map((child, index) => (
                  <tr
                    key={child.route.id}
                    id={index === 0 ? childPanelId : undefined}
                    className="border-b border-border/50 bg-background/60 hover:bg-muted/30"
                    data-testid={`row-route-${child.route.id}`}
                  >
                    {canWrite && (
                      <td className="px-2 py-1 align-middle">
                        <Checkbox
                          checked={deleteSelection.has(child.route.id)}
                          onCheckedChange={(checked) => onSelectIds([child.route.id], checked === true)}
                          disabled={selectionDisabled || !child.canDelete}
                          aria-label={t("routes.selectRouteForDeletion", { name: child.name, defaultValue: child.name })}
                          data-testid={`checkbox-route-${child.route.id}`}
                        />
                      </td>
                    )}
                    <td className="py-1 pl-10 pr-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate" title={child.name}>{child.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{child.vehicleLabel ?? UNKNOWN}</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 tabular-nums">{child.day ? formatDay(child.day) : UNKNOWN}</td>
                    <td className="max-w-[12rem] truncate px-2 py-1" title={child.driverName ?? undefined}>
                      {child.driverName ?? <span className="text-amber-700 dark:text-amber-400">{UNKNOWN}</span>}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCount(child.metrics.stops)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatMinutes(child.metrics.workMin)}</td>
                    <OptionalCells metrics={child.metrics} columns={columns} locale={locale} env={child.envScore} />
                    <td className="px-2 py-1"><StatusPill status={child.route.status} /></td>
                    <td className="px-2 py-1">
                      <div className="flex items-center justify-end gap-0.5" data-route-action>
                        <Link
                          href={child.href}
                          onClick={onNavigate}
                          className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label={`${t("routes.table.openRoute")}: ${child.identity}`}
                          data-testid={`link-open-route-${child.route.id}`}
                        >
                          {t("routes.table.open")}
                        </Link>
                        <RouteActionsMenu
                          route={child.route}
                          identity={child.identity}
                          onPreview={() => onPreviewRoute(child.route.id)}
                          deleteDisabled={deleteDisabled || !child.canDelete}
                          onDeleted={() => onRouteDeleted(row.key)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
      </table>
    </div>
  );
}
