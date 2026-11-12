import { outgoingRoute } from "../services/outgoing-route-service";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, routesTable, vehiclePositionsTable } from "@workspace/db";
import { getOrgId, requireRole } from "../middleware/auth";
import { handleError, parseUuidParam } from "../lib/errors";
import {
  endRouteExecution,
  getRouteExecution,
  RouteExecutionError,
  startRouteExecution,
} from "../services/route-execution-service";
import {
  DriverAssistanceError,
  executionActorForRequest,
  getDriverAssistanceContext,
  validateDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();

const LifecycleBody = z.object({
  clientEventId: z.string().trim().min(1).max(200),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  // occurredAt is accepted as the mobile-friendly alias for either lifecycle edge.
  occurredAt: z.string().datetime().optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
}).strict();

function actorFor(req: Request) {
  return executionActorForRequest(req, getDriverAssistanceContext(req));
}

async function startHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = parseUuidParam(req.params);
    const body = LifecycleBody.parse(req.body ?? {});
    const result = await startRouteExecution({
      routeId: id,
      clientEventId: body.clientEventId,
      startedAt: body.startedAt ?? body.occurredAt,
      coordinates: { latitude: body.latitude, longitude: body.longitude },
      actor: actorFor(req),
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof RouteExecutionError || error instanceof DriverAssistanceError) {
      res.status(error.statusCode).json({
        error: error.message,
        ...(error instanceof RouteExecutionError && error.code ? { code: error.code } : {}),
      });
      return;
    }
    handleError(res, error);
  }
}

async function endHandler(req: Request, res: Response): Promise<void> {
  try {
    const { id } = parseUuidParam(req.params);
    const body = LifecycleBody.parse(req.body ?? {});
    const result = await endRouteExecution({
      routeId: id,
      clientEventId: body.clientEventId,
      endedAt: body.endedAt ?? body.occurredAt,
      coordinates: { latitude: body.latitude, longitude: body.longitude },
      actor: actorFor(req),
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof RouteExecutionError || error instanceof DriverAssistanceError) {
      res.status(error.statusCode).json({
        error: error.message,
        ...(error instanceof RouteExecutionError && error.code ? { code: error.code } : {}),
      });
      return;
    }
    handleError(res, error);
  }
}

function sessionResponse(
  execution: Awaited<ReturnType<typeof getRouteExecution>> extends infer T
    ? Exclude<T, null>
    : never,
  sampleCount = 0,
  lastPosition: Record<string, unknown> | null = null,
  plannedDistanceKm: number | null = null,
) {
  return {
    routeId: execution.routeId,
    sessionId: execution.id,
    clientSessionId: execution.startClientEventId,
    status: execution.status,
    startedAt: execution.startedAt,
    endedAt: execution.endedAt,
    summary: execution.summary
      ? {
          ...execution.summary,
          sampleCount,
          distanceKm: execution.summary.distanceKm ?? plannedDistanceKm ?? 0,
          durationMin: execution.summary.durationMin ?? Math.max(
            0,
            Math.round((
              (execution.endedAt ?? new Date()).getTime() - execution.startedAt.getTime()
            ) / 60_000),
          ),
          startedAt: execution.startedAt,
          endedAt: execution.endedAt,
          lastPosition,
        }
      : {
          sampleCount,
          distanceKm: plannedDistanceKm ?? 0,
          durationMin: Math.max(
            0,
            Math.round((
              (execution.endedAt ?? new Date()).getTime() - execution.startedAt.getTime()
            ) / 60_000),
          ),
          startedAt: execution.startedAt,
          endedAt: execution.endedAt,
          lastPosition,
        },
  };
}

async function sessionProjection(routeId: string, organizationId: string) {
  const execution = await getRouteExecution(routeId, organizationId);
  if (!execution) return null;
  let [route] = await db
    .select()
    .from(routesTable)
    .where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ))
    .limit(1);
  if (route?.dispatchSnapshotVersion != null) route = await outgoingRoute(route);
  const [sample] = await db
    .select({ count: count() })
    .from(vehiclePositionsTable)
    .where(and(
      eq(vehiclePositionsTable.routeId, routeId),
      eq(vehiclePositionsTable.organizationId, organizationId),
      eq(vehiclePositionsTable.executionId, execution.id),
    ));
  const [last] = await db
    .select({
      latitude: vehiclePositionsTable.latitude,
      longitude: vehiclePositionsTable.longitude,
      heading: vehiclePositionsTable.heading,
      speedKmh: vehiclePositionsTable.speedKmh,
      accuracy: vehiclePositionsTable.accuracy,
      recordedAt: vehiclePositionsTable.recordedAt,
    })
    .from(vehiclePositionsTable)
    .where(and(
      eq(vehiclePositionsTable.routeId, routeId),
      eq(vehiclePositionsTable.organizationId, organizationId),
      eq(vehiclePositionsTable.executionId, execution.id),
    ))
    .orderBy(desc(vehiclePositionsTable.recordedAt))
    .limit(1);
  return sessionResponse(
    execution,
    Number(sample?.count ?? 0),
    last ? { ...last } : null,
    route?.totalDistanceKm ?? null,
  );
}

router.post(
  ["/routes/:id/execution/start", "/routes/:id/start"],
  requireRole("admin", "dispatcher", "driver"),
  startHandler,
);

router.post(
  "/tracking/route-session",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const body = z.object({
        routeId: z.guid(),
        action: z.enum(["start", "end"]),
        clientSessionId: z.string().trim().min(1).max(200),
        occurredAt: z.string().datetime().optional(),
      }).strict().parse(req.body ?? {});
      const actor = actorFor(req);
      const result = body.action === "start"
        ? await startRouteExecution({
            routeId: body.routeId,
            clientEventId: body.clientSessionId,
            startedAt: body.occurredAt,
            actor,
          })
        : await endRouteExecution({
            routeId: body.routeId,
            clientEventId: body.clientSessionId,
            endedAt: body.occurredAt,
            actor,
          });
      const projection = await sessionProjection(body.routeId, actor.organizationId);
      res.status(result.duplicate ? 200 : 201).json(projection);
    } catch (error) {
      if (error instanceof RouteExecutionError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({
          error: error.message,
          ...(error instanceof RouteExecutionError && error.code ? { code: error.code } : {}),
        });
        return;
      }
      handleError(res, error);
    }
  },
);

router.get(
  "/tracking/route-session/:routeId",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const routeId = Array.isArray(req.params.routeId)
        ? req.params.routeId[0]
        : req.params.routeId;
      if (!z.guid().safeParse(routeId).success) {
        res.status(400).json({ error: "Invalid routeId parameter" });
        return;
      }
      await validateDriverAssistanceContext(req, { routeId });
      const organizationId = getOrgId(req);
      let [route] = await db
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, organizationId),
        ))
        .limit(1);
      if (!route || (
        req.user!.role === "driver"
        && route.handoffDriverId !== req.user!.driverProfileId
      )) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      if (route.dispatchSnapshotVersion != null || req.user!.role === "driver") route = await outgoingRoute(route);
      if (
        route.handoffStatus !== "accepted"
        || route.handoffVersion !== route.planRevision
        || !route.handoffDriverId
      ) {
        res.status(409).json({
          error: "The current route plan must be dispatched and accepted before execution",
        });
        return;
      }
      const projection = await sessionProjection(routeId, organizationId);
      res.json(projection);
    } catch (error) {
      if (error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);
router.post(
  ["/routes/:id/execution/end", "/routes/:id/end"],
  requireRole("admin", "dispatcher", "driver"),
  endHandler,
);

router.get(
  "/routes/:id/execution",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const { id } = parseUuidParam(req.params);
      await validateDriverAssistanceContext(req, { routeId: id });
      const organizationId = getOrgId(req);
      const [route] = await db
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, id),
          eq(routesTable.organizationId, organizationId),
        ))
        .limit(1);
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      if (req.user!.role === "driver" && route.handoffDriverId !== req.user!.driverProfileId) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      if (req.user!.role === "driver") await outgoingRoute(route);
      res.json(await getRouteExecution(id, organizationId));
    } catch (error) {
      if (error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);

export default router;