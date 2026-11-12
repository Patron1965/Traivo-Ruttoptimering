import { Router, type IRouter } from "express";
import { eq, and, sql, count, sum } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable, driversTable } from "@workspace/db";
import { GetDashboardStatsQueryParams } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import { assertOrgScope } from "../middleware/auth";

const router: IRouter = Router();

router.get("/dashboard/stats", async (req, res) => {
  try {
    const { organizationId: requestedOrganizationId } = GetDashboardStatsQueryParams.parse(req.query);
    const organizationId = assertOrgScope(req, requestedOrganizationId);

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
      .where(
        and(
          eq(vehiclesTable.organizationId, organizationId),
          eq(vehiclesTable.isActive, true)
        )
      );

    const [driverStats] = await db
      .select({
        activeDrivers: count(),
      })
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true)
        )
      );

    res.json({
      totalRoutes: routeStats?.totalRoutes ?? 0,
      totalStops: stopStats?.totalStops ?? 0,
      totalDistanceKm: Number(routeStats?.totalDistanceKm ?? 0),
      totalDurationMin: Number(routeStats?.totalDurationMin ?? 0),
      activeVehicles: vehicleStats?.activeVehicles ?? 0,
      completedRoutes: Number(routeStats?.completedRoutes ?? 0),
      pendingStops: Number(stopStats?.pendingStops ?? 0),
      co2EmissionsKg: Number(routeStats?.co2EmissionsKg ?? 0),
      activeDrivers: driverStats?.activeDrivers ?? 0,
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
