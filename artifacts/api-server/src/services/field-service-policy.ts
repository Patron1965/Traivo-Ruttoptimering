import type { ALNSNode, ALNSVehicle } from "./alns/types";

export const INCOMPATIBLE_TECHNICIAN_REASON = {
  reasonCodes: ["INCOMPATIBLE_ROLE"],
  details: ["Vehicle does not have an active technician assigned"],
};

export function markUnstaffedVehicleIneligible(
  vehicle: ALNSVehicle,
  fieldServiceNodes: ALNSNode[],
  driverId: string | undefined,
  reasons: Map<string, { reasonCodes: string[]; details: string[] }>,
): boolean {
  if (driverId || fieldServiceNodes.length === 0) return false;

  const ineligible = new Set<string>();
  for (const node of fieldServiceNodes) {
    ineligible.add(node.id);
    if (!reasons.has(node.id)) {
      reasons.set(node.id, {
        reasonCodes: [...INCOMPATIBLE_TECHNICIAN_REASON.reasonCodes],
        details: [...INCOMPATIBLE_TECHNICIAN_REASON.details],
      });
    }
  }
  vehicle.ineligibleStopIds = ineligible;
  return true;
}

export interface FieldServicePolicyDriver {
  id: string;
  vehicleId: string | null;
}

export async function applyFieldServiceEligibilityToVehicles(
  vehicles: ALNSVehicle[],
  fieldServiceNodes: ALNSNode[],
  drivers: FieldServicePolicyDriver[],
  checkEligibility: (
    driverId: string,
    vehicleId: string,
    node: ALNSNode,
  ) => Promise<boolean>,
): Promise<Set<string>> {
  const driversByVehicle = new Map<string, FieldServicePolicyDriver[]>();
  for (const driver of drivers) {
    if (!driver.vehicleId) continue;
    const vehicleDrivers = driversByVehicle.get(driver.vehicleId) ?? [];
    vehicleDrivers.push(driver);
    driversByVehicle.set(driver.vehicleId, vehicleDrivers);
  }

  for (const vehicle of vehicles) {
    const ineligible = new Set<string>();
    const vehicleDrivers = driversByVehicle.get(vehicle.id) ?? [];
    for (const node of fieldServiceNodes) {
      let eligible = false;
      for (const driver of vehicleDrivers) {
        if (await checkEligibility(driver.id, vehicle.id, node)) {
          eligible = true;
          break;
        }
      }
      if (!eligible) ineligible.add(node.id);
    }
    if (ineligible.size > 0) {
      vehicle.ineligibleStopIds = ineligible;
    }
  }

  return new Set(
    fieldServiceNodes
      .filter(node =>
        !vehicles.some(vehicle => !vehicle.ineligibleStopIds?.has(node.id)),
      )
      .map(node => node.id),
  );
}