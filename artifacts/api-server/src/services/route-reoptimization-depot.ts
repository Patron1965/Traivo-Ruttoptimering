type Position = { latitude: number; longitude: number };
type DriverDepot = {
  startLatitude: number | null;
  startLongitude: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
};

function position(latitude: number | null, longitude: number | null): Position | null {
  return latitude != null && longitude != null &&
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { latitude, longitude } : null;
}

/** Persisted route/organization evidence wins; never substitute caller coordinates. */
export function resolveReoptimizationDepot(
  depot: { start: Position; end: Position } | null,
  driver: DriverDepot,
): { start: Position; end: Position } | null {
  const start = depot
    ? position(depot.start.latitude, depot.start.longitude)
    : position(driver.startLatitude, driver.startLongitude);
  const end = depot
    ? position(depot.end.latitude, depot.end.longitude)
    : position(driver.endLatitude, driver.endLongitude);
  return start && end ? { start, end } : null;
}
