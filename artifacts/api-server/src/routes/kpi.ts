import { Router, type IRouter } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import {
  db,
  routesTable,
  stopsTable,
  vehiclesTable,
  driversTable,
  deliveryProofsTable,
  vehiclePositionsTable,
} from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

function parseDateRange(req: { query: Record<string, unknown> }): { from: Date; to: Date } {
  const toIso = (req.query.to as string) || new Date().toISOString();
  const fromIso = (req.query.from as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { from: new Date(fromIso), to: new Date(toIso) };
}

router.get("/kpi/overview", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId required" });
      return;
    }
    const { from, to } = parseDateRange(req);

    const [routeStats] = await db
      .select({
        totalRoutes: sql<number>`count(*)::int`,
        completedRoutes: sql<number>`count(*) filter (where ${routesTable.status} = 'completed')::int`,
        totalDistanceKm: sql<number>`coalesce(sum(${routesTable.totalDistanceKm}), 0)::float`,
      })
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          gte(routesTable.createdAt, from),
          lte(routesTable.createdAt, to),
        ),
      );

    const stopStats = await db
      .select({
        status: stopsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(stopsTable)
      .innerJoin(routesTable, eq(stopsTable.routeId, routesTable.id))
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          gte(routesTable.createdAt, from),
          lte(routesTable.createdAt, to),
        ),
      )
      .groupBy(stopsTable.status);

    const stopsByStatus: Record<string, number> = {};
    let totalStops = 0;
    for (const row of stopStats) {
      stopsByStatus[row.status] = row.count;
      totalStops += row.count;
    }
    const completedStops = stopsByStatus["completed"] || 0;
    const failedStops = stopsByStatus["failed"] || 0;
    const onTimeRate = totalStops > 0 ? completedStops / totalStops : 0;
    const failureRate = totalStops > 0 ? failedStops / totalStops : 0;

    const [vehicleCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));

    const [driverCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(driversTable)
      .where(eq(driversTable.organizationId, organizationId));

    const [podCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveryProofsTable)
      .innerJoin(stopsTable, eq(deliveryProofsTable.stopId, stopsTable.id))
      .innerJoin(routesTable, eq(stopsTable.routeId, routesTable.id))
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          gte(deliveryProofsTable.capturedAt, from),
          lte(deliveryProofsTable.capturedAt, to),
        ),
      );

    const podRate = completedStops > 0 ? Math.min(podCount.count / completedStops, 1) : 0;

    const [telemetryCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(vehiclePositionsTable)
      .where(
        and(
          eq(vehiclePositionsTable.organizationId, organizationId),
          gte(vehiclePositionsTable.recordedAt, from),
          lte(vehiclePositionsTable.recordedAt, to),
        ),
      );

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      routes: {
        total: routeStats?.totalRoutes ?? 0,
        completed: routeStats?.completedRoutes ?? 0,
        completionRate: routeStats && routeStats.totalRoutes > 0 ? routeStats.completedRoutes / routeStats.totalRoutes : 0,
      },
      stops: {
        total: totalStops,
        completed: completedStops,
        failed: failedStops,
        onTimeRate,
        failureRate,
        byStatus: stopsByStatus,
      },
      fleet: {
        vehicles: vehicleCount?.count ?? 0,
        drivers: driverCount?.count ?? 0,
      },
      sustainability: {
        totalDistanceKm: Math.round((routeStats?.totalDistanceKm ?? 0) * 100) / 100,
        totalCo2Kg: Math.round((routeStats?.totalDistanceKm ?? 0) * 0.21 * 100) / 100,
      },
      pod: {
        captured: podCount?.count ?? 0,
        captureRate: podRate,
      },
      telemetry: {
        gpsPings: telemetryCount?.count ?? 0,
      },
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/kpi/timeseries", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId required" });
      return;
    }
    const { from, to } = parseDateRange(req);

    const rows = await db.execute(sql`
      SELECT
        date_trunc('day', ${routesTable.createdAt}) AS day,
        count(*)::int AS routes,
        count(*) filter (where ${routesTable.status} = 'completed')::int AS completed_routes,
        coalesce(sum(${routesTable.totalDistanceKm}), 0)::float AS distance_km,
        coalesce(sum(${routesTable.totalDistanceKm}), 0)::float * 0.21 AS co2_kg
      FROM ${routesTable}
      WHERE ${routesTable.organizationId} = ${organizationId}
        AND ${routesTable.createdAt} >= ${from}
        AND ${routesTable.createdAt} <= ${to}
      GROUP BY day
      ORDER BY day ASC
    `);

    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      series: (rows.rows as Array<Record<string, unknown>>).map((r) => ({
        date: r.day,
        routes: r.routes,
        completedRoutes: r.completed_routes,
        distanceKm: r.distance_km,
        co2Kg: r.co2_kg,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
