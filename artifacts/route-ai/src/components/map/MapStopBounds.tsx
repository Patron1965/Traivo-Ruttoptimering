import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import { latLngBounds } from "leaflet";

/** Opt-in review framing. A manual pan/zoom takes precedence over new batches. */
export function MapStopBounds({
  coordinates,
  request,
}: {
  coordinates: [number, number][];
  request?: number;
}) {
  const map = useMap();
  const touched = useRef(false);
  const fitting = useRef(false);
  const lastRequest = useRef<number | undefined>(undefined);
  const coordinateKey = JSON.stringify(coordinates);

  useEffect(() => {
    if (request === undefined) return;
    const onMove = () => {
      if (!fitting.current) touched.current = true;
    };
    map.on("movestart", onMove);
    map.on("zoomstart", onMove);
    return () => {
      map.off("movestart", onMove);
      map.off("zoomstart", onMove);
    };
  }, [map, request === undefined]);

  useEffect(() => {
    if (request === undefined) return;
    const points = JSON.parse(coordinateKey) as [number, number][];
    if (!points.length) return;
    const explicitRequest = lastRequest.current !== request;
    lastRequest.current = request;
    if (!explicitRequest && touched.current) return;
    fitting.current = true;
    try {
      map.fitBounds(latLngBounds(points), {
        padding: [40, 40],
        maxZoom: 16,
        animate: false,
      });
      if (explicitRequest) touched.current = false;
    } finally {
      fitting.current = false;
    }
  }, [map, coordinateKey, request]);

  return null;
}