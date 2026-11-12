import type { Driver, Vehicle } from "@workspace/api-client-react";

/**
 * Vehicle id is the canonical resource id; the driver row is an internal operational profile.
 * resourceProfile === null means the server deliberately found no unambiguous profile
 * (e.g. duplicate legacy profiles). Never guess in that case. Only fall back to the
 * drivers list when the field is absent (older server), and only on a unique match.
 */
export function resolveResourceProfile(vehicle: Vehicle | undefined, drivers?: Driver[] | null): Driver | undefined {
  if (!vehicle) return undefined;
  const nested = (vehicle as { resourceProfile?: Driver | null }).resourceProfile;
  if (nested !== undefined) return nested ?? undefined;
  const matches = drivers?.filter((d) => d.isActive && d.vehicleId === vehicle.id) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

export function buildProfileByResourceId(vehicles?: Vehicle[] | null, drivers?: Driver[] | null): Map<string, Driver> {
  const map = new Map<string, Driver>();
  vehicles?.forEach((v) => {
    const profile = resolveResourceProfile(v, drivers);
    if (profile) map.set(v.id, profile);
  });
  return map;
}

/** True when a resource needs review (no unambiguous operational profile). */
export function resourceNeedsReview(vehicle: Vehicle, drivers?: Driver[] | null): boolean {
  return !resolveResourceProfile(vehicle, drivers);
}

export function resourceLabel(vehicle: Vehicle | undefined, fallback = "Okänd resurs"): string {
  return vehicle?.name?.trim() || fallback;
}
