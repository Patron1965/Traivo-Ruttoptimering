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

const routeCache = new Map<string, [number, number][]>();

export async function fetchRouteGeometry(
  waypoints: [number, number][],
): Promise<[number, number][]> {
  if (waypoints.length < 2) return waypoints;

  const key = waypoints.map((w) => `${w[0].toFixed(5)},${w[1].toFixed(5)}`).join("|");
  if (routeCache.has(key)) return routeCache.get(key)!;

  const coords = waypoints.map((w) => `${w[1]},${w[0]}`).join(";");
  const url = `${import.meta.env.BASE_URL}api/osrm/route?coords=${encodeURIComponent(coords)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return waypoints;
    const data: OsrmResponse = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return waypoints;
    const decoded = decodePolyline(data.routes[0].geometry);
    routeCache.set(key, decoded);
    return decoded;
  } catch {
    return waypoints;
  }
}
