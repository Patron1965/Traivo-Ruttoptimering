import type { Driver, Vehicle, RouteResourceReplacementInput, RouteResourceReplacementPreview } from "@workspace/api-client-react";

export function activeResourcePairs(vehicles: readonly Vehicle[], drivers: readonly Driver[]) {
  return vehicles.filter(vehicle => vehicle.isActive).flatMap(vehicle => {
    const profiles = drivers.filter(driver => driver.isActive && driver.vehicleId === vehicle.id);
    const driver = vehicle.resourceProfile === null ? undefined : vehicle.resourceProfile ?? (profiles.length === 1 ? profiles[0] : undefined);
    return driver ? [{ value: `${vehicle.id}:${driver.id}`, vehicle, driver }] : [];
  });
}
export function resourceReviewRequest(routeId: string, planRevision: number, pair: string, force = false) {
  const [vehicleId, driverId, extra] = pair.split(":");
  if (!vehicleId || !driverId || extra) return null;
  return Object.freeze({ routeId, planRevision, vehicleId, driverId, force }) satisfies Readonly<RouteResourceReplacementInput>;
}
export function onlyAuthorizedSoftConflicts(conflicts: readonly string[]) {
  return conflicts.length > 0 && conflicts.every(code => code === "CAPACITY" || code === "WORKING_HOURS");
}
export function resourceReviewError(error: unknown) {
  const data = error && typeof error === "object" && "data" in error ? error.data : null;
  return data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error : "Resursbytet kunde inte behandlas. Kontrollera anslutningen och begär en ny förhandsgranskning.";
}
export function resourceConfirmation(
  request: Readonly<RouteResourceReplacementInput>,
  preview: RouteResourceReplacementPreview,
  acceptedSoft: boolean,
) {
  if (!preview.canChange || !preview.previewDigest) return null;
  if (preview.conflicts.length && (!onlyAuthorizedSoftConflicts(preview.conflicts) || !acceptedSoft || !request.force)) return null;
  return Object.freeze({ ...request, expectedPreviewDigest: preview.previewDigest });
}
