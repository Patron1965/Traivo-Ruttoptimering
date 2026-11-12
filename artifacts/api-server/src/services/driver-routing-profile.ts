import type { Driver } from "@workspace/db";
import type { ALNSVehicle } from "./alns/types";

type RoutingDriverProfile = Pick<
  Driver,
  | "capacityKg"
  | "capacityVolume"
  | "startLatitude"
  | "startLongitude"
  | "endLatitude"
  | "endLongitude"
  | "tempo"
>;

export function applyDriverRoutingProfile(
  vehicle: ALNSVehicle,
  driver: RoutingDriverProfile,
): ALNSVehicle {
  return {
    ...vehicle,
    capacityKg: driver.capacityKg == null
      ? vehicle.capacityKg
      : Math.min(vehicle.capacityKg, driver.capacityKg),
    capacityVolume: driver.capacityVolume == null
      ? vehicle.capacityVolume
      : Math.min(vehicle.capacityVolume, driver.capacityVolume),
    // An absent driver override must not erase the organization depot carried
    // by the planning vehicle. Explicit driver positions remain visible and win.
    startLatitude: driver.startLatitude ?? vehicle.startLatitude,
    startLongitude: driver.startLongitude ?? vehicle.startLongitude,
    endLatitude: driver.endLatitude ?? vehicle.endLatitude,
    endLongitude: driver.endLongitude ?? vehicle.endLongitude,
    tempoMultiplier: driver.tempo === "slow" ? 1.15 : driver.tempo === "fast" ? 0.9 : 1,
  };
}