import type { DistrictCoordinate } from "./district-solver";

/** Job-owned evidence, never sent to aggregate diagnostics or ordinary logs. */
export interface DistrictMatrixRepair {
  providerIdentity: string;
  requested: DistrictCoordinate[];
  table: {
    distance: number;
    duration: number;
    waypoints: DistrictCoordinate[];
  };
  /** Complete provider response, including geometry, snaps and leg costs. */
  verification: unknown;
  replacement: { distance: number; duration: number };
}

export const MAX_DISTRICT_MATRIX_REPAIRS = 32;

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** No rounding/clamping here: both leg and total costs must already be valid. */
export function verifiedDistrictPair(
  body: any,
  requested: DistrictCoordinate[],
  tableSnaps: DistrictCoordinate[],
  assertSnaps: (requested: DistrictCoordinate[], snaps: DistrictCoordinate[]) => void,
  distanceMeters: (a: DistrictCoordinate, b: DistrictCoordinate) => number,
): { distance: number; duration: number } {
  const reject = (): never => {
    throw new Error("Distriktsrutt: Den negativa matrisposten kunde inte verifieras med fullständig bilvägsgeometri, väganknytning och giltiga kostnader.");
  };
  const coordinate = (xy: any): DistrictCoordinate => {
    if (!Array.isArray(xy) || xy.length !== 2 ||
        !xy.every((v: unknown) => typeof v === "number" && Number.isFinite(v)) ||
        Math.abs(xy[0]) > 180 || Math.abs(xy[1]) > 90) return reject();
    return { longitude: xy[0], latitude: xy[1] };
  };
  if (body?.code !== "Ok" || !Array.isArray(body.routes) || body.routes.length !== 1 ||
      !Array.isArray(body.waypoints) || body.waypoints.length !== 2) return reject();
  const snaps = body.waypoints.map((w: any) => coordinate(w?.location));
  assertSnaps(requested, snaps);
  // Recovery must refer to the same directed road connection, not a new snap.
  if (snaps.some((snap: DistrictCoordinate, i: number) => distanceMeters(snap, tableSnaps[i]) > 1))
    return reject();
  const route = body.routes[0];
  if (route?.geometry?.type !== "LineString" || !Array.isArray(route.geometry.coordinates) ||
      route.geometry.coordinates.length < 2 || !Array.isArray(route.legs) || route.legs.length !== 1)
    return reject();
  const shape = route.geometry.coordinates.map(coordinate);
  if (distanceMeters(shape[0], snaps[0]) > 1 ||
      distanceMeters(shape[shape.length - 1], snaps[1]) > 1) return reject();
  const leg = route.legs[0];
  if (!nonnegative(route.distance) || !nonnegative(route.duration) ||
      !nonnegative(leg?.distance) || !nonnegative(leg?.duration) ||
      Math.abs(route.distance - leg.distance) > 0.1 ||
      Math.abs(route.duration - leg.duration) > 0.1) return reject();
  return { distance: leg.distance, duration: leg.duration };
}
