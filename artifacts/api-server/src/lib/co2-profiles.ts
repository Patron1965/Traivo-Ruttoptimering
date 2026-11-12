export interface EmissionProfile {
  label: string;
  co2PerKmGrams: number;
  wellToWheelFactor: number;
}

export const EMISSION_PROFILES: Record<string, EmissionProfile> = {
  fossil: {
    label: "Diesel Van",
    co2PerKmGrams: 210,
    wellToWheelFactor: 1.2,
  },
  diesel_truck: {
    label: "Diesel Truck",
    co2PerKmGrams: 350,
    wellToWheelFactor: 1.2,
  },
  electric: {
    label: "Electric Van",
    co2PerKmGrams: 50,
    wellToWheelFactor: 1.5,
  },
  hybrid: {
    label: "Hybrid",
    co2PerKmGrams: 130,
    wellToWheelFactor: 1.15,
  },
};

const DEFAULT_LOAD_FACTOR = 0.7;

export function calculateCo2Kg(
  distanceKm: number,
  vehicleType: string,
  loadFactor?: number,
): number {
  const profile = EMISSION_PROFILES[vehicleType] ?? EMISSION_PROFILES.fossil;
  const load = loadFactor ?? DEFAULT_LOAD_FACTOR;
  const loadAdjustment = 0.8 + 0.4 * load;
  const co2Grams =
    distanceKm * profile.co2PerKmGrams * profile.wellToWheelFactor * loadAdjustment;
  return co2Grams / 1000;
}

export function baselineFossilCo2Kg(distanceKm: number): number {
  const profile = EMISSION_PROFILES.fossil;
  return (distanceKm * profile.co2PerKmGrams * profile.wellToWheelFactor) / 1000;
}
