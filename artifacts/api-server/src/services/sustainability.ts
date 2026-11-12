import { and, eq, gte, inArray, lte } from "drizzle-orm";
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

export interface SustainabilityStatsOptions {
  /** Reject oversized report inputs instead of creating an unbounded response. */
  maxRoutes?: number;
  /** Bound stop reads when generating a report for a broad time period. */
  maxStops?: number;
  /** The PDF does not display ETA metrics, so it can skip their calculation. */
  includeEtaMetrics?: boolean;
}

export class SustainabilityDataLimitError extends Error {
  readonly statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = "SustainabilityDataLimitError";
  }
}

const PM25_FACTORS: Record<string, { tireAndBrake: number; exhaust: number }> = {
  fossil: { tireAndBrake: 0.015, exhaust: 0.045 },
  diesel_truck: { tireAndBrake: 0.025, exhaust: 0.065 },
  electric: { tireAndBrake: 0.012, exhaust: 0 },
  hybrid: { tireAndBrake: 0.014, exhaust: 0.015 },
};

export function estimateParticleEmissions(
  distanceKm: number,
  vehicleType: string,
  totalStops: number,
  durationMin: number
): number {
  const factors = PM25_FACTORS[vehicleType] ?? PM25_FACTORS.fossil;

  const avgSpeedKmh = durationMin > 0 ? (distanceKm / durationMin) * 60 : 30;
  const speedFactor = avgSpeedKmh < 20 ? 1.4 : avgSpeedKmh < 40 ? 1.1 : avgSpeedKmh < 60 ? 1.0 : 0.9;

  const brakingEvents = Math.max(0, totalStops * 2);
  const brakingPm25 = brakingEvents * 0.002;

  const baseEmissions = distanceKm * (factors.tireAndBrake + factors.exhaust) * speedFactor;
  const pm25Grams = baseEmissions + brakingPm25;
  return Math.round(pm25Grams * 1000) / 1000;
}

export function calculateNoiseImpact(
  date: string | Date,
  durationMin: number,
  hasResidentialStops: boolean
): { noiseScore: number; isNightRoute: boolean } {
  const d = new Date(date);
  const hour = d.getHours();
  const endHour = (hour + Math.ceil(durationMin / 60)) % 24;

  const isNight = hour >= 22 || hour < 6 || endHour >= 22 || endHour < 6;
  const nightOverlapHours = isNight ? Math.min(durationMin / 60, 4) : 0;

  let noiseScore: number;
  if (isNight) {
    noiseScore = 40 + nightOverlapHours * 15;
    if (hasResidentialStops) {
      noiseScore += 20;
    }
  } else {
    noiseScore = 10 + (durationMin / 60) * 2;
    if (hasResidentialStops) {
      noiseScore += 5;
    }
  }

  return { noiseScore: Math.round(Math.min(100, Math.max(5, noiseScore))), isNightRoute: isNight };
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

export async function calculateSustainabilityStats(
  organizationId: string,
  from?: Date,
  to?: Date,
  options: SustainabilityStatsOptions = {},
): Promise<SustainabilityStats> {
  const { maxRoutes, maxStops, includeEtaMetrics = true } = options;
  const routeConditions = [eq(routesTable.organizationId, organizationId)];
  if (from) routeConditions.push(gte(routesTable.date, from));
  if (to) routeConditions.push(lte(routesTable.date, to));
  const routeQuery = db
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
    .leftJoin(vehiclesTable, and(
      eq(routesTable.vehicleId, vehiclesTable.id),
      eq(vehiclesTable.organizationId, organizationId),
    ))
    .where(and(...routeConditions));
  const routeData = maxRoutes === undefined
    ? await routeQuery
    : await routeQuery.limit(maxRoutes + 1);
  if (maxRoutes !== undefined && routeData.length > maxRoutes) {
    throw new SustainabilityDataLimitError(
      `Environment reports are limited to ${maxRoutes.toLocaleString("sv-SE")} routes. Narrow the date range and try again.`,
    );
  }

  const RESIDENTIAL_KEYWORDS = ["gatan", "vägen", "gata", "väg", "allé", "stigen", "hemväg", "residential", "apartment", "street", "road", "avenue", "lane"];

  const routeIds = routeData.map(r => r.routeId);
  const stopCountByRoute = new Map<string, number>();
  const residentialByRoute = new Map<string, boolean>();
  let stops: Array<{
    routeId: string | null;
    address: string;
    timeWindowStart: Date | null;
    timeWindowEnd: Date | null;
    serviceDurationMin: number;
    status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  }> = [];

  if (routeIds.length > 0) {
    const stopsQuery = db.select({
      routeId: stopsTable.routeId,
      address: stopsTable.address,
      timeWindowStart: stopsTable.timeWindowStart,
      timeWindowEnd: stopsTable.timeWindowEnd,
      serviceDurationMin: stopsTable.serviceDurationMin,
      status: stopsTable.status,
    }).from(stopsTable).where(and(
      inArray(stopsTable.routeId, routeIds),
      eq(stopsTable.organizationId, organizationId),
    ));
    stops = maxStops === undefined
      ? await stopsQuery
      : await stopsQuery.limit(maxStops + 1);
    if (maxStops !== undefined && stops.length > maxStops) {
      throw new SustainabilityDataLimitError(
        `Environment reports are limited to ${maxStops.toLocaleString("sv-SE")} stops. Narrow the date range and try again.`,
      );
    }
    const stopsByRoute = new Map<string, typeof stops>();
    for (const stop of stops) {
      if (!stop.routeId) continue;
      const routeStops = stopsByRoute.get(stop.routeId) ?? [];
      routeStops.push(stop);
      stopsByRoute.set(stop.routeId, routeStops);
    }
    for (const routeId of routeIds) {
      const routeStops = stopsByRoute.get(routeId) ?? [];
      stopCountByRoute.set(routeId, routeStops.length);
      const hasResidential = routeStops.some(s => {
        const addr = (s.address ?? "").toLowerCase();
        return RESIDENTIAL_KEYWORDS.some(kw => addr.includes(kw));
      });
      residentialByRoute.set(routeId, hasResidential);
    }
  }

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
    const hasResidential = residentialByRoute.get(r.routeId) ?? true;
    const { noiseScore, isNightRoute } = calculateNoiseImpact(dateStr, dur, hasResidential);
    totalNoiseScore += noiseScore;
    if (isNightRoute) nightRouteCount++;

    const totalStops = stopCountByRoute.get(r.routeId) ?? 0;
    const pm25 = estimateParticleEmissions(dist, vType, totalStops, dur);
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

  let etaMetrics: EtaMetrics = {
    avgTimeWindowSlackMin: 0,
    stopsWithTimeWindows: 0,
    stopsOnTime: 0,
    stopsLate: 0,
    avgDurationMin: 0,
    totalRoutes: routeData.length,
  };

  if (includeEtaMetrics) {
    let totalSlackMin = 0;
    let timeWindowCount = 0;
    let onTimeCount = 0;
    let lateCount = 0;

    for (const stop of stops) {
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

    const avgDuration = routeData.length > 0
      ? routeData.reduce((sum, route) => sum + Number(route.durationMin ?? 0), 0) / routeData.length
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
