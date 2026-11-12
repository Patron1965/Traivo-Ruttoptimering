import { hasValidRouteGeometry } from "./route-geometry";

interface OsrmRoute {
  geometry: string;
}

interface OsrmResponse {
  code: string;
  routes: OsrmRoute[];
}

function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

export interface RouteGeometryResult {
  coordinates: [number, number][];
  isFallback: boolean;
  error?: string;
}

const routeCache = new Map<string, [number, number][]>();

export async function fetchRouteGeometry(
  waypoints: [number, number][],
): Promise<RouteGeometryResult> {
  const validWaypoints = waypoints.filter(
    (w) =>
      Number.isFinite(w[0]) &&
      Number.isFinite(w[1]) &&
      Math.abs(w[0]) > 0.0001 &&
      Math.abs(w[1]) > 0.0001 &&
      Math.abs(w[0]) <= 90 &&
      Math.abs(w[1]) <= 180,
  );
  const fallback = { coordinates: validWaypoints, isFallback: true };
  if (validWaypoints.length < 2) return fallback;

  const key = validWaypoints.map((w) => `${w[0].toFixed(5)},${w[1].toFixed(5)}`).join("|");
  if (routeCache.has(key)) return { coordinates: routeCache.get(key)!, isFallback: false };

  try {
    const combined: [number, number][] = [];
    // Adjacent chunks share their boundary waypoint: no road leg is lost.
    for (let offset = 0; offset < validWaypoints.length - 1; offset += 99) {
      const chunk = validWaypoints.slice(offset, offset + 100);
      const coords = chunk.map((w) => `${w[1]},${w[0]}`).join(";");
      const url = `${import.meta.env?.BASE_URL ?? "/"}api/osrm/route?coords=${encodeURIComponent(coords)}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { ...fallback, error: `Routing service returned ${res.status}` };
      }
      const data: OsrmResponse = await res.json();
      if (data.code !== "Ok" || !data.routes?.[0]) {
        return { ...fallback, error: "Routing service did not return a route" };
      }
      const decoded = decodePolyline(data.routes[0].geometry);
      if (!hasValidRouteGeometry(decoded)) {
        return { ...fallback, error: "Routing service returned invalid geometry" };
      }
      const last = combined.at(-1);
      const first = decoded[0];
      combined.push(...(last && last[0] === first[0] && last[1] === first[1] ? decoded.slice(1) : decoded));
    }
    // Never cache or display a partial road route when any chunk failed.
    routeCache.set(key, combined);
    return { coordinates: combined, isFallback: false };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : "Routing service unavailable",
    };
  }
}
