export interface PlanReviewDepotSnapshot {
  start: {
    latitude: number;
    longitude: number;
  };
}

export interface PlanReviewRoute {
  vehicleId?: string | null;
  depotSnapshot?: PlanReviewDepotSnapshot | null;
}

export interface PlanReviewDriver {
  id: string;
  vehicleId?: string | null;
  isActive?: boolean;
  startLatitude?: number | null;
  startLongitude?: number | null;
}

export interface PlanReviewDepotContext {
  depotLatitude: number;
  depotLongitude: number;
  fallbackDriverId?: string;
}

export function resolvePlanResumeStep(
  reviewRequested: boolean,
  routeCount: number,
  allApproved: boolean,
): 6 | 7 {
  if (reviewRequested) return 6;
  return allApproved && routeCount > 0 ? 7 : 6;
}

function validCoordinate(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Resolves the immutable depot captured by a route plan before considering
 * mutable driver metadata. A review must never invent coordinates when the
 * plan and its assigned resources do not contain a usable depot.
 */
export function resolvePlanReviewDepot(
  routes: readonly PlanReviewRoute[],
  drivers: readonly PlanReviewDriver[],
  activeVehicleIds: ReadonlySet<string> = new Set(),
): PlanReviewDepotContext | null {
  const snapshot = routes.find((route) =>
    validCoordinate(route.depotSnapshot?.start.latitude)
    && validCoordinate(route.depotSnapshot?.start.longitude),
  )?.depotSnapshot?.start;
  const routeDrivers = routes.flatMap((route) => {
    if (!route.vehicleId || !activeVehicleIds.has(route.vehicleId)) return [];
    const assigned = drivers.filter(
      (driver) =>
        driver.vehicleId === route.vehicleId &&
        driver.isActive === true,
    );
    return assigned.length === 1 ? assigned : [];
  });
  const fallbackDriver = routeDrivers[0];

  if (snapshot) {
    return {
      depotLatitude: snapshot.latitude,
      depotLongitude: snapshot.longitude,
      fallbackDriverId: fallbackDriver?.id,
    };
  }

  const driverWithDepot = routeDrivers.find((driver) =>
    validCoordinate(driver.startLatitude)
    && validCoordinate(driver.startLongitude),
  );
  if (!driverWithDepot) return null;
  const depotLatitude = driverWithDepot.startLatitude;
  const depotLongitude = driverWithDepot.startLongitude;
  if (!validCoordinate(depotLatitude) || !validCoordinate(depotLongitude)) return null;
  return {
    depotLatitude,
    depotLongitude,
    fallbackDriverId: fallbackDriver?.id ?? driverWithDepot.id,
  };
}