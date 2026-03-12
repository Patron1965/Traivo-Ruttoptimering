import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, routesTable, vehiclesTable, stopsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

async function buildFleetContext(organizationId: string): Promise<string> {
  const { start: todayStart, end: todayEnd } = todayRange();

  const [vehicles, allRoutes, allStops] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId)),
    db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)),
  ]);

  const todayRoutes = allRoutes.filter(r =>
    r.date && r.date >= todayStart && r.date < todayEnd
  );
  const otherRoutes = allRoutes.filter(r =>
    !r.date || r.date < todayStart || r.date >= todayEnd
  );

  const todayRouteIds = new Set(todayRoutes.map(r => r.id));
  const todayStops = allStops.filter(s => s.routeId && todayRouteIds.has(s.routeId));
  const unassignedStops = allStops.filter(s => !s.routeId);

  const vehicleSummary = vehicles.map(v =>
    `- ${v.name} (${v.licensePlate}): ${v.vehicleType}, capacity ${v.capacityKg}kg/${v.capacityVolume}m³${
      v.vehicleType === 'electric' ? `, battery ${v.batteryCapacityKwh}kWh at ${v.currentBatteryPercent ?? 100}%, range ${v.rangeKm}km` : ''
    }, active: ${v.isActive}`
  ).join('\n');

  const vehicleById = new Map(vehicles.map(v => [v.id, v.name]));

  const formatRoute = (r: typeof allRoutes[0]) => {
    const routeStops = allStops.filter(s => s.routeId === r.id);
    const lateStops = routeStops.filter(s => {
      if (!s.timeWindowEnd || s.status === 'completed') return false;
      return s.status === 'pending' && new Date() > s.timeWindowEnd;
    });
    return `- "${r.name}" (${r.status}): ${r.totalStops} stops, ${r.totalDistanceKm ?? 0}km, ${r.totalDurationMin ?? 0}min, CO₂: ${r.co2EmissionsKg ?? 0}kg, vehicle: ${r.vehicleId ? vehicleById.get(r.vehicleId) ?? 'unknown' : 'none'}, date: ${r.date?.toISOString().split('T')[0] ?? 'unset'}${
      lateStops.length > 0 ? `, ⚠ ${lateStops.length} stop(s) past time window` : ''
    }`;
  };

  const todayRouteSummary = todayRoutes.map(formatRoute).join('\n');
  const otherRouteSummary = otherRoutes.length > 0
    ? `\n\n### Other Routes (${otherRoutes.length})\n${otherRoutes.slice(0, 10).map(formatRoute).join('\n')}${otherRoutes.length > 10 ? `\n... and ${otherRoutes.length - 10} more` : ''}`
    : '';

  const formatStop = (s: typeof allStops[0]) =>
    `- "${s.notes || s.address}" at (${s.latitude}, ${s.longitude}), service: ${s.serviceDurationMin}min, status: ${s.status}, weight: ${s.weightKg ?? 0}kg${
      s.timeWindowStart ? `, window: ${s.timeWindowStart.toISOString().slice(11,16)}-${s.timeWindowEnd?.toISOString().slice(11,16) ?? '?'}` : ''
    }${s.routeId ? `, route: ${allRoutes.find(r => r.id === s.routeId)?.name ?? s.routeId}` : ', UNASSIGNED'}${
      s.timeWindowEnd && s.status === 'pending' && new Date() > s.timeWindowEnd ? ' ⚠ LATE' : ''
    }`;

  const todayStopSummary = todayStops.length > 0
    ? todayStops.slice(0, 30).map(formatStop).join('\n') + (todayStops.length > 30 ? `\n... and ${todayStops.length - 30} more stops` : '')
    : 'No stops scheduled for today';

  const unassignedSummary = unassignedStops.length > 0
    ? unassignedStops.slice(0, 10).map(formatStop).join('\n') + (unassignedStops.length > 10 ? `\n... and ${unassignedStops.length - 10} more unassigned` : '')
    : 'No unassigned stops';

  const today = new Date().toISOString().split('T')[0];
  return `## Fleet Overview — Today (${today})

### Vehicles (${vehicles.length})
${vehicleSummary || 'No vehicles'}

### Today's Routes (${todayRoutes.length})
${todayRouteSummary || 'No routes scheduled for today'}

### Today's Stops (${todayStops.length})
${todayStopSummary}

### Unassigned Stops (${unassignedStops.length})
${unassignedSummary}${otherRouteSummary}

### Overall Stats
- Total routes: ${allRoutes.length}, Total stops: ${allStops.length}
- Total CO₂: ${allRoutes.reduce((sum, r) => sum + (Number(r.co2EmissionsKg) || 0), 0).toFixed(1)}kg`;
}

const SYSTEM_PROMPT = `You are RouteAI Assistant, an intelligent fleet management and route optimization assistant for Stockholm Logistics AB. You help operators understand their fleet status, route performance, and delivery operations.

You have access to real-time fleet data provided below. Answer questions accurately based on this data. When asked about specific metrics, cite the actual numbers. Be concise but helpful.

You can help with:
- Fleet status and vehicle information
- Route details, distances, and durations
- Stop assignments and delivery status
- CO₂ emissions and sustainability metrics
- Operational suggestions and optimizations
- Time window analysis and scheduling

Always respond in a friendly, professional tone. If you don't have enough data to answer a question, say so clearly. Use metric units (km, kg).`;

router.post("/ai/chat", async (req, res) => {
  try {
    const { messages, organizationId } = req.body;

    if (!organizationId || !messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "organizationId and messages array are required" });
      return;
    }

    const MAX_MESSAGES = 30;
    const validRoles = new Set(["user", "assistant"]);
    const sanitized = messages
      .filter((m: { role?: string; content?: string }) =>
        m && typeof m.content === "string" && m.content.length <= 4000 && validRoles.has(m.role ?? "")
      )
      .slice(-MAX_MESSAGES);

    if (sanitized.length === 0) {
      res.status(400).json({ error: "At least one valid message is required" });
      return;
    }

    const context = await buildFleetContext(organizationId);

    const chatMessages = [
      { role: "system" as const, content: `${SYSTEM_PROMPT}\n\n${context}` },
      ...sanitized.map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    const stream = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 8192,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      if (abortController.signal.aborted) {
        stream.controller.abort();
        break;
      }
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (!abortController.signal.aborted) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      handleError(res, err);
    } else {
      res.write(`data: ${JSON.stringify({ error: "An error occurred" })}\n\n`);
      res.end();
    }
  }
});

export default router;
