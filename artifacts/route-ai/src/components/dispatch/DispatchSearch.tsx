import type { RefObject } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  searchDispatchItems,
  type DispatchSearchItem,
  type DispatchSearchResult,
} from "@/lib/dispatch-search";

interface DispatchSearchProps {
  items: readonly DispatchSearchItem[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (result: DispatchSearchResult) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

const MAX_VISIBLE_RESULTS = 12;

function resultLabel(result: DispatchSearchResult, unassignedLabel: string): string {
  const route = result.routeName || unassignedLabel;
  const sequence = result.stop.sequenceOrder == null
    ? ""
    : ` · #${result.stop.sequenceOrder}`;
  return `${result.stop.contactName || result.stop.address}${sequence} · ${route}`;
}

export function DispatchSearch({
  items,
  query,
  onQueryChange,
  onSelect,
  inputRef,
}: DispatchSearchProps) {
  const { t } = useTranslation();
  const results = searchDispatchItems(items, query);
  const hasQuery = query.trim().length > 0;
  const visibleResults = results.slice(0, MAX_VISIBLE_RESULTS);
  const noResults = hasQuery && results.length === 0;

  return (
    <div className="relative min-w-0 flex-1 basis-full xl:basis-40 xl:max-w-[15rem]" data-testid="dispatch-search">
      <label htmlFor="dispatch-global-search" className="sr-only">
        {t("dispatch.searchLabel")}
      </label>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id="dispatch-global-search"
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("dispatch.searchPlaceholder")}
          autoComplete="off"
          aria-controls="dispatch-search-results"
          aria-expanded={hasQuery}
          aria-describedby={noResults ? "dispatch-search-status" : undefined}
          className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-9 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        {hasQuery && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("dispatch.clearSearch")}
            title={t("dispatch.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {hasQuery && (
        <div
          id="dispatch-search-results"
          className="absolute left-0 top-full z-[70] mt-1 w-full overflow-hidden rounded-md border border-border bg-card shadow-xl xl:w-[min(28rem,calc(100vw-2rem))]"
          role="region"
          aria-label={t("dispatch.searchResultsLabel")}
        >
          {noResults ? (
            <p
              id="dispatch-search-status"
              role="status"
              aria-live="polite"
              className="px-3 py-3 text-xs text-muted-foreground"
            >
              {t("dispatch.searchNoResults")}
            </p>
          ) : (
            <>
              <p className="border-b border-border/70 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground">
                {t("dispatch.searchResultCount", { count: results.length })}
              </p>
              <ul className="max-h-80 overflow-y-auto py-1">
                {visibleResults.map((result) => (
                  <li key={`${result.routeId ?? "unassigned"}:${result.stopId}`}>
                    <button
                      type="button"
                      onClick={() => onSelect(result)}
                      className={cn(
                        "flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                      )}
                    >
                      <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded border border-primary/30 bg-primary/10 px-1 font-mono text-[10px] font-bold text-primary">
                        {result.stop.sequenceOrder ?? "—"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">
                          {resultLabel(result, t("dispatch.unplannedStops"))}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {result.stop.address}
                          {result.vehicleLicense ? ` · ${result.vehicleLicense}` : ""}
                          {result.driverName ? ` · ${result.driverName}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {results.length > MAX_VISIBLE_RESULTS && (
                <p className="border-t border-border/70 px-3 py-1.5 text-[10px] text-muted-foreground">
                  {t("dispatch.searchMoreResults", {
                    count: results.length - MAX_VISIBLE_RESULTS,
                  })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
