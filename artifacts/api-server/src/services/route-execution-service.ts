import { and, eq } from "drizzle-orm";
import {
  db,
  routeExecutionsTable,
  routesTable,
  stopsTable,
  type RouteExecutionSummary,
} from "@workspace/db";
import { broadcastTenantEvent } from "../ws";
import { assertCurrentDriverAssistance } from "../lib/driver-assistance";
import { outgoingRoute, outgoingStops, OutgoingVersionError, type OutgoingDatabase } from "./outgoing-route-service";

export type RouteExecutionCoordinates = {
  latitude?: number | null;
  longitude?: number | null;
};

export class RouteExecutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RouteExecutionError";
  }
}


type Actor = {
  organizationId: string;
  actorUserId: string;
  role: string;
  driverProfileId: string | null;
  assistedRouteId?: string | null;
  assistedDriverId?: string | null;
};

async function executionOutgoingRoute(route: typeof routesTable.$inferSelect, actor: Actor, database: OutgoingDatabase = db) {
  if (actor.role === "driver" && route.handoffDriverId !== actor.driverProfileId) {
    throw new RouteExecutionError("Forbidden: route is assigned to another driver", 403);
  }
  try { return await outgoingRoute(route, database); }
  catch (error) {
    if (error instanceof OutgoingVersionError) throw new RouteExecutionError(error.message, error.statusCode, error.code);
    throw error;
  }
}

function isFiniteCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateCoordinates(input: RouteExecutionCoordinates): RouteExecutionCoordinates {
  const hasLatitude = input.latitude != null;
  const hasLongitude = input.longitude != null;
  if (hasLatitude !== hasLongitude) {
    throw new RouteExecutionError("latitude and longitude must be provided together", 400);
  }
  if (
    hasLatitude
    && (
      !isFiniteCoordinate(input.latitude, -90, 90)
      || !isFiniteCoordinate(input.longitude, -180, 180)
    )
  ) {
    throw new RouteExecutionError("Invalid execution coordinates", 400);
  }
  return input;
}

function assertCurrentPlanAuthorization(
  route: typeof routesTable.$inferSelect,
  actor: Actor,
): void {
  assertCurrentDriverAssistance(route, actor.assistedRouteId && actor.assistedDriverId
    ? { routeId: actor.assistedRouteId, driverId: actor.assistedDriverId }
    : null);
  if (
    route.handoffStatus !== "accepted"
    || route.handoffVersion !== route.planRevision
    || !route.handoffDriverId
  ) {
    throw new RouteExecutionError(
      "The current route plan must be dispatched and accepted before execution",
      409,
    );
  }
  if (actor.role === "driver" && route.handoffDriverId !== actor.driverProfileId) {
    throw new RouteExecutionError("Route is not assigned to this driver", 403);
  }
}

function assertAcceptedRoute(
  route: typeof routesTable.$inferSelect,
  actor: Actor,
): void {
  if (route.status === "completed" || route.status === "cancelled") {
    throw new RouteExecutionError("Completed or cancelled routes cannot be executed", 409);
  }
  assertCurrentPlanAuthorization(route, actor);
}

async function getCurrentRouteExecution(
  routeId: string,
  organizationId: string,
  planVersion: number,
) {
  const [execution] = await db
    .select()
    .from(routeExecutionsTable)
    .where(and(
      eq(routeExecutionsTable.routeId, routeId),
      eq(routeExecutionsTable.organizationId, organizationId),
      eq(routeExecutionsTable.planVersion, planVersion),
    ))
    .limit(1);
  return execution ?? null;
}

function assertEventId(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new RouteExecutionError(`${field} is required and must be at most 200 characters`, 400);
  }
}

function parseTimestamp(value: string | undefined, field: string, fallback: Date): Date {
  if (value == null) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RouteExecutionError(`${field} must be a valid ISO timestamp`, 400);
  }
  return parsed;
}

function sameCoordinates(
  existing: { startLatitude: number | null; startLongitude: number | null },
  input: RouteExecutionCoordinates,
): boolean {
  return (
    existing.startLatitude === (input.latitude ?? null)
    && existing.startLongitude === (input.longitude ?? null)
  );
}

function sameEndCoordinates(
  existing: { endLatitude: number | null; endLongitude: number | null },
  input: RouteExecutionCoordinates,
): boolean {
  return (
    existing.endLatitude === (input.latitude ?? null)
    && existing.endLongitude === (input.longitude ?? null)
  );
}

function hasUnfinishedStops(stops: Array<{ status: string }>): boolean {
  return stops.some((stop) =>
    stop.status !== "completed"
    && stop.status !== "failed"
    && stop.status !== "skipped"
  );
}

function assertExecutionDriverMatchesRoute(
  execution: Pick<typeof routeExecutionsTable.$inferSelect, "driverId">,
  route: Pick<typeof routesTable.$inferSelect, "handoffDriverId">,
): void {
  if (!route.handoffDriverId || execution.driverId !== route.handoffDriverId) {
    throw new RouteExecutionError(
      "The current route execution does not match the assigned driver",
      409,
    );
  }
}

export async function startRouteExecution(args: {
  routeId: string;
  clientEventId: string;
  startedAt?: string;
  coordinates?: RouteExecutionCoordinates;
  actor: Actor;
}) {
  assertEventId(args.clientEventId, "clientEventId");
  const coordinates = validateCoordinates(args.coordinates ?? {});
  const startedAt = parseTimestamp(args.startedAt, "startedAt", new Date());
  const actor = args.actor;

  let persisted;
  try {
    persisted = await db.transaction(async (tx) => {
      let [route] = await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, args.routeId),
          eq(routesTable.organizationId, actor.organizationId),
        ))
        .limit(1)
        .for("update");
      if (!route) throw new RouteExecutionError("Route not found", 404);
      const workingRevision = route.planRevision;
      if (route.dispatchSnapshotVersion != null || actor.role === "driver") route = await executionOutgoingRoute(route, actor, tx);

      assertAcceptedRoute(route, actor);

      const [existing] = await tx
        .select()
        .from(routeExecutionsTable)
        .where(and(
          eq(routeExecutionsTable.organizationId, actor.organizationId),
          eq(routeExecutionsTable.routeId, route.id),
          eq(routeExecutionsTable.planVersion, route.planRevision),
        ))
        .limit(1);
      if (existing) {
        assertExecutionDriverMatchesRoute(existing, route);
        if (
          existing.startClientEventId !== args.clientEventId
          || (
            args.startedAt != null
            && existing.startedAt.toISOString() !== startedAt.toISOString()
          )
          || !sameCoordinates(existing, coordinates)
        ) {
          throw new RouteExecutionError(
            "Route execution has already started for this plan version",
            409,
          );
        }

        // Older servers allowed an execution to be ended while stops were
        // still unfinished.  Keep that data recoverable, but only reopen the
        // exact original start event, for the currently accepted in-progress
        // route.  This does not make a terminal/completed route executable
        // again and does not weaken the plan or driver guards above.
        if (existing.status === "ended" && route.status === "in_progress") {
          const stops = await tx
            .select({ status: stopsTable.status })
            .from(stopsTable)
            .where(and(
              eq(stopsTable.organizationId, actor.organizationId),
              eq(stopsTable.routeId, route.id),
            ));
          if (hasUnfinishedStops(stops)) {
            const [reopenedExecution] = await tx
              .update(routeExecutionsTable)
              .set({
                status: "active",
                endedAt: null,
                endLatitude: null,
                endLongitude: null,
                // Tracking's mobile session endpoint intentionally reuses
                // clientSessionId for start and end. In that legacy shape
                // there is no distinct retired event id to preserve; the
                // resumed session must be allowed to end with that same id.
                endClientEventId: existing.endClientEventId === existing.startClientEventId
                  ? null
                  : existing.endClientEventId,
                endedByUserId: null,
                summary: null,
                updatedAt: new Date(),
              })
              .where(and(
                eq(routeExecutionsTable.id, existing.id),
                eq(routeExecutionsTable.status, "ended"),
              ))
              .returning();
            if (!reopenedExecution) {
              throw new RouteExecutionError(
                "Route execution changed while resuming; retry with the same clientEventId",
                409,
              );
            }
            return { execution: reopenedExecution, duplicate: false as const, route };
          }
        }

        return { execution: existing, duplicate: true as const, route };
      }

      const [execution] = await tx
        .insert(routeExecutionsTable)
        .values({
          organizationId: actor.organizationId,
          routeId: route.id,
          driverId: route.handoffDriverId!,
          planVersion: route.planRevision,
          status: "active",
          startedAt,
          startLatitude: coordinates.latitude ?? null,
          startLongitude: coordinates.longitude ?? null,
          startClientEventId: args.clientEventId,
          startedByUserId: actor.actorUserId,
        })
        .returning();
      if (!execution) {
        throw new RouteExecutionError("Route execution could not be started", 500);
      }
      const [updatedRoute] = await tx
        .update(routesTable)
        .set({ ...(workingRevision === route.planRevision ? { status: "in_progress" as const } : {}), updatedAt: new Date() })
        .where(and(
          eq(routesTable.id, route.id),
          eq(routesTable.organizationId, actor.organizationId),
        ))
        .returning();
      return { execution, duplicate: false as const,
        route: updatedRoute?.dispatchSnapshotVersion != null ? await outgoingRoute(updatedRoute, tx) : updatedRoute ?? route };
    });
  } catch (error) {
    if (error instanceof RouteExecutionError) throw error;
    const candidate = error as { code?: string; cause?: { code?: string } };
    if (candidate.code !== "23505" && candidate.cause?.code !== "23505") throw error;
    let [route] = await db
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.id, args.routeId),
        eq(routesTable.organizationId, actor.organizationId),
      ))
      .limit(1);
    if (route && (route.dispatchSnapshotVersion != null || actor.role === "driver")) route = await executionOutgoingRoute(route, actor);
    const execution = route
      ? await getCurrentRouteExecution(args.routeId, actor.organizationId, route.planRevision)
      : null;
    if (route && execution) assertExecutionDriverMatchesRoute(execution, route);
    if (
      !execution
      || execution.startClientEventId !== args.clientEventId
      || (
        args.startedAt != null
        && execution.startedAt.toISOString() !== startedAt.toISOString()
      )
      || !sameCoordinates(execution, coordinates)
    ) {
      throw new RouteExecutionError(
        "Route execution changed while starting; reload and retry",
        409,
      );
    }
    persisted = { execution, duplicate: true as const };
  }

  if (!persisted.duplicate) {
    const { notifyRouteCustomers } = await import("./customer-notifications");
    void notifyRouteCustomers(args.routeId, actor.organizationId, "approaching");
    await broadcastTenantEvent(actor.organizationId, "route:execution-started", {
      routeId: args.routeId,
      execution: persisted.execution,
    });
  }
  return persisted;
}

function summarizeStops(
  stops: Array<{ status: string }>,
  startedAt: Date,
  endedAt: Date,
  distanceKm: number | null,
): RouteExecutionSummary {
  const completedStops = stops.filter((stop) => stop.status === "completed").length;
  const failedStops = stops.filter((stop) => stop.status === "failed").length;
  const skippedStops = stops.filter((stop) => stop.status === "skipped").length;
  return {
    totalStops: stops.length,
    completedStops,
    failedStops,
    skippedStops,
    pendingStops: Math.max(0, stops.length - completedStops - failedStops - skippedStops),
    durationMin: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000)),
    distanceKm,
  };
}

export async function endRouteExecution(args: {
  routeId: string;
  clientEventId: string;
  endedAt?: string;
  coordinates?: RouteExecutionCoordinates;
  actor: Actor;
}) {
  assertEventId(args.clientEventId, "clientEventId");
  const coordinates = validateCoordinates(args.coordinates ?? {});
  const actor = args.actor;
  const requestedEndedAt = parseTimestamp(args.endedAt, "endedAt", new Date());

  let persisted;
  try {
    persisted = await db.transaction(async (tx) => {
      let [route] = await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, args.routeId),
          eq(routesTable.organizationId, actor.organizationId),
        ))
        .limit(1)
        .for("update");
      if (!route) throw new RouteExecutionError("Route not found", 404);
      const workingRevision = route.planRevision;
      if (route.dispatchSnapshotVersion != null || actor.role === "driver") route = await executionOutgoingRoute(route, actor, tx);

      // A completed route may still receive an idempotent retry of the exact
      // end event. Authorize against the current handoff/plan first, but do
      // this before the terminal-status check in assertAcceptedRoute.
      assertCurrentPlanAuthorization(route, actor);
      const [replayedExecution] = await tx
        .select()
        .from(routeExecutionsTable)
        .where(and(
          eq(routeExecutionsTable.organizationId, actor.organizationId),
          eq(routeExecutionsTable.routeId, route.id),
          eq(routeExecutionsTable.planVersion, route.planRevision),
          eq(routeExecutionsTable.status, "ended"),
          eq(routeExecutionsTable.endClientEventId, args.clientEventId),
        ))
        .limit(1)
        .for("update");
      if (replayedExecution) {
        assertExecutionDriverMatchesRoute(replayedExecution, route);
        if (
          (actor.role === "driver" && replayedExecution.driverId !== actor.driverProfileId)
          || (
            args.endedAt != null
            && replayedExecution.endedAt?.toISOString() !== requestedEndedAt.toISOString()
          )
          || !sameEndCoordinates(replayedExecution, coordinates)
        ) {
          throw new RouteExecutionError(
            "clientEventId was already used for a different route end",
            409,
          );
        }
        return { execution: replayedExecution, duplicate: true as const, route };
      }
      assertAcceptedRoute(route, actor);

      const [execution] = await tx
        .select()
        .from(routeExecutionsTable)
        .where(and(
          eq(routeExecutionsTable.organizationId, actor.organizationId),
          eq(routeExecutionsTable.routeId, route.id),
          eq(routeExecutionsTable.planVersion, route.planRevision),
        ))
        .limit(1)
        .for("update");
      if (!execution) {
        throw new RouteExecutionError(
          "Route execution has not been started for this plan version",
          409,
        );
      }

      assertExecutionDriverMatchesRoute(execution, route);
      if (execution.status === "ended") {
        throw new RouteExecutionError("Route execution has already ended", 409);
      }

      // A legacy ended execution can be resumed with its original start
      // event. Keep its old end event id as a retired-event marker so a late
      // retry of that event cannot terminate the resumed execution.
      if (execution.endClientEventId === args.clientEventId) {
        throw new RouteExecutionError(
          "The previous route end event was superseded while resuming; use a new clientEventId",
          409,
        );
      }

      const endedAt = requestedEndedAt;
      if (endedAt.getTime() < execution.startedAt.getTime()) {
        throw new RouteExecutionError("endedAt cannot be before startedAt", 400);
      }
      let stops = await tx
        .select({ status: stopsTable.status })
        .from(stopsTable)
        .where(and(
          eq(stopsTable.organizationId, actor.organizationId),
          eq(stopsTable.routeId, route.id),
        ));
      if (route.dispatchSnapshotVersion != null) stops = await outgoingStops(route, tx);
      if (hasUnfinishedStops(stops)) {
        throw new RouteExecutionError(
          "Route has unfinished stops; complete, fail, or skip them before ending execution",
          409,
          "ROUTE_STOPS_REMAIN",
        );
      }
      const summary = summarizeStops(
        stops,
        execution.startedAt,
        endedAt,
        route.totalDistanceKm ?? null,
      );
      const [updatedExecution] = await tx
        .update(routeExecutionsTable)
        .set({
          status: "ended",
          endedAt,
          endLatitude: coordinates.latitude ?? null,
          endLongitude: coordinates.longitude ?? null,
          endClientEventId: args.clientEventId,
          endedByUserId: actor.actorUserId,
          summary,
          updatedAt: new Date(),
        })
        .where(and(
          eq(routeExecutionsTable.id, execution.id),
          eq(routeExecutionsTable.status, "active"),
        ))
        .returning();
      if (!updatedExecution) {
        throw new RouteExecutionError(
          "Route execution changed while ending; retry with the same clientEventId",
          409,
        );
      }

      const nextStatus = summary.pendingStops === 0 ? "completed" : "in_progress";
      const [updatedRoute] = await tx
        .update(routesTable)
        .set({ ...(workingRevision === route.planRevision ? { status: nextStatus } : {}), updatedAt: new Date() })
        .where(and(
          eq(routesTable.id, route.id),
          eq(routesTable.organizationId, actor.organizationId),
        ))
        .returning();
      return {
        execution: updatedExecution,
        duplicate: false as const,
        route: updatedRoute?.dispatchSnapshotVersion != null ? await outgoingRoute(updatedRoute, tx) : updatedRoute ?? route,
      };
    });
  } catch (error) {
    if (error instanceof RouteExecutionError) throw error;
    const candidate = error as { code?: string; cause?: { code?: string } };
    if (candidate.code !== "23505" && candidate.cause?.code !== "23505") throw error;
    let [route] = await db
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.id, args.routeId),
        eq(routesTable.organizationId, actor.organizationId),
      ))
      .limit(1);
    if (route && (route.dispatchSnapshotVersion != null || actor.role === "driver")) route = await executionOutgoingRoute(route, actor);
    if (route) assertCurrentPlanAuthorization(route, actor);
    const execution = route
      ? await getCurrentRouteExecution(args.routeId, actor.organizationId, route.planRevision)
      : null;
    if (route && execution) assertExecutionDriverMatchesRoute(execution, route);
    if (
      !execution
      || execution.endClientEventId !== args.clientEventId
      || (
        args.endedAt != null
        && execution.endedAt?.toISOString() !== requestedEndedAt.toISOString()
      )
      || !sameEndCoordinates(execution, coordinates)
    ) {
      throw new RouteExecutionError(
        "Route execution changed while ending; reload and retry",
        409,
      );
    }
    persisted = { execution, duplicate: true as const };
  }

  if (!persisted.duplicate) {
    await broadcastTenantEvent(actor.organizationId, "route:execution-ended", {
      routeId: args.routeId,
      execution: persisted.execution,
    });
  }
  return persisted;
}

export async function getActiveRouteExecution(routeId: string, organizationId: string) {
  const [route] = await db
    .select({
      planRevision: routesTable.handoffVersion,
      handoffDriverId: routesTable.handoffDriverId,
    })
    .from(routesTable)
    .where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ))
    .limit(1);
  if (!route) return null;
  if (route.planRevision == null) return null;
  const execution = await getCurrentRouteExecution(routeId, organizationId, route.planRevision);
  return execution?.status === "active"
    && execution.driverId === route.handoffDriverId
    ? execution
    : null;
}

export async function getRouteExecution(routeId: string, organizationId: string) {
  const [route] = await db
    .select({
      planRevision: routesTable.handoffVersion,
      handoffDriverId: routesTable.handoffDriverId,
    })
    .from(routesTable)
    .where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ))
    .limit(1);
  if (!route) return null;
  if (route.planRevision == null) return null;
  const execution = await getCurrentRouteExecution(routeId, organizationId, route.planRevision);
  return execution && execution.driverId === route.handoffDriverId
    ? execution
    : null;
}