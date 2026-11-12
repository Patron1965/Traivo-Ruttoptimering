import { Columns3, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  OPTIONAL_ROUTE_COLUMNS,
  isValidDay,
  type OptionalRouteColumn,
  type RoutesListFilters,
} from "@/lib/route-project-table";

const STATUS_TABS = [
  ["all", "routes.filterAll"],
  ["active", "routes.filterActive"],
  ["drafts", "routes.filterDrafts"],
  ["completed", "routes.filterCompleted"],
] as const;

const COLUMN_KEYS: Record<OptionalRouteColumn, string> = {
  distance: "routes.table.colDistance",
  travel: "routes.table.colTravel",
  service: "routes.table.colService",
  utilization: "routes.table.colUtilization",
  environment: "routes.table.colEnvironment",
};

interface RoutesListToolbarProps {
  filters: RoutesListFilters;
  onChange: (next: Partial<RoutesListFilters>) => void;
  columns: OptionalRouteColumn[];
  onColumnsChange: (columns: OptionalRouteColumn[]) => void;
}

export function RoutesListToolbar({ filters, onChange, columns, onColumnsChange }: RoutesListToolbarProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[14rem] flex-1 max-w-md">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="routes-search" className="sr-only">{t("routes.searchLabel")}</label>
        <Input
          id="routes-search"
          type="search"
          value={filters.q}
          onChange={(event) => onChange({ q: event.target.value })}
          placeholder={t("routes.searchPlaceholder")}
          className="h-8 pl-8 pr-8 text-sm"
          autoComplete="off"
          data-testid="input-routes-search"
        />
        {filters.q && (
          <button
            type="button"
            onClick={() => onChange({ q: "" })}
            className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("routes.clearSearch")}
            data-testid="button-clear-search"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1">
        <label htmlFor="routes-date" className="text-xs font-medium text-muted-foreground">{t("routes.table.dateFilter")}</label>
        <Input
          id="routes-date"
          type="date"
          value={filters.date ?? ""}
          onChange={(event) => onChange({ date: isValidDay(event.target.value) ? event.target.value : null })}
          className="h-8 w-[9.5rem] text-sm"
          data-testid="input-routes-date"
        />
        {filters.date && (
          <button
            type="button"
            onClick={() => onChange({ date: null })}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t("routes.table.clearDate")}
            data-testid="button-clear-date"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5" role="tablist" aria-label={t("routes.statusFilter")}>
        {STATUS_TABS.map(([value, labelKey]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filters.status === value}
            onClick={() => onChange({ status: value })}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              filters.status === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`tab-status-${value}`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="ml-auto h-8 gap-1.5" data-testid="button-columns">
            <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
            {t("routes.table.columns")}
            {columns.length > 0 && <span className="text-xs text-muted-foreground">+{columns.length}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs">{t("routes.table.columns")}</DropdownMenuLabel>
          {OPTIONAL_ROUTE_COLUMNS.map((column) => (
            <DropdownMenuCheckboxItem
              key={column}
              checked={columns.includes(column)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => onColumnsChange(
                OPTIONAL_ROUTE_COLUMNS.filter((c) => (c === column ? checked === true : columns.includes(c))),
              )}
              data-testid={`checkbox-column-${column}`}
            >
              {t(COLUMN_KEYS[column])}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
