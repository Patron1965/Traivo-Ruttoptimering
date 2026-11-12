import { useEffect, useState, useCallback, useRef, lazy, Suspense } from "react";
import { mapRouteEndpoints } from "@/lib/map-route-endpoints";
import { MapContainer, Marker, Popup, ZoomControl, Circle, Polyline, Polygon, useMap, useMapEvents } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type Route, type Stop, type VehiclePosition } from "@workspace/api-client-react";
import { DEPOT_LOCATION } from "@/lib/constants";
import { renderToString } from "react-dom/server";
import { useTranslation } from "react-i18next";
import { fetchRouteGeometry, type RouteGeometryResult } from "@/lib/osrm";
import { PredictionLayer } from "./PredictionLayer";
import { MapRouteSelectionLayer } from "./MapRouteSelectionLayer";
import { MapDriverSelection } from "./MapDriverSelection";
const MapPlanActions = lazy(() => import("./MapPlanActions"));
import { MapBackgroundLayer } from "./MapBackgroundLayer";
import { MapStopBounds } from "./MapStopBounds";
import { getRouteColor, sortStopsBySequence, getValidCoordinates, isValidCoordinate } from "@/lib/map-utils";
import { getStopStatusTranslationKey } from "@/lib/stop-status";
import { stopMarkerStatusBadge } from "@/lib/stop-marker-status";
import { Warehouse, Zap, Fuel, Navigation, Clock, Battery } from "lucide-react";
import { routeHighlight } from "@/lib/dispatch-route-selection";
import { PositionFreshness } from "./PositionFreshness";
import { LockEvidenceBadges } from "@/components/dispatch/LockEvidenceBadges";

const STATUS_WEIGHT: Record<string, number> = {
  draft: 5,
  planned: 5,
  optimized: 5,
  active: 6,
  in_progress: 6,
  delayed: 6,
  completed: 5,
  cancelled: 5,
};

const STATUS_OPACITY: Record<string, number> = {
  draft: 0.9,
  planned: 0.95,
  optimized: 1.0,
  active: 1.0,
  in_progress: 1.0,
  delayed: 1.0,
  completed: 0.95,
  cancelled: 0.9,
};

interface RouteData extends Route {
  stopsList: Stop[];
}

function routeDepotPoints(route: RouteData) {
  const saved = mapRouteEndpoints(route);
  const stops = getValidCoordinates(route.stopsList ?? []);
  return {
    // Unknown endpoints can only display known stops, not an invented trip.
    start: saved.start ?? stops[0] ?? [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng] as [number, number],
    end: saved.end ?? stops.at(-1) ?? [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng] as [number, number],
    hasStart: !!saved.start,
    hasEnd: !!saved.end,
  };
}

interface RouteMapProps {
  routes?: RouteData[];
  unassignedStops?: Stop[];
  vehiclePositions?: VehiclePosition[];
  center?: [number, number];
  zoom?: number;
  interactive?: boolean;
  selectedStopId?: string | null;
  selectedStopIds?: Set<string>;
  onSelectStop?: (stopId: string, modifiers?: { additive: boolean }) => void;
  highlightedRouteId?: string | null;
  highlightedRouteIds?: ReadonlySet<string>;
  onHighlightRoute?: (routeId: string) => void;
  onSelectDriverRoute?: (routeId: string, additive: boolean) => void;
  onClearDriverRoutes?: () => void;
  planningActionsEnabled?: boolean;
  focusStopId?: string | null;
  hoveredStopId?: string | null;
  onHoverStop?: (stopId: string | null) => void;
  dropRequest?: { clientX: number; clientY: number; nonce: number } | null;
  onDropRoute?: (routeId: string | null) => void;
  showPredictions?: boolean;
  preserveRouteVisibility?: boolean;
  fitStopsRequest?: number;
  focusBounds?: { coordinates: [number, number][]; request: number } | null;
  showDepot?: boolean;
  stopMarkerLabels?: Record<string, string>;
  selectionEnabled?: boolean;
  onPolygonSelect?: (stopIds: string[]) => void;
}

function insidePolygon(point: L.Point, vertices: L.Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i], b = vertices[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function MapAreaSelection({ active, stops, onFinish, onCancel }: {
  active: boolean;
  stops: Stop[];
  onFinish: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [vertices, setVertices] = useState<L.LatLng[]>([]);
  const controlsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (controlsRef.current) {
      L.DomEvent.disableClickPropagation(controlsRef.current);
      L.DomEvent.disableScrollPropagation(controlsRef.current);
    }
  }, [active]);
  const map = useMapEvents({
    click: (event) => {
      if (active) setVertices((current) => [...current, event.latlng]);
    },
  });
  useEffect(() => {
    if (!active) setVertices([]);
  }, [active]);
  const finish = useCallback(() => {
    if (vertices.length < 3) return;
    const polygon = vertices.map((vertex) => map.latLngToLayerPoint(vertex));
    const bounds = map.getBounds();
    onFinish(stops.filter((stop) =>
      isValidCoordinate(stop.latitude, stop.longitude)
      && bounds.contains([stop.latitude, stop.longitude])
      && insidePolygon(map.latLngToLayerPoint([stop.latitude, stop.longitude]), polygon),
    ).map((stop) => stop.id));
    setVertices([]);
  }, [map, onFinish, stops, vertices]);
  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setVertices([]);
        onCancel();
      } else if (event.key === "Enter" && vertices.length >= 3) {
        event.preventDefault();
        finish();
      }
    };
    // Handle map cancellation before Dispatch's global bubble-phase shortcuts.
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [active, finish, onCancel, vertices.length]);
  if (!active) return null;
  return <>
    <div ref={controlsRef} className="absolute left-3 top-3 z-[1000] flex max-w-64 flex-col gap-2 rounded-lg border border-border bg-card p-2 shadow-lg">
      <button type="button" data-testid="dispatch-finish-marking" disabled={vertices.length < 3}
        onClick={finish} className="rounded-md bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">Slutför markering</button>
      <button type="button" data-testid="dispatch-cancel-marking" onClick={onCancel}
        className="rounded-md border px-3 py-2 text-xs font-bold">Avbryt markering</button>
      <span className="text-[11px] text-muted-foreground">Klicka minst tre hörn på kartan ({vertices.length} valda). Enter slutför, Escape avbryter.</span>
    </div>
    {vertices.length >= 3
      ? <Polygon positions={vertices} pathOptions={{ color: "#0e7490", weight: 2, fillOpacity: 0.15, interactive: false }} />
      : vertices.length > 0 && <Polyline positions={vertices} pathOptions={{ color: "#0e7490", weight: 2, dashArray: "5 5", interactive: false }} />}
  </>;
}

// Do not rely on optional markercluster CSS: counts must remain readable in
// production builds as well as development, including on a pale basemap.
function createClusterIcon(cluster: { getChildCount: () => number }) {
  const count = cluster.getChildCount();
  return L.divIcon({
    html: `<div style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:#075985;color:white;border:3px solid white;box-shadow:0 2px 7px #0005;font:bold 13px/1 sans-serif">${count}</div>`,
    className: "route-map-cluster",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

function MapFlyTo({ routes, unassignedStops, focusStopId }: { routes: RouteData[]; unassignedStops: Stop[]; focusStopId: string | null }) {
  const map = useMap();
  const stop = routes.flatMap((route) => route.stopsList).find((item) => item.id === focusStopId)
    ?? unassignedStops.find((item) => item.id === focusStopId);
  const latitude = stop?.latitude;
  const longitude = stop?.longitude;
  useEffect(() => {
    if (focusStopId && isValidCoordinate(latitude, longitude)) {
      map.flyTo([latitude!, longitude!], 14, { duration: 0.5 });
    }
  }, [focusStopId, latitude, longitude, map]);
  return null;
}

function MapResizeObserver() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    let animationFrame = 0;
    let settleTimer = 0;
    const applySize = (redrawTiles = false) => {
      // Keep tiles aligned while resizing, but avoid expensive moveend consumers
      // on every frame of a splitter drag.
      map.invalidateSize({ pan: true, animate: false, debounceMoveend: true });
      if (redrawTiles) {
        map.eachLayer((layer) => {
          if (layer instanceof L.TileLayer) layer.redraw();
        });
      }
    };
    const invalidate = () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
      animationFrame = window.requestAnimationFrame(() => {
        applySize();
        settleTimer = window.setTimeout(() => applySize(true), 160);
      });
    };

    const observer = new ResizeObserver(invalidate);
    observer.observe(container);
    if (container.parentElement) observer.observe(container.parentElement);
    window.addEventListener("resize", invalidate);
    invalidate();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", invalidate);
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(settleTimer);
    };
  }, [map]);

  return null;
}

const createCustomIcon = (color: string, label?: string, isDepot = false) => {
  const size = label && label.length > 2 ? 32 : 24;
  const iconHtml = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {isDepot ? (
        <div className="w-8 h-8 bg-primary/10 rounded border-2 border-primary shadow-sm flex items-center justify-center">
           <Warehouse className="w-4 h-4 text-primary" />
        </div>
      ) : (
        <div
          className="w-6 h-6 flex items-center justify-center text-white text-[11px] font-bold font-mono border shadow-sm transition-transform"
          style={{ width: size, height: size, backgroundColor: color, borderColor: 'rgba(255,255,255,0.85)', borderRadius: '4px' }}
        >
          {label}
        </div>
      )}
    </div>
  );

  return L.divIcon({
    html: iconHtml,
    className: "custom-leaflet-icon",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

const createDimmedIcon = (color: string, label?: string) => {
  const iconHtml = renderToString(
    <div className="relative flex items-center justify-center opacity-30" style={{ width: 20, height: 20 }}>
      <div
        className="w-5 h-5 flex items-center justify-center text-white text-[9px] font-bold font-mono border border-transparent shadow-sm"
        style={{ backgroundColor: color, borderRadius: '4px' }}
      >
        {label}
      </div>
    </div>
  );
  return L.divIcon({
    html: iconHtml,
    className: "custom-leaflet-icon-dimmed",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -10],
  });
};

const createSelectedIcon = (color: string, label?: string) => {
  const size = label && label.length > 2 ? 36 : 32;
  const iconHtml = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded bg-white animate-ping opacity-20 scale-125" />
      <div
        className="relative z-10 w-7 h-7 flex items-center justify-center text-white text-[12px] font-bold font-mono border-2 border-white shadow-lg"
        style={{ width: size - 4, height: size - 4, backgroundColor: color, borderRadius: '4px' }}
      >
        {label}
      </div>
    </div>
  );
  return L.divIcon({
    html: iconHtml,
    className: "custom-leaflet-icon-selected",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

const createVehicleIcon = (heading: number, vehicleType: string) => {
  const color = vehicleType === "electric" ? "#10B981" : "#F59E0B";
  const html = renderToString(
    <div style={{ width: 40, height: 40, transform: `rotate(${heading}deg)` }} className="flex items-center justify-center">
      <div className="relative">
        <div className="absolute inset-0 rounded-full animate-ping opacity-30" style={{ backgroundColor: color }} />
        <div className="w-10 h-10 rounded-full flex items-center justify-center border-2 shadow-lg" style={{ backgroundColor: `${color}20`, borderColor: color }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
        </div>
      </div>
    </div>
  );
  return L.divIcon({
    html,
    className: "vehicle-marker-icon",
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -20],
  });
};

function useRouteGeometries(routes: RouteData[]) {
  const [geometries, setGeometries] = useState<Map<string, RouteGeometryResult>>(new Map());

  const routeKey = routes.map(r => {
    const coordinates = getValidCoordinates(r.stopsList);
    const depot = routeDepotPoints(r);
    return `${r.id}:${depot.start.join(",")}:${coordinates.map(([lat, lng]) => `${lat},${lng}`).join(";")}:${depot.end.join(",")}`;
  }).join("|");

  useEffect(() => {
    if (!routeKey) {
      setGeometries(new Map());
      return;
    }
    const requests = routes.map((route) => {
      const validCoords = getValidCoordinates(route.stopsList);
      const depot = routeDepotPoints(route);
      const waypoints: [number, number][] = validCoords.length > 0
        ? [
            depot.start,
            ...validCoords,
            depot.end,
          ]
        : [];
      return { routeId: route.id, waypoints };
    });

    setGeometries(new Map(requests.map(({ routeId, waypoints }) => [
      routeId,
      { coordinates: waypoints, isFallback: true },
    ])));

    let cancelled = false;
    Promise.all(requests.map(async ({ routeId, waypoints }) => ({
      routeId,
      result: await fetchRouteGeometry(waypoints),
    }))).then((results) => {
      if (!cancelled) {
        setGeometries(new Map(results.map(({ routeId, result }) => [routeId, result])));
      }
    });

    return () => { cancelled = true; };
  }, [routeKey]);

  return geometries;
}

export function RouteMap({
  routes = [],
  unassignedStops = [],
  vehiclePositions = [],
  center,
  zoom = 11,
  interactive = true,
  selectedStopId = null,
  selectedStopIds = new Set<string>(),
  onSelectStop,
  highlightedRouteId = null,
  highlightedRouteIds,
  onHighlightRoute,
  onSelectDriverRoute,
  onClearDriverRoutes,
  planningActionsEnabled = false,
  focusStopId = null,
  hoveredStopId = null,
  onHoverStop,
  dropRequest,
  onDropRoute,
  showPredictions = false,
  preserveRouteVisibility = false,
  fitStopsRequest,
  focusBounds,
  showDepot = true,
  stopMarkerLabels,
  selectionEnabled = false,
  onPolygonSelect,
}: RouteMapProps) {
  const selectedRoutes = highlightedRouteIds ?? new Set(highlightedRouteId ? [highlightedRouteId] : []);
  const [mounted, setMounted] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markingFeedback, setMarkingFeedback] = useState<string | null>(null);
  const { t } = useTranslation();
  const routeGeometries = useRouteGeometries(routes);
  const mapCenter = center ?? (
    routes[0]
      ? routeDepotPoints(routes[0]).start
      : [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng]
  );

  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!selectionEnabled) setMarking(false);
  }, [selectionEnabled]);
  const finishMarking = useCallback((ids: string[]) => {
    if (ids.length) onPolygonSelect?.(ids);
    setMarkingFeedback(ids.length ? null : "Inga stopp finns i markeringen. Markera ett annat område. Ditt tidigare urval finns kvar.");
    setMarking(false);
  }, [onPolygonSelect]);
  const cancelMarking = useCallback(() => setMarking(false), []);

  if (!mounted) return <div className="w-full h-full bg-muted/20 animate-pulse rounded-2xl" />;

  const validUnassignedStops = unassignedStops.filter((stop) =>
    isValidCoordinate(stop.latitude, stop.longitude),
  );
  const validVehiclePositions = vehiclePositions.filter((position) =>
    isValidCoordinate(position.latitude, position.longitude),
  );

  return (
    <div className="relative isolate z-0 h-full w-full">
    {interactive && onSelectDriverRoute && !marking && routes.length > 0 && (
      <MapDriverSelection routes={routes} selected={selectedRoutes}
        onSelect={onSelectDriverRoute} onClear={onClearDriverRoutes}
        actions={planningActionsEnabled ? <Suspense fallback={<p>Laddar planåtgärder…</p>}>
          <MapPlanActions visibleRoutes={routes} selected={selectedRoutes} />
        </Suspense> : undefined} />
    )}
    {selectionEnabled && onPolygonSelect && !marking && (
      <div className="absolute left-3 top-3 z-[1000] flex flex-col items-start gap-1">
        <button type="button" data-testid="dispatch-mark-stops" aria-pressed={marking}
          className={`h-7 rounded border border-border px-2 py-0 text-[11px] font-semibold shadow-sm [@media(pointer:coarse)]:h-11 ${marking ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted"}`}
          onClick={() => { setMarkingFeedback(null); setMarking(true); }}>
          {marking ? "Avbryt markering" : "Markera stopp"}
        </button>
        {markingFeedback && <span role="status" className="max-w-64 rounded bg-card p-2 text-xs text-muted-foreground shadow-sm">{markingFeedback}</span>}
      </div>
    )}
    <MapContainer
      center={mapCenter}
      zoom={zoom}
      className="w-full h-full rounded-2xl z-0"
      zoomControl={false}
      dragging={interactive}
      scrollWheelZoom={interactive}
    >
      <MapResizeObserver />
      <MapAreaSelection active={marking} stops={[...routes.flatMap((route) => route.stopsList), ...unassignedStops]}
        onFinish={finishMarking} onCancel={cancelMarking} />
      <MapStopBounds
        request={focusBounds?.request ?? fitStopsRequest}
        coordinates={focusBounds?.coordinates ?? [
          ...routes.flatMap((route) => getValidCoordinates(route.stopsList)),
          ...validUnassignedStops.map((stop): [number, number] => [stop.latitude, stop.longitude]),
        ]}
      />
      <MapFlyTo routes={routes} unassignedStops={unassignedStops} focusStopId={selectedStopId ?? focusStopId} />
      <ZoomControl position="bottomright" />
      <MapBackgroundLayer />
      {routes.some((route) => {
        const endpoints = mapRouteEndpoints(route);
        return !endpoints.start || !endpoints.end;
      }) && (
        <div role="status" className="absolute bottom-12 left-3 z-[1000] max-w-sm rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          {t("map.missingRouteEndpoints", { defaultValue: "Start- eller slutplats saknas för en rutt. Kartan visar bara kända platser." })}
        </div>
      )}

      <PredictionLayer visible={showPredictions} />

      {showDepot && (routes.length > 0 ? routes : [{
        id: "legacy-depot",
        depotSnapshot: null,
      } as RouteData]).flatMap((route) => {
        const depot = routeDepotPoints(route);
        const points = depot.hasStart && depot.hasEnd && depot.start[0] === depot.end[0] && depot.start[1] === depot.end[1]
          ? [{ key: "depot", point: depot.start, label: t("map.centralDepot") }]
          : [
              { key: "start", point: depot.start, label: "Startdepå" },
              { key: "end", point: depot.end, label: "Slutdepå" },
            ];
        return points.filter(({ key }) => key === "depot" ? depot.hasStart && depot.hasEnd : key === "start" ? depot.hasStart : depot.hasEnd).map(({ key, point, label }) => (
          <Marker key={`${route.id}-${key}`} position={point} icon={createCustomIcon("#06B6D4", undefined, true)}>
            <Popup><div className="p-3 font-bold">{label}</div></Popup>
          </Marker>
        ));
      })}

      {/* Geofence detection remains active in the API; its 500 m zones are
          intentionally not rendered here to keep the dispatcher map clear. */}

      <MapRouteSelectionLayer
        dropRequest={dropRequest}
        onDropRoute={onDropRoute}
        key={JSON.stringify([marking, routes.map((route) => [route.id, route.planId])])}
        onSelect={interactive && !marking ? onSelectDriverRoute : undefined}
        routes={routes.map((route, rIndex) => {
        const routeVehicleColor = (route as typeof route & { routeColor?: string; color?: string }).routeColor
          ?? (route as typeof route & { color?: string }).color;
        const color = getRouteColor(route.status, rIndex, true, routeVehicleColor);
        const validCoords = getValidCoordinates(route.stopsList);
        const depot = routeDepotPoints(route);

        const roadPathResult = routeGeometries.get(route.id);
        const fallbackPath: [number, number][] = validCoords.length > 0
          ? [
              depot.start,
              ...validCoords,
              depot.end,
            ]
          : [];
        const path = roadPathResult?.coordinates || fallbackPath;
        const isFallback = roadPathResult ? roadPathResult.isFallback : true;

        const { isDimmed, isHighlighted } = routeHighlight(route.id, selectedRoutes, preserveRouteVisibility);

        const weight = STATUS_WEIGHT[route.status] ?? 4;
        const opacity = STATUS_OPACITY[route.status] ?? 1;

        return { id: route.id, name: route.name, positions: path,
          isFallback, isDimmed, isHighlighted, color, weight, opacity };
      })} />

      <MarkerClusterGroup
        iconCreateFunction={createClusterIcon}
        chunkedLoading
        maxClusterRadius={stopMarkerLabels ? 40 : 60}
        spiderfyOnMaxZoom
        showCoverageOnHover={false}
        {...(marking ? { disableClusteringAtZoom: 0 } : stopMarkerLabels ? {} : { disableClusteringAtZoom: 13 })}
      >
        {routes.map((route, rIndex) => {
          const routeVehicleColor = (route as typeof route & { routeColor?: string; color?: string }).routeColor
            ?? (route as typeof route & { color?: string }).color;
          const color = getRouteColor(route.status, rIndex, true, routeVehicleColor);
          const sortedStops = sortStopsBySequence(route.stopsList).filter((stop) =>
            isValidCoordinate(stop.latitude, stop.longitude),
          );
          const { isDimmed } = routeHighlight(route.id, selectedRoutes, preserveRouteVisibility);

          return sortedStops.map((stop, sIndex) => {
            const isSelected = stop.id === selectedStopId || selectedStopIds.has(stop.id);
            const sequenceLabel = (stop.sequenceOrder ?? sIndex + 1).toString();
            const baseIcon = isSelected
              ? createSelectedIcon(color, sequenceLabel)
              : isDimmed
                ? createDimmedIcon(color, sequenceLabel)
                : createCustomIcon(color, sequenceLabel);
            const badge = stopMarkerStatusBadge(stop.status);
            const icon = badge ? L.divIcon({
              ...baseIcon.options,
              html: `${baseIcon.options.html}${badge}`,
            }) : baseIcon;
            return (
              <Marker
                key={stop.id}
                position={[stop.latitude, stop.longitude]}
                icon={icon}
                title={`stop:${stop.id}`}
                eventHandlers={{
                  mouseover: () => { if (!marking) onHoverStop?.(stop.id); },
                  mouseout: () => onHoverStop?.(null),
                  click: (event) => {
                    const original = event.originalEvent as MouseEvent;
                     const additive = marking || original.shiftKey || original.metaKey || original.ctrlKey;
                    onSelectStop?.(stop.id, {
                      additive,
                    });
                     if (!additive) onHighlightRoute?.(route.id);
                  },
                }}
              >
                <Popup maxWidth={288}>
                  <div className="w-[min(18rem,calc(100vw-3rem))] p-2">
                    <LockEvidenceBadges route={route} stop={stop} />
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/50">
                      <div className="w-3 h-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      <span className="min-w-0 break-words font-bold text-sm leading-snug">{route.name}</span>
                    </div>
                    <h4 className="break-words font-bold leading-snug">{stop.notes || t("common.deliveryStop")}</h4>
                    <p className="mt-1 break-words text-sm leading-snug text-muted-foreground" title={stop.address}>{stop.address}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="min-w-0 bg-muted p-1.5 rounded-md">
                        <span className="block text-muted-foreground">{t("map.sequence")}</span>
                        <span className="font-semibold">#{sequenceLabel}</span>
                      </div>
                      <div className="min-w-0 bg-muted p-1.5 rounded-md">
                        <span className="block text-muted-foreground">{t("common.status")}</span>
                        <span className="block break-words font-semibold leading-snug">
                          {t(`stopStatus.${getStopStatusTranslationKey(stop.status)}`)}
                        </span>
                        {stop.pickupAddress && stop.status === "pending" && (
                          <span className="block text-[10px] text-muted-foreground mt-0.5">{t("pdStep.pickup", "Pickup step")}</span>
                        )}
                        {stop.pickupAddress && stop.status === "in_progress" && (
                          <span className="block text-[10px] text-muted-foreground mt-0.5">{t("pdStep.delivery", "Delivery step")}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            );
          });
        })}

        {validUnassignedStops.map((stop) => {
          const isSelected = stop.id === selectedStopId || selectedStopIds.has(stop.id);
          return (
            <Marker
              key={stop.id}
              position={[stop.latitude, stop.longitude]}
              icon={isSelected
                ? createSelectedIcon(stopMarkerLabels ? "#0369a1" : "#64748B", stopMarkerLabels?.[stop.id])
                : createCustomIcon(stopMarkerLabels ? "#0369a1" : "#64748B", stopMarkerLabels?.[stop.id])}
              title={stopMarkerLabels ? `${stopMarkerLabels[stop.id] ?? ""} · ${stop.address}` : `stop:${stop.id}`}
              eventHandlers={{
                mouseover: () => { if (!marking) onHoverStop?.(stop.id); },
                mouseout: () => onHoverStop?.(null),
                click: (event) => {
                  const original = event.originalEvent as MouseEvent;
                  onSelectStop?.(stop.id, {
                     additive: marking || original.shiftKey || original.metaKey || original.ctrlKey,
                  });
                },
              }}
            >
              <Popup>
                <div className="p-2 w-[min(18rem,calc(100vw-4rem))] break-words">
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/50">
                    <span className="px-2 py-0.5 rounded-md bg-muted text-foreground text-xs font-bold uppercase tracking-wider">
                      {stopMarkerLabels?.[stop.id] ?? t("common.unassigned")}
                    </span>
                  </div>
                  <h4 className="font-bold">{stop.notes || t("common.deliveryStop")}</h4>
                  <p className="text-sm text-muted-foreground mt-1">{stop.address}</p>
                  {stopMarkerLabels && (
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {stop.contactName && <p>{stop.contactName}</p>}
                      {stop.externalRef && <p>{stop.externalRef}</p>}
                      <p>{stop.latitude.toFixed(6)}, {stop.longitude.toFixed(6)}</p>
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MarkerClusterGroup>

      {hoveredStopId && (() => {
        let hoveredLatLng: [number, number] | null = null;
        let hoveredColor = "#3b82f6";
        for (let i = 0; i < routes.length; i++) {
          const route = routes[i];
          const s = route.stopsList.find((x) => x.id === hoveredStopId);
          if (s && isValidCoordinate(s.latitude, s.longitude)) {
            hoveredLatLng = [s.latitude, s.longitude];
            const routeVehicleColor = (route as typeof route & { routeColor?: string; color?: string }).routeColor
              ?? (route as typeof route & { color?: string }).color;
            hoveredColor = getRouteColor(route.status, i, true, routeVehicleColor);
            break;
          }
        }
        if (!hoveredLatLng) {
          const u = unassignedStops.find((x) => x.id === hoveredStopId);
          if (u && isValidCoordinate(u.latitude, u.longitude)) {
            hoveredLatLng = [u.latitude, u.longitude];
            hoveredColor = "#64748B";
          }
        }
        if (!hoveredLatLng) return null;
        return (
          <>
            <Circle
              center={hoveredLatLng}
              radius={140}
              pathOptions={{ color: hoveredColor, fillColor: hoveredColor, fillOpacity: 0.15, weight: 2, opacity: 0.9 }}
            />
            <Circle
              center={hoveredLatLng}
              radius={260}
              pathOptions={{ color: hoveredColor, fillOpacity: 0, weight: 1.5, opacity: 0.5, dashArray: "4 4" }}
            />
          </>
        );
      })()}

      {validVehiclePositions.map((pos, idx) => (
        <Marker
          key={`vehicle-${pos.vehicleId}-${pos.routeId || idx}`}
          position={[pos.latitude, pos.longitude]}
          icon={createVehicleIcon(pos.heading, pos.vehicleType)}
        >
          <Popup>
            <div className="p-3 min-w-[220px]">
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/50">
                {pos.vehicleType === "electric" ? (
                  <Zap className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Fuel className="h-4 w-4 text-amber-500" />
                )}
                <span className="font-bold">{pos.vehicleName}</span>
                <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">{pos.licensePlate}</span>
              </div>
              <div className="space-y-2 text-sm">
                <PositionFreshness measuredAt={(pos as VehiclePosition & { measuredAt?: string | null }).measuredAt} />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("map.speed")}</span>
                  <span className="font-semibold">{pos.speedKmh} km/h</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t("map.travelled")}</span>
                  <span className="font-semibold">{pos.distanceTravelledKm} km</span>
                </div>
                {pos.nextStopAddress && (
                  <div className="bg-muted p-2 rounded-lg mt-2">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                      <Navigation className="h-3 w-3" />
                      {t("map.nextStop")}
                    </div>
                    <p className="text-xs font-medium truncate">{pos.nextStopAddress}</p>
                    {pos.etaMinutes != null && (
                      <div className="flex items-center gap-1 text-xs text-primary font-bold mt-1">
                        <Clock className="h-3 w-3" />
                        {t("map.eta")}: {pos.etaMinutes} min
                      </div>
                    )}
                  </div>
                )}
                {pos.batteryPercent != null && (
                  <div className="flex items-center gap-2 mt-2">
                    <Battery className="h-3 w-3 text-emerald-500" />
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          pos.batteryPercent > 50 ? "bg-emerald-500" : pos.batteryPercent > 20 ? "bg-amber-500" : "bg-destructive"
                        }`}
                        style={{ width: `${pos.batteryPercent}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold">{Math.round(pos.batteryPercent)}%</span>
                  </div>
                )}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
    </div>
  );
}
