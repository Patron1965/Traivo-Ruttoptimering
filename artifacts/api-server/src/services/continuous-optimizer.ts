import { EventEmitter } from "events";
import {
  runALNS,
  buildInitialSolutionFromCW,
  type ALNSNode,
  type ALNSVehicle,
  type ALNSSolution,
  type ALNSConfig,
  type OptimizationWeights,
  type CostBreakdown,
} from "./alns";
import { precomputeDistanceMatrix } from "./osrm";

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
  private bestCost = Infinity;
  private initialCost = Infinity;
  private iteration = 0;
  private startedAt = 0;
  private lastImprovementAt: number | null = null;
  private improvementHistory: ImprovementEvent[] = [];

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
    if (this.running) return;
    this.running = true;
    this.aborted = false;
    this.startedAt = Date.now();
    this.iteration = 0;
    this.improvementHistory = [];
    this.lastImprovementAt = null;

    const allCoords = [
      { lat: this.depotLat, lon: this.depotLon },
      ...this.nodes.map(n => ({ lat: n.latitude, lon: n.longitude })),
    ];
    const osrmOk = await precomputeDistanceMatrix(allCoords);
    console.log(osrmOk
      ? `ContinuousOptimizer: Using OSRM road distances for ${this.nodes.length} stops`
      : `ContinuousOptimizer: Falling back to Haversine for ${this.nodes.length} stops`
    );

    const startTime = new Date();
    this.currentSolution = buildInitialSolutionFromCW(
      this.nodes,
      this.vehicles,
      this.depotLat,
      this.depotLon,
      startTime
    );

    const alnsConfig: Record<string, unknown> = {
      timeLimitMs: this.options.microIterationMs,
      maxIterations: 200,
    };
    if (this.options.weights) alnsConfig.weights = this.options.weights;

    const initialResult = runALNS(
      this.currentSolution,
      this.vehicles,
      this.depotLat,
      this.depotLon,
      startTime,
      alnsConfig as Parameters<typeof runALNS>[5]
    );

    this.currentSolution = initialResult;
    this.bestCost = initialResult.cost;
    this.initialCost = initialResult.cost;
    this.iteration = 1;

    this.emit("started", this.getStatus());

    this.loop(startTime);
  }

  stop(): ALNSSolution | null {
    this.aborted = true;
    this.running = false;
    this.emit("stopped", this.getStatus());
    return this.currentSolution;
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
    return this.currentSolution;
  }

  async injectDisruption(newNodes: ALNSNode[], removedNodeIds?: string[]): Promise<void> {
    if (!this.currentSolution) return;

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
      };
      if (this.options.weights) loopConfig.weights = this.options.weights;

      const result = runALNS(
        this.currentSolution!,
        this.vehicles,
        this.depotLat,
        this.depotLon,
        startTime,
        loopConfig as Parameters<typeof runALNS>[5]
      );

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

      await new Promise<void>((resolve) => setImmediate(resolve));
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
