export interface EnvironmentContext {
  weatherImpact: number;
  evRangeMultiplier: number;
}

export const DEFAULT_ENV_CTX: EnvironmentContext = { weatherImpact: 1.0, evRangeMultiplier: 1.0 };

let _envCtx: EnvironmentContext = DEFAULT_ENV_CTX;

export function getEnvCtx(): EnvironmentContext {
  return _envCtx;
}

export function setEnvCtx(ctx: EnvironmentContext): void {
  _envCtx = ctx;
}

export interface ALNSNode {
  id: string;
  latitude: number;
  longitude: number;
  timeWindowStart: Date | null;
  timeWindowEnd: Date | null;
  serviceDurationMin: number;
  weightKg: number;
  volumeM3: number;
  isChargingStation?: boolean;
  chargingStationName?: string;
  chargingDurationMin?: number;
}

export interface ALNSVehicle {
  id: string;
  vehicleType: string;
  capacityKg: number;
  capacityVolume: number;
  rangeKm: number | null;
}

export interface ALNSDriverConstraints {
  vehicleId: string;
  driverName: string;
  preferredStartTime: string;
  preferredEndTime: string;
  maxDrivingHoursPerDay: number;
  avoidNightDriving: boolean;
  breakFrequencyMinutes: number;
  preferredBreakDurationMin: number;
}

export interface ALNSRoute {
  vehicleId: string;
  nodes: ALNSNode[];
  totalWeight: number;
  totalVolume: number;
}

export interface ALNSSolution {
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  cost: number;
  costBreakdown: CostBreakdown;
}

export interface CostBreakdown {
  distanceCost: number;
  co2Cost: number;
  etaPrecisionCost: number;
  driverPenaltyCost: number;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalTimeWindowSlackMin: number;
  totalDriverPenalty: number;
}

export interface OptimizationWeights {
  distanceWeight: number;
  co2Weight: number;
  etaPrecisionWeight: number;
  driverHappinessWeight: number;
}

export const DEFAULT_WEIGHTS: OptimizationWeights = {
  distanceWeight: 0.45,
  co2Weight: 0.25,
  etaPrecisionWeight: 0.15,
  driverHappinessWeight: 0.15,
};

export const CHARGING_STATIONS: ALNSNode[] = [
  { id: "cs-1", name: "Ionity Stockholm North", latitude: 59.3850, longitude: 18.0200 },
  { id: "cs-2", name: "Recharge Solna", latitude: 59.3600, longitude: 18.0000 },
  { id: "cs-3", name: "Tesla SC Kista", latitude: 59.4050, longitude: 17.9450 },
  { id: "cs-4", name: "Vattenfall Södermalm", latitude: 59.3150, longitude: 18.0700 },
  { id: "cs-5", name: "Mer Hammarby", latitude: 59.3050, longitude: 18.1000 },
  { id: "cs-6", name: "Ionity Nacka", latitude: 59.3100, longitude: 18.1600 },
  { id: "cs-7", name: "Recharge Bromma", latitude: 59.3400, longitude: 17.9400 },
  { id: "cs-8", name: "E.ON Järfälla", latitude: 59.4300, longitude: 17.8700 },
  { id: "cs-9", name: "Fortum Lidingö", latitude: 59.3700, longitude: 18.1500 },
  { id: "cs-10", name: "ChargeNode Danderyd", latitude: 59.3950, longitude: 18.0600 },
].map(s => ({
  id: s.id,
  latitude: s.latitude,
  longitude: s.longitude,
  timeWindowStart: null,
  timeWindowEnd: null,
  serviceDurationMin: 0,
  weightKg: 0,
  volumeM3: 0,
  isChargingStation: true,
  chargingStationName: (s as any).name,
  chargingDurationMin: 30,
}));

export const FULL_CHARGE_DURATION_MIN = 30;
export const MIN_CHARGE_DURATION_MIN = 10;
export const EV_CONSUMPTION_KM_PER_KWH = 5;

export const EMISSION_PROFILES: Record<string, { gCo2PerKm: number; loadFactor: number }> = {
  fossil: { gCo2PerKm: 210, loadFactor: 1.15 },
  electric: { gCo2PerKm: 50, loadFactor: 1.05 },
  hybrid: { gCo2PerKm: 130, loadFactor: 1.10 },
};

export interface RouteEvaluation {
  feasible: boolean;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalTimeWindowSlackMin: number;
  endTime: Date;
  rangeUsedKm: number;
  chargingInsertions: number;
  driverPenalty: number;
}

export interface OperatorStats {
  score: number;
  uses: number;
  weight: number;
}

export interface ALNSConfig {
  timeLimitMs: number;
  weights: OptimizationWeights;
  maxIterations: number;
  removalFraction: number;
  coolingRate: number;
  initialTemperature: number;
  driverConstraints?: ALNSDriverConstraints[];
  environment?: EnvironmentContext;
}

export const DEFAULT_CONFIG: ALNSConfig = {
  timeLimitMs: 30000,
  weights: DEFAULT_WEIGHTS,
  maxIterations: 10000,
  removalFraction: 0.3,
  coolingRate: 0.9995,
  initialTemperature: 100,
};

export interface ALNSResult {
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  costBreakdown: CostBreakdown;
  routeEvaluations: Map<string, RouteEvaluation>;
}

export interface ClusteredOptimizationProgress {
  totalClusters: number;
  completedClusters: number;
  phase: "clustering" | "optimizing" | "merging" | "complete";
  elapsedMs: number;
}

export function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export function deepCloneSolution(sol: ALNSSolution): ALNSSolution {
  return {
    routes: sol.routes.map(r => ({
      vehicleId: r.vehicleId,
      nodes: r.nodes.map(n => ({ ...n })),
      totalWeight: r.totalWeight,
      totalVolume: r.totalVolume,
    })),
    unassigned: sol.unassigned.map(n => ({ ...n })),
    cost: sol.cost,
    costBreakdown: { ...sol.costBreakdown },
  };
}
