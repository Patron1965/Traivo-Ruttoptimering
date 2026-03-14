import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, routesTable, vehiclesTable } from "@workspace/db";
import { GetSustainabilityStatsQueryParams } from "@workspace/api-zod";
import { handleError } from "../lib/errors";

const CO2_PER_KM_FOSSIL = 0.242;

const router: IRouter = Router();

router.get("/sustainability/stats", async (req, res) => {
  try {
    const { organizationId } = GetSustainabilityStatsQueryParams.parse(req.query);

    const routeData = await db
      .select({
        routeId: routesTable.id,
        routeName: routesTable.name,
        vehicleName: vehiclesTable.name,
        vehicleType: vehiclesTable.vehicleType,
        distanceKm: routesTable.totalDistanceKm,
        co2Kg: routesTable.co2EmissionsKg,
        date: routesTable.date,
      })
      .from(routesTable)
      .leftJoin(vehiclesTable, eq(routesTable.vehicleId, vehiclesTable.id))
      .where(eq(routesTable.organizationId, organizationId));

    let totalCo2Kg = 0;
    let fossilCo2Kg = 0;
    let evCo2Kg = 0;

    const routeBreakdown = routeData.map((r) => {
      const co2 = Number(r.co2Kg ?? 0);
      const dist = Number(r.distanceKm ?? 0);
      const vType = r.vehicleType ?? "fossil";
      totalCo2Kg += co2;
      if (vType === "electric") {
        evCo2Kg += co2;
      } else {
        fossilCo2Kg += co2;
      }
      return {
        routeId: r.routeId,
        routeName: r.routeName,
        vehicleName: r.vehicleName ?? "Unknown",
        vehicleType: vType,
        distanceKm: Math.round(dist * 100) / 100,
        co2Kg: Math.round(co2 * 100) / 100,
        date: r.date?.toISOString() ?? new Date().toISOString(),
      };
    });

    const totalDistAllRoutes = routeData.reduce(
      (sum, r) => sum + Number(r.distanceKm ?? 0),
      0
    );
    const allFossilCo2 = totalDistAllRoutes * CO2_PER_KM_FOSSIL;
    const co2SavedKg = Math.max(0, allFossilCo2 - totalCo2Kg);
    const treesEquivalent = Math.round((co2SavedKg / 21.77) * 10) / 10;

    res.json({
      totalCo2Kg: Math.round(totalCo2Kg * 100) / 100,
      fossilCo2Kg: Math.round(fossilCo2Kg * 100) / 100,
      evCo2Kg: Math.round(evCo2Kg * 100) / 100,
      co2SavedKg: Math.round(co2SavedKg * 100) / 100,
      treesEquivalent,
      routeBreakdown,
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
