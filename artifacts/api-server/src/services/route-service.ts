import { eq, and, inArray, ne, or, sql, isNull } from "drizzle-orm";
import {
  db,
  routesTable,
  stopsTable,
  vehiclesTable,
  driversTable,
  driverPreferencesTable,
  deliveryNotificationsTable,
  routeHistoryTable,
  geofenceEventsTable,
  driverBehaviorLogsTable,
  routeIncidentsTable,
  routeExecutionsTable,
  executionEventsTable,
  organizationsTable,
  routeAcknowledgementsTable,
  routeMessagesTable,
  stopMessageThreadsTable,
  deliveryProofsTable,
  serviceReportsTable,
  notificationsTable,
  vehiclePositionsTable,
  planningDraftsTable,
  routePlanApprovalsTable,
  auditLogTable,
} from "@workspace/db";
import { dispatchWebhookEvent } from "./webhooks";
import { computeHappinessScore } from "./happiness-score";
import { broadcastDataChange } from "./realtime";
import { autoLogCompletedRoute } from "./driver-learning-service";
import {
  assertVehicleEligibleForFieldService,
  fieldServiceRequirementsFromStop,
} from "./field-service";
import {
  projectStopForReadRole,
  type StopReadPrincipal,
  invalidatedRoutePlanningState,
  persistDispatchRouteWorkday,
  calculateDispatchConflicts,
  assertDispatchRouteWorkdaySafeForPreview,
} from "./stop-service";
import { reorderAssignedRouteStops } from "./import-route-workflow";
import { notifyDriverRouteChanged } from "./route-notification-service";
import { isProtectedImportRoute } from "./route-plan-approval-service";
import { outgoingRoute, outgoingRoutesForDriver, outgoingStops } from "./outgoing-route-service";
import {
  RouteFirstStopLockError,
} from "./route-first-stop-lock-service";
import { preparePersistedRouteRoadData } from "./operational-road-preparation";
import { withRequiredRoadData } from "./road-data-policy";
import { plannerFactsDigest } from "./planner-stop-facts";
import { lockDispatchBindingFacts } from "./dispatch-binding-facts";
import { hasBlockingPlanningConflicts } from "./planning-conflict-policy";
import { materialResourceSnapshot, materialResourceSnapshotHash } from "./route-plan-approval-service";
import { assertDriverEligibleForFieldServiceStops } from "./field-service";
import { assertPlanningLockOrder } from "./planning-lock-invariants";
import { DispatchRevisionConflictError } from "./stop-service";
import type { DispatchConsequences, DispatchRouteMetrics } from "./dispatch-preview-contract";

export interface CreateRouteData {
  organizationId: string;
  name: string;
  date?: Date;
  vehicleId?: string | null;
  status?: string;
  totalStops?: number;
  [key: string]: unknown;
}

export interface UpdateRouteData {
  name?: string;
  date?: Date;
  vehicleId?: string | null;
  status?: string;
  totalStops?: number;
  totalDistanceKm?: number | null;
  totalDurationMin?: number | null;
  co2EmissionsKg?: number | null;
  [key: string]: unknown;
}

export interface RouteFirstStopLockActor {
  userId?: string | null;
  userEmail?: string | null;
}

export async function listRoutes(
  organizationId: string,
  status?: string,
  principal?: StopReadPrincipal,
) {
  if (principal?.role === "driver") {
    if (!principal.driverProfileId) return [];
    return (await outgoingRoutesForDriver(organizationId, principal.driverProfileId))
      .filter((route) => status ? route.status === status : route.status !== "cancelled");
  }
  const conditions = [eq(routesTable.organizationId, organizationId)];
  if (status) {
    conditions.push(eq(routesTable.status, status as any));
  } else {
    // Cancelled rows are retained archives, not operational work. Historical
    // screens can request that explicit status, but neither dispatcher nor
    // driver default lists should offer an archived route for execution.
    conditions.push(ne(routesTable.status, "cancelled"));
  }

  return db.select().from(routesTable).where(and(...conditions));
}

export async function getRoute(id: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, organizationId)));
  return route ?? null;
}

export async function createRoute(data: CreateRouteData) {
  if (data.draftId && data.status === "in_progress") {
    const error = new Error(
      "Protected imported plans must be dispatched through the approved handoff flow.",
    ) as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  }
  const [route] = await db.insert(routesTable).values(data as any).returning();
  dispatchWebhookEvent(route.organizationId, "route.created", {
    routeId: route.id, name: route.name, status: route.status,
  }).catch(() => {});
  broadcastDataChange(route.organizationId, "route", "created", { id: route.id, name: route.name });
  return route;
}

export interface RouteResourceReplacementInput {
  routeId: string; vehicleId: string; driverId: string; planRevision: number;
  force?: boolean; expectedPreviewDigest?: string;
}

/** Keep membership/order; reuse canonical dispatch workday and conflict policy.
 * This is an explicit pair replacement, not a second optimizer/scheduler. */
export async function replaceRouteResources(
  organizationId: string, input: RouteResourceReplacementInput,
  options: { previewOnly?: boolean; actor?: RouteFirstStopLockActor } = {},
) {
  const fail = (message: string): never => { throw new RouteFirstStopLockError(message); };
  const snapshot = await getRoute(input.routeId, organizationId);
  if (!snapshot) return null;
  if (!["draft", "optimized"].includes(snapshot.status) || snapshot.optimizationFrozen || snapshot.lockedFirstStopId) {
    fail("Resursbyte kräver en ännu ej utskickad och upplåst arbetsrutt.");
  }
  if (!snapshot.depotSnapshot || !snapshot.optimizationPlanningSnapshot) {
    fail("Rutten saknar auktoritativt depå- eller planeringsunderlag. Beräkna planen före resursbyte.");
  }
  // All potential external I/O precedes transactional locks, including the
  // selected pair's depot/shift facts and persisted charging visits.
  await preparePersistedRouteRoadData(organizationId, {
    routeIds: [input.routeId], vehicleIds: [input.vehicleId], driverIds: [input.driverId],
  });
  const result = await withRequiredRoadData(() => db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + input.routeId}))`);
    const [route] = await tx.select().from(routesTable).where(and(
      eq(routesTable.id, input.routeId), eq(routesTable.organizationId, organizationId),
    )).for("update");
    if (!route) return null;
    if (route.planRevision !== input.planRevision || plannerFactsDigest(route) !== plannerFactsDigest(snapshot)) throw new DispatchRevisionConflictError();
    if (!["draft", "optimized"].includes(route.status)) fail("Resursbyte gäller endast ännu ej utskickade arbetsrutter.");
    if (route.optimizationFrozen || route.lockedFirstStopId) fail("Lås upp rutten eller förstastoppsregeln före resursbyte.");
    const stops = await tx.select().from(stopsTable).where(and(
      eq(stopsTable.routeId, route.id), eq(stopsTable.organizationId, organizationId), isNull(stopsTable.archivedAt),
    )).orderBy(stopsTable.id).for("update");
    if (stops.some(stop => stop.status !== "pending")) fail("Utförd eller pågående historik får inte byta resurs.");
    const [organization] = await tx.select().from(organizationsTable).where(
      eq(organizationsTable.id, organizationId),
    ).for("update");
    const facts = await lockDispatchBindingFacts(tx, organizationId,
      [...new Set([input.vehicleId, ...(route.vehicleId ? [route.vehicleId] : [])])].sort(),
      [...new Set(stops.flatMap(stop => stop.customerId ? [stop.customerId] : []))].sort());
    const vehicle = facts.vehicles.find(vehicle => vehicle.id === input.vehicleId);
    const driver = facts.drivers.find(driver => driver.id === input.driverId);
    if (!vehicle?.isActive || !driver?.isActive || driver.vehicleId !== vehicle.id) fail("Välj ett verkligt aktivt fordons–förarpar med befintlig koppling.");
    if (stops.some(stop => stop.lockedDriverId && stop.lockedDriverId !== input.driverId)) fail("Resursbytet bryter uppdragets förarlås.");
    const occupied = await tx.select({ id: routesTable.id }).from(routesTable).where(and(
      eq(routesTable.organizationId, organizationId), ne(routesTable.id, route.id),
      eq(routesTable.vehicleId, input.vehicleId), eq(routesTable.date, route.date),
      ne(routesTable.status, "cancelled"), ne(routesTable.status, "completed"),
    ));
    if (occupied.length) fail("Det valda fordonet är redan tilldelat en annan rutt detta datum.");
    await assertDriverEligibleForFieldServiceStops(organizationId, route.id, input.driverId, input.vehicleId, route.date, tx);
    const certifications = facts.certifications.filter(cert => cert.driverId === input.driverId);
    const candidate = { ...route, vehicleId: input.vehicleId,
      // Exact local evaluation reference only. No handoff is changed in preview.
      handoffDriverId: input.driverId,
      optimizationResourceSnapshot: materialResourceSnapshot(vehicle!, driver!, stops, certifications),
      optimizationResourceSnapshotHash: materialResourceSnapshotHash(vehicle!, driver!, stops, certifications),
    };
    assertPlanningLockOrder(candidate, stops, stops);
    const after = await assertDispatchRouteWorkdaySafeForPreview(tx, organizationId, candidate, organization, stops);
    let before: DispatchRouteMetrics | null = null;
    try { before = await assertDispatchRouteWorkdaySafeForPreview(tx, organizationId, route, organization, stops); }
    catch (error) {
      if (!(error instanceof Error && "statusCode" in error && error.statusCode === 409)) throw error;
    }
    const unknown: DispatchRouteMetrics = { driveMin: null, workMin: null, endAt: null, windowViolations: null, stopCount: stops.length };
    const conflicts = calculateDispatchConflicts(candidate, vehicle, driver, stops, organization);
    const consequences: DispatchConsequences = {
      status: before && after ? "verified" : "unknown",
      ...(!before || !after ? { reason: "Verifierade före/efter-mått saknas för denna rutt." } : {}),
      unplanned: { before: 0, after: 0 },
      routes: [{ routeId: route.id, routeName: route.name, before: before ?? unknown, after: after ?? unknown }],
    };
    const previewDigest = plannerFactsDigest({
      organizationId, input: { routeId: input.routeId, vehicleId: input.vehicleId, driverId: input.driverId,
        planRevision: input.planRevision, force: input.force === true },
      route, stops, facts, organization, conflicts, consequences,
    });
    const canChange = !hasBlockingPlanningConflicts(conflicts, input.force === true);
    if (options.previewOnly) return { kind: "preview" as const, canChange, conflicts, consequences, previewDigest };
    if (!input.expectedPreviewDigest || input.expectedPreviewDigest !== previewDigest) throw new DispatchRevisionConflictError();
    if (!canChange) fail("Resursbytet bryter en planeringsregel. Hårda begränsningar kan inte överstyras.");
    await tx.update(routesTable).set({
      vehicleId: input.vehicleId,
      optimizationResourceSnapshot: candidate.optimizationResourceSnapshot,
      optimizationResourceSnapshotHash: candidate.optimizationResourceSnapshotHash,
    }).where(and(eq(routesTable.id, route.id), eq(routesTable.organizationId, organizationId), eq(routesTable.planRevision, route.planRevision)));
    if (input.force && conflicts.length) await tx.update(stopsTable).set({
      assignmentOverrideAt: new Date(), assignmentOverrideReasonCodes: conflicts,
    }).where(and(eq(stopsTable.routeId, route.id), eq(stopsTable.organizationId, organizationId)));
    await persistDispatchRouteWorkday(tx, organizationId, candidate, organization);
    const [saved] = await tx.select().from(routesTable).where(eq(routesTable.id, route.id));
    if (after) {
      const summary = saved?.workdaySummary;
      const actual = {
        driveMin: summary ? summary.nonReturnDrivingMin + summary.returnMin : null,
        workMin: summary?.totalMin ?? null, endAt: saved?.workdayTimeline?.at(-1)?.endAt ?? null,
        windowViolations: summary ? summary.lateStopIds?.length ?? 0 : null, stopCount: saved?.totalStops ?? 0,
      };
      if (plannerFactsDigest(actual) !== plannerFactsDigest(after)) throw new DispatchRevisionConflictError();
    }
    await tx.delete(routePlanApprovalsTable).where(and(eq(routePlanApprovalsTable.routeId, route.id), eq(routePlanApprovalsTable.organizationId, organizationId)));
    await tx.insert(auditLogTable).values({
      organizationId, userId: options.actor?.userId ?? null, userEmail: options.actor?.userEmail ?? null,
      action: "route.resources_replaced", resourceType: "route", resourceId: route.id, method: "POST",
      path: "/api/planner-corrections/route-resources/confirm", statusCode: "200",
      diff: { previous: { vehicleId: route.vehicleId, driver: route.optimizationResourceSnapshot?.driver },
        next: { vehicleId: input.vehicleId, driverId: input.driverId }, previewDigest, consequences, acceptedConflicts: input.force ? conflicts : [] },
    });
    return { kind: "replaced" as const, route: saved, conflicts, consequences };
  }));
  if (result?.kind === "replaced") broadcastDataChange(organizationId, "route", "updated", { id: input.routeId });
  return result;
}

/**
 * Atomically pins (or unpins) the first customer job on a route.  The route
 * row and all of its stops are locked before validating the revision, so a
 * concurrent reorder, dispatch move, or optimizer cannot win silently.
 */
export async function setLockedFirstStop(
  routeId: string,
  organizationId: string,
  stopId: string | null,
  expectedPlanRevision: number,
  actor: RouteFirstStopLockActor = {},
) {
  if (stopId !== null) await preparePersistedRouteRoadData(organizationId, { routeIds: [routeId] });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
    );
    const [route] = await tx
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.id, routeId),
        eq(routesTable.organizationId, organizationId),
      ))
      .for("update");
    if (!route) return null;
    if (route.planRevision !== expectedPlanRevision) {
      throw new RouteFirstStopLockError(
        "Ruttplanen ändrades innan första stoppet kunde låsas. Ladda om och försök igen.",
      );
    }
    if (stopId != null && route.vehicleId == null) {
      throw new RouteFirstStopLockError(
        "Ett första kundstopp kan bara låsas på en rutt som har ett fordon tilldelat.",
      );
    }
    if (stopId != null && !["draft", "optimized"].includes(route.status)) {
      throw new RouteFirstStopLockError(
        "Första stoppet kan bara låsas på en planerad eller optimerad rutt som ännu inte har startats.",
      );
    }

    const routeStops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        eq(stopsTable.routeId, routeId),
        isNull(stopsTable.archivedAt),
      ))
      .orderBy(stopsTable.sequenceOrder, stopsTable.id)
      .for("update");
    const lockedStop = stopId == null
      ? undefined
      : routeStops.find((candidate) => candidate.id === stopId);
    if (stopId != null) {
      if (!lockedStop || lockedStop.status !== "pending" || lockedStop.archivedAt != null) {
        throw new RouteFirstStopLockError(
          "Första stoppet måste vara ett väntande, oarkiverat stopp på samma rutt.",
        );
      }
      // A live/terminal stop before the requested pending stop cannot be
      // displaced without changing execution history; fail closed.
      const requestedOrder = lockedStop.sequenceOrder ?? Number.MAX_SAFE_INTEGER;
      if (routeStops.some((candidate) =>
        candidate.status !== "pending"
        && (candidate.sequenceOrder ?? Number.MAX_SAFE_INTEGER) <= requestedOrder
      )) {
        throw new RouteFirstStopLockError(
          "Det valda stoppet kan inte bli först eftersom rutten redan innehåller ett aktivt eller avslutat stopp före det.",
        );
      }
    } else if (route.lockedFirstStopId != null) {
      const currentLocked = routeStops.find(
        (candidate) => candidate.id === route.lockedFirstStopId,
      );
      if (!currentLocked) {
        throw new RouteFirstStopLockError(
          "Det låsta första stoppet saknas på rutten. Ladda om och korrigera rutten innan upplåsning.",
        );
      }
    }

    const currentCustomerOrder = routeStops
      .filter((candidate) => candidate.sequenceOrder != null)
      .map((candidate) => candidate.id);
    if (
      (stopId == null && route.lockedFirstStopId == null)
      || (stopId != null
        && route.lockedFirstStopId === stopId
        && currentCustomerOrder[0] === stopId)
    ) {
      return route;
    }

    if (stopId != null) {
      const reorderedStops = routeStops.filter((candidate) => candidate.id !== stopId);
      reorderedStops.unshift(lockedStop!);
      for (let index = 0; index < reorderedStops.length; index++) {
        await tx.update(stopsTable).set({
          sequenceOrder: index + 1,
        }).where(and(
          eq(stopsTable.id, reorderedStops[index].id),
          eq(stopsTable.organizationId, organizationId),
          eq(stopsTable.routeId, routeId),
        ));
      }
      await tx.update(routesTable).set({
        lockedFirstStopId: stopId,
      }).where(and(
        eq(routesTable.id, routeId),
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planRevision, expectedPlanRevision),
      ));
      // Rebuild the authoritative clock/itinerary from the newly pinned order.
      const [organization] = await tx
        .select({
          maxDriverOvertimeMin: organizationsTable.maxDriverOvertimeMin,
          allowLateStopsMin: organizationsTable.allowLateStopsMin,
        })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId));
      await withRequiredRoadData(() => persistDispatchRouteWorkday(
        tx,
        organizationId,
        { ...route, lockedFirstStopId: stopId },
        organization,
      ));
    } else {
      const [unlocked] = await tx.update(routesTable).set({
        lockedFirstStopId: null,
        ...(
          ["draft", "optimized"].includes(route.status)
            ? invalidatedRoutePlanningState(routeStops.length)
            : { planRevision: sql`${routesTable.planRevision} + 1` }
        ),
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.id, routeId),
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planRevision, expectedPlanRevision),
      )).returning();
      if (!unlocked) {
        throw new RouteFirstStopLockError(
          "Ruttplanen ändrades innan första stoppet kunde låsas upp. Ladda om och försök igen.",
        );
      }
    }

    await tx.delete(routePlanApprovalsTable).where(and(
      eq(routePlanApprovalsTable.organizationId, organizationId),
      eq(routePlanApprovalsTable.routeId, routeId),
    ));
    await tx.insert(auditLogTable).values({
      organizationId,
      userId: actor.userId ?? null,
      userEmail: actor.userEmail ?? null,
      action: stopId == null ? "route.first_stop_unlock" : "route.first_stop_lock",
      resourceType: "route",
      resourceId: routeId,
      method: "PUT",
      path: `/api/routes/${routeId}/locked-first-stop`,
      statusCode: "200",
      requestId: null,
      ipAddress: null,
      userAgent: null,
      diff: {
        previousLockedFirstStopId: route.lockedFirstStopId,
        lockedFirstStopId: stopId,
        previousPlanRevision: route.planRevision,
      },
      metadata: null,
    });
    const [saved] = await tx
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.id, routeId),
        eq(routesTable.organizationId, organizationId),
      ));
    return saved ?? null;
  });
}

export async function updateRoute(
  id: string,
  organizationId: string,
  data: UpdateRouteData,
  notifyFields: Record<string, boolean> = {},
  expectedPlanRevision?: number,
) {
  const conditions = [eq(routesTable.id, id), eq(routesTable.organizationId, organizationId)];
  const [previousRoute] = await db
    .select({
      handoffDriverId: routesTable.handoffDriverId,
      handoffStatus: routesTable.handoffStatus,
      planRevision: routesTable.planRevision,
      status: routesTable.status,
    })
    .from(routesTable)
    .where(and(...conditions))
    .limit(1);
  if (previousRoute && expectedPlanRevision !== undefined && previousRoute.planRevision !== expectedPlanRevision) {
    const error = new Error("Arbetsplanens version har ändrats. Läs in och granska aktuell version.") as Error & { statusCode: number };
    error.statusCode = 409; throw error;
  }
  if (previousRoute && ["completed", "cancelled"].includes(previousRoute.status)
    && Object.keys(data).some((key) => key !== "status")) {
    const error = new Error("Terminala rutter är historik och kan inte få ändrade planeringsuppgifter.") as Error & { statusCode: number };
    error.statusCode = 409; throw error;
  }
  const blockedPlanningFields = [
    "vehicleId",
    "date",
    "totalStops",
    "totalDistanceKm",
    "totalDurationMin",
    "co2EmissionsKg",
  ];
  if (blockedPlanningFields.some((field) =>
    Object.prototype.hasOwnProperty.call(data, field)
  )) {
    const error = new Error(
      "Planning fields must use an atomic planning or dispatch operation.",
    ) as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  }
  const route = data.status
    ? await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + id}))`,
        );
        const [existing] = await tx
          .select()
          .from(routesTable)
          .where(and(...conditions))
          .for("update");
        if (!existing) return null;
        if (
          !Number.isInteger(expectedPlanRevision) ||
          existing.planRevision !== expectedPlanRevision
        ) {
          const error = new Error(
            "Route changed before its status could be saved. Reload and try again.",
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        if (
          ["completed", "cancelled"].includes(existing.status) &&
          data.status !== existing.status
        ) {
          const error = new Error(
            "Completed or cancelled routes cannot be reopened.",
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        if (
          existing.lockedFirstStopId != null
          && data.status
          && !["draft", "optimized"].includes(data.status)
        ) {
          throw new RouteFirstStopLockError(
            "Rutten har ett låst första kundstopp och kan inte startas eller avslutas innan den låses upp.",
          );
        }
        if (
          existing.lockedFirstStopId != null
          && data.vehicleId !== undefined
          && data.vehicleId !== existing.vehicleId
        ) {
          throw new RouteFirstStopLockError(
            "Rutten har ett låst första kundstopp och kan inte byta fordon innan den låses upp.",
          );
        }
        if (
          isProtectedImportRoute(existing)
          && (data.status === "in_progress" || data.status === "completed")
        ) {
          const error = new Error(
            "Protected imported plans must be dispatched through the approved handoff flow.",
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        const lockedStops = await tx
          .select({ status: stopsTable.status })
          .from(stopsTable)
          .where(and(
            eq(stopsTable.organizationId, organizationId),
            eq(stopsTable.routeId, id),
          ))
          .orderBy(stopsTable.id)
          .for("update");
        if (
          data.status === "completed" &&
          lockedStops.some((stop) => stop.status !== "completed")
        ) {
          const error = new Error(
            "A route can be completed only when all of its stops are completed.",
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        const [saved] = await tx
          .update(routesTable)
          .set({
            ...data,
            ...notifyFields,
            planRevision: sql`${routesTable.planRevision} + 1`,
            handoffStatus: "pending",
            handoffVersion: null,
            handoffDriverId: null,
            sentAt: null, receivedAt: null, openedAt: null, acceptedAt: null, rejectedAt: null, rejectionReason: null,
            updatedAt: new Date(),
          } as any)
          .where(and(
            ...conditions,
            eq(routesTable.planRevision, expectedPlanRevision!),
          ))
          .returning();
        if (!saved) {
          const error = new Error(
            "Route changed before its status could be saved. Reload and try again.",
          ) as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        if (data.status !== existing.status) {
          // A route entering a terminal/execution state changes which nearby
          // route pairs are relevant. Clear only derived counterpart evidence.
          await tx
            .update(routesTable)
            .set({ geographicOverlapExplanation: null })
            .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));
        }
        return saved;
      })
    : (await db
        .update(routesTable)
        .set({
          ...data,
          ...notifyFields,
          ...(Object.keys(data).length ? {
            planRevision: sql`${routesTable.planRevision} + 1`,
            manualReviewedAt: null,
          } : {}),
          updatedAt: new Date(),
        } as any)
        .where(and(...conditions, eq(routesTable.planRevision,
          expectedPlanRevision ?? previousRoute?.planRevision ?? -1)))
        .returning())[0] ?? null;

  if (!route) {
    if (previousRoute) {
      const error = new Error("Arbetsplanen ändrades under sparandet. Läs in och granska aktuell version.") as Error & { statusCode: number };
      error.statusCode = 409; throw error;
    }
    return null;
  }

  if (
    previousRoute?.handoffDriverId
    && previousRoute.handoffStatus === "accepted"
    && route.planRevision > previousRoute.planRevision
  ) {
    await notifyDriverRouteChanged({
      organizationId,
      routeId: route.id,
      driverId: previousRoute.handoffDriverId,
      planVersion: route.planRevision,
      message: `Route ${route.name} changed. Review and accept the new plan before continuing.`,
    });
  }

  if (data.status === "completed" && route.vehicleId) {
    updateHappinessScoreForVehicle(route.vehicleId, route.organizationId).catch(() => {});
    autoLogCompletedRoute(route.id, route.organizationId).catch((err) =>
      console.error("autoLogCompletedRoute failed:", err),
    );
  }

  if (data.status) {
    const eventMap: Record<string, string> = {
      optimized: "route.optimized",
      in_progress: "route.started",
      completed: "route.completed",
      cancelled: "route.cancelled",
    };
    const event = eventMap[data.status];
    if (event) {
      dispatchWebhookEvent(route.organizationId, event, {
        routeId: route.id, name: route.name, status: route.status,
      }).catch(() => {});
    }
  }

  broadcastDataChange(route.organizationId, "route", "updated", { id: route.id, name: route.name, status: route.status });
  return route;
}

export type RouteDeleteConflictReason =
  | "route_status"
  | "stop_status"
  | "handoff"
  | "execution_history"
  | "partial_plan"
  | "approved_route"
  | "approved_membership"
  | "live_confirmation"
  | "protected_confirmation"
  | "locked_first_stop";

export interface RouteDeleteConflictDetail {
  routeId: string;
  reason: RouteDeleteConflictReason;
  message: string;
  routeStatus?: string;
  handoffStatus?: string;
  stopIds?: string[];
  historyTypes?: string[];
  approvalPlanRevision?: number;
}

/**
 * A stable, deliberately tenant-safe error for route deletion.  The route ids
 * in details have already been found in the authenticated tenant, so this
 * never becomes an existence oracle for ids from another tenant.
 */
export class RouteDeleteConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "ROUTE_DELETE_CONFLICT";

  constructor(readonly conflicts: RouteDeleteConflictDetail[]) {
    super(
      conflicts.length === 1
        ? conflicts[0].message
        : "One or more routes cannot be deleted safely.",
    );
    this.name = "RouteDeleteConflictError";
  }
}

export class RouteDeleteNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    // Keep this intentionally generic.  A mixed tenant request must not reveal
    // which supplied id was foreign or missing.
    super("Route not found");
    this.name = "RouteDeleteNotFoundError";
  }
}

type RouteDeleteResult = {
  deletedRouteIds: string[];
  deletedCount: number;
  archivedRouteIds: string[];
  archivedCount: number;
};

function retainRouteForHistory(
  archivedRouteIds: Set<string>,
  routeId: string,
) {
  archivedRouteIds.add(routeId);
}

function isLiveRouteForRemoval(route: Pick<typeof routesTable.$inferSelect, "status" | "handoffStatus">): boolean {
  return route.status === "in_progress" || route.handoffStatus !== "pending";
}

function removeDeletedRouteReferences(
  value: unknown,
  deletedRouteIds: Set<string>,
  survivingRouteIds: Set<string>,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    const routeCollection = key === "routes" || key === "assignedRoutes";
    const routeIdCollection = key === "routeIds" || key === "assignedRouteIds";
    return value
      .filter((entry) => {
        if (routeIdCollection && typeof entry === "string") {
          return !deletedRouteIds.has(entry);
        }
        if (routeCollection && entry && typeof entry === "object" && !Array.isArray(entry)) {
          const routeId = (entry as Record<string, unknown>).routeId;
          return typeof routeId !== "string" || survivingRouteIds.has(routeId);
        }
        return true;
      })
      .map((entry) => removeDeletedRouteReferences(
        entry,
        deletedRouteIds,
        survivingRouteIds,
        key,
      ));
  }
  if (!value || typeof value !== "object") return value;

  const sourceEvidence = key === "recovery";
  const output: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    // Recovery is immutable source evidence.  It is deliberately not used as
    // the cached route response and must remain available to protected
    // reoptimization after a released order.
    if (sourceEvidence) {
      output[entryKey] = entry;
      continue;
    }
    if (
      entryKey === "routeId"
      && typeof entry === "string"
      && deletedRouteIds.has(entry)
    ) {
      continue;
    }
    if (
      (entryKey === "routeIds" || entryKey === "assignedRouteIds")
      && Array.isArray(entry)
    ) {
      output[entryKey] = entry.filter((routeId): routeId is string =>
        typeof routeId !== "string" || !deletedRouteIds.has(routeId));
      continue;
    }
    output[entryKey] = removeDeletedRouteReferences(
      entry,
      deletedRouteIds,
      survivingRouteIds,
      entryKey,
    );
  }
  return output;
}

function reconcilePartialPlanResult(
  planResult: Record<string, unknown> | null,
  deletedRouteIds: Set<string>,
  survivingRouteIds: Set<string>,
  releasedStopIds: string[],
): Record<string, unknown> | null {
  if (!planResult) return null;
  const reconciled = removeDeletedRouteReferences(
    planResult,
    deletedRouteIds,
    survivingRouteIds,
  ) as Record<string, unknown>;
  const planInputs = reconciled.planningInputs;
  const releasedPriorities = new Map<string, number>();
  if (planInputs && typeof planInputs === "object" && !Array.isArray(planInputs)) {
    const stopPriorities = (planInputs as Record<string, unknown>).stopPriorities;
    if (stopPriorities && typeof stopPriorities === "object" && !Array.isArray(stopPriorities)) {
      const nextStopPriorities = { ...(stopPriorities as Record<string, unknown>) };
      for (const stopId of releasedStopIds) {
        const priority = nextStopPriorities[stopId];
        if (priority === 0 || priority === 1 || priority === 2) {
          releasedPriorities.set(stopId, priority);
        }
        delete nextStopPriorities[stopId];
      }
      reconciled.planningInputs = {
        ...(planInputs as Record<string, unknown>),
        stopPriorities: nextStopPriorities,
      };
    }
  }
  const existingUnassigned = Array.isArray(reconciled.unassignedStopIds)
    ? reconciled.unassignedStopIds.filter((stopId): stopId is string => typeof stopId === "string")
    : [];
  reconciled.unassignedStopIds = [...new Set([...existingUnassigned, ...releasedStopIds])];
  reconciled.releasedStopIds = [...new Set(releasedStopIds)];

  const summary = reconciled.planningSummary;
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    const nextSummary = { ...(summary as Record<string, unknown>) };
    const existingUnplanned = Array.isArray(nextSummary.unplanned)
      ? nextSummary.unplanned.filter((entry) =>
        entry
        && typeof entry === "object"
        && !releasedStopIds.includes((entry as Record<string, unknown>).stopId as string),
      )
      : [];
    nextSummary.unplanned = [
      ...existingUnplanned,
      ...releasedStopIds.map((stopId) => ({
        stopId,
        priority: releasedPriorities.get(stopId) ?? 0,
        reason: "The order was released when its route was deleted.",
      })),
    ];
    const mandatory = Array.isArray(nextSummary.mandatoryUnplannedStopIds)
      ? nextSummary.mandatoryUnplannedStopIds.filter((stopId): stopId is string =>
        typeof stopId === "string" && !releasedStopIds.includes(stopId))
      : [];
    nextSummary.mandatoryUnplannedStopIds = [...new Set([
      ...mandatory,
      ...releasedStopIds.filter((stopId) => releasedPriorities.get(stopId) === 2),
    ])];
    if (releasedStopIds.length > 0) nextSummary.complete = false;
    nextSummary.unassignedStopIds = [...new Set([
      ...(Array.isArray(nextSummary.unassignedStopIds)
        ? nextSummary.unassignedStopIds.filter((stopId): stopId is string =>
          typeof stopId === "string")
        : []),
      ...releasedStopIds,
    ])];
    reconciled.planningSummary = nextSummary;
  }
  return reconciled;
}

/**
 * Delete one or more routes as one planning mutation.
 *
 * The lock order intentionally matches the planning/dispatch mutation
 * contract: deterministic route advisory locks, route rows, related draft
 * rows, then route-owned stops.  All validation happens before the first write, so a
 * conflict in one route rolls back every route in a bulk request.
 */
export async function deleteRoutes(
  requestedRouteIds: string[],
  organizationId: string,
  confirmLiveRouteRemoval: boolean,
): Promise<RouteDeleteResult> {
  const routeIds = [...new Set(requestedRouteIds.map((routeId) => routeId.toLowerCase()))].sort();
  if (routeIds.length === 0) {
    return { deletedRouteIds: [], deletedCount: 0, archivedRouteIds: [], archivedCount: 0 };
  }

  const result = await db.transaction(async (tx) => {
    // Discover generated-plan membership before taking any row lock, then
    // acquire every route advisory lock in one deterministic order. A partial
    // delete must not deadlock with a plan-wide reoptimization that locks a
    // surviving sibling before the requested route.
    const requestedPlanRows = await tx
      .select({ id: routesTable.id, planId: routesTable.planId })
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.id, routeIds),
      ));
    const requestedPlanIds = [...new Set(requestedPlanRows.map((route) => route.planId))].sort();
    const groupedRouteIdsQuery = requestedPlanIds.length === 0
      ? []
      : await tx
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(and(
          eq(routesTable.organizationId, organizationId),
          inArray(routesTable.planId, requestedPlanIds),
        ))
        .orderBy(routesTable.id);
    const groupedRouteIds = [...new Set([
      ...routeIds,
      ...groupedRouteIdsQuery.map((route) => route.id),
    ])].sort();
    for (const routeId of groupedRouteIds) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`,
      );
    }

    const routes = await tx
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.id, routeIds),
      ))
      .orderBy(routesTable.id)
      .for("update");
    if (routes.length !== routeIds.length) {
      throw new RouteDeleteNotFoundError();
    }

    // Keep draft locking before stop locking, matching the protected planning
    // mutation order (route -> draft -> stops) and avoiding a route-delete /
    // reoptimization deadlock.
    const draftIds = [...new Set(
      routes
        .map((route) => route.draftId)
        .filter((draftId): draftId is string => Boolean(draftId)),
    )].sort();
    const planIds = [...new Set(routes.map((route) => route.planId))].sort();

    const groupedRoutes = groupedRouteIds.length === 0
      ? []
      : await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.organizationId, organizationId),
          inArray(routesTable.id, groupedRouteIds),
        ))
        .orderBy(routesTable.id)
        .for("update");

    const conflicts = new Map<string, RouteDeleteConflictDetail>();
    const archivedRouteIds = new Set<string>();
    const liveRouteIds = new Set(
      routes.filter(isLiveRouteForRemoval).map((route) => route.id),
    );
    for (const routeId of liveRouteIds) archivedRouteIds.add(routeId);
    for (const route of routes) {
      if (route.lockedFirstStopId == null || route.status !== "in_progress") continue;
      conflicts.set(route.id, {
        routeId: route.id,
        reason: "locked_first_stop",
        message: "Ruttan har ett låst första kundstopp. Lås upp rutten innan den tas bort.",
        routeStatus: route.status,
        handoffStatus: route.handoffStatus,
      });
    }
    if (liveRouteIds.size > 0 && !confirmLiveRouteRemoval) {
      for (const route of routes) {
        if (route.status !== "in_progress") continue;
        if (conflicts.has(route.id)) continue;
        conflicts.set(route.id, {
          routeId: route.id,
          reason: "live_confirmation",
          message: "Removing a live, dispatched, or accepted route requires explicit confirmation.",
          routeStatus: route.status,
          handoffStatus: route.handoffStatus,
        });
      }
    }
    const partialPlanRouteIds = new Set<string>();
    const partialPlanRouteIdsWithProtectedSibling = new Set<string>();
    for (const route of routes) {
      const survivingSibling = groupedRoutes.find((candidate) =>
        candidate.id !== route.id
        && !routeIds.includes(candidate.id)
        && candidate.planId === route.planId
        && (route.draftId == null || candidate.draftId === route.draftId),
      );
      if (survivingSibling) {
        partialPlanRouteIds.add(route.id);
        if (
          ["in_progress", "completed"].includes(survivingSibling.status)
          || survivingSibling.handoffStatus !== "pending"
        ) {
          partialPlanRouteIdsWithProtectedSibling.add(route.id);
        }
      }
    }

    /*
     * Approval rows are durable handoff authorization evidence.  The FK is
     * ON DELETE CASCADE, so deleting an approved route would otherwise erase
     * that evidence.  Reject before any detach/delete write instead.
     */
    const approvals = await tx
      .select({
        routeId: routePlanApprovalsTable.routeId,
        planRevision: routePlanApprovalsTable.planRevision,
      })
      .from(routePlanApprovalsTable)
      .where(and(
        eq(routePlanApprovalsTable.organizationId, organizationId),
        inArray(routePlanApprovalsTable.routeId, groupedRouteIds.length > 0 ? groupedRouteIds : routeIds),
      ))
      .orderBy(routePlanApprovalsTable.routeId, routePlanApprovalsTable.planRevision)
      .for("update");
    for (const approval of approvals) {
      if (routeIds.includes(approval.routeId)) {
        // Keep the route row and approval FK evidence instead of deleting it.
        // This is also what allows an approved live route to be removed from
        // operations without rewriting approval evidence for its siblings.
        archivedRouteIds.add(approval.routeId);
      } else if (partialPlanRouteIds.size > 0) {
        for (const partialRouteId of partialPlanRouteIds) {
          const partialRoute = routes.find((route) => route.id === partialRouteId);
          const approvedRoute = groupedRoutes.find((route) => route.id === approval.routeId);
          if (
            partialRoute
            && approvedRoute
            && approvedRoute.planId === partialRoute.planId
            && (partialRoute.draftId == null || approvedRoute.draftId === partialRoute.draftId)
          ) {
            if (!archivedRouteIds.has(partialRouteId)) {
              conflicts.set(partialRouteId, {
                routeId: partialRouteId,
                reason: "approved_membership",
                message: "A surviving route in this plan is approved; partial deletion would invalidate its plan membership.",
                approvalPlanRevision: approval.planRevision,
              });
            }
          }
        }
      }
    }

    const draftAssociation = [
      ...(draftIds.length > 0 ? [inArray(planningDraftsTable.id, draftIds)] : []),
      ...(planIds.length > 0 ? [inArray(planningDraftsTable.planId, planIds)] : []),
    ];
    const drafts = draftAssociation.length === 0
      ? []
      : await tx
        .select()
        .from(planningDraftsTable)
        .where(and(
          eq(planningDraftsTable.organizationId, organizationId),
          or(...draftAssociation),
        ))
        .orderBy(planningDraftsTable.id)
        .for("update");

    const routeStops = await tx
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.routeId, routeIds),
      ))
      .orderBy(stopsTable.routeId, stopsTable.id)
      .for("update");

    const draftById = new Map(drafts.map((draft) => [draft.id, draft]));

    for (const route of routes) {
      if (["completed", "cancelled"].includes(route.status)) {
        conflicts.set(route.id, {
          routeId: route.id,
          reason: "route_status",
          message: `Route with status ${route.status} cannot be deleted.`,
          routeStatus: route.status,
        });
      }
    }

    /*
     * Do not remove operational evidence as a side effect of deleting a
     * planning row.  In particular, route executions cascade at the database
     * level and several legacy tables do not have an FK; checking all of them
     * here is what makes the retention rule explicit and atomic.
     */
    const executionRows = await tx
      .select()
      .from(routeExecutionsTable)
      .where(and(
        eq(routeExecutionsTable.organizationId, organizationId),
        inArray(routeExecutionsTable.routeId, routeIds),
      ))
      .orderBy(routeExecutionsTable.routeId)
      .for("update");
    for (const row of executionRows) retainRouteForHistory(archivedRouteIds, row.routeId);

    // Dispatch/acceptance is not execution. Ordinary deletion may withdraw an
    // unstarted route, but must not silently cancel a run that started while
    // the confirmation dialog was open (including inconsistent legacy status).
    if (!confirmLiveRouteRemoval) {
      const startedRouteIds = new Set([
        ...executionRows.map((row) => row.routeId),
        ...routeStops.filter((stop) => stop.status !== "pending").map((stop) => stop.routeId!),
      ]);
      for (const routeId of startedRouteIds) {
        conflicts.set(routeId, {
          routeId,
          reason: routeStops.some((stop) => stop.routeId === routeId && stop.status !== "pending")
            ? "stop_status" : "live_confirmation",
          message: "The route has execution evidence and cannot be removed as an unstarted route.",
        });
      }
    }

    const executionEvents = await tx
      .select({ routeId: executionEventsTable.routeId })
      .from(executionEventsTable)
      .where(and(
        eq(executionEventsTable.organizationId, organizationId),
        inArray(executionEventsTable.routeId, routeIds),
      ));
    for (const row of executionEvents) retainRouteForHistory(archivedRouteIds, row.routeId);

    const routeHistory = await tx
      .select({ routeId: routeHistoryTable.routeId })
      .from(routeHistoryTable)
      .where(and(
        eq(routeHistoryTable.organizationId, organizationId),
        inArray(routeHistoryTable.routeId, routeIds),
      ));
    for (const row of routeHistory) retainRouteForHistory(archivedRouteIds, row.routeId);

    const geofenceEvents = await tx
      .select({ routeId: geofenceEventsTable.routeId })
      .from(geofenceEventsTable)
      .where(and(
        eq(geofenceEventsTable.organizationId, organizationId),
        inArray(geofenceEventsTable.routeId, routeIds),
      ));
    for (const row of geofenceEvents) retainRouteForHistory(archivedRouteIds, row.routeId);

    const routeIncidents = await tx
      .select({ routeId: routeIncidentsTable.routeId })
      .from(routeIncidentsTable)
      .where(and(
        eq(routeIncidentsTable.organizationId, organizationId),
        inArray(routeIncidentsTable.routeId, routeIds),
      ));
    for (const row of routeIncidents) retainRouteForHistory(archivedRouteIds, row.routeId);

    const behaviorLogs = await tx
      .select({ routeId: driverBehaviorLogsTable.routeId })
      .from(driverBehaviorLogsTable)
      .where(inArray(driverBehaviorLogsTable.routeId, routeIds));
    for (const row of behaviorLogs) retainRouteForHistory(archivedRouteIds, row.routeId);

    const vehiclePositions = await tx
      .select({ routeId: vehiclePositionsTable.routeId })
      .from(vehiclePositionsTable)
      .where(and(
        eq(vehiclePositionsTable.organizationId, organizationId),
        inArray(vehiclePositionsTable.routeId, routeIds),
      ));
    for (const row of vehiclePositions) {
      if (row.routeId) retainRouteForHistory(archivedRouteIds, row.routeId);
    }

    const deliveryNotifications = await tx
      .select({ routeId: deliveryNotificationsTable.routeId })
      .from(deliveryNotificationsTable)
      .where(inArray(deliveryNotificationsTable.routeId, routeIds));
    for (const row of deliveryNotifications) {
      if (row.routeId) retainRouteForHistory(archivedRouteIds, row.routeId);
    }

    const notifications = await tx
      .select({ routeId: notificationsTable.routeId })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.organizationId, organizationId),
        inArray(notificationsTable.routeId, routeIds),
      ));
    for (const row of notifications) {
      if (row.routeId) retainRouteForHistory(archivedRouteIds, row.routeId);
    }

    const acknowledgements = await tx
      .select({ routeId: routeAcknowledgementsTable.routeId })
      .from(routeAcknowledgementsTable)
      .where(and(
        eq(routeAcknowledgementsTable.organizationId, organizationId),
        inArray(routeAcknowledgementsTable.routeId, routeIds),
      ));
    for (const row of acknowledgements) retainRouteForHistory(archivedRouteIds, row.routeId);

    const routeMessages = await tx
      .select({ routeId: routeMessagesTable.routeId })
      .from(routeMessagesTable)
      .where(and(
        eq(routeMessagesTable.organizationId, organizationId),
        inArray(routeMessagesTable.routeId, routeIds),
      ));
    for (const row of routeMessages) retainRouteForHistory(archivedRouteIds, row.routeId);

    const stopMessageThreads = await tx
      .select({ routeId: stopMessageThreadsTable.routeId })
      .from(stopMessageThreadsTable)
      .where(and(
        eq(stopMessageThreadsTable.organizationId, organizationId),
        inArray(stopMessageThreadsTable.routeId, routeIds),
      ));
    for (const row of stopMessageThreads) retainRouteForHistory(archivedRouteIds, row.routeId);

    const routeStopIds = routeStops.map((stop) => stop.id);
    if (routeStopIds.length > 0) {
      const deliveryProofs = await tx
        .select({ stopId: deliveryProofsTable.stopId })
        .from(deliveryProofsTable)
        .where(inArray(deliveryProofsTable.stopId, routeStopIds));
      const routeByStopId = new Map(routeStops.map((stop) => [stop.id, stop.routeId!]));
      for (const row of deliveryProofs) {
        const routeId = routeByStopId.get(row.stopId);
        if (routeId) retainRouteForHistory(archivedRouteIds, routeId);
      }

      const serviceReports = await tx
        .select({ stopId: serviceReportsTable.stopId })
        .from(serviceReportsTable)
        .where(and(
          eq(serviceReportsTable.organizationId, organizationId),
          inArray(serviceReportsTable.stopId, routeStopIds),
        ));
      for (const row of serviceReports) {
        const routeId = routeByStopId.get(row.stopId);
        if (routeId) retainRouteForHistory(archivedRouteIds, routeId);
      }
    }

    // A running execution is live even if a legacy route row has inconsistent
    // status/handoff fields. Treat it exactly like a dispatched live route:
    // require the acknowledgement and retain an archive rather than deleting.
    for (const execution of executionRows) {
      if (execution.status !== "active") continue;
      archivedRouteIds.add(execution.routeId);
      liveRouteIds.add(execution.routeId);
      if (!confirmLiveRouteRemoval) {
        const route = routes.find((candidate) => candidate.id === execution.routeId)!;
        conflicts.set(execution.routeId, {
          routeId: execution.routeId,
          reason: "live_confirmation",
          message: "Removing a live, dispatched, or accepted route requires explicit confirmation.",
          routeStatus: route.status,
          handoffStatus: route.handoffStatus,
        });
      }
    }
    for (const routeId of partialPlanRouteIds) {
      const route = routes.find((candidate) => candidate.id === routeId);
      if (route?.draftId && !archivedRouteIds.has(routeId)) {
        const draft = draftById.get(route.draftId);
        if (!draft?.planId || !draft.planPayloadHash || !draft.planResult) {
          conflicts.set(routeId, {
            routeId,
            reason: "partial_plan",
            message: "This generated draft is incomplete and cannot be partially reconciled safely; replan it before deleting a route.",
          });
        }
      }
    }
    for (const routeId of partialPlanRouteIdsWithProtectedSibling) {
      if (!archivedRouteIds.has(routeId)) {
        conflicts.set(routeId, {
          routeId,
          reason: "partial_plan",
          message: "A surviving route is already executing or handed off; the plan cannot be partially changed safely.",
        });
      }
    }
    for (const stop of routeStops) {
      if (!archivedRouteIds.has(stop.routeId!) && stop.status !== "pending") {
        const existing = conflicts.get(stop.routeId!);
        if (!existing || existing.reason === "execution_history") {
          conflicts.set(stop.routeId!, {
            routeId: stop.routeId!,
            reason: "stop_status",
            message: "A route with an active or terminal stop cannot be deleted.",
            stopIds: [stop.id],
          });
        } else {
          existing.stopIds = [...(existing.stopIds ?? []), stop.id];
        }
      }
    }

    if (conflicts.size > 0) {
      throw new RouteDeleteConflictError(
        routes
          .map((route) => conflicts.get(route.id))
          .filter((conflict): conflict is RouteDeleteConflictDetail => Boolean(conflict)),
      );
    }

    const hardDeletedRouteIds = routeIds.filter((routeId) => !archivedRouteIds.has(routeId));
    // A pending order remains in the tenant, but no longer carries the
    // deleted plan identity/date.  Keeping those fields would let a stale
    // draft replay put the order back on the deleted route.
    const releasedStopPatch = {
      routeId: null,
      sequenceOrder: null,
      planningPlanId: null,
      planningDate: null,
      unplannedReason: null,
    };
    if (hardDeletedRouteIds.length > 0) {
      await tx.update(stopsTable).set(releasedStopPatch).where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.routeId, hardDeletedRouteIds),
        eq(stopsTable.status, "pending"),
      ));
    }
    if (archivedRouteIds.size > 0) {
      // An unfinished in-progress stop has no terminal delivery evidence; it
      // becomes a pending, unassigned order. Terminal stops remain attached
      // to the archive with their proofs and event history intact.
      await tx.update(stopsTable).set({
        ...releasedStopPatch,
        status: "pending",
      }).where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.routeId, [...archivedRouteIds]),
        inArray(stopsTable.status, ["pending", "in_progress"]),
      ));
      await tx.update(routeExecutionsTable).set({
        status: "ended",
        endedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(routeExecutionsTable.organizationId, organizationId),
        inArray(routeExecutionsTable.routeId, [...archivedRouteIds]),
        eq(routeExecutionsTable.status, "active"),
      ));
      await tx.update(routesTable).set({
        status: "cancelled",
        planRevision: sql`${routesTable.planRevision} + 1`,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null, receivedAt: null, openedAt: null, acceptedAt: null, rejectedAt: null, rejectionReason: null,
        executionProjection: null,
        redistributionSuggestion: null,
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.id, [...archivedRouteIds]),
      ));
    }

    /*
     * A complete plan deletion clears its generated identity.  A partial
     * deletion instead keeps the frozen plan identity/hash, removes deleted
     * routes from the cached response, records released orders as unassigned,
     * and retains immutable recovery evidence for protected reoptimization.
     */
    for (const draft of drafts) {
      if (hardDeletedRouteIds.length === 0) continue;
      const draftPlanRoutes = groupedRoutes.filter((route) =>
        (draft.planId != null && route.planId === draft.planId) || route.draftId === draft.id,
      );
      const draftDeletedRouteIds = new Set(
        draftPlanRoutes
          .filter((route) => hardDeletedRouteIds.includes(route.id))
          .map((route) => route.id),
      );
      const draftSurvivingRouteIds = new Set(
        draftPlanRoutes
          .filter((route) => !hardDeletedRouteIds.includes(route.id))
          .map((route) => route.id),
      );
      const isPartialPlan = draftDeletedRouteIds.size > 0 && draftSurvivingRouteIds.size > 0;
      if (isPartialPlan) {
        const draftReleasedStopIds = routeStops
          .filter((stop) =>
            stop.status === "pending"
            && stop.routeId != null
            && draftDeletedRouteIds.has(stop.routeId))
          .map((stop) => stop.id);
        const existingMetadata = draft.state.planningMetadata;
        const planningMetadata = existingMetadata && typeof existingMetadata === "object"
          && !Array.isArray(existingMetadata)
          ? existingMetadata as Record<string, unknown>
          : {};
        const previousTombstones = Array.isArray(planningMetadata.routeDeletionTombstones)
          ? planningMetadata.routeDeletionTombstones
          : [];
        const tombstone = {
          routeIds: [...draftDeletedRouteIds],
          stopIds: draftReleasedStopIds,
          deletedAt: new Date().toISOString(),
        };
        const nextState = removeDeletedRouteReferences(
          draft.state,
          draftDeletedRouteIds,
          draftSurvivingRouteIds,
        ) as Record<string, unknown>;
        const statePlanningInputs = nextState.planningInputs;
        if (
          statePlanningInputs
          && typeof statePlanningInputs === "object"
          && !Array.isArray(statePlanningInputs)
        ) {
          const statePriorities = (statePlanningInputs as Record<string, unknown>).stopPriorities;
          if (statePriorities && typeof statePriorities === "object" && !Array.isArray(statePriorities)) {
            const nextPriorities = { ...(statePriorities as Record<string, unknown>) };
            for (const stopId of draftReleasedStopIds) delete nextPriorities[stopId];
            nextState.planningInputs = {
              ...(statePlanningInputs as Record<string, unknown>),
              stopPriorities: nextPriorities,
            };
          }
        }
        nextState.planningMetadata = {
          ...planningMetadata,
          routeDeletionTombstones: [...previousTombstones, tombstone],
        };
        await tx.update(planningDraftsTable).set({
          // Keep planId and planPayloadHash frozen: replay can only hydrate
          // the surviving live routes and cannot create a new plan here.
          planResult: reconcilePartialPlanResult(
            draft.planResult,
            draftDeletedRouteIds,
            draftSurvivingRouteIds,
            draftReleasedStopIds,
          ),
          state: nextState as typeof draft.state,
          revision: sql`${planningDraftsTable.revision} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(planningDraftsTable.id, draft.id),
          eq(planningDraftsTable.organizationId, organizationId),
        ));
      } else if (draft.planId !== null || draft.planPayloadHash !== null || draft.planResult !== null) {
        const clearedState = removeDeletedRouteReferences(
          draft.state,
          draftDeletedRouteIds,
          new Set<string>(),
        ) as typeof draft.state;
        await tx.update(planningDraftsTable).set({
          planId: null,
          planPayloadHash: null,
          planResult: null,
          state: clearedState,
          revision: sql`${planningDraftsTable.revision} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(planningDraftsTable.id, draft.id),
          eq(planningDraftsTable.organizationId, organizationId),
        ));
      }
    }

    const deleted = hardDeletedRouteIds.length === 0
      ? []
      : await tx.delete(routesTable).where(and(
          eq(routesTable.organizationId, organizationId),
          inArray(routesTable.id, hardDeletedRouteIds),
        )).returning({ id: routesTable.id });
    if (deleted.length !== hardDeletedRouteIds.length) {
      // This should only be possible if a database-side trigger changed the
      // route set between locking and deletion; preserve all-or-none behavior.
      throw new RouteDeleteNotFoundError();
    }
    // Removed/cancelled routes invalidate pair evidence stored on every
    // surviving counterpart. This is deliberately a derived-only update.
    await tx
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.optimizationFrozen, false)));
    return {
      deletedRouteIds: deleted.map((route) => route.id),
      deletedCount: deleted.length,
      archivedRouteIds: routeIds.filter((routeId) => archivedRouteIds.has(routeId)),
      archivedCount: archivedRouteIds.size,
    };
  });

  for (const routeId of result.deletedRouteIds) {
    broadcastDataChange(organizationId, "route", "deleted", { id: routeId });
    broadcastDataChange(organizationId, "stop", "updated", { routeId, bulk: true });
  }
  for (const routeId of result.archivedRouteIds) {
    broadcastDataChange(organizationId, "route", "updated", {
      id: routeId,
      status: "cancelled",
      archived: true,
    });
    broadcastDataChange(organizationId, "stop", "updated", { routeId, bulk: true });
  }
  return {
    deletedRouteIds: requestedRouteIds.filter((routeId) =>
      result.deletedRouteIds.includes(routeId.toLowerCase())),
    deletedCount: result.deletedCount,
    archivedRouteIds: requestedRouteIds.filter((routeId) =>
      result.archivedRouteIds.includes(routeId.toLowerCase())),
    archivedCount: result.archivedCount,
  };
}

export async function deleteRoute(
  id: string,
  organizationId: string,
  confirmLiveRouteRemoval: boolean,
) {
  const result = await deleteRoutes([id], organizationId, confirmLiveRouteRemoval);
  return result.deletedCount + result.archivedCount === 1 ? id : null;
}

export async function getRouteStops(
  routeId: string,
  organizationId: string,
  principal?: StopReadPrincipal,
) {
  if (principal?.role === "driver") {
    const route = await getRoute(routeId, organizationId);
    if (!route || route.handoffDriverId !== principal.driverProfileId) return null;
    return (await outgoingStops(await outgoingRoute(route)))
      .map((stop) => projectStopForReadRole(stop, principal.role));
  }
  const [route] = await db
    .select({ id: routesTable.id, status: routesTable.status })
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return null;

  const stops = await db
    .select()
    .from(stopsTable)
    .where(and(
      eq(stopsTable.routeId, routeId),
      // Terminal routes are explicit history views; operational planning and
      // driver route reads must not surface archived work.
      ...(["completed", "cancelled"].includes(route.status) ? [] : [isNull(stopsTable.archivedAt)]),
    ))
    .orderBy(stopsTable.sequenceOrder);
  return principal
    ? stops.map((stop) => projectStopForReadRole(stop, principal.role))
    : stops;
}

export async function exportRoute(routeId: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return null;

  let vehicleName = "Unassigned";
  if (route.vehicleId) {
    const [vehicle] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
    if (vehicle) vehicleName = vehicle.name;
  }

  const stops = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.routeId, routeId))
    .orderBy(stopsTable.sequenceOrder);

  return { route, vehicleName, stops };
}

export async function reorderStops(
  routeId: string,
  organizationId: string,
  stopIds: string[],
  expectedPlanRevision: number,
) {
  return reorderAssignedRouteStops(
    organizationId,
    routeId,
    stopIds,
    expectedPlanRevision,
  );
}

export async function rescheduleFailedStops(routeId: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return { error: "Route not found", status: 404 };

  const failedStops = await db
    .select()
    .from(stopsTable)
    .where(and(eq(stopsTable.routeId, routeId), eq(stopsTable.status, "failed")))
    .orderBy(stopsTable.sequenceOrder);
  if (failedStops.length === 0) return { error: "No failed stops to reschedule", status: 400 };

  const nextDay = new Date(route.date);
  nextDay.setDate(nextDay.getDate() + 1);

  for (const stop of failedStops) {
    if (stop.jobType === "field_service") {
      await assertVehicleEligibleForFieldService(
        organizationId,
        route.vehicleId,
        fieldServiceRequirementsFromStop(stop),
        nextDay,
      );
    }
  }

  const newRoute = await db.transaction(async (tx) => {
    const [created] = await tx.insert(routesTable).values({
      organizationId,
      name: `${route.name} (omplanerad)`,
      date: nextDay,
      vehicleId: route.vehicleId,
      totalStops: failedStops.length,
      status: "draft",
    }).returning();

    const stopsToInsert = failedStops.map((s, idx) => ({
      organizationId,
      routeId: created.id,
      customerId: s.customerId,
      address: s.address,
      latitude: s.latitude,
      longitude: s.longitude,
      serviceDurationMin: s.serviceDurationMin,
      weightKg: s.weightKg,
      volumeM3: s.volumeM3,
      notes: s.notes ? `Omplanerad: ${s.notes}` : "Omplanerad från misslyckad leverans",
      sequenceOrder: idx + 1,
      timeWindowStart: s.timeWindowStart,
      timeWindowEnd: s.timeWindowEnd,
      status: "pending" as const,
      contactName: s.contactName,
      contactEmail: s.contactEmail,
      contactPhone: s.contactPhone,
      externalRef: s.externalRef,
      pickupAddress: s.pickupAddress,
      pickupLatitude: s.pickupLatitude,
      pickupLongitude: s.pickupLongitude,
      jobType: s.jobType,
      priority: s.priority,
      slaDeadline: s.slaDeadline,
      serviceCategory: s.serviceCategory,
      serviceInstructions: s.serviceInstructions,
      requiredSkills: s.requiredSkills,
      requiredCertifications: s.requiredCertifications,
      requiredEquipment: s.requiredEquipment,
      customFields: s.customFields,
      ...((s as typeof s & { unavailablePeriods?: unknown }).unavailablePeriods != null
        ? {
            unavailablePeriods: (s as typeof s & {
              unavailablePeriods?: unknown;
            }).unavailablePeriods,
          }
        : {}),
    }));
    // The stop schema may be deployed independently of this scheduling
    // change; keep the snapshot field structural until both packages agree
    // on its generated Drizzle type.
    await tx.insert(stopsTable).values(stopsToInsert as any);
    return created;
  });

  return { data: newRoute };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getRouteComparison(routeId: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return null;

  let vehicle = null;
  if (route.vehicleId) {
    const [v] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
    vehicle = v || null;
  }

  const stops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId)).orderBy(stopsTable.sequenceOrder);
  const completedStops = stops.filter((s) => s.status === "completed");
  const failedStops = stops.filter((s) => s.status === "failed");
  const skippedStops = stops.filter((s) => s.status === "skipped");
  const pendingStops = stops.filter((s) => s.status === "pending" || s.status === "in_progress");

  let plannedDistanceKm = 0;
  for (let i = 1; i < stops.length; i++) {
    plannedDistanceKm += haversineKm(stops[i - 1].latitude, stops[i - 1].longitude, stops[i].latitude, stops[i].longitude);
  }
  let actualDistanceKm = 0;
  for (let i = 1; i < completedStops.length; i++) {
    actualDistanceKm += haversineKm(completedStops[i - 1].latitude, completedStops[i - 1].longitude, completedStops[i].latitude, completedStops[i].longitude);
  }

  const plannedDurationMin = route.totalDurationMin || stops.length * 15;
  const actualServiceMin = completedStops.reduce((sum, s) => sum + (s.serviceDurationMin || 5), 0);
  const completionRate = stops.length > 0 ? Math.round((completedStops.length / stops.length) * 100) : 0;

  return {
    route: { id: route.id, name: route.name, status: route.status, date: route.date, vehicleName: vehicle ? `${vehicle.name} (${vehicle.licensePlate})` : null },
    planned: { totalStops: stops.length, distanceKm: Math.round(plannedDistanceKm * 10) / 10, durationMin: plannedDurationMin, co2Kg: route.co2EmissionsKg || 0, coordinates: stops.map((s) => ({ lat: s.latitude, lng: s.longitude, address: s.address, status: s.status })) },
    actual: { completedStops: completedStops.length, failedStops: failedStops.length, skippedStops: skippedStops.length, pendingStops: pendingStops.length, distanceKm: Math.round(actualDistanceKm * 10) / 10, serviceDurationMin: actualServiceMin, completionRate, coordinates: completedStops.map((s) => ({ lat: s.latitude, lng: s.longitude, address: s.address })) },
    stops: stops.map((s) => ({ id: s.id, address: s.address, status: s.status, sequenceOrder: s.sequenceOrder, latitude: s.latitude, longitude: s.longitude, serviceDurationMin: s.serviceDurationMin })),
  };
}

async function updateHappinessScoreForVehicle(vehicleId: string, organizationId: string) {
  const drivers = await db
    .select()
    .from(driversTable)
    .where(and(eq(driversTable.vehicleId, vehicleId), eq(driversTable.organizationId, organizationId)));

  for (const driver of drivers) {
    let [prefs] = await db
      .select()
      .from(driverPreferencesTable)
      .where(eq(driverPreferencesTable.driverId, driver.id));
    if (!prefs) {
      [prefs] = await db.insert(driverPreferencesTable).values({ driverId: driver.id }).returning();
    }
    const score = await computeHappinessScore(driver.id, organizationId, prefs);
    if (score !== prefs.happinessScore) {
      await db.update(driverPreferencesTable).set({ happinessScore: score }).where(eq(driverPreferencesTable.driverId, driver.id));
    }
  }
}
