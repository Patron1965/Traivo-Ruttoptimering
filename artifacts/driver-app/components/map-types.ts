export interface MapStop {
  id: string;
  latitude: number;
  longitude: number;
  sequence: number | null;
  address: string;
  status: string;
  color: string;
}

export interface NativeMapProps {
  stops: MapStop[];
  polylineCoords: { latitude: number; longitude: number }[];
  primaryColor: string;
  outlineColor: string;
  routeSource: "road" | "fallback";
  bottomPadding: number;
  nextStopId?: string;
  selectedStopId?: string | null;
  onSelectStop?: (id: string) => void;
  viewportCommand?: { type: "in" | "out" | "fit"; revision: number };
}
