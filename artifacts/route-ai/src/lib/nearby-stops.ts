import type { ScheduledRow, ScheduledStop } from "./scheduling";

export interface PlanStop {
  stop: ScheduledStop;
  planId: string | null;
}

export interface NearbyStop extends PlanStop {
  distanceMeters: number;
}

const EARTH_RADIUS_METERS = 6_371_000;

function validCoordinates(stop: ScheduledStop): boolean {
  return Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)
    && stop.latitude >= -90 && stop.latitude <= 90
    && stop.longitude >= -180 && stop.longitude <= 180;
}

/** Straight-line geographic distance; no routing or external geocoding. */
export function nearbyStopsWithin50m(
  selected: PlanStop | null,
  candidates: readonly PlanStop[],
): NearbyStop[] {
  if (!selected?.planId || !validCoordinates(selected.stop)) return [];
  const radians = Math.PI / 180;
  return candidates.flatMap((candidate) => {
    if (candidate.planId !== selected.planId ||
        candidate.stop.stopId === selected.stop.stopId ||
        !validCoordinates(candidate.stop)) return [];
    const dLat = (candidate.stop.latitude - selected.stop.latitude) * radians;
    const dLon = (candidate.stop.longitude - selected.stop.longitude) * radians;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(selected.stop.latitude * radians) *
      Math.cos(candidate.stop.latitude * radians) * Math.sin(dLon / 2) ** 2;
    const distanceMeters = 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
    return distanceMeters <= 50 ? [{ ...candidate, distanceMeters }] : [];
  }).sort((a, b) => a.distanceMeters - b.distanceMeters ||
    (a.stop.stopId < b.stop.stopId ? -1 : a.stop.stopId > b.stop.stopId ? 1 : 0));
}

/** Only the selected route's plan is eligible, even on the global dispatch board. */
export function nearbyStopsForSelection(
  selected: ScheduledStop | null,
  rows: readonly ScheduledRow[],
  routes: readonly { id: string; planId?: string | null }[],
): NearbyStop[] {
  if (!selected) return [];
  const planByRoute = new Map(routes.map((route) => [route.id, route.planId ?? null]));
  const selectedRow = rows.find((row) => row.stops.some((stop) => stop.stopId === selected.stopId));
  if (!selectedRow) return [];
  const planId = planByRoute.get(selectedRow.routeId) ?? null;
  return nearbyStopsWithin50m(
    { stop: selected, planId },
    rows.flatMap((row) => row.stops.map((stop) => ({
      stop,
      planId: planByRoute.get(row.routeId) ?? null,
    }))),
  );
}