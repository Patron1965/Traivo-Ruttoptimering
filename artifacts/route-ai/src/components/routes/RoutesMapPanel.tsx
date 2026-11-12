import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { renderToString } from "react-dom/server";
import { AlertCircle, LoaderCircle, Route as RouteIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Route } from "@workspace/api-client-react";
import { MapRouteLine } from "@/components/map/MapRouteLine";
import { getRouteColor, getValidCoordinates, isValidCoordinate, sortStopsBySequence } from "@/lib/map-utils";
import { useRouteMapGeometries, type RouteMapSelection } from "@/hooks/use-route-map-geometries";

export interface MapStop {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  notes?: string | null;
  sequenceOrder?: number | null;
}

interface MapVehicle {
  name?: string | null;
  licensePlate?: string | null;
  routeColor?: string | null;
}

function routeDepotPoints(route: Route): { start: [number, number]; end: [number, number] } | null {
  const snapshot = route.depotSnapshot;
  if (!snapshot?.start || !snapshot.end) return null;
  const start: [number, number] = [snapshot.start.latitude, snapshot.start.longitude];
  const end: [number, number] = [snapshot.end.latitude, snapshot.end.longitude];
  return isValidCoordinate(start[0], start[1]) && isValidCoordinate(end[0], end[1]) ? { start, end } : null;
}

function stopIcon(color: string, label: string) {
  return L.divIcon({
    className: "",
    html: renderToString(
      <div
        className="flex items-center justify-center h-6 w-6 rounded-full border-2 border-white text-white shadow-lg"
        style={{ backgroundColor: color }}
      >
        <span className="text-[11px] font-bold font-mono">{label}</span>
      </div>,
    ),
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function FitRoutes({ coordinates }: { coordinates: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (coordinates.length === 0) return;
    map.fitBounds(L.latLngBounds(coordinates), { padding: [40, 40], maxZoom: 13 });
  }, [coordinates, map]);
  return null;
}

interface RoutesMapPanelProps {
  allRoutes: Route[];
  selectedRoutes: Route[];
  hasSelection: boolean;
  stopsByRouteId: Map<string, MapStop[]>;
  isStopsLoading: boolean;
  stopsError: unknown;
  vehicleById: Map<string, MapVehicle>;
}

export function RoutesMapPanel({
  allRoutes,
  selectedRoutes,
  hasSelection,
  stopsByRouteId,
  isStopsLoading,
  stopsError,
  vehicleById,
}: RoutesMapPanelProps) {
  const { t } = useTranslation();

  const mapSelections = useMemo<RouteMapSelection[]>(
    () => selectedRoutes.map((route) => {
      const routeStops = sortStopsBySequence(stopsByRouteId.get(route.id) || []);
      const validStops = routeStops.filter((stop) => isValidCoordinate(stop.latitude, stop.longitude));
      const stopCoordinates = getValidCoordinates(validStops);
      const depot = routeDepotPoints(route);
      return {
        routeId: route.id,
        stops: validStops,
        missingCoordinateCount: routeStops.length - validStops.length + (depot ? 0 : 1),
        waypoints: stopCoordinates.length > 0
          ? [...(depot ? [depot.start] : []), ...stopCoordinates, ...(depot ? [depot.end] : [])]
          : [],
      };
    }),
    [selectedRoutes, stopsByRouteId],
  );
  const mapGeometries = useRouteMapGeometries(mapSelections);
  const colorByRouteId = useMemo(() => new Map(
    selectedRoutes.map((route) => {
      const vehicle = route.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
      const routeIndex = allRoutes.findIndex((candidate) => candidate.id === route.id);
      return [route.id, getRouteColor(route.status, Math.max(routeIndex, 0), true, vehicle?.routeColor ?? undefined)] as const;
    }),
  ), [allRoutes, selectedRoutes, vehicleById]);
  const fitCoordinates = useMemo(() => {
    const coordinates: [number, number][] = [];
    mapSelections.forEach((selection) => {
      const geometry = mapGeometries.get(selection.routeId);
      const line = geometry?.coordinates.filter(([lat, lng]) => isValidCoordinate(lat, lng)) ?? [];
      if (line.length > 0) coordinates.push(...line);
      else coordinates.push(...selection.stops.map((stop) => [stop.latitude, stop.longitude] as [number, number]));
    });
    return coordinates;
  }, [mapGeometries, mapSelections]);
  const missingCoordinateCount = isStopsLoading
    ? 0
    : mapSelections.filter((s) => s.stops.length === 0 || (s.missingCoordinateCount ?? 0) > 0).length;
  const geometryLoading = mapSelections.some((s) => mapGeometries.get(s.routeId)?.status === "loading");
  const fallbackCount = mapSelections.filter((s) => mapGeometries.get(s.routeId)?.status === "fallback").length;
  const errorCount = mapSelections.filter((s) => mapGeometries.get(s.routeId)?.status === "error").length;

  return (
    <div className="h-[40vh] min-h-[16rem] xl:h-full xl:w-[34%] shrink-0 border-t xl:border-t-0 xl:border-l border-border relative z-0">
      <MapContainer center={[59.33, 18.07]} zoom={11} className="h-full w-full" zoomControl={false}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {fitCoordinates.length > 0 && <FitRoutes coordinates={fitCoordinates} />}
        {mapSelections.map((selection) => {
          const geometry = mapGeometries.get(selection.routeId);
          if (!geometry) return null;
          return (
            <MapRouteLine
              key={`${selection.routeId}:${geometry.requestKey}:${geometry.status}`}
              positions={geometry.coordinates}
              color={colorByRouteId.get(selection.routeId) || "#0891B2"}
              weight={5}
              isFallback={geometry.isFallback}
              isHighlighted={!geometry.isFallback}
            />
          );
        })}
        {mapSelections.flatMap((selection) => {
          const color = colorByRouteId.get(selection.routeId) || "#0891B2";
          return selection.stops.map((stop, index) => (
            <Marker
              key={`${selection.routeId}:${stop.id}`}
              position={[stop.latitude, stop.longitude]}
              icon={stopIcon(color, (stop.sequenceOrder ?? index + 1).toString())}
            >
              <Popup className="dark-popup">
                <div className="text-xs">
                  <p className="font-bold">#{stop.sequenceOrder ?? index + 1} {stop.address}</p>
                  {stop.notes && <p className="text-muted-foreground">{stop.notes}</p>}
                </div>
              </Popup>
            </Marker>
          ));
        })}
      </MapContainer>

      {!hasSelection && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <div className="text-center text-muted-foreground">
            <RouteIcon className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm px-6">{t("routes.selectPlanOrRouteToMap")}</p>
          </div>
        </div>
      )}

      {hasSelection && (isStopsLoading || !!stopsError || geometryLoading || missingCoordinateCount > 0 || fallbackCount > 0 || errorCount > 0) && (
        <div
          className="absolute top-3 left-3 right-3 z-[500] space-y-1 rounded-lg border border-border bg-background/90 p-2.5 text-xs shadow-lg backdrop-blur-sm"
          role="status"
          aria-live="polite"
          data-testid="route-map-status"
        >
          {isStopsLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span>{t("routes.loadingStopsForMap")}</span>
            </div>
          )}
          {!!stopsError && (
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t("routes.failedToLoadStops")}</span>
            </div>
          )}
          {!stopsError && geometryLoading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span>{t("routes.loadingMapGeometry")}</span>
            </div>
          )}
          {missingCoordinateCount > 0 && (
            <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t("routes.missingCoordinates", { count: missingCoordinateCount })}</span>
            </div>
          )}
          {fallbackCount > 0 && (
            <div className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t("routes.fallbackGeometry", { count: fallbackCount })}</span>
            </div>
          )}
          {errorCount > 0 && (
            <div className="flex items-start gap-2 text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t("routes.geometryError", { count: errorCount })}</span>
            </div>
          )}
        </div>
      )}

      {selectedRoutes.length > 0 && (
        <div
          className="absolute bottom-3 left-3 right-3 z-[500] max-h-32 overflow-y-auto rounded-lg border border-border bg-background/90 p-3 shadow-lg backdrop-blur-sm"
          aria-label={t("routes.mapLegend")}
          data-testid="route-map-legend"
        >
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("routes.mapLegend")}</p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {selectedRoutes.map((route) => {
              const vehicle = route.vehicleId ? vehicleById.get(route.vehicleId) : undefined;
              return (
                <div key={route.id} className="flex min-w-0 items-center gap-2 text-xs" data-testid={`legend-route-${route.id}`}>
                  <span
                    className="h-3 w-3 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: colorByRouteId.get(route.id) || "#0891B2" }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate" title={route.name}>{route.name}</span>
                  <span className="shrink-0 text-muted-foreground">{vehicle?.licensePlate || t("routes.missingData")}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
