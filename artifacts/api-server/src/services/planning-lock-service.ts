import { and, eq, isNull, sql } from "drizzle-orm";
import { db, routesTable, stopsTable, driversTable, vehiclesTable, driverCertificationsTable, organizationsTable, routePlanApprovalsTable, auditLogTable } from "@workspace/db";
import { SetRoutePlanningLocksBody } from "@workspace/api-zod";
import type { z } from "zod";
import { broadcastDataChange } from "./realtime";
import { evaluateRequestedRouteServiceStart, ImportRouteWorkflowError } from "./import-route-workflow";
import { plannedServiceStartForStop } from "./route-workday";
import { invalidatedRouteHandoff } from "./route-acknowledgement-service";

export class PlanningLockError extends Error {
  statusCode = 409;
  code = "PLANNING_LOCK_CONFLICT";
}

export async function setRoutePlanningLocks(
  organizationId: string,
  routeId: string,
  input: z.infer<typeof SetRoutePlanningLocksBody>,
  actor: { userId?: string | null; userEmail?: string | null } = {},
) {
  // Expensive road preparation/evaluation is deliberately outside row locks.
  // The exact snapshots below are compared again inside the atomic write.
  let requestedEvaluation: Awaited<ReturnType<typeof evaluateRequestedRouteServiceStart>> | undefined;
  if (input.serviceStartAt != null) {
    const instant = new Date(input.serviceStartAt);
    // HTTP boundary validates explicit offset before generated Zod coerces Date.
    if (!Number.isFinite(instant.getTime()) || instant.getTime() % 60_000 !== 0) {
      throw new PlanningLockError("Ange en explicit ISO-tid på exakt minut med tidszon. Toleransen är noll sekunder.");
    }
    const [original] = await db.select().from(routesTable).where(and(
      eq(routesTable.organizationId, organizationId), eq(routesTable.id, routeId),
    ));
    if (!original) return null;
    if (original.planRevision !== input.planRevision) throw new PlanningLockError("Planversionen har ändrats. Ladda om.");
    const [originalStop] = input.stopId ? await db.select().from(stopsTable).where(and(
      eq(stopsTable.organizationId, organizationId), eq(stopsTable.id, input.stopId), eq(stopsTable.routeId, routeId),
      isNull(stopsTable.archivedAt),
    )) : [];
    if (!originalStop || originalStop.status !== "pending") throw new PlanningLockError("Välj ett väntande uppdrag på samma rutt.");
    if (originalStop.lockedServiceStartAt && originalStop.lockedServiceStartAt.getTime() !== instant.getTime()) {
      throw new PlanningLockError("Lås upp befintligt tidslås innan det ersätts.");
    }
    const actual = plannedServiceStartForStop(original.workdayTimeline, originalStop.id);
    if (!actual || new Date(actual).getTime() !== instant.getTime()) {
      try {
        requestedEvaluation = await evaluateRequestedRouteServiceStart(organizationId, routeId,
          input.planRevision, originalStop.id, instant);
      } catch (error) {
        if (error instanceof ImportRouteWorkflowError) throw new PlanningLockError(error.message);
        throw error;
      }
    }
  }
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`);
    const [route] = await tx.select().from(routesTable).where(and(
      eq(routesTable.organizationId, organizationId), eq(routesTable.id, routeId),
    )).for("update");
    if (!route) return null;
    if (route.planRevision !== input.planRevision) {
      throw new PlanningLockError("Planversionen har ändrats. Ladda om innan du ändrar lås.");
    }
    if (["completed", "cancelled"].includes(route.status)) {
      throw new PlanningLockError("Avslutad rutthistorik kan inte ändras.");
    }
    const stopLockRequested = input.resourcePair !== undefined || input.serviceStartAt !== undefined;
    if (stopLockRequested && !input.stopId) {
      throw new PlanningLockError("Välj ett uppdrag för resurs- eller tidslås.");
    }
    if (!stopLockRequested && input.frozen === undefined) {
      throw new PlanningLockError("Begäran innehåller ingen låsändring.");
    }
    const [stop] = input.stopId
      ? await tx.select().from(stopsTable).where(and(
        eq(stopsTable.id, input.stopId), eq(stopsTable.organizationId, organizationId),
        eq(stopsTable.routeId, routeId), isNull(stopsTable.archivedAt),
      )).for("update")
      : [];
    if (input.stopId && (!stop || stop.status !== "pending")) {
      throw new PlanningLockError("Lås kan bara ändras för väntande, oarkiverade uppdrag på samma rutt.");
    }
    if (requestedEvaluation) {
      const preview = requestedEvaluation;
      const currentStops = await tx.select().from(stopsTable).where(and(
        eq(stopsTable.organizationId, organizationId), eq(stopsTable.routeId, routeId), isNull(stopsTable.archivedAt),
      )).orderBy(stopsTable.sequenceOrder).for("update");
      const [currentVehicle] = await tx.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.id, preview.vehicle.id),
      )).for("update");
      const [currentDriver] = await tx.select().from(driversTable).where(and(
        eq(driversTable.organizationId, organizationId), eq(driversTable.id, preview.driver.id),
      )).for("update");
      const certifications = await tx.select().from(driverCertificationsTable).where(and(
        eq(driverCertificationsTable.organizationId, organizationId), eq(driverCertificationsTable.driverId, preview.driver.id),
      )).orderBy(driverCertificationsTable.id).for("update");
      const [organization] = await tx.select().from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId)).for("update");
      if (JSON.stringify(route) !== JSON.stringify(preview.sourceRouteSnapshot)
        || JSON.stringify(currentStops) !== JSON.stringify(preview.stops)
        || JSON.stringify(currentVehicle) !== JSON.stringify(preview.vehicle)
        || JSON.stringify(currentDriver) !== JSON.stringify(preview.driver)
        || JSON.stringify(certifications) !== JSON.stringify(preview.driverCertifications)
        || JSON.stringify(organization) !== JSON.stringify(preview.organization)) {
        throw new PlanningLockError("Rutten, uppdragen eller resurserna ändrades medan tidslåset beräknades. Ladda om.");
      }
    }
    if (input.frozen && (!route.workdayTimeline?.length || !route.plannerItinerary?.length)) {
      throw new PlanningLockError("Rutten saknar en auktoritativ planerad tidslinje. Beräkna planen före frysning.");
    }
    let frozenDriverId = route.frozenDriverId;
    if (input.frozen || input.resourcePair) {
      if (!route.vehicleId) throw new PlanningLockError("Rutten saknar ett fordons–förarpar.");
      const pairs = await tx.select({ driver: driversTable }).from(driversTable)
        .innerJoin(vehiclesTable, and(
          eq(vehiclesTable.id, driversTable.vehicleId), eq(vehiclesTable.organizationId, organizationId),
          eq(vehiclesTable.isActive, true),
        )).where(and(
          eq(driversTable.organizationId, organizationId), eq(driversTable.vehicleId, route.vehicleId),
          eq(driversTable.isActive, true),
          ...(input.resourcePair ? [eq(driversTable.id, input.resourcePair.driverId)] : []),
        )).for("update");
      if (pairs.length !== 1 || (input.resourcePair && input.resourcePair.vehicleId !== route.vehicleId)) {
        throw new PlanningLockError("Välj ett entydigt aktivt fordons–förarpar som hör till rutten och organisationen.");
      }
      frozenDriverId = pairs[0]!.driver.id;
    }
    let lockedServiceStartAt: Date | null | undefined;
    if (input.serviceStartAt !== undefined) {
      lockedServiceStartAt = input.serviceStartAt === null ? null : new Date(input.serviceStartAt);
      if (lockedServiceStartAt && (
        !Number.isFinite(lockedServiceStartAt.getTime())
        || lockedServiceStartAt.getUTCSeconds() !== 0 || lockedServiceStartAt.getUTCMilliseconds() !== 0
      )) throw new PlanningLockError("Ange en explicit ISO-tid på exakt minut med tidszon. Toleransen är noll sekunder.");
      if (lockedServiceStartAt) {
        const actual = plannedServiceStartForStop(requestedEvaluation?.workday.events ?? route.workdayTimeline, stop!.id);
        if (!actual || new Date(actual).getTime() !== lockedServiceStartAt.getTime()) {
          throw new PlanningLockError("Begärd exakt servicestart kan inte uppfyllas inom ruttens hårda villkor.");
        }
      }
    }
    if (stop && stopLockRequested) {
      if (stop.lockedVehicleId && input.resourcePair
        && (stop.lockedVehicleId !== input.resourcePair.vehicleId || stop.lockedDriverId !== input.resourcePair.driverId)) {
        throw new PlanningLockError("Lås upp befintligt resurslås innan det ersätts.");
      }
      if (stop.lockedServiceStartAt && lockedServiceStartAt
        && stop.lockedServiceStartAt.getTime() !== lockedServiceStartAt.getTime()) {
        throw new PlanningLockError("Lås upp befintligt tidslås innan det ersätts.");
      }
      await tx.update(stopsTable).set({
        ...(input.resourcePair === undefined ? {} : {
          lockedVehicleId: input.resourcePair?.vehicleId ?? null,
          lockedDriverId: input.resourcePair?.driverId ?? null,
        }),
        ...(lockedServiceStartAt === undefined ? {} : { lockedServiceStartAt }),
      }).where(and(eq(stopsTable.id, stop.id), eq(stopsTable.organizationId, organizationId)));
    }
    const [saved] = await tx.update(routesTable).set({
      ...(requestedEvaluation ? {
        plannerItinerary: requestedEvaluation.itinerary,
        workdayTimeline: requestedEvaluation.workday.events,
        workdaySummary: requestedEvaluation.workday.summary,
        totalDistanceKm: requestedEvaluation.distanceKm,
        totalDurationMin: requestedEvaluation.durationMin,
        executionProjection: null,
        geographicOverlapExplanation: null,
        redistributionSuggestion: null,
        // The route is locked above. Editing working locks must not revoke
        // the driver's already dispatched version (including version zero).
        ...(route.dispatchSnapshotVersion != null && route.handoffVersion != null
          ? {} : invalidatedRouteHandoff()),
      } : {}),
      ...(input.frozen === undefined ? {} : {
        optimizationFrozen: input.frozen,
        frozenDriverId: input.frozen ? frozenDriverId : null,
      }),
      planRevision: sql`${routesTable.planRevision} + 1`,
      manualReviewedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId),
      eq(routesTable.planRevision, input.planRevision))).returning();
    if (!saved) throw new PlanningLockError("Planversionen har ändrats. Ladda om.");
    await tx.delete(routePlanApprovalsTable).where(and(
      eq(routePlanApprovalsTable.organizationId, organizationId), eq(routePlanApprovalsTable.routeId, routeId),
    ));
    await tx.insert(auditLogTable).values({
      organizationId, userId: actor.userId ?? null, userEmail: actor.userEmail ?? null,
      action: "route.planning_locks", resourceType: "route", resourceId: routeId,
      method: "PUT", path: `/api/routes/${routeId}/planning-locks`, statusCode: "200",
      diff: { previousPlanRevision: route.planRevision, input },
    });
    return saved;
  });
  if (result) {
    broadcastDataChange(organizationId, "route", "updated", { id: routeId });
    if (input.stopId) broadcastDataChange(organizationId, "stop", "updated", { id: input.stopId });
  }
  return result;
}
