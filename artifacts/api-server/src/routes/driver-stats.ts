import { Router, type IRouter } from "express";
import { eq, and, sql, count } from "drizzle-orm";
import { db, driversTable, routesTable, stopsTable, vehiclesTable, driverPreferencesTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { computeHappinessScore } from "./driver-preferences";
import { outgoingRoutesForDriver, outgoingStops } from "../services/outgoing-route-service";
import {
  DriverAssistanceError,
  validateDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();

router.get("/drivers/:id/stats", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    await validateDriverAssistanceContext(req, { driverId: id });
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const [driver] = await db
      .select()
      .from(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)));
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    const operational = req.user!.role === "driver";
    const dispatched = operational ? await outgoingRoutesForDriver(organizationId, id) : null;
    if (operational) driver.vehicleId = dispatched?.[0]?.vehicleId ?? null;
    const vehicleId = driver.vehicleId;
    if (!vehicleId) {
      res.json({
        driver,
        totalDeliveries: 0,
        completedDeliveries: 0,
        failedDeliveries: 0,
        skippedDeliveries: 0,
        onTimeRate: 0,
        avgServiceDurationMin: 0,
        totalDistanceKm: 0,
        totalRoutes: 0,
        completedRoutes: 0,
        happinessScore: 50,
      });
      return;
    }

    const routes = dispatched ?? await db
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.vehicleId, vehicleId), eq(routesTable.organizationId, organizationId)));

    const routeIds = routes.map((r) => r.id);
    const totalRoutes = routes.length;
    const completedRoutes = routes.filter((r) => r.status === "completed").length;
    const totalDistanceKm = routes.reduce((sum, r) => sum + (r.totalDistanceKm ?? 0), 0);

    if (routeIds.length === 0) {
      res.json({
        driver,
        totalDeliveries: 0,
        completedDeliveries: 0,
        failedDeliveries: 0,
        skippedDeliveries: 0,
        onTimeRate: 0,
        avgServiceDurationMin: 0,
        totalDistanceKm: 0,
        totalRoutes: 0,
        completedRoutes: 0,
        happinessScore: 50,
      });
      return;
    }

    const allStops = dispatched ? (await Promise.all(dispatched.map((route) => outgoingStops(route)))).flat() : await db
      .select()
      .from(stopsTable)
      .where(sql`${stopsTable.routeId} IN (${sql.join(routeIds.map(id => sql`${id}`), sql`, `)})`);

    const totalDeliveries = allStops.length;
    const completedDeliveries = allStops.filter((s) => s.status === "completed").length;
    const failedDeliveries = allStops.filter((s) => s.status === "failed").length;
    const skippedDeliveries = allStops.filter((s) => s.status === "skipped").length;

    const completedStops = allStops.filter((s) => s.status === "completed");
    const avgServiceDurationMin =
      completedStops.length > 0
        ? Math.round(
            completedStops.reduce((sum, s) => sum + s.serviceDurationMin, 0) / completedStops.length
          )
        : 0;

    const onTimeRate =
      totalDeliveries > 0 ? Math.round((completedDeliveries / totalDeliveries) * 100) : 0;

    let [prefs] = await db
      .select()
      .from(driverPreferencesTable)
      .where(eq(driverPreferencesTable.driverId, id));

    if (!prefs) {
      [prefs] = await db
        .insert(driverPreferencesTable)
        .values({ driverId: id })
        .returning();
    }

    const happinessScore = operational ? prefs.happinessScore : await computeHappinessScore(id, organizationId, prefs);
    if (happinessScore !== prefs.happinessScore) {
      await db
        .update(driverPreferencesTable)
        .set({ happinessScore })
        .where(eq(driverPreferencesTable.driverId, id));
      prefs.happinessScore = happinessScore;
    }

    res.json({
      driver,
      totalDeliveries,
      completedDeliveries,
      failedDeliveries,
      skippedDeliveries,
      onTimeRate,
      avgServiceDurationMin,
      totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
      totalRoutes,
      completedRoutes,
      happinessScore: Math.round(prefs.happinessScore * 100),
    });
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

export default router;
