const norm = (v: string | null | undefined) => (v ?? "").trim().toLocaleLowerCase("sv-SE");

/**
 * One compact identity line: full route title (never parsed or rewritten),
 * the vehicle/resource name only when it adds information, and the plate.
 */
export function routeIdentityLine(
  routeName: string | null | undefined,
  vehicleName: string | null | undefined,
  licensePlate: string | null | undefined,
  driverName?: string | null,
): string {
  const parts: string[] = [];
  const route = routeName?.trim();
  if (route) parts.push(route);
  const vehicle = vehicleName?.trim();
  if (vehicle) {
    const v = norm(vehicle);
    const redundant = (route && norm(route).includes(v)) || v === norm(driverName);
    if (!redundant) parts.push(vehicle);
  }
  const plate = licensePlate?.trim();
  if (plate && !parts.some((p) => norm(p).includes(norm(plate)))) parts.push(plate);
  return parts.join(" \u2022 ");
}
