import type { Driver, Route, Stop, Vehicle } from "@workspace/db";
import { DEFAULT_WEIGHTS, optimizeWithALNS, policyToALNSConfig, resolveOptimizationPolicy } from "./alns";
import { optimizeWithPlanningLocks, OptimizerPlanningLockConflict } from "./planner-lock-aware-optimizer";
import { normalizePlanningInputs, planningWeights, routingConstraintsForDriver, toAlnsNode } from "./import-route-workflow";
import { applyDriverRoutingProfile } from "./driver-routing-profile";
import { effectivePlanningPolicy, organizationPlanningPolicy, withOrganizationPlanningPolicy } from "./planning-policy";

export class DispatchTargetOptimizationError extends Error {
  readonly statusCode: number;
  constructor(readonly code: "DISPATCH_TARGET_INFEASIBLE" | "DISPATCH_TARGET_UNAVAILABLE") {
    super(code === "DISPATCH_TARGET_INFEASIBLE"
      ? "Alla stopp ryms inte i mottagarrutten med dess planeringsvillkor. Välj färre stopp eller en annan befintlig rutt."
      : "Mottagarrutten kan inte optimeras säkert just nu. Kontrollera ruttens planeringsunderlag och vägdata och gör en ny förhandsvisning.");
    this.name = "DispatchTargetOptimizationError";
    this.statusCode = code === "DISPATCH_TARGET_INFEASIBLE" ? 409 : 503;
  }
}

export function dispatchTargetOptimizationSettings(
  organization: Parameters<typeof organizationPlanningPolicy>[0],
  snapshot: Route["optimizationPlanningSnapshot"],
  stopCount: number,
) {
  const planning = normalizePlanningInputs(snapshot);
  const policy = effectivePlanningPolicy(organization, snapshot);
  return {
    planning, policy,
    config: {
      ...policyToALNSConfig(resolveOptimizationPolicy(stopCount, 12_000)),
      timeLimitMs: 12_000,
      weights: { ...DEFAULT_WEIGHTS, ...planningWeights(planning) },
    },
  };
}

/** Locked-snapshot adapter; the canonical engine owns verified road preparation.
 * No resource creation, customer writes, or publication.
 */
export async function optimizeDispatchTarget(
  ...args: Parameters<typeof optimizeDispatchTargetSnapshot>
) {
  try {
    return await optimizeDispatchTargetSnapshot(...args);
  } catch (error) {
    if (error instanceof DispatchTargetOptimizationError) throw error;
    if (error instanceof OptimizerPlanningLockConflict) {
      throw new DispatchTargetOptimizationError("DISPATCH_TARGET_INFEASIBLE");
    }
    // Never return insertion order, rerun with relaxed rules, or expose an
    // uncontrolled engine/provider error when optimization fails.
    throw new DispatchTargetOptimizationError("DISPATCH_TARGET_UNAVAILABLE");
  }
}

async function optimizeDispatchTargetSnapshot(
  route: Route, stops: Stop[], vehicle: Vehicle, driver: Driver,
  organization: Parameters<typeof organizationPlanningPolicy>[0],
  allowWorkingHoursOverrun = false,
) {
  if (!route.depotSnapshot || route.optimizationFrozen) {
    throw new DispatchTargetOptimizationError("DISPATCH_TARGET_UNAVAILABLE");
  }
  const { planning, policy, config } = dispatchTargetOptimizationSettings(
    organization, route.optimizationPlanningSnapshot, stops.length,
  );
  const routingVehicle = withOrganizationPlanningPolicy(applyDriverRoutingProfile({
    id: vehicle.id, vehicleType: vehicle.vehicleType,
    capacityKg: vehicle.capacityKg, capacityVolume: vehicle.capacityVolume,
    rangeKm: vehicle.vehicleType === "electric" && vehicle.rangeKm != null
      ? vehicle.rangeKm * Math.max(0, Math.min(100, vehicle.currentBatteryPercent ?? 100)) / 100
      : vehicle.rangeKm,
    startLatitude: route.depotSnapshot.start.latitude,
    startLongitude: route.depotSnapshot.start.longitude,
    endLatitude: route.depotSnapshot.end.latitude,
    endLongitude: route.depotSnapshot.end.longitude,
  }, driver), policy);
  routingVehicle.driverId = driver.id;
  routingVehicle.travelReservePercent = planning.travelReservePercent;
  const result = await optimizeWithPlanningLocks({
    stops, routes: [route], vehicles: [vehicle], drivers: [driver],
    nodes: stops.map(stop => toAlnsNode(stop, planning)), routingVehicles: [routingVehicle],
  }, optimizeWithALNS, route.depotSnapshot.start.latitude, route.depotSnapshot.start.longitude,
  route.date, { ...config, driverConstraints: [{
    ...routingConstraintsForDriver(driver),
    // Explicit dispatcher consent relaxes only the shift end, not capacity,
    // driving limits, breaks, time windows, qualifications or planning locks.
    ...(allowWorkingHoursOverrun ? { preferredEndTime: "23:59:59" } : {}),
    vehicleId: vehicle.id,
  }] });
  const ids = result.routes.flatMap(item => {
    if (item.vehicleId !== vehicle.id) throw new DispatchTargetOptimizationError("DISPATCH_TARGET_UNAVAILABLE");
    return item.nodes.filter(node => !node.isChargingStation).map(node => node.id);
  });
  if (result.unassigned.length || ids.length !== stops.length || new Set(ids).size !== stops.length
    || ids.some(id => !stops.some(stop => stop.id === id))) {
    throw new DispatchTargetOptimizationError("DISPATCH_TARGET_INFEASIBLE");
  }
  return ids;
}
