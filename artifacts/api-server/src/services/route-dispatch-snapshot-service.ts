import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, routeDispatchSnapshotsTable, routesTable, stopsTable, vehiclesTable, driversTable, executionEventsTable, type Route, type Stop } from "@workspace/db";
import { PlanningLockError } from "./planning-lock-service";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const stable = (value: unknown): string => JSON.stringify(value, (_key, child) =>
  child && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

/** A proposed dispatch cannot move/rewrite any already executed outgoing segment. */
export async function assertOutgoingDispatchCompatible(tx: Transaction, route: Route, proposed: Stop[]) {
  const ids = proposed.map((stop) => stop.id);
  if (ids.length) {
    const overlapping = await tx.select({ id: routesTable.id }).from(routesTable)
      .innerJoin(routeDispatchSnapshotsTable, and(
        eq(routeDispatchSnapshotsTable.routeId, routesTable.id),
        eq(routeDispatchSnapshotsTable.organizationId, routesTable.organizationId),
        eq(routeDispatchSnapshotsTable.planRevision, routesTable.handoffVersion),
      )).where(and(
        eq(routesTable.organizationId, route.organizationId), ne(routesTable.id, route.id),
        ne(routesTable.status, "cancelled"),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${routeDispatchSnapshotsTable.stops}) entry
          WHERE entry->>'id' IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)))`,
      )).limit(1);
    if (overlapping.length) {
      throw new PlanningLockError("Uppdrag ingår fortfarande i en annan utskickad rutt. Granska och skicka källruttens nya version först.");
    }
    const foreignFacts = await tx.select({ id: executionEventsTable.id }).from(executionEventsTable).where(and(
      eq(executionEventsTable.organizationId, route.organizationId),
      inArray(executionEventsTable.stopId, ids), ne(executionEventsTable.routeId, route.id),
    )).limit(1);
    if (foreignFacts.length) throw new PlanningLockError("Arbetsförslaget innehåller utförd historik från en annan rutt. Granska förslaget före utskick.");
  }
  if (route.dispatchSnapshotVersion == null) return;
  const [previous] = await tx.select().from(routeDispatchSnapshotsTable).where(and(
    eq(routeDispatchSnapshotsTable.organizationId, route.organizationId),
    eq(routeDispatchSnapshotsTable.routeId, route.id),
    eq(routeDispatchSnapshotsTable.planRevision, route.dispatchSnapshotVersion),
  ));
  if (!previous) throw new PlanningLockError("Tidigare utskicksbevis saknas. Granska historiken före nytt utskick.");
  const priorIds = previous.stops.map((stop) => String(stop.id));
  const actual = priorIds.length ? await tx.select().from(stopsTable).where(and(
    eq(stopsTable.organizationId, route.organizationId), inArray(stopsTable.id, priorIds),
  )).for("update") : [];
  if (actual.length !== priorIds.length) throw new PlanningLockError("Utskicksbevisets uppdrag saknar aktuell faktarad. Granska historiken innan ny version skickas.");
  const material = (stop: Record<string, unknown>) => {
    const { lockedVehicleId: _vehicle, lockedDriverId: _driver, lockedServiceStartAt: _time,
      assignmentOverrideAt: _override, assignmentOverrideReasonCodes: _codes, ...rest } = stop;
    return rest;
  };
  for (const fact of actual.filter((stop) => stop.status !== "pending")) {
    const before = previous.stops.find((stop) => stop.id === fact.id)!;
    const after = proposed.find((stop) => stop.id === fact.id);
    if (!after || stable(material(before)) !== stable(material(stopPlanningEvidence(after)))) {
      throw new PlanningLockError("Arbetsförslaget flyttar eller ändrar ett aktivt/utfört utskickat uppdrag. Historiken måste bevaras.");
    }
    const beforeItinerary = (previous.route.plannerItinerary as Array<{ stopId?: string }> | null)?.filter((entry) => entry.stopId === fact.id) ?? [];
    const afterItinerary = route.plannerItinerary?.filter((entry) => entry.stopId === fact.id) ?? [];
    const beforeTimeline = (previous.route.workdayTimeline as Array<{ stopId?: string }> | null)?.filter((entry) => entry.stopId === fact.id) ?? [];
    const afterTimeline = route.workdayTimeline?.filter((entry) => entry.stopId === fact.id) ?? [];
    // A remaining-work proposal may omit already fulfilled timeline anchors.
    // The original planned time remains immutable in its dispatched version;
    // replacing that anchor with a different time/order is not permitted.
    const active = fact.status === "in_progress";
    if (((active || afterItinerary.length > 0) && stable(beforeItinerary) !== stable(afterItinerary))
      || ((active || afterTimeline.length > 0) && stable(beforeTimeline) !== stable(afterTimeline))) {
      throw new PlanningLockError("Arbetsförslaget skriver om planerad ordning/tid för en aktiv eller utförd del. Bevara utskickad historik före godkännande.");
    }
  }
}

function routePlanningEvidence(route: Route): Record<string, unknown> {
  const {
    handoffStatus: _handoffStatus, handoffVersion: _handoffVersion, handoffDriverId: _handoffDriverId,
    sentAt: _sentAt, receivedAt: _receivedAt, openedAt: _openedAt, acceptedAt: _acceptedAt,
    rejectedAt: _rejectedAt, rejectionReason: _reason, executionProjection: _projection,
    redistributionSuggestion: _suggestion, updatedAt: _updatedAt, dispatchSnapshotVersion: _snapshotVersion,
    ...planning
  } = route;
  return JSON.parse(JSON.stringify({ ...planning, __snapshotSchema: 2 }));
}

function stopPlanningEvidence(stop: Stop): Record<string, unknown> {
  const {
    status: _status, terminalAt: _terminalAt, skipReason: _skipReason,
    skipComment: _skipComment, actualDurationMin: _actualDurationMin,
    executionComment: _executionComment, ...planning
  } = stop;
  return JSON.parse(JSON.stringify(planning));
}

/** Called only after atomic approval/recipient checks in canonical dispatch. */
export async function captureRouteDispatchSnapshot(
  tx: Transaction, route: Route, stops: Stop[], driverId: string, capturedAt: Date,
) {
  const [vehicle] = route.vehicleId ? await tx.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.id, route.vehicleId), eq(vehiclesTable.organizationId, route.organizationId),
  )) : [];
  const [driver] = await tx.select().from(driversTable).where(and(
    eq(driversTable.id, driverId), eq(driversTable.organizationId, route.organizationId),
  ));
  const routeEvidence = {
    ...routePlanningEvidence(route),
    __vehicle: vehicle ? JSON.parse(JSON.stringify(vehicle)) : null,
    __driver: driver ? JSON.parse(JSON.stringify(driver)) : null,
  };
  const stopEvidence = [...stops].sort((a, b) => a.id.localeCompare(b.id)).map(stopPlanningEvidence);
  const [existing] = await tx.select().from(routeDispatchSnapshotsTable).where(and(
    eq(routeDispatchSnapshotsTable.routeId, route.id),
    eq(routeDispatchSnapshotsTable.organizationId, route.organizationId),
    eq(routeDispatchSnapshotsTable.planRevision, route.planRevision),
  ));
  if (existing) {
    // PostgreSQL jsonb key order is canonical, not JS insertion order.
    if (existing.driverId !== driverId
      || stable(existing.route) !== stable(routeEvidence)
      || stable(existing.stops) !== stable(stopEvidence)) {
      throw new PlanningLockError("Utskicksversionen har redan en annan ögonblicksbild. Skapa och godkänn en ny planversion.");
    }
  } else {
    await tx.insert(routeDispatchSnapshotsTable).values({
      routeId: route.id, organizationId: route.organizationId,
      planRevision: route.planRevision, driverId, capturedAt,
      route: routeEvidence, stops: stopEvidence,
    });
  }
  await tx.update(routesTable).set({ dispatchSnapshotVersion: route.planRevision }).where(and(
    eq(routesTable.id, route.id), eq(routesTable.organizationId, route.organizationId),
    eq(routesTable.planRevision, route.planRevision),
  ));
  return { ...route, dispatchSnapshotVersion: route.planRevision };
}

export async function getRouteDispatchSnapshot(organizationId: string, routeId: string) {
  const [route] = await db.select().from(routesTable).where(and(
    eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId),
  ));
  if (!route) return null;
  if (route.dispatchSnapshotVersion == null) {
    throw new PlanningLockError("Rutten saknar en autentisk utskickad ögonblicksbild. Äldre utskick återskapas inte från arbetsversionen.");
  }
  const [snapshot] = await db.select().from(routeDispatchSnapshotsTable).where(and(
    eq(routeDispatchSnapshotsTable.routeId, routeId),
    eq(routeDispatchSnapshotsTable.organizationId, organizationId),
    eq(routeDispatchSnapshotsTable.planRevision, route.dispatchSnapshotVersion),
  ));
  if (!snapshot) throw new PlanningLockError("Den utskickade ögonblicksbilden saknas. Arbetsversionen används inte som ersättning.");
  return snapshot;
}
