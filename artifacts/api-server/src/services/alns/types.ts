import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkdayEvent } from "../route-workday";

export interface EnvironmentContext {
  weatherImpact: number;
  evRangeMultiplier: number;
}

export const DEFAULT_ENV_CTX: EnvironmentContext = { weatherImpact: 1.0, evRangeMultiplier: 1.0 };

let _envCtx: EnvironmentContext = DEFAULT_ENV_CTX;
const environmentScope = new AsyncLocalStorage<EnvironmentContext>();

export function getEnvCtx(): EnvironmentContext {
  return environmentScope.getStore() ?? _envCtx;
}

export function setEnvCtx(ctx: EnvironmentContext): void {
  const scoped = environmentScope.getStore();
  if (scoped) Object.assign(scoped, ctx);
  else _envCtx = ctx;
}

export function withOptimizationEnvironment<T>(ctx: EnvironmentContext, operation: () => T): T {
  return environmentScope.run({ ...ctx }, operation);
}

export interface ALNSNode {
  id: string;
  jobType?: "delivery" | "pickup_delivery" | "field_service";
  latitude: number;
  longitude: number;
  timeWindowStart: Date | null;
  timeWindowEnd: Date | null;
  serviceDurationMin: number;
  /**
   * Absolute UTC delivery closures materialized onto the stop when it is
   * planned.  A composite pickup/delivery node applies these periods only to
   * its delivery leg; pickup remains serviceable independently.
   */
  unavailablePeriods?: Array<{ start: string; end: string }>;
  weightKg: number;
  volumeM3: number;
  isChargingStation?: boolean;
  chargingStationName?: string;
  chargingDurationMin?: number;
  /**
   * Pickup & Delivery: when set, the optimizer routes to the pickup location
   * first, services it (pickupServiceMin), then continues to the delivery location
   * (node.latitude/longitude). Weight is counted once (the cargo) — no separate
   * pickup node is created. Same-vehicle constraint is automatically satisfied.
   */
  pickupLat?: number;
  pickupLon?: number;
  pickupServiceMin?: number;
  /** Field service hard requirements — populated from the stop's required_* columns */
  requiredSkills?: string[];
  requiredCertifications?: string[];
  requiredEquipment?: string[];
  /** Planning-input values are copied to nodes at optimization time, never persisted as raw stop durations. */
  planningPriority?: 0 | 1 | 2;
  stopReserveMin?: number;
  travelReservePercent?: number;
  /** Canonical persistent planner constraints; never inferred from a soft window. */
  lockedVehicleId?: string | null;
  lockedDriverId?: string | null;
  lockedServiceStartAt?: Date | null;
  /** Existing first-customer rule; charging waypoints may precede it. */
  mustBeFirstCustomer?: boolean;
}

/**
 * Per-vehicle field service eligibility cache, populated once before optimization
 * runs and re-used by evaluateRoute for O(1) feasibility checks.
 */
export interface VehicleFieldServiceEligibility {
  /** vehicleId → set of nodeIds this vehicle is INELIGIBLE for */
  ineligibleNodeIds: Map<string, Set<string>>;
  /** nodeId → reason details for reporting in unassigned list */
  unassignedReasons: Map<string, { reasonCodes: string[]; details: string[] }>;
}

export interface ALNSVehicle {
  /** Refreshed canonical workday constraints; retained through repair/persistence. */
  canonicalDriverConstraints?: ALNSDriverConstraints;
  id: string;
  /** Current active canonical DB link, required when evaluating a resource lock. */
  driverId?: string | null;
  vehicleType: string;
  capacityKg: number;
  capacityVolume: number;
  rangeKm: number | null;
  startLatitude?: number | null;
  startLongitude?: number | null;
  endLatitude?: number | null;
  endLongitude?: number | null;
  tempoMultiplier?: number;
  /** Pre-computed set of stop IDs this vehicle+driver combination cannot serve */
  ineligibleStopIds?: Set<string>;
  /** Applied to every driving leg, including the final return. */
  travelReservePercent?: number;
  /**
   * Organization-wide allowances used by the canonical route-workday
   * evaluator. They are copied onto each routing vehicle so ALNS, imports,
   * reoptimization, and mutation validation cannot accidentally diverge.
   */
  maxDriverOvertimeMin?: number;
  allowLateStopsMin?: number;
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
  breakStartTime?: string | null;
  breakEndTime?: string | null;
}

export interface ALNSRoute {
  vehicleId: string;
  nodes: ALNSNode[];
  totalWeight: number;
  totalVolume: number;
  /** Customer stop that must remain the first customer job during reoptimization. */
  lockedFirstStopId?: string | null;
  /** Frozen routes must be partitioned out before any mutable operators run. */
  optimizationFrozen?: boolean;
  sourceRouteId?: string;
  frozenTimeline?: WorkdayEvent[];
}

export interface ALNSSolution {
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  cost: number;
  costBreakdown: CostBreakdown;
  runStats?: ALNSRunStats;
}

export interface CostBreakdown {
  areasWorktime?: {
    infeasibleRoutes: number;
    unassignedMandatory: number;
    unassignedCustomers: number;
    worktimeSpreadMin: number;
    routeWorkMinutes: Record<string, number>;
  };
  distanceCost: number;
  co2Cost: number;
  etaPrecisionCost: number;
  driverPenaltyCost: number;
  /** Normalized [0, 1] penalty for nearby customer stops assigned to separate routes. */
  geographicCohesionCost: number;
  totalDistanceKm: number;
  totalCo2Kg: number;
  totalTimeWindowSlackMin: number;
  totalDriverPenalty: number;
}

export interface OptimizationWeights {
  objectivePriority?: "areas_worktime";
  /** Independent of fleet occupancy. Zero disables workload minimax scoring. */
  workloadBalanceWeight?: number;
  distanceWeight: number;
  co2Weight: number;
  etaPrecisionWeight: number;
  driverHappinessWeight: number;
  geographicCohesionWeight: number;
}

export const DEFAULT_WEIGHTS: OptimizationWeights = {
  distanceWeight: 0.45,
  co2Weight: 0.25,
  etaPrecisionWeight: 0.15,
  driverHappinessWeight: 0.15,
  geographicCohesionWeight: 0,
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
  actualWorkMinutes?: number;
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
  maxNoImprovementIterations?: number;
  minIterationsBeforeEarlyStop: number;
  localSearchTimeLimitMs: number;
  distanceMatrixTimeoutMs: number;
  removalFraction: number;
  coolingRate: number;
  initialTemperature: number;
  driverConstraints?: ALNSDriverConstraints[];
  environment?: EnvironmentContext;
  vehicleDistributionMode: "minimize" | "balance";
}

export const DEFAULT_CONFIG: ALNSConfig = {
  timeLimitMs: 30000,
  weights: DEFAULT_WEIGHTS,
  maxIterations: 10000,
  minIterationsBeforeEarlyStop: 0,
  localSearchTimeLimitMs: 5000,
  distanceMatrixTimeoutMs: 10000,
  removalFraction: 0.3,
  coolingRate: 0.9995,
  initialTemperature: 100,
  vehicleDistributionMode: "minimize",
};

export type ALNSStopReason = "time_limit" | "max_iterations" | "no_improvement" | "no_nodes";
export type ClusterStopReason = ALNSStopReason | "no_vehicles";
export type OptimizationStopReason = ClusterStopReason | "mixed";

export interface ALNSRunStats {
  iterations: number;
  improvements: number;
  searchMs: number;
  localSearchMs: number;
  stopReason: ALNSStopReason;
}

export interface ClusteredALNSRunStats {
  totalClusters: number;
  optimizedClusters: number;
  iterations: number;
  improvements: number;
  stopReason: OptimizationStopReason;
  clusterStopReasons: Partial<Record<ClusterStopReason, number>>;
}

export type OptimizationRunStats = ALNSRunStats | ClusteredALNSRunStats;

export interface OptimizationPerformance {
  distanceMatrixMs: number;
  clusteringMs: number;
  alnsSearchMs: number;
  mergingMs: number;
  searchMs: number;
  totalMs: number;
  distanceSource: "cache" | "osrm" | "mixed" | "haversine";
  runStats?: OptimizationRunStats;
}

export interface ALNSResult {
  environment?: EnvironmentContext;
  routes: ALNSRoute[];
  unassigned: ALNSNode[];
  costBreakdown: CostBreakdown;
  routeEvaluations: Map<string, RouteEvaluation>;
  performance: OptimizationPerformance;
}

export interface ClusteredOptimizationProgress {
  totalClusters: number;
  completedClusters: number;
  phase: "preparing" | "distance_matrix" | "clustering" | "optimizing" | "merging" | "complete";
  elapsedMs: number;
  iterations: number;
  improvements: number;
  stopReason: OptimizationStopReason | null;
  clusterStopReasons: Partial<Record<ClusterStopReason, number>>;
}

export function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export function deepCloneSolution(sol: ALNSSolution): ALNSSolution {
  return {
    routes: sol.routes.map(r => ({
      ...r,
      vehicleId: r.vehicleId,
      nodes: r.nodes.map(n => ({ ...n })),
      totalWeight: r.totalWeight,
      totalVolume: r.totalVolume,
    })),
    unassigned: sol.unassigned.map(n => ({ ...n })),
    cost: sol.cost,
    costBreakdown: { ...sol.costBreakdown },
    runStats: sol.runStats ? { ...sol.runStats } : undefined,
  };
}
