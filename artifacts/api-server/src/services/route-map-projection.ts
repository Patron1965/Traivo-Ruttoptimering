import type { ListRoutesResponseItem } from "@workspace/api-zod";
import type { z } from "zod/v4";

type RouteMapEndpoints = NonNullable<z.infer<typeof ListRoutesResponseItem>["mapEndpoints"]>;

type Location = { latitude?: unknown; longitude?: unknown };
type MapRoute = {
  depotSnapshot?: { start?: Location; end?: Location } | null;
  optimizationResourceSnapshot?: unknown;
};

function location(value?: Location | null) {
  const { latitude, longitude } = value ?? {};
  return typeof latitude === "number" && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    && typeof longitude === "number" && Number.isFinite(longitude) && Math.abs(longitude) <= 180
    ? { latitude, longitude } : null;
}

/** Display coordinates only: never manufacture depot verification evidence. */
export function routeMapEndpoints(route: MapRoute): RouteMapEndpoints {
  const snapshot = route.optimizationResourceSnapshot as {
    driver?: { startLatitude?: unknown; startLongitude?: unknown; endLatitude?: unknown; endLongitude?: unknown };
  } | null;
  const driver = snapshot?.driver;
  return {
    start: location(route.depotSnapshot?.start) ?? location({ latitude: driver?.startLatitude, longitude: driver?.startLongitude }),
    end: location(route.depotSnapshot?.end) ?? location({ latitude: driver?.endLatitude, longitude: driver?.endLongitude }),
  };
}

/** Apply only after choosing the caller's working or outgoing route revision. */
export function projectRouteForMap<T extends MapRoute>(route: T) {
  return { ...route, mapEndpoints: routeMapEndpoints(route) };
}
