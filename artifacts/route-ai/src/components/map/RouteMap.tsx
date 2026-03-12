import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, ZoomControl } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type Route, type Stop } from "@workspace/api-client-react";
import { ROUTE_COLORS, DEPOT_LOCATION } from "@/lib/constants";
import { formatDistance, formatDuration } from "@/lib/utils";
import { MapPin, Truck, Warehouse } from "lucide-react";
import { renderToString } from "react-dom/server";

interface RouteData extends Route {
  stopsList: Stop[];
}

interface RouteMapProps {
  routes?: RouteData[];
  unassignedStops?: Stop[];
  center?: [number, number];
  zoom?: number;
  interactive?: boolean;
}

// Custom markers using Lucide icons rendered to HTML
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

export function RouteMap({ 
  routes = [], 
  unassignedStops = [],
  center = [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
  zoom = 11,
  interactive = true
}: RouteMapProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return <div className="w-full h-full bg-muted/20 animate-pulse rounded-2xl" />;

  return (
    <MapContainer 
      center={center} 
      zoom={zoom} 
      className="w-full h-full rounded-2xl z-0"
      zoomControl={false}
      dragging={interactive}
      scrollWheelZoom={interactive}
    >
      <ZoomControl position="bottomright" />
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      />

      {/* Depot */}
      <Marker position={[DEPOT_LOCATION.lat, DEPOT_LOCATION.lng]} icon={createCustomIcon("#06B6D4", undefined, true)}>
        <Popup className="rounded-xl overflow-hidden shadow-2xl border-0">
          <div className="p-3">
            <h3 className="font-bold text-lg">Central Depot</h3>
            <p className="text-sm text-muted-foreground mt-1">Stockholm Logistics Hub</p>
          </div>
        </Popup>
      </Marker>

      {/* Routes */}
      {routes.map((route, rIndex) => {
        const color = ROUTE_COLORS[rIndex % ROUTE_COLORS.length];
        
        // Ensure stops are sorted by sequence order
        const sortedStops = [...route.stopsList].sort((a, b) => (a.sequenceOrder || 0) - (b.sequenceOrder || 0));
        
        // Build path: Depot -> Stop 1 -> Stop 2 -> ... -> Depot
        const path: [number, number][] = [
          [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng],
          ...sortedStops.map(s => [s.latitude, s.longitude] as [number, number]),
          [DEPOT_LOCATION.lat, DEPOT_LOCATION.lng]
        ];

        return (
          <div key={route.id}>
            <Polyline 
              positions={path} 
              pathOptions={{ 
                color, 
                weight: 4, 
                opacity: 0.8,
                dashArray: route.status === "draft" ? "8, 8" : undefined
              }} 
            />
            {sortedStops.map((stop, sIndex) => (
              <Marker 
                key={stop.id} 
                position={[stop.latitude, stop.longitude]}
                icon={createCustomIcon(color, (sIndex + 1).toString())}
              >
                <Popup>
                  <div className="p-2 min-w-[200px]">
                    <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/50">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                      <span className="font-bold text-sm">{route.name}</span>
                    </div>
                    <h4 className="font-bold">{stop.notes || "Delivery Stop"}</h4>
                    <p className="text-sm text-muted-foreground mt-1 truncate max-w-[200px]" title={stop.address}>{stop.address}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-muted p-1.5 rounded-md">
                        <span className="block text-muted-foreground">Sequence</span>
                        <span className="font-semibold">#{sIndex + 1}</span>
                      </div>
                      <div className="bg-muted p-1.5 rounded-md">
                        <span className="block text-muted-foreground">Duration</span>
                        <span className="font-semibold">{stop.serviceDurationMin}m</span>
                      </div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </div>
        );
      })}

      {/* Unassigned Stops */}
      {unassignedStops.map((stop) => (
        <Marker 
          key={stop.id} 
          position={[stop.latitude, stop.longitude]}
          icon={createCustomIcon("#64748B")} // Slate gray for unassigned
        >
          <Popup>
            <div className="p-2 min-w-[200px]">
              <div className="flex items-center gap-2 mb-2 pb-2 border-b border-border/50">
                <span className="px-2 py-0.5 rounded-md bg-destructive/10 text-destructive text-xs font-bold uppercase tracking-wider">Unassigned</span>
              </div>
              <h4 className="font-bold">{stop.notes || "Delivery Stop"}</h4>
              <p className="text-sm text-muted-foreground mt-1">{stop.address}</p>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
