import { db, driverBehaviorLogsTable, driverLearnedProfilesTable, routesTable, stopsTable, driversTable, vehiclesTable } from "@workspace/db";
import { eq, desc, and, gte, sql } from "drizzle-orm";

export async function verifyDriverBelongsToOrg(driverId: string, orgId: string): Promise<boolean> {
  const driver = await db.query.driversTable.findFirst({
    where: and(eq(driversTable.id, driverId), eq(driversTable.organizationId, orgId)),
  });
  return !!driver;
}

interface BehaviorLogInput {
  driverId: string;
  routeId: string;
  plannedDurationMin?: number;
  actualDurationMin?: number;
  plannedDistanceKm?: number;
  actualDistanceKm?: number;
  stopsCompleted: number;
  stopsTotal: number;
  stopsFailed: number;
  avgServiceDurationMin?: number;
  onTimeRate?: number;
  breaksTaken?: number;
  totalBreakMin?: number;
  startedAt?: Date;
  finishedAt?: Date;
  areaCenter?: { lat: number; lng: number };
  weatherCondition?: string;
}

export async function logRouteBehavior(input: BehaviorLogInput) {
  const [log] = await db
    .insert(driverBehaviorLogsTable)
    .values({
      driverId: input.driverId,
      routeId: input.routeId,
      plannedDurationMin: input.plannedDurationMin ?? null,
      actualDurationMin: input.actualDurationMin ?? null,
      plannedDistanceKm: input.plannedDistanceKm ?? null,
      actualDistanceKm: input.actualDistanceKm ?? null,
      stopsCompleted: input.stopsCompleted,
      stopsTotal: input.stopsTotal,
      stopsFailed: input.stopsFailed,
      avgServiceDurationMin: input.avgServiceDurationMin ?? null,
      onTimeRate: input.onTimeRate ?? null,
      breaksTaken: input.breaksTaken ?? 0,
      totalBreakMin: input.totalBreakMin ?? 0,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      areaCenter: input.areaCenter ?? null,
      weatherCondition: input.weatherCondition ?? null,
    })
    .returning();

  await updateLearnedProfile(input.driverId);
  return log;
}

export async function autoLogCompletedRoute(routeId: string, organizationId: string) {
  const route = await db.query.routesTable.findFirst({
    where: and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ),
  });
  if (!route || route.status !== "completed") return null;

  if (!route.vehicleId) return null;

  const driver = await db.query.driversTable.findFirst({
    where: eq(driversTable.vehicleId, route.vehicleId),
  });

  if (!driver) return null;

  const existing = await db.query.driverBehaviorLogsTable.findFirst({
    where: and(
      eq(driverBehaviorLogsTable.driverId, driver.id),
      eq(driverBehaviorLogsTable.routeId, routeId)
    ),
  });
  if (existing) return existing;

  const stops = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.routeId, routeId));

  const completed = stops.filter((s) => s.status === "completed");
  const failed = stops.filter((s) => s.status === "failed");

  let avgLat = 0,
    avgLng = 0;
  for (const s of stops) {
    avgLat += s.latitude;
    avgLng += s.longitude;
  }
  if (stops.length > 0) {
    avgLat /= stops.length;
    avgLng /= stops.length;
  }

  const onTimeCount = completed.filter((s) => {
    if (!s.timeWindowEnd) return true;
    return true;
  }).length;

  return logRouteBehavior({
    driverId: driver.id,
    routeId,
    plannedDurationMin: route.totalDurationMin ?? undefined,
    plannedDistanceKm: route.totalDistanceKm ?? undefined,
    stopsCompleted: completed.length,
    stopsTotal: stops.length,
    stopsFailed: failed.length,
    onTimeRate: stops.length > 0 ? onTimeCount / stops.length : undefined,
    areaCenter: stops.length > 0 ? { lat: avgLat, lng: avgLng } : undefined,
  });
}

export async function updateLearnedProfile(driverId: string) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const logs = await db
    .select()
    .from(driverBehaviorLogsTable)
    .where(
      and(
        eq(driverBehaviorLogsTable.driverId, driverId),
        gte(driverBehaviorLogsTable.logDate, thirtyDaysAgo)
      )
    )
    .orderBy(desc(driverBehaviorLogsTable.logDate))
    .limit(50);

  if (logs.length < 3) return null;

  let speedFactorSum = 0;
  let speedFactorCount = 0;
  let serviceDurationFactorSum = 0;
  let serviceDurationFactorCount = 0;
  let reliabilitySum = 0;
  let breakIntervals: number[] = [];
  let startHours: number[] = [];

  const areaMap = new Map<string, { lat: number; lng: number; count: number }>();

  for (const log of logs) {
    if (log.plannedDurationMin && log.actualDurationMin && log.plannedDurationMin > 0) {
      speedFactorSum += log.actualDurationMin / log.plannedDurationMin;
      speedFactorCount++;
    }

    if (log.avgServiceDurationMin) {
      serviceDurationFactorSum += log.avgServiceDurationMin / 15;
      serviceDurationFactorCount++;
    }

    if (log.stopsTotal > 0) {
      reliabilitySum += log.stopsCompleted / log.stopsTotal;
    }

    if (log.breaksTaken > 0 && log.actualDurationMin) {
      breakIntervals.push(log.actualDurationMin / log.breaksTaken);
    }

    if (log.startedAt) {
      startHours.push(log.startedAt.getHours());
    }

    if (log.areaCenter) {
      const center = log.areaCenter as { lat: number; lng: number };
      const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
      const existing = areaMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        areaMap.set(key, { lat: center.lat, lng: center.lng, count: 1 });
      }
    }
  }

  const speedFactor = speedFactorCount > 0
    ? Math.round((speedFactorSum / speedFactorCount) * 100) / 100
    : 1.0;

  const serviceDurationFactor = serviceDurationFactorCount > 0
    ? Math.round((serviceDurationFactorSum / serviceDurationFactorCount) * 100) / 100
    : 1.0;

  const reliabilityScore = logs.length > 0
    ? Math.round((reliabilitySum / logs.length) * 100) / 100
    : 0.5;

  const preferredAreas = Array.from(areaMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((a) => ({
      lat: a.lat,
      lng: a.lng,
      familiarity: Math.min(1.0, a.count / logs.length),
    }));

  const avgBreakIntervalMin = breakIntervals.length > 0
    ? Math.round((breakIntervals.reduce((s, v) => s + v, 0) / breakIntervals.length) * 10) / 10
    : null;

  const peakPerformanceHour = startHours.length > 0
    ? getModeValue(startHours)
    : null;

  const existing = await db.query.driverLearnedProfilesTable.findFirst({
    where: eq(driverLearnedProfilesTable.driverId, driverId),
  });

  const profileData = {
    speedFactor: clamp(speedFactor, 0.5, 2.0),
    serviceDurationFactor: clamp(serviceDurationFactor, 0.5, 2.0),
    reliabilityScore,
    preferredAreas,
    avgBreakIntervalMin,
    peakPerformanceHour,
    dataPointCount: logs.length,
    lastUpdated: new Date(),
  };

  if (existing) {
    const [updated] = await db
      .update(driverLearnedProfilesTable)
      .set(profileData)
      .where(eq(driverLearnedProfilesTable.driverId, driverId))
      .returning();
    return updated;
  } else {
    const [created] = await db
      .insert(driverLearnedProfilesTable)
      .values({ driverId, ...profileData })
      .returning();
    return created;
  }
}

export async function getLearnedProfile(driverId: string) {
  return db.query.driverLearnedProfilesTable.findFirst({
    where: eq(driverLearnedProfilesTable.driverId, driverId),
  });
}

export async function getDriverBehaviorLogs(driverId: string, limit = 20) {
  return db
    .select()
    .from(driverBehaviorLogsTable)
    .where(eq(driverBehaviorLogsTable.driverId, driverId))
    .orderBy(desc(driverBehaviorLogsTable.logDate))
    .limit(limit);
}

export async function getDriverLearningInsights(driverId: string) {
  const profile = await getLearnedProfile(driverId);
  const logs = await getDriverBehaviorLogs(driverId, 30);

  if (!profile || logs.length < 3) {
    return {
      hasEnoughData: false,
      message: "Behöver minst 3 avslutade rutter för att generera insikter",
      profile: null,
      trends: null,
    };
  }

  const recentLogs = logs.slice(0, 10);
  const olderLogs = logs.slice(10);

  const recentReliability = recentLogs.length > 0
    ? recentLogs.reduce((s, l) => s + (l.stopsTotal > 0 ? l.stopsCompleted / l.stopsTotal : 0), 0) / recentLogs.length
    : 0;
  const olderReliability = olderLogs.length > 0
    ? olderLogs.reduce((s, l) => s + (l.stopsTotal > 0 ? l.stopsCompleted / l.stopsTotal : 0), 0) / olderLogs.length
    : recentReliability;

  const recentSpeedAccuracy = computeAvgSpeedAccuracy(recentLogs);
  const olderSpeedAccuracy = olderLogs.length > 0 ? computeAvgSpeedAccuracy(olderLogs) : recentSpeedAccuracy;

  const reliabilityTrend = recentReliability - olderReliability;
  const speedAccuracyTrend = recentSpeedAccuracy - olderSpeedAccuracy;

  const strengths: string[] = [];
  const improvements: string[] = [];

  if (profile.reliabilityScore >= 0.95) strengths.push("Utmärkt leveranssäkerhet");
  else if (profile.reliabilityScore >= 0.85) strengths.push("Bra leveranssäkerhet");
  else improvements.push("Leveranssäkerhet kan förbättras");

  if (profile.speedFactor >= 0.9 && profile.speedFactor <= 1.1) strengths.push("Punktlig tidshållning");
  else if (profile.speedFactor > 1.2) improvements.push("Tar ofta längre tid än planerat");
  else if (profile.speedFactor < 0.8) strengths.push("Snabbare än genomsnittet");

  if ((profile.preferredAreas as any[])?.length >= 3) strengths.push("Bred områdeskännedom");

  return {
    hasEnoughData: true,
    profile: {
      speedFactor: profile.speedFactor,
      serviceDurationFactor: profile.serviceDurationFactor,
      reliabilityScore: profile.reliabilityScore,
      preferredAreas: profile.preferredAreas,
      avgBreakIntervalMin: profile.avgBreakIntervalMin,
      peakPerformanceHour: profile.peakPerformanceHour,
      dataPoints: profile.dataPointCount,
    },
    trends: {
      reliabilityTrend: Math.round(reliabilityTrend * 100) / 100,
      speedAccuracyTrend: Math.round(speedAccuracyTrend * 100) / 100,
      improving: reliabilityTrend > 0 || speedAccuracyTrend > 0,
    },
    strengths,
    improvements,
  };
}

export function getAreaFamiliarity(
  driverProfile: { preferredAreas: { lat: number; lng: number; familiarity: number }[] } | null,
  targetLat: number,
  targetLng: number
): number {
  if (!driverProfile || !driverProfile.preferredAreas || driverProfile.preferredAreas.length === 0) {
    return 0;
  }

  let maxFamiliarity = 0;
  for (const area of driverProfile.preferredAreas) {
    const dist = Math.sqrt((targetLat - area.lat) ** 2 + (targetLng - area.lng) ** 2) * 111;
    if (dist < 5) {
      const proximity = Math.max(0, 1 - dist / 5);
      const familiarity = area.familiarity * proximity;
      maxFamiliarity = Math.max(maxFamiliarity, familiarity);
    }
  }

  return Math.round(maxFamiliarity * 100) / 100;
}

function computeAvgSpeedAccuracy(logs: any[]): number {
  let sum = 0;
  let count = 0;
  for (const log of logs) {
    if (log.plannedDurationMin && log.actualDurationMin && log.plannedDurationMin > 0) {
      const accuracy = 1 - Math.abs(log.actualDurationMin - log.plannedDurationMin) / log.plannedDurationMin;
      sum += Math.max(0, accuracy);
      count++;
    }
  }
  return count > 0 ? sum / count : 0.5;
}

function getModeValue(values: number[]): number {
  const freq = new Map<number, number>();
  for (const v of values) {
    freq.set(v, (freq.get(v) ?? 0) + 1);
  }
  let maxFreq = 0;
  let mode = values[0];
  for (const [val, f] of freq) {
    if (f > maxFreq) {
      maxFreq = f;
      mode = val;
    }
  }
  return mode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
