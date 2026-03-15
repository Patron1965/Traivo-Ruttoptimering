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
  noiseImpactScore: number;
  nightRouteCount: number;
  avgParticlePm25: number;
  environmentalScore: number;
  routeEnvironmentalScores: RouteEnvScore[];
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

export interface RouteEnvScore {
  routeId: string;
  routeName: string;
  environmentalScore: number;
  co2Score: number;
  noiseScore: number;
  particleScore: number;
  isNightRoute: boolean;
}

const PM25_FACTORS: Record<string, { tireAndBrake: number; exhaust: number }> = {
  fossil: { tireAndBrake: 0.015, exhaust: 0.045 },
  diesel_truck: { tireAndBrake: 0.025, exhaust: 0.065 },
  electric: { tireAndBrake: 0.012, exhaust: 0 },
  hybrid: { tireAndBrake: 0.014, exhaust: 0.015 },
};

export function estimateParticleEmissions(distanceKm: number, vehicleType: string): number {
  const factors = PM25_FACTORS[vehicleType] ?? PM25_FACTORS.fossil;
  const pm25Grams = distanceKm * (factors.tireAndBrake + factors.exhaust);
  return Math.round(pm25Grams * 1000) / 1000;
}

export function calculateNoiseImpact(date: string | Date, durationMin: number): { noiseScore: number; isNightRoute: boolean } {
  const d = new Date(date);
  const hour = d.getHours();
  const endHour = (hour + Math.ceil(durationMin / 60)) % 24;

  const isNight = hour >= 22 || hour < 6 || endHour >= 22 || endHour < 6;
  const nightOverlapHours = isNight ? Math.min(durationMin / 60, 4) : 0;

  const noiseScore = isNight
    ? Math.min(100, 40 + nightOverlapHours * 15)
    : Math.max(5, 10 + (durationMin / 60) * 2);

  return { noiseScore: Math.round(noiseScore), isNightRoute: isNight };
}

export function calculateEnvironmentalScore(
  co2Kg: number,
  distanceKm: number,
  noiseScore: number,
  pm25Grams: number,
  vehicleType: string
): number {
  const baselineCo2 = baselineFossilCo2Kg(distanceKm);
  const co2Ratio = baselineCo2 > 0 ? Math.min(1, co2Kg / baselineCo2) : 1;
  const co2Score = Math.round((1 - co2Ratio) * 100);

  const noiseNorm = Math.max(0, 100 - noiseScore);

  const maxPm25 = distanceKm * 0.11;
  const particleRatio = maxPm25 > 0 ? Math.min(1, pm25Grams / maxPm25) : 1;
  const particleScore = Math.round((1 - particleRatio) * 100);

  const combined = co2Score * 0.5 + noiseNorm * 0.25 + particleScore * 0.25;
  return Math.round(Math.max(0, Math.min(100, combined)));
}

export async function calculateSustainabilityStats(organizationId: string): Promise<SustainabilityStats> {
  const routeData = await db
    .select({
      routeId: routesTable.id,
      routeName: routesTable.name,
      vehicleName: vehiclesTable.name,
      vehicleType: vehiclesTable.vehicleType,
      distanceKm: routesTable.totalDistanceKm,
      durationMin: routesTable.totalDurationMin,
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
  let totalNoiseScore = 0;
  let nightRouteCount = 0;
  let totalPm25 = 0;
  const routeEnvironmentalScores: RouteEnvScore[] = [];

  const routeBreakdown = routeData.map((r) => {
    const dist = Number(r.distanceKm ?? 0);
    const dur = Number(r.durationMin ?? 30);
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

    const dateStr = r.date?.toISOString() ?? new Date().toISOString();
    const { noiseScore, isNightRoute } = calculateNoiseImpact(dateStr, dur);
    totalNoiseScore += noiseScore;
    if (isNightRoute) nightRouteCount++;

    const pm25 = estimateParticleEmissions(dist, vType);
    totalPm25 += pm25;

    const baselineCo2Route = baselineFossilCo2Kg(dist);
    const co2Ratio = baselineCo2Route > 0 ? Math.min(1, co2 / baselineCo2Route) : 1;
    const co2ScoreRoute = Math.round((1 - co2Ratio) * 100);
    const noiseNorm = Math.max(0, 100 - noiseScore);
    const maxPm25 = dist * 0.11;
    const particleRatio = maxPm25 > 0 ? Math.min(1, pm25 / maxPm25) : 1;
    const particleScoreRoute = Math.round((1 - particleRatio) * 100);

    const envScore = calculateEnvironmentalScore(co2, dist, noiseScore, pm25, vType);

    routeEnvironmentalScores.push({
      routeId: r.routeId,
      routeName: r.routeName ?? "Unknown",
      environmentalScore: envScore,
      co2Score: Math.max(0, co2ScoreRoute),
      noiseScore: noiseNorm,
      particleScore: Math.max(0, particleScoreRoute),
      isNightRoute,
    });

    return {
      routeId: r.routeId,
      routeName: r.routeName,
      vehicleName: r.vehicleName ?? "Unknown",
      vehicleType: vType,
      distanceKm: Math.round(dist * 100) / 100,
      co2Kg: Math.round(co2 * 100) / 100,
      date: dateStr,
    };
  });

  const totalDistAllRoutes = routeData.reduce(
    (sum, r) => sum + Number(r.distanceKm ?? 0),
    0
  );
  const allFossilCo2 = baselineFossilCo2Kg(totalDistAllRoutes);
  const co2SavedKg = Math.max(0, allFossilCo2 - totalCo2Kg);
  const treesEquivalent = Math.round((co2SavedKg / 21.77) * 10) / 10;

  const avgNoiseScore = routeData.length > 0
    ? Math.round(totalNoiseScore / routeData.length)
    : 0;
  const avgPm25 = routeData.length > 0
    ? Math.round((totalPm25 / routeData.length) * 1000) / 1000
    : 0;

  const avgEnvScore = routeEnvironmentalScores.length > 0
    ? Math.round(routeEnvironmentalScores.reduce((s, r) => s + r.environmentalScore, 0) / routeEnvironmentalScores.length)
    : 0;

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
    noiseImpactScore: avgNoiseScore,
    nightRouteCount,
    avgParticlePm25: avgPm25,
    environmentalScore: avgEnvScore,
    routeEnvironmentalScores,
  };
}
