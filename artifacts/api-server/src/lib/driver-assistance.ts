import { outgoingRoute, outgoingStops } from "../services/outgoing-route-service";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { db, driversTable, routesTable, stopsTable } from "@workspace/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An assistance context is deliberately separate from authentication.  The
 * admin remains the request actor; the selected driver is only the execution
 * recipient used for the same ownership checks a driver receives.
 */
export type DriverAssistanceContext = {
  driverId: string;
  routeId: string;
};

export class DriverAssistanceError extends Error {
  constructor(message: string, readonly statusCode = 403) {
    super(message);
    this.name = "DriverAssistanceError";
  }
}

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Parses the opt-in context and rejects partial or non-admin attempts. */
export function getDriverAssistanceContext(req: Request): DriverAssistanceContext | null {
  const driverId = header(req, "x-traivo-assist-driver-id");
  const routeId = header(req, "x-traivo-assist-route-id");
  if (!driverId && !routeId) return null;
  if (!driverId || !routeId || !UUID.test(driverId) || !UUID.test(routeId)) {
    throw new DriverAssistanceError("A valid selected driver and route are required for driver assistance", 400);
  }
  if (req.user?.role !== "admin") {
    throw new DriverAssistanceError("Only administrators may use driver assistance");
  }
  return { driverId, routeId };
}

/**
 * Call this only after the route row has been locked.  It keeps every assisted
 * action tied to the currently assigned recipient and current plan revision.
 */
export function assertCurrentDriverAssistance(
  route: {
    id: string;
    handoffDriverId: string | null;
    handoffVersion: number | null;
    planRevision: number;
  },
  context: DriverAssistanceContext | null,
): void {
  if (!context) return;
  if (
    route.id !== context.routeId
    || route.handoffDriverId !== context.driverId
    || route.handoffVersion == null
  ) {
    throw new DriverAssistanceError(
      "The selected driver is no longer assigned to this current route plan",
      409,
    );
  }
}

/**
 * Validates an assisted read (or the precondition for a write which performs
 * its own locked revalidation). This deliberately includes the selected
 * driver's tenant membership; matching untrusted header UUIDs is never enough.
 */
export async function validateDriverAssistanceContext(
  req: Request,
  target: { driverId?: string; routeId?: string; stopId?: string } = {},
): Promise<DriverAssistanceContext | null> {
  const context = getDriverAssistanceContext(req);
  if (!context) return null;
  if (
    (target.driverId && target.driverId !== context.driverId)
    || (target.routeId && target.routeId !== context.routeId)
  ) {
    throw new DriverAssistanceError("The request is outside the selected driver assistance scope", 409);
  }

  const [row] = await db
    .select({ route: routesTable })
    .from(routesTable)
    .innerJoin(driversTable, and(
      eq(driversTable.id, context.driverId),
      eq(driversTable.organizationId, req.user!.organizationId),
      eq(driversTable.isActive, true),
      eq(routesTable.handoffDriverId, context.driverId),
    ))
    .where(and(
      eq(routesTable.id, context.routeId),
      eq(routesTable.organizationId, req.user!.organizationId),
    ))
    .limit(1);
  if (!row) {
    throw new DriverAssistanceError("The selected driver is no longer assigned to this route", 409);
  }
  const projected = await outgoingRoute(row.route);
  assertCurrentDriverAssistance(projected, context);

  if (target.stopId) {
    const stop = (await outgoingStops(projected)).find((candidate) => candidate.id === target.stopId);
    if (!stop) {
      throw new DriverAssistanceError("The requested stop is outside the selected route", 409);
    }
  }
  return context;
}

/** The effective driver is used exclusively for execution ownership checks. */
export function executionActorForRequest(req: Request, context: DriverAssistanceContext | null) {
  return {
    organizationId: req.user!.organizationId,
    actorUserId: req.user!.id,
    // Preserve the actual actor id above; role/driver below only select the
    // established driver ownership guard in the execution service.
    role: context ? "driver" : req.user!.role,
    driverProfileId: context?.driverId ?? req.user!.driverProfileId,
    assistedRouteId: context?.routeId ?? null,
    assistedDriverId: context?.driverId ?? null,
  };
}