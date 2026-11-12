import { and, eq, inArray, sql } from "drizzle-orm";
import { applyStopSelection, readStopSelection } from "./execution-stop-selection";
import {
  db, routesTable, stopsTable, routeDispatchSnapshotsTable, routeExecutionsTable, driversTable,
  type Route, type Stop, type Vehicle, type Driver,
} from "@workspace/db";

export type OutgoingDatabase = Pick<typeof db, "select">;
export class OutgoingVersionError extends Error {
  readonly statusCode = 409;
  readonly code = "OUTGOING_REVIEW_REQUIRED";
}

const runtimeStopKeys = [
  "status", "terminalAt", "skipReason", "skipComment", "actualDurationMin", "executionComment",
] as const;
const stopDateKeys = [
  "timeWindowStart", "timeWindowEnd", "slaDeadline", "planningDate", "assignmentOverrideAt",
  "lockedServiceStartAt", "terminalAt", "archivedAt", "createdAt",
] as const;

/** No legacy reconstruction: an operational projection requires authentic evidence. */
export async function outgoingRoute(
  route: Route, database: OutgoingDatabase = db,
): Promise<Route> {
  if (route.dispatchSnapshotVersion == null || route.handoffVersion == null) {
    throw new OutgoingVersionError("Äldre utskick saknar verifierad ögonblicksbild. Granska arbetsplanen och skicka den på nytt till föraren.");
  }
  const [snapshot] = await database.select().from(routeDispatchSnapshotsTable).where(and(
    eq(routeDispatchSnapshotsTable.organizationId, route.organizationId),
    eq(routeDispatchSnapshotsTable.routeId, route.id),
    eq(routeDispatchSnapshotsTable.planRevision, route.handoffVersion),
  ));
  const [recipient] = route.handoffDriverId ? await database.select({ id: driversTable.id }).from(driversTable).where(and(
    eq(driversTable.id, route.handoffDriverId), eq(driversTable.organizationId, route.organizationId),
    eq(driversTable.isActive, true),
  )) : [];
  if (!recipient || !snapshot || snapshot.driverId !== route.handoffDriverId
    || snapshot.planRevision !== route.dispatchSnapshotVersion
    || snapshot.route.__snapshotSchema !== 2) {
    throw new OutgoingVersionError("Utskicksbeviset är ofullständigt. Granska och skicka en ny version; arbetsvärden används inte som ersättning.");
  }
  const [execution] = await database.select({ status: routeExecutionsTable.status, summary: routeExecutionsTable.summary }).from(routeExecutionsTable).where(and(
    eq(routeExecutionsTable.organizationId, route.organizationId),
    eq(routeExecutionsTable.routeId, route.id), eq(routeExecutionsTable.planVersion, snapshot.planRevision),
  )).limit(1);
  const { __snapshotSchema: _schema, ...planning } = snapshot.route;
  const [firstStop] = planning.lockedFirstStopId ? await database.select({ status: stopsTable.status }).from(stopsTable).where(and(
    eq(stopsTable.id, String(planning.lockedFirstStopId)), eq(stopsTable.organizationId, route.organizationId),
  )) : [];
  const result = {
    ...planning,
    id: route.id, organizationId: route.organizationId,
    planRevision: snapshot.planRevision,
    dispatchSnapshotVersion: snapshot.planRevision,
    date: new Date(planning.date as string),
    createdAt: new Date(planning.createdAt as string),
    updatedAt: route.updatedAt,
    status: route.status === "cancelled" ? "cancelled"
      : (route.status === "completed" && route.planRevision === snapshot.planRevision)
        || (execution?.status === "ended" && execution.summary?.pendingStops === 0) ? "completed" : "in_progress",
    // Receipt/acceptance and execution facts are live, never copied back from
    // an immutable planning snapshot.
    handoffStatus: route.handoffStatus, handoffVersion: route.handoffVersion,
    handoffDriverId: snapshot.driverId, sentAt: route.sentAt, receivedAt: route.receivedAt,
    openedAt: route.openedAt, acceptedAt: route.acceptedAt, rejectedAt: route.rejectedAt,
    rejectionReason: route.rejectionReason, executionProjection: route.executionProjection,
    redistributionSuggestion: route.redistributionSuggestion,
    lockedFirstStopId: firstStop && ["completed", "failed", "skipped"].includes(firstStop.status) ? null : planning.lockedFirstStopId,
  } as Route;
  const stops = await outgoingStops(result, database, false);
  const selection = await readStopSelection(result, stops, database);
  result.executionProjection = {
    generatedAt: new Date().toISOString(), deviationMin: 0, expectedFinishAt: null,
    depotReturnAt: null, overtimeRisk: false, overtimeMin: 0, remainingEtas: [],
    ...result.executionProjection,
    selectionRevision: selection.revision, activeStopId: selection.activeStopId,
    selectionChangedAt: selection.changedAt,
    ...(selection.changedAt ? {
      remainingEtas: [], expectedFinishAt: null, depotReturnAt: null,
      etaUnavailableReason: "Körordningen har ändrats. Planerade tider är inte aktuella ETA-värden.",
    } : {}),
  };
  return result;
}

export async function outgoingStops(route: Route, database: OutgoingDatabase = db, applySelection = true): Promise<Stop[]> {
  const [snapshot] = await database.select().from(routeDispatchSnapshotsTable).where(and(
    eq(routeDispatchSnapshotsTable.organizationId, route.organizationId),
    eq(routeDispatchSnapshotsTable.routeId, route.id),
    eq(routeDispatchSnapshotsTable.planRevision, route.planRevision),
  ));
  if (!snapshot || snapshot.route.__snapshotSchema !== 2) {
    throw new OutgoingVersionError("Utskickade uppdrag saknar verifierad ögonblicksbild. Granska och skicka en ny version.");
  }
  const ids = snapshot.stops.map((stop) => String(stop.id));
  const actual = ids.length ? await database.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, route.organizationId), inArray(stopsTable.id, ids),
  )) : [];
  const byId = new Map(actual.map((stop) => [stop.id, stop]));
  const stops = snapshot.stops.map((planning) => {
    const fact = byId.get(String(planning.id));
    if (!fact) throw new OutgoingVersionError("Ett utskickat uppdrag saknas. Ingen arbetskopia används som ersättning.");
    const stop = { ...planning, routeId: route.id } as unknown as Stop;
    for (const key of runtimeStopKeys) (stop as any)[key] = fact[key];
    if (["completed", "failed", "skipped"].includes(fact.status)) {
      stop.lockedVehicleId = null; stop.lockedDriverId = null; stop.lockedServiceStartAt = null;
    }
    for (const key of stopDateKeys) {
      if (stop[key] != null) (stop as any)[key] = new Date(stop[key] as unknown as string);
    }
    return stop;
  }).sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0));
  if (!applySelection) return stops;
  const selection = await readStopSelection(route, stops, database);
  return applyStopSelection(stops, selection.activeStopId);
}

export async function outgoingRoutesForDriver(organizationId: string, driverId: string, database: OutgoingDatabase = db) {
  const rows = await database.select().from(routesTable).where(and(
    eq(routesTable.organizationId, organizationId), eq(routesTable.handoffDriverId, driverId),
    sql`${routesTable.handoffVersion} IS NOT NULL`,
  ));
  return Promise.all(rows.map((route) => outgoingRoute(route, database)));
}

export const PLANNER_OUTGOING_SCOPE_LIMIT = 100;
export interface PlannerOutgoingRouteResources {
  outgoingVersion: number;
  /** Immutable approved resource records, not current profile/linkage reads. */
  vehicle: Vehicle;
  driver: Driver;
}

function approvedPlannerResources(route: Route): PlannerOutgoingRouteResources {
  const evidence = route as unknown as { __vehicle?: Vehicle; __driver?: Driver };
  const vehicle = evidence.__vehicle;
  const driver = evidence.__driver;
  if (!vehicle || !driver || vehicle.id !== route.vehicleId || driver.id !== route.handoffDriverId
    || driver.vehicleId !== vehicle.id || vehicle.organizationId !== route.organizationId
    || driver.organizationId !== route.organizationId
    || typeof vehicle.name !== "string" || typeof vehicle.routeColor !== "string"
    || typeof driver.name !== "string") {
    throw new OutgoingVersionError("Utskicket saknar entydigt godkänt fordon–förarpar. Granska och skicka en ny version; aktuell arbetskoppling används inte som ersättning.");
  }
  return { outgoingVersion: route.planRevision, vehicle, driver };
}

export class PlannerOutgoingScopeError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

/**
 * One repeatable, read-only operational view for exactly the planner's selected
 * route IDs. Never return a successful subset if any dispatched route fails.
 */
export async function plannerOutgoingView(organizationId: string, requestedRouteIds: readonly string[]) {
  const routeIds = [...new Set(requestedRouteIds)];
  if (!routeIds.length || requestedRouteIds.length > PLANNER_OUTGOING_SCOPE_LIMIT) {
    throw new PlannerOutgoingScopeError(
      `Välj 1–${PLANNER_OUTGOING_SCOPE_LIMIT} rutter för livevyn. Ingen delmängd har lästs in.`,
      400, "OUTGOING_SCOPE_INVALID",
    );
  }
  return db.transaction(async (tx) => {
    const workingRoutes = await tx.select().from(routesTable).where(and(
      eq(routesTable.organizationId, organizationId), inArray(routesTable.id, routeIds),
    ));
    if (workingRoutes.length !== routeIds.length) {
      throw new PlannerOutgoingScopeError(
        "En eller flera valda rutter finns inte i den aktuella organisationen. Läs in urvalet igen.",
        404, "OUTGOING_SCOPE_NOT_FOUND",
      );
    }
    const byId = new Map(workingRoutes.map((route) => [route.id, route]));
    const routes: Route[] = [];
    const stops: Stop[] = [];
    const omittedRouteIds: string[] = [];
    const perRouteResources: Record<string, PlannerOutgoingRouteResources> = {};
    const stopIds = new Set<string>();
    for (const id of routeIds) {
      const workingRoute = byId.get(id)!;
      if (workingRoute.handoffVersion == null && workingRoute.handoffDriverId == null
        && workingRoute.handoffStatus === "pending") {
        omittedRouteIds.push(id); // No current handoff, not a fabricated legacy view.
        continue;
      }
      try {
        const route = await outgoingRoute(workingRoute, tx);
        const resources = approvedPlannerResources(route);
        const routeStops = await outgoingStops(route, tx);
        if (routeStops.some((stop) => stopIds.has(stop.id))) {
          throw new OutgoingVersionError("Ett uppdrag ingår i flera aktuella utskick. Granska utskicken före fortsatt användning av livevyn.");
        }
        routes.push(route);
        perRouteResources[id] = resources;
        for (const stop of routeStops) { stopIds.add(stop.id); stops.push(stop); }
      } catch (error) {
        if (error instanceof OutgoingVersionError) Object.assign(error, { routeId: id });
        throw error;
      }
    }
    return { routes, stops, omittedRouteIds, perRouteResources };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Locate membership by the outgoing snapshot, never working stop.routeId. */
export async function outgoingStopContext(
  organizationId: string, stopId: string, driverId: string | null,
  database: OutgoingDatabase = db,
  expectedRouteId?: string,
) {
  const candidates = await database.select({ route: routesTable }).from(routesTable)
    .innerJoin(routeDispatchSnapshotsTable, and(
      eq(routeDispatchSnapshotsTable.routeId, routesTable.id),
      eq(routeDispatchSnapshotsTable.organizationId, routesTable.organizationId),
      eq(routeDispatchSnapshotsTable.planRevision, routesTable.handoffVersion),
    )).where(and(
      eq(routesTable.organizationId, organizationId),
      ...(driverId ? [eq(routesTable.handoffDriverId, driverId)] : []),
      ...(expectedRouteId ? [eq(routesTable.id, expectedRouteId)] : []),
      sql`${routeDispatchSnapshotsTable.stops} @> ${JSON.stringify([{ id: stopId }])}::jsonb`,
    ));
  if (candidates.length !== 1) {
    throw new OutgoingVersionError("Uppdraget saknar entydig aktuell utskicksversion för denna förare. Granska och skicka på nytt.");
  }
  const route = await outgoingRoute(candidates[0]!.route, database);
  const stop = (await outgoingStops(route, database)).find((candidate) => candidate.id === stopId);
  if (!stop) throw new OutgoingVersionError("Uppdraget ingår inte i aktuell utskicksversion.");
  return { route, stop };
}
