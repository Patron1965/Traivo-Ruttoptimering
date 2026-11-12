import { randomUUID } from "node:crypto";
import { EventEmitter } from "events";
import {
  runALNS,
  evaluateRoute,
  computeSolutionCost,
  buildInitialSolutionFromCW,
  type ALNSNode,
  type ALNSVehicle,
  type ALNSSolution,
  type ALNSConfig,
  type OptimizationWeights,
  type CostBreakdown,
  type ALNSDriverConstraints,
  type ALNSRoute,
  CHARGING_STATIONS,
} from "./alns";
import { enrichPlanningLockInputs, type PlanningLockInputs } from "./planner-lock-aware-optimizer";
import { assertFrozenRouteFeasible, assertPlanningLockResult, hasPlanningLock, OptimizerPlanningLockConflict } from "./alns/planning-locks";
import { withRequiredRoadData, RoadDataUnavailableError } from "./road-data-policy";
import { assertCanonicalInputsFresh, loadCanonicalLockInputs } from "./planner-lock-canonical-optimizer";
import { precomputeDistanceMatrix } from "./osrm";
import { logger } from "../lib/logger";
import { recordUsage } from "./usage";
import { getUsageContext } from "./usage-context";
import { withOrganizationServicePolicy } from "./organization-service-policy";

export interface ImprovementEvent {
  iteration: number;
  cost: number;
  previousCost: number;
  deltaPercent: number;
  costBreakdown: CostBreakdown;
  timestamp: number;
}

export interface ContinuousOptimizerStatus {
  running: boolean;
  organizationId: string;
  iteration: number;
  bestCost: number;
  initialCost: number;
  totalImprovementPercent: number;
  lastImprovementAt: number | null;
  startedAt: number;
  improvementHistory: ImprovementEvent[];
  maxTotalMinutes: number;
  maxIdleMinutes: number;
  elapsedMs: number;
  idleMs: number;
}

interface ContinuousOptimizerOptions {
  microIterationMs: number;
  maxIdleMinutes: number;
  maxTotalMinutes: number;
  weights?: OptimizationWeights;
  maxHistoryLength: number;
  driverConstraints?: ALNSDriverConstraints[];
  planningLockInputs?: PlanningLockInputs;
  planningDate?: Date;
}

const DEFAULT_OPTIONS: ContinuousOptimizerOptions = {
  microIterationMs: 100,
  maxIdleMinutes: 5,
  maxTotalMinutes: 30,
  maxHistoryLength: 10,
};

export class ContinuousOptimizer extends EventEmitter {
  private running = false;
  private aborted = false;
  private organizationId: string;
  private nodes: ALNSNode[];
  private vehicles: ALNSVehicle[];
  private depotLat: number;
  private depotLon: number;
  private options: ContinuousOptimizerOptions;

  private currentSolution: ALNSSolution | null = null;
  private frozenRoutes: ALNSRoute[] = [];
  private frozenVehicles: ALNSVehicle[] = [];
  private bestCost = Infinity;
  private initialCost = Infinity;
  private iteration = 0;
  private startedAt = 0;
  private lastImprovementAt: number | null = null;
  private improvementHistory: ImprovementEvent[] = [];

  private isCancelled(): boolean {
    return this.aborted || !this.running;
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async runALNSWithUsage(
    ...args: Parameters<typeof runALNS>
  ): Promise<Awaited<ReturnType<typeof runALNS>>> {
    const usageContext = getUsageContext();
    const startedAt = Date.now();
    const stopCount = this.nodes.filter((node) => !node.isChargingStation).length;
    let outcome = "success";

    try {
      return await withRequiredRoadData(() => runALNS(...args));
    } catch (error) {
      outcome = "failure";
      throw error;
    } finally {
      if (usageContext) {
        const durationMs = Date.now() - startedAt;
        try {
          await recordUsage({
            organizationId: usageContext.organizationId,
            jobId: usageContext.jobId,
            eventKey: randomUUID(),
            category: "optimization",
            provider: "internal",
            operation: "alns",
            outcome,
            units: durationMs / 1000,
            durationMs,
            stopCount,
            sizeClass: stopCount > 100 ? "large" : "small",
            engine: "alns",
          });
        } catch (error) {
          logger.error(
            { event: "usage_ledger_write_failed", provider: "internal", operation: "alns", error },
            "Could not persist optimization usage event",
          );
        }
      }
    }
  }

  private sanitizeSolution(solution: ALNSSolution, startTime: Date): ALNSSolution {
    const vehicleMap = new Map(this.vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const constraintsMap = new Map(
      (this.options.driverConstraints ?? []).map((constraints) => [constraints.vehicleId, constraints]),
    );
    for (const route of solution.routes) {
      const vehicle = vehicleMap.get(route.vehicleId);
      if (!vehicle || route.nodes.length === 0) continue;
      const evaluation = evaluateRoute(
        route,
        vehicle,
        this.depotLat,
        this.depotLon,
        startTime,
        constraintsMap.get(route.vehicleId),
      );
      if (!evaluation.feasible) {
        if (route.nodes.some(hasPlanningLock)) throw new OptimizerPlanningLockConflict(
          `Kontinuerlig optimering kan inte behålla låsta uppdrag på ${route.vehicleId}.`,
        );
        solution.unassigned.push(...route.nodes.filter((node) => !node.isChargingStation));
        route.nodes = [];
        route.totalWeight = 0;
        route.totalVolume = 0;
      }
      if (this.options.planningLockInputs) {
        const sources = new Set(route.nodes.filter(hasPlanningLock).map(node =>
          this.options.planningLockInputs!.stops.find(stop => stop.id === node.id)?.routeId,
        ).filter((id): id is string => Boolean(id)));
        if (sources.size > 1) throw new OptimizerPlanningLockConflict("Låsta uppdrag från olika rutter får inte slås samman.");
        if (sources.size === 1) route.sourceRouteId = [...sources][0];
      }
    }
    assertPlanningLockResult(this.nodes, solution.routes, solution.unassigned, this.vehicles,
      this.depotLat, this.depotLon, startTime, constraintsMap);
    const { cost, breakdown } = computeSolutionCost(
      solution,
      this.vehicles,
      this.depotLat,
      this.depotLon,
      startTime,
      this.options.weights ?? {
        distanceWeight: 1,
        co2Weight: 0.3,
        etaPrecisionWeight: 0.5,
        driverHappinessWeight: 0.2,
        geographicCohesionWeight: 0,
      },
      constraintsMap,
    );
    solution.cost = cost;
    solution.costBreakdown = breakdown;
    return solution;
  }

  constructor(
    organizationId: string,
    nodes: ALNSNode[],
    vehicles: ALNSVehicle[],
    depotLat: number,
    depotLon: number,
    options: Partial<ContinuousOptimizerOptions> = {}
  ) {
    super();
    this.organizationId = organizationId;
    this.nodes = nodes;
    this.vehicles = vehicles;
    this.depotLat = depotLat;
    this.depotLon = depotLon;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async start(): Promise<void> {
    return withOrganizationServicePolicy(this.organizationId, () => this.startWithPolicy());
  }

  private async startWithPolicy(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    this.startedAt = Date.now();
    const startTime = this.options.planningDate ?? new Date();
    if (this.options.planningLockInputs) {
      const effective = enrichPlanningLockInputs(this.options.planningLockInputs);
      this.frozenRoutes = effective.currentRoutes.filter(route => route.optimizationFrozen);
      const reserved = new Set(this.frozenRoutes.map(route => route.vehicleId));
      this.frozenVehicles = effective.vehicles.filter(vehicle => reserved.has(vehicle.id));
      const reservedJobs = new Set(this.frozenRoutes.flatMap(route => route.nodes.map(node => node.id)));
      this.nodes = effective.nodes.filter(node => !reservedJobs.has(node.id));
      this.vehicles = effective.vehicles.filter(vehicle => !reserved.has(vehicle.id));
      const constraints = new Map((this.options.driverConstraints ?? []).map(item => [item.vehicleId, item]));
      for (const route of this.frozenRoutes) assertFrozenRouteFeasible(route,
        this.frozenVehicles.find(vehicle => vehicle.id === route.vehicleId),
        this.depotLat, this.depotLon, startTime, constraints.get(route.vehicleId));
    }
    this.iteration = 0;
    this.improvementHistory = [];
    this.lastImprovementAt = null;

    const allCoords = [
      { lat: this.depotLat, lon: this.depotLon },
      ...this.nodes.map(n => ({ lat: n.latitude, lon: n.longitude })),
      ...this.nodes.flatMap(n => n.pickupLat != null && n.pickupLon != null ? [{ lat: n.pickupLat, lon: n.pickupLon }] : []),
      ...this.vehicles.flatMap(vehicle => [
        { lat: vehicle.startLatitude ?? this.depotLat, lon: vehicle.startLongitude ?? this.depotLon },
        { lat: vehicle.endLatitude ?? this.depotLat, lon: vehicle.endLongitude ?? this.depotLon },
      ]),
      ...(this.vehicles.some(vehicle => vehicle.vehicleType === "electric")
        ? CHARGING_STATIONS.map(node => ({ lat: node.latitude, lon: node.longitude })) : []),
    ];
    const osrmOk = await precomputeDistanceMatrix(allCoords);
    if (this.isCancelled()) return;
    await this.yieldToEventLoop();
    if (this.isCancelled()) return;
    if (!osrmOk && allCoords.some(point => point.lat !== allCoords[0].lat || point.lon !== allCoords[0].lon)) {
      this.running = false;
      throw new RoadDataUnavailableError();
    }

    this.currentSolution = withRequiredRoadData(() => buildInitialSolutionFromCW(
      this.nodes,
      this.vehicles,
      this.depotLat,
      this.depotLon,
      startTime, "minimize", this.options.driverConstraints,
    ));
    if (this.isCancelled()) return;
    await this.yieldToEventLoop();
    if (this.isCancelled()) return;

    const alnsConfig: Record<string, unknown> = {
      timeLimitMs: this.options.microIterationMs,
      maxIterations: 200,
      // Continuous runs must return control quickly enough for Stop to be
      // handled; quality improves across many short passes instead.
      localSearchTimeLimitMs: Math.min(250, this.options.microIterationMs),
    };
    if (this.options.weights) alnsConfig.weights = this.options.weights;
    if (this.options.driverConstraints) alnsConfig.driverConstraints = this.options.driverConstraints;

    const initialResult = await this.runALNSWithUsage(
      this.currentSolution,
      this.vehicles,
      this.depotLat,
      this.depotLon,
      startTime,
      alnsConfig as Parameters<typeof runALNS>[5],
      () => {},
      () => this.isCancelled(),
    );
    if (this.isCancelled()) return;

    this.currentSolution = withRequiredRoadData(() => this.sanitizeSolution(initialResult, startTime));
    this.bestCost = this.currentSolution.cost;
    this.initialCost = this.currentSolution.cost;
    this.iteration = 1;

    this.emit("started", this.getStatus());

    if (this.nodes.length === 0) { this.running = false; this.emit("stopped", this.getStatus()); return; }
    void this.loop(startTime).catch(error => {
      this.running = false;
      this.emit("planning-conflict", error);
    });
  }

  stop(): ALNSSolution | null {
    if (!this.running) {
      this.aborted = true;
      return this.getSolution();
    }
    this.aborted = true;
    this.running = false;
    this.emit("stopped", this.getStatus());
    return this.getSolution();
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): ContinuousOptimizerStatus {
    const now = Date.now();
    const elapsedMs = this.startedAt ? now - this.startedAt : 0;
    const idleMs = this.lastImprovementAt
      ? now - this.lastImprovementAt
      : elapsedMs;
    return {
      running: this.running,
      organizationId: this.organizationId,
      iteration: this.iteration,
      bestCost: this.bestCost,
      initialCost: this.initialCost,
      totalImprovementPercent:
        this.initialCost > 0 && isFinite(this.bestCost)
          ? ((this.initialCost - this.bestCost) / this.initialCost) * 100
          : 0,
      lastImprovementAt: this.lastImprovementAt,
      startedAt: this.startedAt,
      improvementHistory: [...this.improvementHistory],
      maxTotalMinutes: this.options.maxTotalMinutes,
      maxIdleMinutes: this.options.maxIdleMinutes,
      elapsedMs,
      idleMs,
    };
  }

  getSolution(): ALNSSolution | null {
    if (!this.currentSolution || !this.frozenRoutes.length) return this.currentSolution;
    const combined = { ...this.currentSolution, routes: [...this.currentSolution.routes, ...this.frozenRoutes] };
    const evaluated = withRequiredRoadData(() => computeSolutionCost(combined,
      [...this.vehicles, ...this.frozenVehicles], this.depotLat, this.depotLon,
      this.options.planningDate ?? new Date(this.startedAt), this.options.weights ?? DEFAULT_OPTIONS.weights ?? {
        distanceWeight: 1, co2Weight: 0.3, etaPrecisionWeight: 0.5, driverHappinessWeight: 0.2, geographicCohesionWeight: 0,
      }, new Map((this.options.driverConstraints ?? []).map(item => [item.vehicleId, item]))));
    return { ...combined, cost: evaluated.cost, costBreakdown: evaluated.breakdown };
  }
  async validatePlanningSnapshot(): Promise<void> {
    if (this.options.planningLockInputs) await assertCanonicalInputsFresh(this.options.planningLockInputs);
  }

  async injectDisruption(newNodes: ALNSNode[], removedNodeIds?: string[]): Promise<void> {
    return withOrganizationServicePolicy(this.organizationId, () => this.injectDisruptionWithPolicy(newNodes, removedNodeIds));
  }

  private async injectDisruptionWithPolicy(newNodes: ALNSNode[], removedNodeIds?: string[]): Promise<void> {
    if (!this.currentSolution) return;
    await this.validatePlanningSnapshot();
    if (this.options.planningLockInputs && newNodes.length) {
      const refreshed = await loadCanonicalLockInputs(
        [...this.nodes, ...newNodes, ...this.frozenRoutes.flatMap(route => route.nodes.filter(node => !node.isChargingStation))],
        [...this.vehicles, ...this.frozenVehicles], this.depotLat, this.depotLon,
        this.options.planningDate ?? new Date(this.startedAt),
        { driverConstraints: this.options.driverConstraints },
        this.options.planningLockInputs.routes.map(route => route.id),
      );
      for (const node of newNodes) Object.assign(node, refreshed.input.nodes.find(item => item.id === node.id));
      this.options.planningLockInputs = refreshed.input;
    }
    const all = [...this.nodes, ...this.frozenRoutes.flatMap(route => route.nodes)];
    if (all.some(node => removedNodeIds?.includes(node.id) && hasPlanningLock(node))
      || newNodes.some(node => this.frozenRoutes.some(route => route.nodes.some(item => item.id === node.id)))) {
      throw new OptimizerPlanningLockConflict("En störning får inte ta bort låsta uppdrag eller ändra en fryst rutt.");
    }

    if (removedNodeIds && removedNodeIds.length > 0) {
      const removeSet = new Set(removedNodeIds);
      for (const route of this.currentSolution.routes) {
        route.nodes = route.nodes.filter((n) => !removeSet.has(n.id));
        route.totalWeight = route.nodes.reduce((s, n) => s + n.weightKg, 0);
        route.totalVolume = route.nodes.reduce((s, n) => s + n.volumeM3, 0);
      }
    }

    if (newNodes.length > 0) {
      const newCoords = newNodes.map(n => ({ lat: n.latitude, lon: n.longitude }));
      const existingCoords = this.nodes.map(n => ({ lat: n.latitude, lon: n.longitude }));
      const depot = { lat: this.depotLat, lon: this.depotLon };
      await precomputeDistanceMatrix([depot, ...newCoords, ...existingCoords.slice(0, 20)]);

      this.currentSolution.unassigned.push(...newNodes);
      this.nodes = [
        ...this.nodes.filter(
          (n) => !newNodes.some((nn) => nn.id === n.id)
        ),
        ...newNodes,
      ];
    }

    if (removedNodeIds && removedNodeIds.length > 0) {
      const removeSet = new Set(removedNodeIds);
      this.nodes = this.nodes.filter((n) => !removeSet.has(n.id));
      this.currentSolution.unassigned = this.currentSolution.unassigned.filter(
        (n) => !removeSet.has(n.id)
      );
    }

    this.bestCost = Infinity;
    this.lastImprovementAt = Date.now();
  }

  private async loop(startTime: Date): Promise<void> {
    const nodeCount = this.nodes.length;
    const earlyStopIterations = nodeCount <= 5 ? 10 : nodeCount <= 15 ? 30 : nodeCount <= 30 ? 80 : 0;

    while (this.running && !this.aborted) {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed > this.options.maxTotalMinutes * 60_000) {
        this.running = false;
        this.emit("timeout", this.getStatus());
        break;
      }

      const idleTime = this.lastImprovementAt
        ? Date.now() - this.lastImprovementAt
        : elapsed;
      if (
        this.iteration > 3 &&
        idleTime > this.options.maxIdleMinutes * 60_000
      ) {
        this.running = false;
        this.emit("idle-timeout", this.getStatus());
        break;
      }

      if (earlyStopIterations > 0 && this.iteration >= earlyStopIterations && !this.lastImprovementAt) {
        this.running = false;
        this.emit("idle-timeout", this.getStatus());
        break;
      }

      const previousCost = this.bestCost;

      const loopConfig: Record<string, unknown> = {
        timeLimitMs: this.options.microIterationMs,
        maxIterations: 500,
        initialTemperature: Math.max(10, 100 - this.iteration * 2),
        coolingRate: 0.999,
        localSearchTimeLimitMs: Math.min(250, this.options.microIterationMs),
      };
      if (this.options.weights) loopConfig.weights = this.options.weights;
      if (this.options.driverConstraints) loopConfig.driverConstraints = this.options.driverConstraints;

      const rawResult = await this.runALNSWithUsage(
        this.currentSolution!,
        this.vehicles,
        this.depotLat,
        this.depotLon,
        startTime,
        loopConfig as Parameters<typeof runALNS>[5],
        () => {},
        () => this.isCancelled(),
      );
      if (this.isCancelled()) break;
      const result = withRequiredRoadData(() => this.sanitizeSolution(rawResult, startTime));
      if (this.isCancelled()) break;

      this.iteration++;

      if (result.cost < this.bestCost) {
        const deltaPercent =
          previousCost > 0 && isFinite(previousCost)
            ? ((previousCost - result.cost) / previousCost) * 100
            : 0;

        this.currentSolution = result;
        this.bestCost = result.cost;
        this.lastImprovementAt = Date.now();

        const event: ImprovementEvent = {
          iteration: this.iteration,
          cost: result.cost,
          previousCost,
          deltaPercent,
          costBreakdown: result.costBreakdown,
          timestamp: Date.now(),
        };

        this.improvementHistory.push(event);
        if (
          this.improvementHistory.length > this.options.maxHistoryLength
        ) {
          this.improvementHistory.shift();
        }

        this.emit("improvement", event, this.getStatus());
      }

      await this.yieldToEventLoop();
    }
  }
}

const activeOptimizers = new Map<string, ContinuousOptimizer>();

export function getActiveOptimizer(
  organizationId: string
): ContinuousOptimizer | undefined {
  return activeOptimizers.get(organizationId);
}

export function setActiveOptimizer(
  organizationId: string,
  optimizer: ContinuousOptimizer
): void {
  const existing = activeOptimizers.get(organizationId);
  if (existing?.isRunning()) {
    existing.stop();
  }
  activeOptimizers.set(organizationId, optimizer);
}

export function removeActiveOptimizer(organizationId: string): void {
  const existing = activeOptimizers.get(organizationId);
  if (existing?.isRunning()) {
    existing.stop();
  }
  activeOptimizers.delete(organizationId);
}
