import { Router, type IRouter } from "express";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

router.get("/analytics", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const dateConditions = [];
    if (from) dateConditions.push(sql`r.date >= ${new Date(from)}`);
    if (to) dateConditions.push(sql`r.date <= ${new Date(to)}`);
    const dateFilter = dateConditions.length > 0
      ? sql` AND ${sql.join(dateConditions, sql` AND `)}`
      : sql``;

    const summaryResult = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total_routes,
        COALESCE(SUM(r.total_stops), 0)::int AS total_stops,
        ROUND(COALESCE(SUM(r.total_distance_km), 0)::numeric, 1) AS total_distance_km,
        ROUND(COALESCE(SUM(r.co2_emissions_kg), 0)::numeric, 1) AS total_co2_kg,
        COUNT(CASE WHEN r.status = 'draft' THEN 1 END)::int AS draft,
        COUNT(CASE WHEN r.status = 'optimized' THEN 1 END)::int AS optimized,
        COUNT(CASE WHEN r.status = 'in_progress' THEN 1 END)::int AS in_progress,
        COUNT(CASE WHEN r.status = 'completed' THEN 1 END)::int AS completed,
        COUNT(CASE WHEN r.status = 'cancelled' THEN 1 END)::int AS cancelled
      FROM routes r
      WHERE r.organization_id = ${organizationId}${dateFilter}
    `);

    const summary = summaryResult.rows[0] as any;

    const dailyResult = await db.execute(sql`
      SELECT
        DATE_TRUNC('day', r.date)::date AS day,
        COUNT(*)::int AS routes,
        COALESCE(SUM(r.total_stops), 0)::int AS stops,
        ROUND(COALESCE(SUM(r.total_distance_km), 0)::numeric, 1) AS distance_km,
        ROUND(COALESCE(SUM(r.co2_emissions_kg), 0)::numeric, 1) AS co2_kg
      FROM routes r
      WHERE r.organization_id = ${organizationId}${dateFilter}
      GROUP BY DATE_TRUNC('day', r.date)
      ORDER BY day
    `);

    const stopStatsResult = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(CASE WHEN s.status = 'completed' THEN 1 END)::int AS completed,
        COUNT(CASE WHEN s.status = 'failed' THEN 1 END)::int AS failed
      FROM stops s
      INNER JOIN routes r ON s.route_id = r.id
      WHERE r.organization_id = ${organizationId}${dateFilter}
    `);

    const stopStats = stopStatsResult.rows[0] as any;
    const totalStops = Number(stopStats?.total ?? 0);
    const completedStops = Number(stopStats?.completed ?? 0);
    const failedStops = Number(stopStats?.failed ?? 0);
    const onTimeRate = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;

    const vehicleBreakdownResult = await db.execute(sql`
      SELECT
        COALESCE(v.vehicle_type::text, 'unknown') AS type,
        COUNT(r.id)::int AS routes,
        ROUND(COALESCE(SUM(r.total_distance_km), 0)::numeric, 1) AS distance_km,
        ROUND(COALESCE(SUM(r.co2_emissions_kg), 0)::numeric, 1) AS co2_kg
      FROM routes r
      LEFT JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.organization_id = ${organizationId}${dateFilter}
      GROUP BY COALESCE(v.vehicle_type::text, 'unknown')
    `);

    const totalRoutes = Number(summary?.total_routes ?? 0);

    res.json({
      summary: {
        totalRoutes,
        totalStops,
        completedStops,
        failedStops,
        onTimeRate,
        totalDistanceKm: Number(summary?.total_distance_km ?? 0),
        totalCo2Kg: Number(summary?.total_co2_kg ?? 0),
        avgStopsPerRoute: totalRoutes > 0 ? Math.round(Number(summary?.total_stops ?? 0) / totalRoutes) : 0,
      },
      dailyVolume: (dailyResult.rows as any[]).map(r => ({
        date: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
        routes: Number(r.routes),
        stops: Number(r.stops),
        distanceKm: Number(r.distance_km),
        co2Kg: Number(r.co2_kg),
      })),
      vehicleTypeBreakdown: (vehicleBreakdownResult.rows as any[]).map(r => ({
        type: r.type,
        routes: Number(r.routes),
        distanceKm: Number(r.distance_km),
        co2Kg: Number(r.co2_kg),
      })),
      statusBreakdown: {
        draft: Number(summary?.draft ?? 0),
        optimized: Number(summary?.optimized ?? 0),
        in_progress: Number(summary?.in_progress ?? 0),
        completed: Number(summary?.completed ?? 0),
        cancelled: Number(summary?.cancelled ?? 0),
      },
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
