export type RouteMapCoordinate = [number, number];

export function routeMapGeometryKey(
  routeId: string,
  waypoints: RouteMapCoordinate[],
): string {
  return `${routeId}:${waypoints
    .map(([latitude, longitude]) => `${latitude},${longitude}`)
    .join("|")}`;
}