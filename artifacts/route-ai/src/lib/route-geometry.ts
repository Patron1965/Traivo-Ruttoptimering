export type RouteCoordinate = [number, number];

export function isValidRouteGeometryCoordinate(
  coordinate: RouteCoordinate,
): boolean {
  const [latitude, longitude] = coordinate;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function hasValidRouteGeometry(
  coordinates: RouteCoordinate[],
): boolean {
  return coordinates.length >= 2 && coordinates.every(isValidRouteGeometryCoordinate);
}