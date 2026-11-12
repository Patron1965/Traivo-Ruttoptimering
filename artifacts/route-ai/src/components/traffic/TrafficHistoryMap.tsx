import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { getGetRouteStopsQueryOptions, type Route } from "@workspace/api-client-react";
import { RouteMap } from "@/components/map/RouteMap";
import { selectMapRoutes } from "@/lib/live-map";
import { liveRouteFocusPoints } from "@/lib/live-map-focus";

const HISTORY_PAGE = 40;

/** Read-only map of completed/cancelled routes. No telemetry, no planning actions. */
export function TrafficHistoryMap({ routes, routeColor, showPredictions }: {
  routes: Route[];
  routeColor: (route: Route) => string | undefined;
  showPredictions: boolean;
}) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const allHistory = useMemo(
    () => selectMapRoutes(routes, true).sort((a, b) => b.date.localeCompare(a.date)),
    [routes],
  );
  const historyRoutes = useMemo(() => allHistory.slice(0, limit), [allHistory, limit]);
  const queries = useQueries({ queries: historyRoutes.map((route) => getGetRouteStopsQueryOptions(route.id)) });
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ coordinates: [number, number][]; request: number } | null>(null);
  const mapRoutes = historyRoutes.map((route, idx) => ({
    ...route,
    stopsList: queries[idx]?.data ?? [],
    routeColor: routeColor(route),
  }));
  const hasError = queries.some((q) => q.isError);
  const loading = queries.some((q) => q.isLoading);

  return (
    <div className="relative h-full w-full" data-testid="traffic-history-map">
      <RouteMap routes={mapRoutes} highlightedRouteId={selected ?? undefined} showPredictions={showPredictions}
        focusBounds={focus}
        onHighlightRoute={(routeId: string) => {
          setSelected(routeId);
          setFocus({ coordinates: liveRouteFocusPoints(mapRoutes.find((route) => route.id === routeId)), request: Date.now() });
        }} />
      <div data-testid="text-history-count" className="absolute bottom-3 left-3 z-[500] flex items-center gap-2 rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-[11px] shadow">
        <span>Historik: visar {historyRoutes.length} av {allHistory.length} avslutade rutter (nyast först)</span>
        {allHistory.length > historyRoutes.length && (
          <button type="button" data-testid="button-history-more" onClick={() => setLimit((value) => value + HISTORY_PAGE)}
            className="rounded border border-border px-1.5 py-0.5 font-semibold hover:bg-muted">Visa {Math.min(HISTORY_PAGE, allHistory.length - historyRoutes.length)} till</button>
        )}
        {loading && " · läser in stopp"}
        {hasError && <span className="text-destructive"> · vissa stopp kunde inte hämtas</span>}
        {historyRoutes.length === 0 && " · inget att visa"}
      </div>
    </div>
  );
}
