import { eq, and, gte, lt, isNull, sql } from "drizzle-orm";
import { db, routesTable, vehiclesTable, stopsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { assertOrganizationServiceEnabled } from "./organization-service-policy";

export interface Insight {
  id: string;
  type: "warning" | "suggestion" | "info";
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  category: string;
}

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

export async function generateInsights(organizationId: string): Promise<Insight[]> {
  const now = new Date();
  const { start: todayStart, end: todayEnd } = todayRange();
  const recentStart = new Date(now.getTime() - 30 * 86400000);

  const [vehicles, todayRoutes, todayStops, unassignedStops, recentStopStats] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(routesTable).where(
      and(eq(routesTable.organizationId, organizationId), gte(routesTable.date, todayStart), lt(routesTable.date, todayEnd))
    ),
    db.execute(sql`
      SELECT s.id, s.route_id, s.status, s.time_window_start, s.time_window_end,
             s.latitude, s.longitude, s.address, s.weight_kg, s.organization_id
      FROM stops s
      INNER JOIN routes r ON s.route_id = r.id
      WHERE r.organization_id = ${organizationId}
        AND r.date >= ${todayStart} AND r.date < ${todayEnd}
    `).then(r => (r.rows as any[]).map(s => ({
      id: s.id,
      routeId: s.route_id,
      status: s.status,
      timeWindowStart: s.time_window_start ? new Date(s.time_window_start) : null,
      timeWindowEnd: s.time_window_end ? new Date(s.time_window_end) : null,
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      address: s.address,
      weightKg: Number(s.weight_kg) || 0,
    }))),
    db.select().from(stopsTable).where(
      and(eq(stopsTable.organizationId, organizationId), isNull(stopsTable.routeId))
    ),
    db.execute(sql`
      SELECT s.status, s.address, s.latitude, s.longitude FROM stops s
      INNER JOIN routes r ON s.route_id = r.id
      WHERE r.organization_id = ${organizationId}
        AND r.date >= ${recentStart}
        AND s.status IN ('completed', 'failed')
    `).then(r => r.rows as any[]),
  ]);

  const insights: Insight[] = [];
  const todayRouteIds = new Set(todayRoutes.map(r => r.id));

  const lateStops = todayStops.filter(s =>
    s.timeWindowEnd && s.status === "pending" && now > s.timeWindowEnd
  );
  if (lateStops.length > 0) {
    const routeNames = [...new Set(lateStops.map(s => {
      const r = todayRoutes.find(rt => rt.id === s.routeId);
      return r?.name ?? "Unknown";
    }))];
    insights.push({
      id: "late-stops",
      type: "warning",
      severity: "high",
      title: `${lateStops.length} stop(s) past time window`,
      description: `${lateStops.length} delivery stop(s) have exceeded their scheduled time window on route(s): ${routeNames.join(", ")}. Consider reassigning or notifying customers.`,
      category: "delivery",
    });
  }

  const atRiskStops = todayStops.filter(s => {
    if (!s.timeWindowEnd || s.status !== "pending") return false;
    const timeLeft = s.timeWindowEnd.getTime() - now.getTime();
    return timeLeft > 0 && timeLeft < 30 * 60 * 1000;
  });
  if (atRiskStops.length > 0) {
    insights.push({
      id: "at-risk-stops",
      type: "warning",
      severity: "medium",
      title: `${atRiskStops.length} stop(s) at risk of being late`,
      description: `${atRiskStops.length} pending stop(s) have less than 30 minutes remaining in their time window. Immediate attention recommended.`,
      category: "delivery",
    });
  }

  const evVehicles = vehicles.filter(v => v.vehicleType === "electric" && v.isActive);
  const lowBatteryVehicles = evVehicles.filter(v =>
    v.currentBatteryPercent !== null && v.currentBatteryPercent < 25
  );
  if (lowBatteryVehicles.length > 0) {
    insights.push({
      id: "low-battery",
      type: "warning",
      severity: "high",
      title: `${lowBatteryVehicles.length} EV(s) with low battery`,
      description: `${lowBatteryVehicles.map(v => `${v.name} (${v.currentBatteryPercent?.toFixed(0)}%)`).join(", ")} ${lowBatteryVehicles.length === 1 ? "has" : "have"} battery below 25%. Schedule charging to avoid route disruptions.`,
      category: "vehicle",
    });
  }

  const medBatteryVehicles = evVehicles.filter(v =>
    v.currentBatteryPercent !== null && v.currentBatteryPercent >= 25 && v.currentBatteryPercent < 50
  );
  if (medBatteryVehicles.length > 0) {
    insights.push({
      id: "medium-battery",
      type: "info",
      severity: "low",
      title: `${medBatteryVehicles.length} EV(s) with moderate battery`,
      description: `${medBatteryVehicles.map(v => `${v.name} (${v.currentBatteryPercent?.toFixed(0)}%)`).join(", ")} should be scheduled for charging soon.`,
      category: "vehicle",
    });
  }

  if (unassignedStops.length > 0) {
    const withTimeWindow = unassignedStops.filter(s => s.timeWindowStart);
    insights.push({
      id: "unassigned-stops",
      type: "suggestion",
      severity: unassignedStops.length > 5 ? "high" : "medium",
      title: `${unassignedStops.length} unassigned stop(s)`,
      description: `${unassignedStops.length} stop(s) are not assigned to any route${withTimeWindow.length > 0 ? ` (${withTimeWindow.length} with time windows)` : ""}. Run the optimizer to assign them to available vehicles.`,
      category: "planning",
    });
  }

  const totalCo2 = todayRoutes.reduce((sum, r) => sum + (Number(r.co2EmissionsKg) || 0), 0);
  const fossilRoutes = todayRoutes.filter(r => {
    const v = vehicles.find(vh => vh.id === r.vehicleId);
    return v && v.vehicleType === "fossil";
  });
  const fossilCo2 = fossilRoutes.reduce((sum, r) => sum + (Number(r.co2EmissionsKg) || 0), 0);
  if (totalCo2 > 0 && fossilCo2 / totalCo2 > 0.7) {
    const evAvailable = evVehicles.filter(v => {
      const assignedRoutes = todayRoutes.filter(r => r.vehicleId === v.id);
      return assignedRoutes.length === 0;
    });
    if (evAvailable.length > 0) {
      insights.push({
        id: "co2-reduction",
        type: "suggestion",
        severity: "medium",
        title: "CO\u2082 reduction opportunity",
        description: `${(fossilCo2 / totalCo2 * 100).toFixed(0)}% of CO\u2082 emissions come from fossil vehicles. ${evAvailable.length} electric vehicle(s) (${evAvailable.map(v => v.name).join(", ")}) are available and could reduce emissions by up to 90% on reassigned routes.`,
        category: "sustainability",
      });
    }
  }

  const vehicleById = new Map(vehicles.map(v => [v.id, v]));
  for (const route of todayRoutes) {
    if (!route.vehicleId) continue;
    const vehicle = vehicleById.get(route.vehicleId);
    if (!vehicle) continue;

    const routeStops = todayStops.filter(s => s.routeId === route.id);
    const totalWeight = routeStops.reduce((sum, s) => sum + (Number(s.weightKg) || 0), 0);
    const utilization = totalWeight / vehicle.capacityKg;

    if (utilization > 0.9) {
      insights.push({
        id: `capacity-high-${route.id}`,
        type: "warning",
        severity: "medium",
        title: `Route "${route.name}" near capacity limit`,
        description: `Vehicle ${vehicle.name} is at ${(utilization * 100).toFixed(0)}% weight capacity (${totalWeight.toFixed(0)}/${vehicle.capacityKg}kg). Adding more stops may exceed limits.`,
        category: "capacity",
      });
    } else if (utilization < 0.3 && routeStops.length > 0) {
      insights.push({
        id: `capacity-low-${route.id}`,
        type: "suggestion",
        severity: "low",
        title: `Route "${route.name}" underutilized`,
        description: `Vehicle ${vehicle.name} is at only ${(utilization * 100).toFixed(0)}% weight capacity. Consider consolidating with other routes or adding more stops to improve efficiency.`,
        category: "capacity",
      });
    }
  }

  const inactiveVehicles = vehicles.filter(v => !v.isActive);
  if (inactiveVehicles.length > 0 && todayRoutes.length > 0) {
    insights.push({
      id: "inactive-vehicles",
      type: "info",
      severity: "low",
      title: `${inactiveVehicles.length} vehicle(s) inactive`,
      description: `${inactiveVehicles.map(v => v.name).join(", ")} ${inactiveVehicles.length === 1 ? "is" : "are"} currently inactive. Activate if additional capacity is needed.`,
      category: "vehicle",
    });
  }

  if (todayRoutes.length === 0 && unassignedStops.length > 0) {
    insights.push({
      id: "no-routes-today",
      type: "info",
      severity: "medium",
      title: "No routes scheduled for today",
      description: `There are ${unassignedStops.length} unassigned stop(s) in the system but no routes scheduled for today. Use the Route Planner to create and optimize today's routes.`,
      category: "planning",
    });
  }

  const routeRiskInsights = analyzeRouteRisks(todayRoutes, todayStops, vehicles, now, recentStopStats, todayRoutes);
  insights.push(...routeRiskInsights);

  insights.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    const typeOrder = { warning: 0, suggestion: 1, info: 2 };
    return (sevOrder[a.severity] - sevOrder[b.severity]) || (typeOrder[a.type] - typeOrder[b.type]);
  });

  return insights.slice(0, 8);
}

function analyzeRouteRisks(
  todayRoutes: Array<{
    id: string;
    name: string;
    vehicleId: string | null;
    status: string;
    totalDistanceKm: number | null;
    totalDurationMin: number | null;
    date: Date | null;
  }>,
  todayStops: Array<{
    id: string;
    routeId: string | null;
    status: string;
    timeWindowStart: Date | null;
    timeWindowEnd: Date | null;
    latitude: number;
    longitude: number;
    address: string;
  }>,
  vehicles: Array<{
    id: string;
    name: string;
    vehicleType: string;
    rangeKm: number | null;
    currentBatteryPercent: number | null;
  }>,
  now: Date,
  allHistoricalStops?: Array<{
    status: string;
    routeId: string | null;
    address: string;
    latitude: number;
    longitude: number;
  }>,
  allHistoricalRoutes?: Array<{
    id: string;
    status: string;
    date: Date | null;
  }>
): Insight[] {
  const riskInsights: Insight[] = [];
  const hour = now.getHours();

  const isPeakHour = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 18);
  const isPrePeak = (hour >= 6 && hour < 7) || (hour >= 15 && hour < 16);

  const historicalFailRate = computeHistoricalFailRate(allHistoricalStops);
  const areaFailRates = computeAreaFailRates(allHistoricalStops);

  const pendingRoutes = todayRoutes.filter(r => r.status === "optimized" || r.status === "pending");

  for (const route of pendingRoutes) {
    const routeStops = todayStops.filter(s => s.routeId === route.id && s.status === "pending");
    if (routeStops.length === 0) continue;

    let riskScore = 0;
    const riskFactors: string[] = [];

    if (isPeakHour) {
      riskScore += 30;
      riskFactors.push("departing during peak traffic hours");
    } else if (isPrePeak) {
      riskScore += 15;
      riskFactors.push("route will enter peak traffic period");
    }

    const tightWindows = routeStops.filter(s => {
      if (!s.timeWindowStart || !s.timeWindowEnd) return false;
      const windowMinutes = (s.timeWindowEnd.getTime() - s.timeWindowStart.getTime()) / 60000;
      return windowMinutes <= 60;
    });
    if (tightWindows.length > 0) {
      riskScore += tightWindows.length * 15;
      riskFactors.push(`${tightWindows.length} stop(s) with tight time windows (≤60 min)`);
    }

    const totalDistKm = Number(route.totalDistanceKm) || 0;
    if (totalDistKm > 50) {
      riskScore += 10;
      riskFactors.push("long route distance (>50 km)");
    }

    if (routeStops.length > 10) {
      riskScore += 10;
      riskFactors.push(`high stop count (${routeStops.length} stops)`);
    }

    const vehicle = vehicles.find(v => v.id === route.vehicleId);
    if (vehicle?.vehicleType === "electric" && vehicle.currentBatteryPercent !== null) {
      if (vehicle.currentBatteryPercent < 50 && vehicle.rangeKm && totalDistKm > vehicle.rangeKm * 0.6) {
        riskScore += 20;
        riskFactors.push(`EV battery at ${vehicle.currentBatteryPercent}% with long route`);
      }
    }

    if (historicalFailRate > 0.1) {
      riskScore += 15;
      riskFactors.push(`historical failure rate ${(historicalFailRate * 100).toFixed(0)}% across fleet`);
    }

    const stopsInHighFailAreas = routeStops.filter(s => {
      const areaKey = `${Math.round(s.latitude * 100) / 100},${Math.round(s.longitude * 100) / 100}`;
      return (areaFailRates.get(areaKey) ?? 0) > 0.15;
    });
    if (stopsInHighFailAreas.length > 0) {
      riskScore += stopsInHighFailAreas.length * 10;
      riskFactors.push(`${stopsInHighFailAreas.length} stop(s) in historically problematic areas`);
    }

    const stopsWithPriorFails = routeStops.filter(s => {
      if (!allHistoricalStops) return false;
      return allHistoricalStops.some(hs => hs.address === s.address && hs.status === "failed");
    });
    if (stopsWithPriorFails.length > 0) {
      riskScore += stopsWithPriorFails.length * 12;
      riskFactors.push(`${stopsWithPriorFails.length} stop(s) with prior delivery failures at same address`);
    }

    if (riskScore >= 30) {
      const severity: "high" | "medium" | "low" = riskScore >= 50 ? "high" : riskScore >= 30 ? "medium" : "low";
      riskInsights.push({
        id: `route-risk-${route.id}`,
        type: "warning",
        severity,
        title: `Route "${route.name}" has elevated delay risk`,
        description: `Risk factors: ${riskFactors.join("; ")}. Consider rescheduling to avoid delays or reassigning to a different time slot.`,
        category: "predictive",
      });
    }
  }

  if (isPeakHour && pendingRoutes.length > 0) {
    riskInsights.push({
      id: "traffic-peak-warning",
      type: "info",
      severity: "medium",
      title: "Peak traffic period active",
      description: `Current time is within peak traffic hours (${hour >= 7 && hour <= 9 ? "morning" : "evening"} rush). Routes departing now may experience 40-60% longer travel times. Consider delaying non-urgent departures.`,
      category: "predictive",
    });
  }

  return riskInsights;
}

function computeHistoricalFailRate(
  allStops?: Array<{ status: string }>
): number {
  if (!allStops || allStops.length === 0) return 0;
  const completed = allStops.filter(s => s.status === "completed" || s.status === "failed");
  if (completed.length === 0) return 0;
  const failed = completed.filter(s => s.status === "failed").length;
  return failed / completed.length;
}

function computeAreaFailRates(
  allStops?: Array<{ status: string; latitude: number; longitude: number }>
): Map<string, number> {
  const rates = new Map<string, number>();
  if (!allStops) return rates;

  const areaMap = new Map<string, { total: number; failed: number }>();
  for (const s of allStops) {
    if (s.status !== "completed" && s.status !== "failed") continue;
    const key = `${Math.round(s.latitude * 100) / 100},${Math.round(s.longitude * 100) / 100}`;
    const entry = areaMap.get(key) ?? { total: 0, failed: 0 };
    entry.total++;
    if (s.status === "failed") entry.failed++;
    areaMap.set(key, entry);
  }

  for (const [key, entry] of areaMap.entries()) {
    if (entry.total >= 3) {
      rates.set(key, entry.failed / entry.total);
    }
  }
  return rates;
}

export async function enrichInsightsWithAI(insights: Insight[], organizationId?: string): Promise<Insight[]> {
  // Outside the provider-error fallback: a policy denial must remain explicit.
  await assertOrganizationServiceEnabled("aiEnabled", organizationId);
  if (insights.length === 0) return insights;

  try {
    const summaryList = insights.map((ins, i) =>
      `${i + 1}. [${ins.type}/${ins.severity}] ${ins.title}: ${ins.description}`
    ).join("\n");

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 2048,
      messages: [
        {
          role: "system",
          content: "You are a fleet operations advisor. Given a list of fleet insights, provide a brief actionable recommendation for each (1-2 sentences max). Return ONLY a JSON array of strings, one recommendation per insight, in the same order. No markdown, no explanation.",
        },
        {
          role: "user",
          content: summaryList,
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (text) {
      const recommendations: string[] = JSON.parse(text);
      return insights.map((ins, i) => ({
        ...ins,
        description: recommendations[i]
          ? `${ins.description}\n\n\u{1F4A1} ${recommendations[i]}`
          : ins.description,
      }));
    }
  } catch {
  }

  return insights;
}
