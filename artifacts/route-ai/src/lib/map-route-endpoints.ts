import type { Route } from "@workspace/api-client-react";

type Point = [number, number];
type Location = { latitude?: unknown; longitude?: unknown };
function point(value?: Location | null): Point | null {
  const { latitude: lat, longitude: lon } = value ?? {};
  return typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

/** Use the plan's immutable locations, never a demo depot or a current driver. */
export function mapRouteEndpoints(route: Pick<Route, "mapEndpoints" | "depotSnapshot">) {
  // Local optimizer previews use the existing documented depot contract.
  // An API projection (including explicit nulls) always takes precedence.
  const endpoints = route.mapEndpoints ?? route.depotSnapshot;
  return {
    start: point(endpoints?.start),
    end: point(endpoints?.end),
  };
}
