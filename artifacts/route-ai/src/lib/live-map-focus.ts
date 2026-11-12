type Position = { latitude?: number | null; longitude?: number | null };
type FocusRoute = {
  stopsList: Position[];
  depotSnapshot?: { start: Position; end: Position } | null;
};

export function liveMapPoint(position: Position): [number, number][] {
  const { latitude, longitude } = position;
  return typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    ? [[latitude, longitude]] : [];
}

/** Frame known positions only: a missing depot must not introduce demo coordinates. */
export function liveRouteFocusPoints(route?: FocusRoute): [number, number][] {
  if (!route) return [];
  return [
    ...route.stopsList.flatMap(liveMapPoint),
    ...(route.depotSnapshot
      ? [route.depotSnapshot.start, route.depotSnapshot.end].flatMap(liveMapPoint) : []),
  ];
}
