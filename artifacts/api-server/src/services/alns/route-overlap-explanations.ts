import { evaluateRoute } from "./cost";
import { haversineDistance } from "./distance-cache";
import { chargingStationInsertion } from "./operators/repair";
import type { ALNSDriverConstraints, ALNSNode, ALNSRoute, ALNSVehicle } from "./types";

const NEARBY_STOP_RADIUS_KM = 10;
const MAX_ANALYZED_NEARBY_PAIRS = 250;
const MAX_NEARBY_PAIR_COMPARISONS = 50_000;
const COMPARISON_YIELD_BATCH = 64;
const INSERTION_YIELD_BATCH = 32;

export type RouteOverlapReasonCode =
  | "TIME_WINDOW"
  | "CAPACITY"
  | "SKILL"
  | "WORKING_HOURS"
  | "EV_RANGE";

export type RouteOverlapAnalysisStatus = "confirmed" | "unknown" | "incomplete";

export interface RouteOverlapScope {
  /** Only the two routes that own the nearby stops that were evaluated. */
  vehicleIds: string[];
  /** Only customer-stop IDs in the evaluated nearby pairs. */
  stopIds: string[];
}

export interface RouteOverlapExplanation {
  status: RouteOverlapAnalysisStatus;
  /**
   * Present only where the bounded counterfactual checks isolated a hard
   * constraint after both directional insertions failed.
   */
  reasonCode?: RouteOverlapReasonCode;
  message: string;
  analyzedPairCount: number;
  scope: RouteOverlapScope;
}

const REASON_MESSAGES: Record<RouteOverlapReasonCode, string> = {
  TIME_WINDOW: "I de kontrollerade närliggande stoppen blockerade tidsfönster båda prövade flyttriktningarna.",
  CAPACITY: "I de kontrollerade närliggande stoppen blockerade kapacitet båda prövade flyttriktningarna.",
  SKILL: "I de kontrollerade närliggande stoppen blockerade kompetens eller behörighet båda prövade flyttriktningarna.",
  WORKING_HOURS: "I de kontrollerade närliggande stoppen blockerade arbetstidsvillkor båda prövade flyttriktningarna.",
  EV_RANGE: "I de kontrollerade närliggande stoppen blockerade elfordonets räckvidd båda prövade flyttriktningarna.",
};
const UNKNOWN_MESSAGE =
  "Närliggande stopp kontrollerades i båda riktningarna, men ingen blockerande hård begränsning kunde fastställas för de prövade stoppen.";
const INCOMPLETE_MESSAGE =
  "Analysen av närliggande stopp nådde sin beräkningsgräns. Resultatet är ofullständigt och bekräftar ingen orsak.";

function withInsertedNode(route: ALNSRoute, node: ALNSNode, index: number): ALNSRoute {
  const nodes = [...route.nodes.slice(0, index), node, ...route.nodes.slice(index)];
  return {
    ...route,
    nodes,
    totalWeight: route.totalWeight + node.weightKg,
    totalVolume: route.totalVolume + node.volumeM3,
  };
}

function withoutTimeWindows(route: ALNSRoute): ALNSRoute {
  return {
    ...route,
    nodes: route.nodes.map((node) => ({
      ...node,
      timeWindowStart: null,
      timeWindowEnd: null,
    })),
  };
}

function unconstrainedVehicle(vehicle: ALNSVehicle): ALNSVehicle {
  return {
    ...vehicle,
    capacityKg: Number.MAX_SAFE_INTEGER,
    capacityVolume: Number.MAX_SAFE_INTEGER,
    rangeKm: null,
    ineligibleStopIds: undefined,
  };
}

function capacityRelaxedVehicle(vehicle: ALNSVehicle): ALNSVehicle {
  return {
    ...vehicle,
    capacityKg: Number.MAX_SAFE_INTEGER,
    capacityVolume: Number.MAX_SAFE_INTEGER,
  };
}

function schedulingOnlyConstraints(
  driverConstraints?: ALNSDriverConstraints,
): ALNSDriverConstraints | undefined {
  if (!driverConstraints) return undefined;
  return {
    ...driverConstraints,
    preferredEndTime: "47:59",
    maxDrivingHoursPerDay: Number.MAX_SAFE_INTEGER,
    avoidNightDriving: false,
  };
}

/**
 * The overlap explanation has a synchronous public API because it is also used
 * by the regular optimizer response. Keep the algorithm in a generator so the
 * async runner can yield without restarting an insertion scan (or changing
 * the order in which candidates are evaluated).
 */
function* everyInsertionFails(
  route: ALNSRoute,
  node: ALNSNode,
  evaluate: (candidate: ALNSRoute) => boolean,
): Generator<void, boolean, void> {
  for (let index = 0; index <= route.nodes.length; index++) {
    if (index > 0 && index % INSERTION_YIELD_BATCH === 0) yield;
    if (evaluate(withInsertedNode(route, node, index))) return false;
  }
  return true;
}

function* insertionFeasible(
  targetRoute: ALNSRoute,
  node: ALNSNode,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints?: ALNSDriverConstraints,
): Generator<void, boolean, void> {
  return !(yield* everyInsertionFails(targetRoute, node, (candidate) =>
    vehicle.vehicleType === "electric" && vehicle.rangeKm
      ? evaluateEvCandidateWithCharging(
          candidate,
          vehicle,
          depotLat,
          depotLon,
          startTime,
          driverConstraints,
        )
      : evaluateRoute(
          candidate,
          vehicle,
          depotLat,
          depotLon,
          startTime,
          driverConstraints,
        ).feasible,
  ));
}

function* blockingReasonAfterFailedActualInsertions(
  targetRoute: ALNSRoute,
  node: ALNSNode,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints?: ALNSDriverConstraints,
): Generator<void, RouteOverlapReasonCode | null, void> {
  // Always perform the real insertion evaluation first. A capacity, skill, or
  // range precheck is not evidence that every insertion position is invalid.
  if (yield* insertionFeasible(targetRoute, node, vehicle, depotLat, depotLon, startTime, driverConstraints)) {
    return null;
  }

  if (yield* insertionFeasible(
    targetRoute,
    node,
    capacityRelaxedVehicle(vehicle),
    depotLat,
    depotLon,
    startTime,
    driverConstraints,
  )) {
    return "CAPACITY";
  }

  if (
    vehicle.ineligibleStopIds?.has(node.id) &&
    (yield* insertionFeasible(
      targetRoute,
      node,
      { ...vehicle, ineligibleStopIds: undefined },
      depotLat,
      depotLon,
      startTime,
      driverConstraints,
    ))
  ) {
    return "SKILL";
  }

  if (
    (yield* insertionFeasible(
      withoutTimeWindows(targetRoute),
      { ...node, timeWindowStart: null, timeWindowEnd: null },
      vehicle,
      depotLat,
      depotLon,
      startTime,
      driverConstraints,
    ))
  ) {
    return "TIME_WINDOW";
  }

  if (
    driverConstraints &&
    (yield* insertionFeasible(
      targetRoute,
      node,
      vehicle,
      depotLat,
      depotLon,
      startTime,
      schedulingOnlyConstraints(driverConstraints),
    ))
  ) {
    return "WORKING_HOURS";
  }

  if (
    vehicle.vehicleType === "electric" &&
    vehicle.rangeKm &&
    (yield* insertionFeasible(
      targetRoute,
      node,
      { ...vehicle, rangeKm: null },
      depotLat,
      depotLon,
      startTime,
      driverConstraints,
    ))
  ) {
    return "EV_RANGE";
  }

  return null;
}

function evaluateEvCandidateWithCharging(
  candidate: ALNSRoute,
  vehicle: ALNSVehicle,
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints?: ALNSDriverConstraints,
): boolean {
  const route = {
    ...candidate,
    nodes: candidate.nodes.map((node) => ({ ...node })),
  };
  chargingStationInsertion(
    {
      routes: [route],
      unassigned: [],
      cost: 0,
      costBreakdown: {
        distanceCost: 0,
        co2Cost: 0,
        etaPrecisionCost: 0,
        driverPenaltyCost: 0,
        geographicCohesionCost: 0,
        totalDistanceKm: 0,
        totalCo2Kg: 0,
        totalTimeWindowSlackMin: 0,
        totalDriverPenalty: 0,
      },
    },
    [vehicle],
    depotLat,
    depotLon,
    startTime,
  );
  return evaluateRoute(
    route,
    vehicle,
    depotLat,
    depotLon,
    startTime,
    driverConstraints,
  ).feasible;
}

function* explainGeographicRouteOverlapCore(
  routes: ALNSRoute[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints: ALNSDriverConstraints[],
): Generator<void, Map<string, RouteOverlapExplanation>, void> {
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const constraintsByVehicleId = new Map(
    driverConstraints.map((constraints) => [constraints.vehicleId, constraints]),
  );
  const evidenceByVehicleId = new Map<
    string,
    {
      reasonCounts: Map<RouteOverlapReasonCode, number>;
      vehicleIds: Set<string>;
      stopIds: Set<string>;
      analyzedPairCount: number;
      hasUnknownPair: boolean;
    }
  >();

  const recordPair = (
    vehicleId: string,
    otherVehicleId: string,
    stopId: string,
    otherStopId: string,
    reason: RouteOverlapReasonCode | null,
  ) => {
    const evidence = evidenceByVehicleId.get(vehicleId) ?? {
      reasonCounts: new Map<RouteOverlapReasonCode, number>(),
      vehicleIds: new Set<string>(),
      stopIds: new Set<string>(),
      analyzedPairCount: 0,
      hasUnknownPair: false,
    };
    evidence.vehicleIds.add(vehicleId);
    evidence.vehicleIds.add(otherVehicleId);
    evidence.stopIds.add(stopId);
    evidence.stopIds.add(otherStopId);
    evidence.analyzedPairCount += 1;
    if (reason) evidence.reasonCounts.set(reason, (evidence.reasonCounts.get(reason) ?? 0) + 1);
    else evidence.hasUnknownPair = true;
    evidenceByVehicleId.set(vehicleId, evidence);
  };

  const assignedNodes = routes.flatMap((route) =>
    route.nodes
      .filter((node) => !node.isChargingStation)
      .map((node) => ({ route, node })),
  ).sort((left, right) => left.node.latitude - right.node.latitude);
  const latitudeRadiusDegrees = NEARBY_STOP_RADIUS_KM / 111.32;
  let analyzedPairs = 0;
  let comparisons = 0;
  let budgetExhausted = false;

  outer: for (let index = 0; index < assignedNodes.length; index++) {
    const { route, node } = assignedNodes[index];
    for (let candidateIndex = index + 1; candidateIndex < assignedNodes.length; candidateIndex++) {
      const { route: otherRoute, node: otherNode } = assignedNodes[candidateIndex];
      if (otherNode.latitude - node.latitude >= latitudeRadiusDegrees) break;
      if (++comparisons > MAX_NEARBY_PAIR_COMPARISONS) {
        budgetExhausted = true;
        break outer;
      }
      if (comparisons % COMPARISON_YIELD_BATCH === 0) yield;
      if (route.vehicleId === otherRoute.vehicleId) continue;
      if (
        haversineDistance(
          node.latitude,
          node.longitude,
          otherNode.latitude,
          otherNode.longitude,
        ) >= NEARBY_STOP_RADIUS_KM
      ) continue;

      const otherVehicle = vehicleById.get(otherRoute.vehicleId);
      let reasonForOtherRoute: RouteOverlapReasonCode | null = null;
      if (otherVehicle) {
        reasonForOtherRoute = yield* blockingReasonAfterFailedActualInsertions(
          otherRoute,
          node,
          otherVehicle,
          depotLat,
          depotLon,
          startTime,
          constraintsByVehicleId.get(otherRoute.vehicleId),
        );
      }

      const routeVehicle = vehicleById.get(route.vehicleId);
      let reasonForRoute: RouteOverlapReasonCode | null = null;
      if (routeVehicle) {
        reasonForRoute = yield* blockingReasonAfterFailedActualInsertions(
          route,
          otherNode,
          routeVehicle,
          depotLat,
          depotLon,
          startTime,
          constraintsByVehicleId.get(route.vehicleId),
        );
      }

      // A confirmed explanation requires failed actual insertion checks in
      // both directions. A feasible direction merely makes the pair unknown:
      // it never proves that an entire area can be consolidated or improved.
      // A route-level reason is only safe to show for this pair if the same
      // constraint was isolated in both transfer directions. For example,
      // "A cannot take B because of capacity" and "B cannot take A because
      // of skills" is not proof that either route is split for one shared
      // reason.
      if (
        reasonForRoute &&
        reasonForOtherRoute &&
        reasonForRoute === reasonForOtherRoute
      ) {
        recordPair(
          route.vehicleId,
          otherRoute.vehicleId,
          node.id,
          otherNode.id,
          reasonForRoute,
        );
        recordPair(
          otherRoute.vehicleId,
          route.vehicleId,
          otherNode.id,
          node.id,
          reasonForOtherRoute,
        );
      } else {
        recordPair(route.vehicleId, otherRoute.vehicleId, node.id, otherNode.id, null);
        recordPair(otherRoute.vehicleId, route.vehicleId, otherNode.id, node.id, null);
      }

      if (++analyzedPairs >= MAX_ANALYZED_NEARBY_PAIRS) {
        budgetExhausted = true;
        break outer;
      }
    }
  }

  const explanations = new Map<string, RouteOverlapExplanation>();
  for (const [vehicleId, evidence] of evidenceByVehicleId) {
    const primaryReason = [...evidence.reasonCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    // A route-level message represents all pair scope carried with it. Do not
    // choose a majority reason across different confirmed pairs; that would
    // overclaim for the stops with another (or no established) blocker.
    const status: RouteOverlapAnalysisStatus = budgetExhausted
      ? "incomplete"
      : primaryReason &&
          !evidence.hasUnknownPair &&
          evidence.reasonCounts.size === 1
        ? "confirmed"
        : "unknown";
    explanations.set(vehicleId, {
      status,
      ...(status === "confirmed" && primaryReason ? { reasonCode: primaryReason } : {}),
      message:
        status === "confirmed" && primaryReason
          ? REASON_MESSAGES[primaryReason]
          : status === "incomplete"
            ? INCOMPLETE_MESSAGE
            : UNKNOWN_MESSAGE,
      analyzedPairCount: evidence.analyzedPairCount,
      scope: {
        vehicleIds: [...evidence.vehicleIds].sort(),
        stopIds: [...evidence.stopIds].sort(),
      },
    });
  }
  return explanations;
}

function runOverlapExplanationSync(
  routes: ALNSRoute[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints: ALNSDriverConstraints[],
): Map<string, RouteOverlapExplanation> {
  const iterator = explainGeographicRouteOverlapCore(
    routes,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    driverConstraints,
  );
  while (true) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}

export function explainGeographicRouteOverlap(
  routes: ALNSRoute[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints: ALNSDriverConstraints[],
): Map<string, RouteOverlapExplanation> {
  return runOverlapExplanationSync(
    routes,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    driverConstraints,
  );
}

export async function explainGeographicRouteOverlapAsync(
  routes: ALNSRoute[],
  vehicles: ALNSVehicle[],
  depotLat: number,
  depotLon: number,
  startTime: Date,
  driverConstraints: ALNSDriverConstraints[],
): Promise<Map<string, RouteOverlapExplanation>> {
  const iterator = explainGeographicRouteOverlapCore(
    routes,
    vehicles,
    depotLat,
    depotLon,
    startTime,
    driverConstraints,
  );
  while (true) {
    const step = iterator.next();
    if (step.done) return step.value;
    // A macrotask, rather than a resolved promise, lets HTTP heartbeats and
    // timers run while a large comparison/insertion scan is in progress.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}