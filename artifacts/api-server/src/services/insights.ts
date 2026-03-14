import { eq } from "drizzle-orm";
import { db, routesTable, vehiclesTable, stopsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";

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
  const [vehicles, routes, stops] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId)),
    db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)),
  ]);

  const insights: Insight[] = [];
  const now = new Date();
  const { start: todayStart, end: todayEnd } = todayRange();

  const todayRoutes = routes.filter(r => r.date && r.date >= todayStart && r.date < todayEnd);
  const todayRouteIds = new Set(todayRoutes.map(r => r.id));
  const todayStops = stops.filter(s => s.routeId && todayRouteIds.has(s.routeId));

  const lateStops = todayStops.filter(s =>
    s.timeWindowEnd && s.status === "pending" && now > s.timeWindowEnd
  );
  if (lateStops.length > 0) {
    const routeNames = [...new Set(lateStops.map(s => {
      const r = routes.find(rt => rt.id === s.routeId);
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

  const unassignedStops = stops.filter(s => !s.routeId);
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

  const totalCo2 = routes.reduce((sum, r) => sum + (Number(r.co2EmissionsKg) || 0), 0);
  const fossilRoutes = routes.filter(r => {
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

    const routeStops = stops.filter(s => s.routeId === route.id);
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

  if (todayRoutes.length === 0 && stops.length > 0) {
    insights.push({
      id: "no-routes-today",
      type: "info",
      severity: "medium",
      title: "No routes scheduled for today",
      description: `There are ${stops.length} stop(s) in the system but no routes scheduled for today. Use the Route Planner to create and optimize today's routes.`,
      category: "planning",
    });
  }

  insights.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    const typeOrder = { warning: 0, suggestion: 1, info: 2 };
    return (sevOrder[a.severity] - sevOrder[b.severity]) || (typeOrder[a.type] - typeOrder[b.type]);
  });

  return insights.slice(0, 5);
}

export async function enrichInsightsWithAI(insights: Insight[]): Promise<Insight[]> {
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
