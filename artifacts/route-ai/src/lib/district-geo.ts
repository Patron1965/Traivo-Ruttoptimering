export interface GeoVertex { lat: number; lng: number }

/** Ray casting; vertices in lat/lng order. Needs at least three vertices. */
export function pointInPolygon(lat: number, lng: number, polygon: readonly GeoVertex[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.lat > lat) !== (b.lat > lat) && lng < ((b.lng - a.lng) * (lat - a.lat)) / (b.lat - a.lat) + a.lng) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Membership = (inside polygon ∪ manualAdd) − manualRemove.
 * Manual choices always win over the polygon so vertex edits never silently
 * reassign points the planner adjusted by hand.
 */
export function resolveDraftMembers(
  points: readonly { id: string; latitude: number; longitude: number }[],
  polygon: readonly GeoVertex[],
  manualAdd: ReadonlySet<string>,
  manualRemove: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  if (polygon.length >= 3) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const v of polygon) {
      minLat = Math.min(minLat, v.lat); maxLat = Math.max(maxLat, v.lat);
      minLng = Math.min(minLng, v.lng); maxLng = Math.max(maxLng, v.lng);
    }
    for (const p of points) {
      if (p.latitude < minLat || p.latitude > maxLat || p.longitude < minLng || p.longitude > maxLng) continue;
      if (pointInPolygon(p.latitude, p.longitude, polygon)) result.add(p.id);
    }
  }
  for (const id of manualAdd) result.add(id);
  for (const id of manualRemove) result.delete(id);
  return result;
}

export type IntervalResult =
  | { ok: true; indexes: number[]; wraps: boolean }
  | { ok: false; error: string };

/**
 * Resolve a 1-based inclusive interval of a visit order. In a closed loop a
 * start after the end wraps past the last stop back to stop 1; an open order
 * never wraps.
 */
export function resolveInterval(length: number, from: number, to: number, closedLoop: boolean): IntervalResult {
  if (length === 0) return { ok: false, error: "Slingan saknar stopp." };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > length || to > length) {
    return { ok: false, error: `Ange ordningsnummer mellan 1 och ${length}.` };
  }
  if (from <= to) {
    return { ok: true, indexes: Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i), wraps: false };
  }
  if (!closedLoop) return { ok: false, error: "Öppen besöksordning kan inte gå förbi sista stoppet. Välj ett startnummer som är lägre än slutnumret." };
  const indexes: number[] = [];
  for (let i = from - 1; i < length; i += 1) indexes.push(i);
  for (let i = 0; i < to; i += 1) indexes.push(i);
  return { ok: true, indexes, wraps: true };
}

export const ZONE_COLORS = ["#0891b2", "#d9480f", "#7048e8", "#2b8a3e", "#c2255c", "#e8a100", "#1864ab", "#5c940d", "#9c36b5", "#a61e4d", "#0b7285", "#862e9c"];

export const ZONE_TARGET = 500;
