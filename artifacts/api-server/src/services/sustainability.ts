import { eq } from "drizzle-orm";
import { db, routesTable, vehiclesTable, stopsTable } from "@workspace/db";
import { calculateCo2Kg, baselineFossilCo2Kg, EMISSION_PROFILES } from "../lib/co2-profiles";

export interface SustainabilityStats {
  totalCo2Kg: number;
  fossilCo2Kg: number;
  evCo2Kg: number;
  hybridCo2Kg: number;
  co2SavedKg: number;
  treesEquivalent: number;
  emissionProfiles: typeof EMISSION_PROFILES;
  routeBreakdown: RouteBreakdownItem[];
  etaMetrics: EtaMetrics;
}

interface RouteBreakdownItem {
  routeId: string;
  routeName: string;
  vehicleName: string;
  vehicleType: string;
  distanceKm: number;
  co2Kg: number;
  date: string;
}

export interface EtaMetrics {
  avgTimeWindowSlackMin: number;
  stopsWithTimeWindows: number;
  stopsOnTime: number;
  stopsLate: number;
  avgDurationMin: number;
  totalRoutes: number;
}

export async function calculateSustainabilityStats(organizationId: string): Promise<SustainabilityStats> {
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
  let hybridCo2Kg = 0;

  const routeBreakdown = routeData.map((r) => {
    const dist = Number(r.distanceKm ?? 0);
    const vType = (r.vehicleType ?? "fossil") as string;
    const co2 = r.co2Kg != null ? Number(r.co2Kg) : calculateCo2Kg(dist, vType);

    totalCo2Kg += co2;
    if (vType === "electric") {
      evCo2Kg += co2;
    } else if (vType === "hybrid") {
      hybridCo2Kg += co2;
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
  const allFossilCo2 = baselineFossilCo2Kg(totalDistAllRoutes);
  const co2SavedKg = Math.max(0, allFossilCo2 - totalCo2Kg);
  const treesEquivalent = Math.round((co2SavedKg / 21.77) * 10) / 10;

  const routeIds = routeData.map(r => r.routeId);
  let etaMetrics: EtaMetrics = {
    avgTimeWindowSlackMin: 0,
    stopsWithTimeWindows: 0,
    stopsOnTime: 0,
    stopsLate: 0,
    avgDurationMin: 0,
    totalRoutes: routeData.length,
  };

  if (routeIds.length > 0) {
    const allStops = [];
    for (const routeId of routeIds) {
      const stops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
      allStops.push(...stops);
    }

    let totalSlackMin = 0;
    let timeWindowCount = 0;
    let onTimeCount = 0;
    let lateCount = 0;

    for (const stop of allStops) {
      if (stop.timeWindowStart && stop.timeWindowEnd) {
        timeWindowCount++;
        const windowDurationMin = (stop.timeWindowEnd.getTime() - stop.timeWindowStart.getTime()) / 60000;
        const slackMin = Math.max(0, windowDurationMin - stop.serviceDurationMin);
        totalSlackMin += slackMin;

        if (stop.status === "completed" || stop.status === "pending" || stop.status === "in_progress") {
          onTimeCount++;
        } else if (stop.status === "failed" || stop.status === "skipped") {
          lateCount++;
        }
      }
    }

    const routesWithDuration = await db.select({
      id: routesTable.id,
      durationMin: routesTable.totalDurationMin,
    }).from(routesTable).where(eq(routesTable.organizationId, organizationId));

    const avgDuration = routesWithDuration.length > 0
      ? routesWithDuration.reduce((sum, r) => sum + Number(r.durationMin ?? 0), 0) / routesWithDuration.length
      : 0;

    etaMetrics = {
      avgTimeWindowSlackMin: timeWindowCount > 0 ? Math.round(totalSlackMin / timeWindowCount * 10) / 10 : 0,
      stopsWithTimeWindows: timeWindowCount,
      stopsOnTime: onTimeCount,
      stopsLate: lateCount,
      avgDurationMin: Math.round(avgDuration * 10) / 10,
      totalRoutes: routeData.length,
    };
  }

  return {
    totalCo2Kg: Math.round(totalCo2Kg * 100) / 100,
    fossilCo2Kg: Math.round(fossilCo2Kg * 100) / 100,
    evCo2Kg: Math.round(evCo2Kg * 100) / 100,
    hybridCo2Kg: Math.round(hybridCo2Kg * 100) / 100,
    co2SavedKg: Math.round(co2SavedKg * 100) / 100,
    treesEquivalent,
    emissionProfiles: EMISSION_PROFILES,
    routeBreakdown,
    etaMetrics,
  };
}
