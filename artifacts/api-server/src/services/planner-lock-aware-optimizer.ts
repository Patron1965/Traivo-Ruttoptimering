import type { Driver, Route, Stop, Vehicle } from "@workspace/db";
import type {
  ALNSConfig, ALNSNode, ALNSResult, ALNSRoute, ALNSVehicle, ClusteredOptimizationProgress,
} from "./alns/types";
import { DEFAULT_ENV_CTX, DEFAULT_WEIGHTS, withOptimizationEnvironment } from "./alns/types";
import { computeSolutionCost, evaluateRoute } from "./alns/cost";
import { withRequiredRoadData } from "./road-data-policy";
import {
  assertFrozenRouteFeasible, assertLockedJobsRetained, OptimizerPlanningLockConflict,
} from "./alns/planning-locks";

export { OptimizerPlanningLockConflict } from "./alns/planning-locks";

export interface PlanningLockInputs {
  stops: readonly Stop[];
  routes: readonly Route[];
  vehicles: readonly Vehicle[];
  /** Active driver links must be fetched in the same canonical snapshot. */
  drivers?: readonly Driver[];
  nodes: readonly ALNSNode[];
  routingVehicles: readonly ALNSVehicle[];
  /** Complete original itineraries, including charging waypoints. Required for frozen routes. */
  currentRoutes?: readonly ALNSRoute[];
}

function fail(message: string): never { throw new OptimizerPlanningLockConflict(message); }

/**
 * Enrich already-mapped inputs (durations/reserves/eligibility remain caller-owned).
 * No DB reads, inferred driver links, mutation, clock rounding, or soft lock windows.
 */
export function enrichPlanningLockInputs(input: PlanningLockInputs) {
  const stopById = new Map(input.stops.map(stop => [stop.id, stop]));
  const routeById = new Map(input.routes.map(route => [route.id, route]));
  const vehicleById = new Map(input.vehicles.map(vehicle => [vehicle.id, vehicle]));
  const mappedVehicleIds = new Set(input.routingVehicles.map(vehicle => vehicle.id));
  const nodes = input.nodes.map(node => {
    if (node.isChargingStation) return { ...node };
    const stop = stopById.get(node.id);
    if (!stop) fail(`Kanoniskt stoppunderlag saknas för ${node.id}.`);
    const route = stop.routeId ? routeById.get(stop.routeId) : undefined;
    const mustBeFirstCustomer = route?.lockedFirstStopId === stop.id;
    const hasLock = Boolean(stop.lockedVehicleId || stop.lockedDriverId || stop.lockedServiceStartAt || mustBeFirstCustomer);
    if (hasLock && (!route?.vehicleId || !mappedVehicleIds.has(route.vehicleId))) {
      fail(`Det låsta uppdraget ${stop.id} saknar sin ursprungliga rutt/resurs i underlaget.`);
    }
    if (Boolean(stop.lockedVehicleId) !== Boolean(stop.lockedDriverId)) {
      fail(`Det låsta resursparret för ${stop.id} är ofullständigt.`);
    }
    if (stop.lockedVehicleId && stop.lockedVehicleId !== route?.vehicleId) {
      fail(`Det låsta resursparret för ${stop.id} motsvarar inte ursprungsrutten.`);
    }
    if (stop.lockedServiceStartAt
      && (!Number.isFinite(stop.lockedServiceStartAt.getTime()) || stop.lockedServiceStartAt.getTime() % 60_000 !== 0)) {
      fail(`Servicestartslåset för ${stop.id} är inte en exakt minut.`);
    }
    // Time-only locks retain membership as required by the persistent guards.
    // Frozen jobs additionally pin the captured pair.
    const lockedVehicleId = stop.lockedVehicleId
      ?? (stop.lockedServiceStartAt || route?.optimizationFrozen || mustBeFirstCustomer ? route?.vehicleId : null);
    const lockedDriverId = stop.lockedDriverId
      ?? (route?.optimizationFrozen ? route.frozenDriverId : null);
    return {
      ...node, lockedVehicleId, lockedDriverId, mustBeFirstCustomer,
      lockedServiceStartAt: stop.lockedServiceStartAt ? new Date(stop.lockedServiceStartAt) : null,
    };
  });
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const requiredRouteByVehicle = new Map<string, string>();
  for (const node of nodes) {
    const stop = stopById.get(node.id);
    if (!node.lockedVehicleId || !stop?.routeId) continue;
    const previous = requiredRouteByVehicle.get(node.lockedVehicleId);
    if (previous && previous !== stop.routeId) {
      fail(`Fordonet ${node.lockedVehicleId} har låsta uppdrag på flera rutter. Dessa kan inte slås samman.`);
    }
    requiredRouteByVehicle.set(node.lockedVehicleId, stop.routeId);
  }
  if (nodeById.size !== nodes.length) fail("Optimeringsunderlaget innehåller dubbla uppdrags-ID:n.");
  for (const route of input.routes) {
    if (route.lockedFirstStopId && !nodeById.has(route.lockedFirstStopId)) {
      fail(`Den låsta första kundjobbsnoden för ${route.id} saknas i underlaget.`);
    }
  }
  for (const stop of input.stops) {
    if ((stop.lockedVehicleId || stop.lockedDriverId || stop.lockedServiceStartAt
      || (stop.routeId && routeById.get(stop.routeId)?.optimizationFrozen)) && !nodeById.has(stop.id)) {
      fail(`Det låsta uppdraget ${stop.id} saknas i optimeringsunderlaget.`);
    }
  }
  const vehicles = input.routingVehicles.map(vehicle => {
    const canonical = vehicleById.get(vehicle.id);
    if (!canonical) fail(`Kanoniskt fordonsunderlag saknas för ${vehicle.id}.`);
    const links = (input.drivers ?? []).filter(driver =>
      driver.vehicleId === vehicle.id && driver.isActive && driver.organizationId === canonical.organizationId);
    if (links.length > 1) fail(`Fordonet ${vehicle.id} har flera aktiva chaufförslänkar.`);
    const driverId = links[0]?.id ?? null;
    for (const node of nodes) {
      if (node.lockedVehicleId !== vehicle.id) continue;
      if (!canonical.isActive || (node.lockedDriverId && node.lockedDriverId !== driverId)) {
        fail(`Det låsta resursparret för ${node.id} är inte längre aktivt/länkat.`);
      }
      const stop = stopById.get(node.id)!;
      if (stop.organizationId !== canonical.organizationId
        || (stop.routeId && routeById.get(stop.routeId)?.organizationId !== stop.organizationId)) {
        fail(`Låsunderlaget för ${node.id} tillhör inte samma organisation.`);
      }
    }
    return {
      ...vehicle, driverId, vehicleType: canonical.vehicleType,
      capacityKg: Math.min(canonical.capacityKg, vehicle.capacityKg),
      capacityVolume: Math.min(canonical.capacityVolume, vehicle.capacityVolume),
      rangeKm: canonical.rangeKm == null ? vehicle.rangeKm
        : vehicle.rangeKm == null ? canonical.rangeKm : Math.min(canonical.rangeKm, vehicle.rangeKm),
      ineligibleStopIds: vehicle.ineligibleStopIds ? new Set(vehicle.ineligibleStopIds) : undefined,
    };
  });
  const currentRoutes = (input.currentRoutes ?? []).map(mapped => {
    const canonical = mapped.sourceRouteId
      ? routeById.get(mapped.sourceRouteId)
      : input.routes.find(route => route.vehicleId === mapped.vehicleId);
    return {
      ...mapped,
      nodes: mapped.nodes.map(node => node.isChargingStation ? { ...node } : nodeById.get(node.id)
        ?? fail(`Stoppet ${node.id} saknas i det kanoniska optimeringsunderlaget.`)),
      sourceRouteId: canonical?.id,
      lockedFirstStopId: canonical ? canonical.lockedFirstStopId : mapped.lockedFirstStopId,
      optimizationFrozen: canonical?.optimizationFrozen ?? false,
      frozenTimeline: canonical?.optimizationFrozen
        ? canonical.workdayTimeline?.map(event => ({ ...event })) : undefined,
    };
  });
  const frozenRouteSnapshots = input.routes.filter(route => route.optimizationFrozen);
  for (const route of frozenRouteSnapshots) {
    const candidates = currentRoutes.filter(mapped => mapped.sourceRouteId === route.id);
    if (!route.vehicleId || !route.frozenDriverId || candidates.length !== 1 || !route.workdayTimeline?.length) {
      fail(`Den frysta rutten ${route.id} saknar komplett sparat rutt-/tids-/resursunderlag.`);
    }
    if (input.routes.filter(other => other.vehicleId === route.vehicleId).length !== 1) {
      fail(`Fordonet på den frysta rutten ${route.id} används av flera rutter i underlaget.`);
    }
    const expected = input.stops.filter(stop => stop.routeId === route.id)
      .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0)).map(stop => stop.id);
    const actual = candidates[0].nodes.filter(node => !node.isChargingStation).map(node => node.id);
    const itinerary = route.plannerItinerary?.map(entry => `${entry.stopId}:${Boolean(entry.isChargingStop)}`);
    const mappedItinerary = candidates[0].nodes.map(node => `${node.id}:${Boolean(node.isChargingStation)}`);
    // The saved service IDs also prove a partial Stop[] snapshot was not used.
    const savedIds = [...new Set(route.workdayTimeline.filter(event => event.type === "service")
      .map(event => event.stopId).filter((id): id is string => Boolean(id)))];
    if (JSON.stringify(expected) !== JSON.stringify(actual)
      || !itinerary || JSON.stringify(itinerary) !== JSON.stringify(mappedItinerary)
      || savedIds.length !== expected.length || savedIds.some(id => !expected.includes(id))) {
      fail(`Medlemskap/ordning saknas eller avviker för den frysta rutten ${route.id}.`);
    }
    const vehicle = vehicles.find(item => item.id === route.vehicleId);
    if (!vehicle || !vehicleById.get(route.vehicleId)?.isActive
      || vehicleById.get(route.vehicleId)?.organizationId !== route.organizationId
      || vehicle.driverId !== route.frozenDriverId) {
      fail(`Den frysta rutten ${route.id} har inte längre sitt sparade resurspar.`);
    }
  }
  return { nodes, vehicles, currentRoutes, frozenRouteSnapshots };
}

export type LockAwareOptimizer = (
  nodes: ALNSNode[], vehicles: ALNSVehicle[], depotLat: number, depotLon: number, date: Date,
  config?: Partial<ALNSConfig>, onProgress?: (progress: ClusteredOptimizationProgress) => void,
) => Promise<ALNSResult>;

/**
 * Pass optimizeWithALNS as optimizer. Frozen routes never enter mutable search.
 * Persist returned frozenRouteSnapshots unchanged, not regenerated result clocks.
 */
export async function optimizeWithPlanningLocks(
  input: PlanningLockInputs, optimizer: LockAwareOptimizer,
  depotLat: number, depotLon: number, date: Date, config: Partial<ALNSConfig> = {},
  onProgress?: (progress: ClusteredOptimizationProgress) => void,
) {
  const enriched = enrichPlanningLockInputs(input);
  return withOptimizationEnvironment(config.environment ?? DEFAULT_ENV_CTX, () => withRequiredRoadData(async () => {
    const frozen = enriched.currentRoutes.filter(route => route.optimizationFrozen);
    const constraints = new Map((config.driverConstraints ?? []).map(item => [item.vehicleId, item]));
    for (const route of frozen) assertFrozenRouteFeasible(route,
      enriched.vehicles.find(vehicle => vehicle.id === route.vehicleId), depotLat, depotLon, date, constraints.get(route.vehicleId));
    const reservedVehicles = new Set(frozen.map(route => route.vehicleId));
    const reservedJobs = new Set(frozen.flatMap(route => route.nodes.filter(node => !node.isChargingStation).map(node => node.id)));
    const mutableNodes = enriched.nodes.filter(node => !reservedJobs.has(node.id));
    const emptyBreakdown = {
      distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0,
      geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0,
      totalTimeWindowSlackMin: 0, totalDriverPenalty: 0,
    };
    const result: ALNSResult = mutableNodes.length === 0 ? {
      routes: [], unassigned: [], routeEvaluations: new Map(), costBreakdown: emptyBreakdown,
      performance: { distanceMatrixMs: 0, clusteringMs: 0, alnsSearchMs: 0, mergingMs: 0,
        searchMs: 0, totalMs: 0, distanceSource: "cache" },
      environment: { ...(config.environment ?? DEFAULT_ENV_CTX) },
    } : await optimizer(
      mutableNodes,
      enriched.vehicles.filter(vehicle => !reservedVehicles.has(vehicle.id)),
      depotLat, depotLon, date, config, onProgress,
    );
    if (result.routes.some(route => reservedVehicles.has(route.vehicleId)
      || route.nodes.some(node => reservedJobs.has(node.id)))
      || result.unassigned.some(node => reservedJobs.has(node.id))) {
      fail("Optimeraren försökte ändra en fryst rutts reserverade uppdrag/resurs.");
    }
    result.routes = [...result.routes, ...frozen];
    assertLockedJobsRetained(enriched.nodes, result.routes, result.unassigned);
    const knownNodes = new Map(enriched.nodes.map(node => [node.id, node]));
    const sourceStops = new Map(input.stops.map(stop => [stop.id, stop]));
    for (const route of result.routes) {
      // Validate using original constraints, not potentially stripped output flags.
      const authoritative = { ...route, nodes: route.nodes.map(node => knownNodes.get(node.id) ?? node) };
      const sourceRouteIds = new Set(authoritative.nodes.filter(node =>
        node.lockedVehicleId || node.lockedDriverId || node.lockedServiceStartAt,
      ).map(node => sourceStops.get(node.id)?.routeId).filter((id): id is string => Boolean(id)));
      if (sourceRouteIds.size > 1) fail("Optimeraren försökte slå samman låsta uppdrag från olika rutter.");
      const sourceRouteId = [...sourceRouteIds][0];
      if (sourceRouteId) route.sourceRouteId = sourceRouteId;
      const vehicle = enriched.vehicles.find(item => item.id === route.vehicleId);
      if (!vehicle || !evaluateRoute(authoritative, vehicle, depotLat, depotLon, date, constraints.get(route.vehicleId)).feasible) {
        fail(`Optimeringsresultatet för ${route.vehicleId} bryter mot planens hårda villkor.`);
      }
      result.routeEvaluations.set(route.vehicleId,
        evaluateRoute(authoritative, vehicle, depotLat, depotLon, date, constraints.get(route.vehicleId)));
    }
    result.costBreakdown = computeSolutionCost(
      { routes: result.routes, unassigned: result.unassigned, cost: 0, costBreakdown: result.costBreakdown },
      enriched.vehicles, depotLat, depotLon, date, config.weights ?? DEFAULT_WEIGHTS, constraints,
      config.vehicleDistributionMode ?? "minimize",
    ).breakdown;
    return { ...result, frozenRouteSnapshots: enriched.frozenRouteSnapshots };
  }));
}
