import { Router, type IRouter } from "express";
import { eq, sql, count, sum } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable } from "@workspace/db";
import { GetDashboardStatsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/stats", async (req, res) => {
  try {
    const { organizationId } = GetDashboardStatsQueryParams.parse(req.query);

    const [routeStats] = await db
      .select({
        totalRoutes: count(),
        totalDistanceKm: sum(routesTable.totalDistanceKm),
        totalDurationMin: sum(routesTable.totalDurationMin),
        co2EmissionsKg: sum(routesTable.co2EmissionsKg),
        completedRoutes: sql<number>`count(*) filter (where ${routesTable.status} = 'completed')`,
      })
      .from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));

    const [stopStats] = await db
      .select({
        totalStops: count(),
        pendingStops: sql<number>`count(*) filter (where ${stopsTable.status} = 'pending')`,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));

    const [vehicleStats] = await db
      .select({
        activeVehicles: count(),
      })
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));

    res.json({
      totalRoutes: routeStats?.totalRoutes ?? 0,
      totalStops: stopStats?.totalStops ?? 0,
      totalDistanceKm: Number(routeStats?.totalDistanceKm ?? 0),
      totalDurationMin: Number(routeStats?.totalDurationMin ?? 0),
      activeVehicles: vehicleStats?.activeVehicles ?? 0,
      completedRoutes: Number(routeStats?.completedRoutes ?? 0),
      pendingStops: Number(stopStats?.pendingStops ?? 0),
      co2EmissionsKg: Number(routeStats?.co2EmissionsKg ?? 0),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
