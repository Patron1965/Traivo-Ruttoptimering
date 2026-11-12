import { useEffect, useMemo, useState } from "react";
import { Battery, ChevronDown, ChevronUp, Clock, Gauge, Navigation, Radio, MapPinOff } from "lucide-react";
import type { GeofenceEvent, VehiclePosition } from "@workspace/api-client-react";
import { formatAge, latestActualByRoute, telemetryStatus, type LiveVehicleStatus } from "@/lib/live-telemetry";

export function useNow(intervalMs = 10000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const STATUS_LABEL: Record<LiveVehicleStatus, string> = {
  live: "Aktuell",
  stale: "Inaktuell",
  "no-position": "Position saknas",
};

export function TelemetryStatusBadge({ status }: { status: LiveVehicleStatus }) {
  const cls = status === "live"
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
    : status === "stale"
      ? "bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/40"
      : "bg-muted text-muted-foreground border-border";
  return (
    <span data-testid={`status-telemetry-${status}`} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export type TelemetryRoute = { id: string; name: string; color?: string };

export function TelemetryRow({ route, position, now, selected, onSelect, large = false }: {
  route: TelemetryRoute;
  position?: VehiclePosition;
  now: number;
  selected?: boolean;
  onSelect?: () => void;
  large?: boolean;
}) {
  const status = telemetryStatus(position, now);
  const measured = position?.measuredAt ? Date.parse(position.measuredAt) : null;
  const content = (
    <>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: route.color ?? "hsl(var(--primary))" }} />
        <span className={`min-w-0 flex-1 truncate font-semibold ${large ? "text-base" : "text-xs"}`} title={route.name}>{route.name}</span>
        <TelemetryStatusBadge status={status} />
      </div>
      {position && status !== "no-position" ? (
        <div className={`mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground ${large ? "text-sm" : "text-[11px]"}`}>
          <span className="truncate">{position.vehicleName} · {position.licensePlate}</span>
          <span className="flex items-center justify-end gap-1 font-mono tabular-nums text-foreground"><Gauge className="h-3 w-3" />{Math.round(position.speedKmh)} km/h</span>
          {position.nextStopAddress && (
            <span className="col-span-2 flex items-center gap-1 truncate"><Navigation className="h-3 w-3 shrink-0" /><span className="truncate">{position.nextStopAddress}</span>
              {position.etaMinutes != null && <span className="ml-auto shrink-0 font-mono text-foreground">ETA {position.etaMinutes} min</span>}
            </span>
          )}
          {position.batteryPercent != null && (
            <span className="flex items-center gap-1"><Battery className="h-3 w-3" />{Math.round(position.batteryPercent)} %</span>
          )}
          {measured != null && (
            <span className="col-span-1 flex items-center justify-end gap-1" title={new Date(measured).toLocaleString("sv-SE")}>
              <Clock className="h-3 w-3" />{formatAge(now - measured)}
            </span>
          )}
        </div>
      ) : (
        <p className={`mt-1 flex items-center gap-1 text-muted-foreground ${large ? "text-sm" : "text-[11px]"}`}>
          <MapPinOff className="h-3 w-3" />Ingen uppmätt position har tagits emot. Ingen position visas på kartan.
        </p>
      )}
    </>
  );
  const base = `block w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${selected ? "border-primary bg-primary/5" : "border-border/70 bg-card hover:border-primary/40"}`;
  return onSelect
    ? <button type="button" data-testid={`button-telemetry-route-${route.id}`} aria-pressed={selected} onClick={onSelect} className={base}>{content}</button>
    : <div data-testid={`row-telemetry-route-${route.id}`} className={base}>{content}</div>;
}

/** Collapsible live panel over the traffic map: actual telemetry and geofence events. */
export function TrafficTelemetryPanel({ routes, positions, positionsUpdatedAt, eventsUpdatedAt, events, eventsError, positionsError, selectedRouteId, onSelectRoute }: {
  positionsUpdatedAt: number;
  eventsUpdatedAt: number;
  routes: TelemetryRoute[];
  positions: VehiclePosition[];
  events: GeofenceEvent[];
  positionsError: boolean;
  eventsError: boolean;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string) => void;
}) {
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.localStorage.getItem("traffic.telemetryOpen") !== "0");
  const [eventsOpen, setEventsOpen] = useState(false);
  useEffect(() => { window.localStorage.setItem("traffic.telemetryOpen", open ? "1" : "0"); }, [open]);
  const now = useNow();
  const latest = useMemo(() => latestActualByRoute(positions), [positions]);
  const routeIds = useMemo(() => new Set(routes.map((route) => route.id)), [routes]);
  const scopedEvents = events.filter((event) => routeIds.has(event.routeId));
  const counts = routes.reduce((acc, route) => { acc[telemetryStatus(latest.get(route.id), now)] += 1; return acc; },
    { live: 0, stale: 0, "no-position": 0 } as Record<LiveVehicleStatus, number>);

  return (
    <div data-testid="panel-traffic-telemetry" className="pointer-events-auto absolute right-3 top-3 z-[500] flex max-h-[calc(100%-1.5rem)] w-[300px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur">
      <button type="button" data-testid="button-toggle-telemetry" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex items-center gap-2 px-3 py-2 text-left text-xs font-semibold">
        <Radio className="h-3.5 w-3.5 text-primary" />
        <span className="flex-1">Telemetri</span>
        <span className="font-mono text-[10px] text-muted-foreground">{counts.live} aktuella · {counts.stale} inaktuella · {counts["no-position"]} saknas</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto border-t border-border px-2 py-2">
          {positionsError && <p role="alert" className="rounded bg-destructive/10 px-2 py-1 text-[11px]">Positioner kunde inte hämtas. Visade positioner kan vara inaktuella.</p>}
          {!positionsError && positionsUpdatedAt > 0 && now - positionsUpdatedAt > 30000 && (
            <p role="alert" className="rounded bg-amber-500/15 px-2 py-1 text-[11px]">Positioner har inte uppdaterats {formatAge(now - positionsUpdatedAt)}.</p>
          )}
          <p data-testid="text-positions-updated" className="px-1 text-[10px] text-muted-foreground">{positionsUpdatedAt > 0 ? `Positioner hämtade ${formatAge(now - positionsUpdatedAt)}` : "Positioner har inte hämtats ännu"}</p>
          {routes.length === 0 && <p className="px-1 py-2 text-[11px] text-muted-foreground">Inga utskickade rutter i urvalet.</p>}
          {routes.map((route) => (
            <TelemetryRow key={route.id} route={route} position={latest.get(route.id)} now={now}
              selected={selectedRouteId === route.id} onSelect={() => onSelectRoute(route.id)} />
          ))}
          <div className="border-t border-border pt-1.5">
            <button type="button" data-testid="button-toggle-geofence" onClick={() => setEventsOpen((v) => !v)} aria-expanded={eventsOpen}
              className="flex w-full items-center gap-2 px-1 py-1 text-[11px] font-semibold">
              <span className="flex-1 text-left">Händelser vid stopp ({scopedEvents.length})</span>
              {eventsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {eventsOpen && (
              <ul className="space-y-1 px-1 pb-1">
                {eventsError && <li role="alert" className="text-[11px] text-destructive">Händelser kunde inte hämtas.</li>}
                {!eventsError && eventsUpdatedAt > 0 && now - eventsUpdatedAt > 60000 && <li role="alert" className="text-[11px] text-amber-700 dark:text-amber-300">Händelser har inte uppdaterats {formatAge(now - eventsUpdatedAt)}.</li>}
                {!eventsError && eventsUpdatedAt === 0 && <li className="text-[11px] text-muted-foreground">Läser in händelser…</li>}
                {!eventsError && eventsUpdatedAt > 0 && scopedEvents.length === 0 && <li className="text-[11px] text-muted-foreground">Inga händelser ännu.</li>}
                {scopedEvents.map((event) => (
                  <li key={event.id} data-testid={`row-geofence-${event.id}`} className="flex gap-2 text-[11px]">
                    <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${event.eventType === "entered" ? "bg-emerald-500" : "bg-amber-500"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{event.vehicleName}</span>{" "}
                      <span className="text-muted-foreground">{event.eventType === "entered" ? "anlände till" : "lämnade"}</span>
                      <span className="block truncate text-muted-foreground">{event.stopAddress}</span>
                    </span>
                    <span className="shrink-0 font-mono text-muted-foreground">{new Date(event.timestamp).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
