import { Router, type IRouter } from "express";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

router.get("/analytics", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    const conditions = [eq(routesTable.organizationId, organizationId)];
    if (from) conditions.push(gte(routesTable.date, new Date(from)));
    if (to) conditions.push(lte(routesTable.date, new Date(to)));

    const routes = await db
      .select()
      .from(routesTable)
      .where(and(...conditions))
      .orderBy(routesTable.date);

    const routeIds = routes.map((r) => r.id);

    let allStops: Array<{ routeId: string | null; status: string; serviceDurationMin: number }> = [];
    if (routeIds.length > 0) {
      allStops = await db
        .select({
          routeId: stopsTable.routeId,
          status: stopsTable.status,
          serviceDurationMin: stopsTable.serviceDurationMin,
        })
        .from(stopsTable)
        .where(sql`${stopsTable.routeId} IN (${sql.join(routeIds.map(id => sql`${id}`), sql`, `)})`);
    }

    const vehicles = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));
    const vehicleMap = new Map(vehicles.map((v) => [v.id, v]));

    const dailyVolume: Record<string, { date: string; routes: number; stops: number; distanceKm: number; co2Kg: number }> = {};
    for (const r of routes) {
      const day = new Date(r.date).toISOString().slice(0, 10);
      if (!dailyVolume[day]) {
        dailyVolume[day] = { date: day, routes: 0, stops: 0, distanceKm: 0, co2Kg: 0 };
      }
      dailyVolume[day].routes++;
      dailyVolume[day].stops += r.totalStops;
      dailyVolume[day].distanceKm += r.totalDistanceKm ?? 0;
      dailyVolume[day].co2Kg += r.co2EmissionsKg ?? 0;
    }

    const totalStops = allStops.length;
    const completedStops = allStops.filter((s) => s.status === "completed").length;
    const failedStops = allStops.filter((s) => s.status === "failed").length;
    const onTimeRate = totalStops > 0 ? Math.round((completedStops / totalStops) * 100) : 0;

    const vehicleTypeBreakdown: Record<string, { type: string; routes: number; distanceKm: number; co2Kg: number }> = {};
    for (const r of routes) {
      const vehicle = r.vehicleId ? vehicleMap.get(r.vehicleId) : null;
      const vType = vehicle?.vehicleType || "unknown";
      if (!vehicleTypeBreakdown[vType]) {
        vehicleTypeBreakdown[vType] = { type: vType, routes: 0, distanceKm: 0, co2Kg: 0 };
      }
      vehicleTypeBreakdown[vType].routes++;
      vehicleTypeBreakdown[vType].distanceKm += r.totalDistanceKm ?? 0;
      vehicleTypeBreakdown[vType].co2Kg += r.co2EmissionsKg ?? 0;
    }

    const statusBreakdown = {
      draft: routes.filter((r) => r.status === "draft").length,
      optimized: routes.filter((r) => r.status === "optimized").length,
      in_progress: routes.filter((r) => r.status === "in_progress").length,
      completed: routes.filter((r) => r.status === "completed").length,
      cancelled: routes.filter((r) => r.status === "cancelled").length,
    };

    res.json({
      summary: {
        totalRoutes: routes.length,
        totalStops,
        completedStops,
        failedStops,
        onTimeRate,
        totalDistanceKm: Math.round(routes.reduce((s, r) => s + (r.totalDistanceKm ?? 0), 0) * 10) / 10,
        totalCo2Kg: Math.round(routes.reduce((s, r) => s + (r.co2EmissionsKg ?? 0), 0) * 10) / 10,
        avgStopsPerRoute: routes.length > 0 ? Math.round(totalStops / routes.length) : 0,
      },
      dailyVolume: Object.values(dailyVolume).sort((a, b) => a.date.localeCompare(b.date)),
      vehicleTypeBreakdown: Object.values(vehicleTypeBreakdown),
      statusBreakdown,
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
