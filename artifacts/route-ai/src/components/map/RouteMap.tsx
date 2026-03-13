import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, ZoomControl, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type Route, type Stop, type VehiclePosition } from "@workspace/api-client-react";
import { ROUTE_COLORS, DEPOT_LOCATION } from "@/lib/constants";
import { formatDistance } from "@/lib/utils";
import { MapPin, Truck, Warehouse, Battery, Navigation, Clock, Zap, Fuel } from "lucide-react";
import { renderToString } from "react-dom/server";
import { useTranslation } from "react-i18next";
import { fetchRouteGeometry } from "@/lib/osrm";

interface RouteData extends Route {
  stopsList: Stop[];
}

interface RouteMapProps {
  routes?: RouteData[];
  unassignedStops?: Stop[];
  vehiclePositions?: VehiclePosition[];
  center?: [number, number];
  zoom?: number;
  interactive?: boolean;
  selectedStopId?: string | null;
  onSelectStop?: (stopId: string) => void;
  highlightedRouteId?: string | null;
  onHighlightRoute?: (routeId: string) => void;
  focusStopId?: string | null;
}

function MapFlyTo({ routes, unassignedStops, focusStopId }: { routes: RouteData[]; unassignedStops: Stop[]; focusStopId: string | null }) {
  const map = useMap();
  useEffect(() => {
    if (!focusStopId) return;
    for (const route of routes) {
      const stop = route.stopsList.find((s) => s.id === focusStopId);
      if (stop) {
        map.flyTo([stop.latitude, stop.longitude], 14, { duration: 0.5 });
        return;
      }
    }
    const unassigned = unassignedStops.find((s) => s.id === focusStopId);
    if (unassigned) {
      map.flyTo([unassigned.latitude, unassigned.longitude], 14, { duration: 0.5 });
    }
  }, [focusStopId, routes, unassignedStops, map]);
  return null;
}

const createCustomIcon = (color: string, label?: string, isDepot = false) => {
  const iconHtml = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 32, height: 32 }}>
      {isDepot ? (
        <div className="w-10 h-10 bg-primary/20 rounded-full flex items-center justify-center border-2 border-primary shadow-lg shadow-primary/40">
           <Warehouse className="w-5 h-5 text-primary" />
        </div>
      ) : (
        <>
          <div className="absolute inset-0 rounded-full opacity-20" style={{ backgroundColor: color, transform: 'scale(1.5)' }} />
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill={color} stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-md">
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
            <circle cx="12" cy="10" r="3" fill="white"/>
          </svg>
          {label && (
            <span className="absolute top-[6px] font-bold text-[10px] text-gray-900">{label}</span>
          )}
        </>
      )}
    </div>
  );

  return L.divIcon({
    html: iconHtml,
    className: "custom-leaflet-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32],
  });
};

const createDimmedIcon = (color: string, label?: string) => {
  const iconHtml = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 24, height: 24, opacity: 0.35 }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill={color} stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3" fill="white"/>
      </svg>
      {label && (
        <span className="absolute top-[4px] font-bold text-[8px] text-gray-900">{label}</span>
      )}
    </div>
  );
  return L.divIcon({
    html: iconHtml,
    className: "custom-leaflet-icon-dimmed",
    iconSize: [24, 24],
    iconAnchor: [12, 24],
    popupAnchor: [0, -24],
  });
};

const createSelectedIcon = (color: string, label?: string) => {
  const iconHtml = renderToString(
    <div className="relative flex items-center justify-center" style={{ width: 40, height: 40 }}>
      <div className="absolute inset-0 rounded-full animate-ping opacity-30" style={{ backgroundColor: color }} />
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill={color} stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-lg">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
        <circle cx="12" cy="10" r="3" fill="white"/>
      </svg>
      {label && (
        <span className="absolute top-[7px] font-bold text-[11px] text-gray-900">{label}</span>
      )}
    </div>
  );
  return L.divIcon({
    html: iconHtml,
    className: "custom-leaflet-icon-selected",
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -40],
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
  const [geometries, setGeometries] = useState<Map<string, [number, number][]>>(new Map());

  const routeKey = routes.map(r => {
    const sorted = [...r.stopsList].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
    return `${r.id}:${sorted.map(s => `${s.latitude},${s.longitude}`).join(";")}`;
  }).join("|");

  useEffect(() => {
    if (!routeKey) return;
    let cancelled = false;
    const fetchAll = async () => {
      const newGeometries = new Map<string, [number, number][]>();
      for (const route of routes) {
        const sortedStops = [...route.stopsList].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
        const waypoints: [number, number][] = [
          [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
          ...sortedStops.map(s => [s.latitude, s.longitude] as [number, number]),
          [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
        ];
        const geometry = await fetchRouteGeometry(waypoints);
        if (cancelled) return;
        newGeometries.set(route.id, geometry);
      }
      if (!cancelled) setGeometries(newGeometries);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [routeKey]);

  return geometries;
}

export function RouteMap({ 
  routes = [], 
  unassignedStops = [],
  vehiclePositions = [],
  center = [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
  zoom = 11,
  interactive = true,
  selectedStopId = null,
  onSelectStop,
  highlightedRouteId = null,
  onHighlightRoute,
  focusStopId = null,
}: RouteMapProps) {
  const [mounted, setMounted] = useState(false);
  const { t } = useTranslation();
  const routeGeometries = useRouteGeometries(routes);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return <div className="w-full h-full bg-muted/20 animate-pulse rounded-2xl" />;

  const activeRouteStops = routes
    .filter(r => r.status === "in_progress" || r.status === "optimized")
    .flatMap(r => r.stopsList.filter(s => s.status === "pending" || s.status === "in_progress"));

  return (
    <MapContainer 
      center={center} 
      zoom={zoom} 
      className="w-full h-full rounded-2xl z-0"
      zoomControl={false}
      dragging={interactive}
      scrollWheelZoom={interactive}
    >
      <MapFlyTo routes={routes} unassignedStops={unassignedStops} focusStopId={focusStopId} />
      <ZoomControl position="bottomright" />
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        className="map-tiles-dark"
      />

      <Marker position={[DEPOT_LOCATION.lat, DEPOT_LOCATION.lng]} icon={createCustomIcon("#06B6D4", undefined, true)}>
        <Popup className="rounded-xl overflow-hidden shadow-2xl border-0">
          <div className="p-3">
            <h3 className="font-bold text-lg">{t("map.centralDepot")}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t("map.stockholmHub")}</p>
          </div>
        </Popup>
      </Marker>

      {activeRouteStops.map((stop) => (
        <Circle
          key={`geofence-${stop.id}`}
          center={[stop.latitude, stop.longitude]}
          radius={500}
          pathOptions={{
            color: "#06B6D4",
            fillColor: "#06B6D4",
            fillOpacity: 0.06,
            weight: 1,
            dashArray: "6, 4",
          }}
        />
      ))}

      {routes.map((route, rIndex) => {
        const color = ROUTE_COLORS[rIndex % ROUTE_COLORS.length];
        const sortedStops = [...route.stopsList].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));

        const roadPath = routeGeometries.get(route.id);
        const fallbackPath: [number, number][] = [
          [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
          ...sortedStops.map(s => [s.latitude, s.longitude] as [number, number]),
          [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng]
        ];
        const path = roadPath || fallbackPath;

        const isDimmed =
          highlightedRouteId !== null && highlightedRouteId !== route.id;

        return (
          <div key={route.id}>
            <Polyline 
              positions={path} 
              pathOptions={{ 
                color, 
                weight: isDimmed ? 2 : 4,
                opacity: isDimmed ? 0.2 : 0.8,
                dashArray: route.status === "draft" ? "8, 8" : undefined
              }} 
            />
            {sortedStops.map((stop, sIndex) => {
              const isSelected = stop.id === selectedStopId;
              const icon = isSelected
                ? createSelectedIcon(color, (sIndex + 1).toString())
                : isDimmed
                  ? createDimmedIcon(color, (sIndex + 1).toString())
                  : createCustomIcon(color, (sIndex + 1).toString());
              return (
              <Marker 
                key={stop.id} 
                position={[stop.latitude, stop.longitude]}
                icon={icon}
                eventHandlers={{
                  click: () => {
                    onSelectStop?.(stop.id);
                    onHighlightRoute?.(route.id);
                  },
                }}
              >
                <Popup>
                  <div className="p-2 min-w-[200px]">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/50">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                      <span className="font-bold text-sm">{route.name}</span>
                    </div>
                    <h4 className="font-bold">{stop.notes || t("common.deliveryStop")}</h4>
                    <p className="text-sm text-muted-foreground mt-1 truncate max-w-[200px]" title={stop.address}>{stop.address}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-muted p-1.5 rounded-md">
                        <span className="block text-muted-foreground">{t("map.sequence")}</span>
                        <span className="font-semibold">#{sIndex + 1}</span>
                      </div>
                      <div className="bg-muted p-1.5 rounded-md">
                        <span className="block text-muted-foreground">{t("common.status")}</span>
                        <span className="font-semibold capitalize">{t(`common.${stop.status}`)}</span>
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
              );
            })}
          </div>
        );
      })}

      {vehiclePositions.map((pos, idx) => (
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
      {unassignedStops.map((stop) => {
        const isSelected = stop.id === selectedStopId;
        return (
        <Marker 
          key={stop.id} 
          position={[stop.latitude, stop.longitude]}
          icon={isSelected ? createSelectedIcon("#64748B") : createCustomIcon("#64748B")}
          eventHandlers={onSelectStop ? { click: () => onSelectStop(stop.id) } : undefined}
        >
          <Popup>
            <div className="p-2 min-w-[200px]">
              <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/50">
                <span className="px-2 py-0.5 rounded-md bg-destructive/10 text-destructive text-xs font-bold uppercase tracking-wider">{t("common.unassigned")}</span>
              </div>
              <h4 className="font-bold">{stop.notes || t("common.deliveryStop")}</h4>
              <p className="text-sm text-muted-foreground mt-1">{stop.address}</p>
            </div>
          </Popup>
        </Marker>
        );
      })}
    </MapContainer>
  );
}
