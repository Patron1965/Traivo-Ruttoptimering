import { useEffect, useMemo, useState } from "react";
import {
  useGetVehiclePositions, getGetVehiclePositionsQueryKey,
  useGetGeofenceEvents, getGetGeofenceEventsQueryKey,
} from "@workspace/api-client-react";
import { RouteMap } from "@/components/map/RouteMap";
import { useRoutes } from "@/hooks/use-routes";
import { useStops } from "@/hooks/use-stops";
import { useVehicles } from "@/hooks/use-vehicles";
import { usePlannerOutgoingView } from "@/hooks/use-planner-outgoing-view";
import { useAuth } from "@/lib/auth-context";
import { ROUTE_COLORS } from "@/lib/constants";
import { actualTelemetryOnly, formatAge, isDispatchedOrDriving, latestActualByRoute, telemetryStatus } from "@/lib/live-telemetry";
import { liveMapPoint, liveRouteFocusPoints } from "@/lib/live-map-focus";
import { TelemetryRow, useNow } from "@/components/traffic/TrafficTelemetryPanel";

const POLL_MS = 5000;

/**
 * Independent, read-only live monitor for a second screen. It never talks to
 * its opener: it polls on its own (also in background tabs, regardless of the
 * WebSocket flag) and keeps working after reload or after the opener closes.
 */
export default function LiveMapPopout() {
  const { user, isLoading: authLoading } = useAuth();
  const organizationId = user?.organizationId;
  const allowed = user?.role === "admin" || user?.role === "dispatcher";
  const routesQuery = useRoutes();
  const stopsQuery = useStops();
  const { data: vehicles } = useVehicles();
  const params = useMemo(() => ({ organizationId: organizationId! }), [organizationId]);
  const positionsQuery = useGetVehiclePositions(params, { query: {
    queryKey: getGetVehiclePositionsQueryKey(params), enabled: !!organizationId && allowed,
    refetchInterval: POLL_MS, refetchIntervalInBackground: true, staleTime: 0,
  } });
  const eventParams = useMemo(() => ({ organizationId: organizationId!, limit: 30 }), [organizationId]);
  const eventsQuery = useGetGeofenceEvents(eventParams, { query: {
    queryKey: getGetGeofenceEventsQueryKey(eventParams), enabled: !!organizationId && allowed,
    refetchInterval: 15000, refetchIntervalInBackground: true,
  } });

  // Routes/stops hooks have their own cadence; keep them moving in the background too.
  const refetchRoutes = routesQuery.refetch;
  const refetchStops = stopsQuery.refetch;
  useEffect(() => {
    if (!allowed) return;
    const id = setInterval(() => { void refetchRoutes(); void refetchStops(); }, 20000);
    return () => clearInterval(id);
  }, [allowed, refetchRoutes, refetchStops]);

  useEffect(() => { document.title = "Traivo Route — Livekarta"; }, []);

  const liveRoutes = useMemo(() => (routesQuery.data ?? []).filter(isDispatchedOrDriving), [routesQuery.data]);
  const outgoing = usePlannerOutgoingView(liveRoutes, stopsQuery.data ?? [], allowed);
  const now = useNow(5000);
  const positions = useMemo(() => {
    const routeIds = new Set(outgoing.routes.map((route) => route.id));
    return actualTelemetryOnly(positionsQuery.data ?? []).filter((position) => routeIds.has(position.routeId));
  }, [positionsQuery.data, outgoing.routes]);
  const latest = useMemo(() => latestActualByRoute(positions), [positions]);
  const latestPositions = useMemo(() => [...latest.values()], [latest]);

  const mapRoutes = useMemo(() => {
    const vehicleById = new Map(vehicles?.map((vehicle) => [vehicle.id, vehicle]) ?? []);
    return outgoing.routes.map((route, idx) => {
      const vehicleId = outgoing.perRouteResources[route.id]?.vehicle?.id ?? route.vehicleId;
      const color = (vehicleId ? vehicleById.get(vehicleId)?.routeColor : undefined) ?? ROUTE_COLORS[idx % ROUTE_COLORS.length];
      return {
        ...route,
        stopsList: outgoing.stops.filter((stop) => stop.routeId === route.id)
          .sort((a, b) => (a.sequenceOrder ?? Infinity) - (b.sequenceOrder ?? Infinity)),
        routeColor: color,
        color,
      };
    });
  }, [outgoing.routes, outgoing.stops, outgoing.perRouteResources, vehicles]);

  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ coordinates: [number, number][]; request: number } | null>(null);
  const select = (routeId: string) => {
    if (selected === routeId) { setSelected(null); setFocus(null); return; }
    setSelected(routeId);
    const position = latest.get(routeId);
    const coords = position ? liveMapPoint(position) : liveRouteFocusPoints(mapRoutes.find((route) => route.id === routeId));
    setFocus({ coordinates: coords, request: Date.now() });
  };

  const lastFetch = positionsQuery.dataUpdatedAt;
  const fetchStale = lastFetch > 0 && now - lastFetch > POLL_MS * 4;
  const counts = mapRoutes.reduce((acc, route) => { acc[telemetryStatus(latest.get(route.id), now)] += 1; return acc; },
    { live: 0, stale: 0, "no-position": 0 } as Record<string, number>);
  const events = (eventsQuery.data ?? []).filter((event) => mapRoutes.some((route) => route.id === event.routeId)).slice(0, 8);

  const eventsStale = eventsQuery.dataUpdatedAt > 0 && now - eventsQuery.dataUpdatedAt > 60000;
  const outgoingLoading = allowed && liveRoutes.length > 0 && outgoing.isLoading;
  const routesFailed = routesQuery.isError;
  const stopsFailed = stopsQuery.isError;
  const scopeUnknown = routesFailed || (!routesQuery.data && !routesQuery.isLoading) || outgoingLoading || Boolean(outgoing.error);
  const problems: string[] = [];
  if (routesFailed) problems.push(routesQuery.data
    ? "Ruttlistan kunde inte uppdateras. Visade rutter kan vara inaktuella; nytt försök görs automatiskt."
    : "Ruttlistan kunde inte hämtas. Det går inte att avgöra vilka rutter som är ute.");
  if (stopsFailed) problems.push("Stopplistan kunde inte uppdateras. Stopp på kartan kan vara inaktuella.");
  if (outgoing.error) problems.push("Utskickade planer kunde inte läsas in. Inga rutter visas. Kontrollera inloggningen eller avgränsa urvalet i trafikledningen och ladda om fönstret.");
  if (eventsQuery.isError) problems.push("Händelser vid stopp kunde inte hämtas. Listan kan sakna nya händelser.");
  else if (eventsStale) problems.push("Händelser vid stopp har inte uppdaterats på över en minut.");

  if (authLoading || routesQuery.isLoading) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">Läser in livekartan…</div>;
  }
  if (!allowed) {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background p-6 text-center text-sm">Livekartan kräver inloggning som administratör eller trafikledare.</div>;
  }

  return (
    <div className="flex h-[100dvh] w-screen flex-col overflow-hidden bg-background" data-testid="live-map-popout">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <span className={`h-2.5 w-2.5 rounded-full ${positionsQuery.isError || fetchStale || problems.length > 0 ? "bg-amber-500" : "bg-emerald-500 animate-pulse"}`} />
        <h1 className="text-sm font-bold tracking-tight">Livekarta</h1>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Endast visning</span>
        <span data-testid="text-live-counts" className="ml-auto font-mono text-xs text-muted-foreground">
          {scopeUnknown ? "Urval okänt" : `${mapRoutes.length} rutter`} · {counts.live} aktuella · {counts.stale} inaktuella · {counts["no-position"]} utan position
        </span>
        <span data-testid="text-live-updated" className="font-mono text-xs text-muted-foreground">
          {lastFetch > 0 ? `Hämtat ${formatAge(now - lastFetch)}` : "Ingen hämtning ännu"}
        </span>
      </header>
      {(positionsQuery.isError || fetchStale) && (
        <div role="alert" className="shrink-0 bg-amber-500/15 px-4 py-1.5 text-xs">
          {positionsQuery.isError ? "Positioner kunde inte hämtas. Visade positioner kan vara inaktuella; nytt försök görs automatiskt." : "Ingen ny positionshämtning på en stund. Kontrollera anslutningen."}
        </div>
      )}
      {problems.map((problem) => (
        <div key={problem} role="alert" data-testid="alert-live-problem" className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs">{problem}</div>
      ))}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <RouteMap routes={mapRoutes} vehiclePositions={latestPositions} highlightedRouteId={selected ?? undefined}
            onHighlightRoute={select} focusBounds={focus} preserveRouteVisibility />
        </div>
        <aside className="hidden w-[340px] shrink-0 flex-col border-l border-border bg-card/60 md:flex">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {outgoingLoading && <p data-testid="status-live-loading" className="p-2 text-sm text-muted-foreground">Läser in utskickade planer…</p>}
            {!outgoingLoading && scopeUnknown && mapRoutes.length === 0 && <p className="p-2 text-sm text-muted-foreground">Rutturvalet är okänt just nu. Se meddelandet ovan.</p>}
            {!scopeUnknown && mapRoutes.length === 0 && <p className="p-2 text-sm text-muted-foreground">Inga utskickade eller pågående rutter just nu.</p>}
            {mapRoutes.map((route) => (
              <TelemetryRow key={route.id} large route={{ id: route.id, name: route.name, color: route.color }}
                position={latest.get(route.id)} now={now} selected={selected === route.id} onSelect={() => select(route.id)} />
            ))}
          </div>
          {events.length > 0 && (
            <div className="max-h-56 shrink-0 overflow-y-auto border-t border-border p-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Senaste händelser</p>
              {events.map((event) => (
                <p key={event.id} className="flex gap-2 py-0.5 text-xs">
                  <span className="shrink-0 font-mono text-muted-foreground">{new Date(event.timestamp).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="truncate">{event.vehicleName} {event.eventType === "entered" ? "anlände till" : "lämnade"} {event.stopAddress}</span>
                </p>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
