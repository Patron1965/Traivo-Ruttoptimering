import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, routesTable, vehiclesTable, stopsTable } from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

async function buildFleetContext(organizationId: string): Promise<string> {
  const [vehicles, routes, stops] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId)),
    db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)),
  ]);

  const vehicleSummary = vehicles.map(v =>
    `- ${v.name} (${v.licensePlate}): ${v.vehicleType}, capacity ${v.capacityKg}kg/${v.capacityVolume}m³${
      v.vehicleType === 'electric' ? `, battery ${v.batteryCapacityKwh}kWh at ${v.currentBatteryPercent ?? 100}%, range ${v.rangeKm}km` : ''
    }, active: ${v.isActive}`
  ).join('\n');

  const routeSummary = routes.map(r =>
    `- "${r.name}" (${r.status}): ${r.totalStops} stops, ${r.totalDistanceKm ?? 0}km, ${r.totalDurationMin ?? 0}min, CO₂: ${r.co2EmissionsKg ?? 0}kg, date: ${r.date?.toISOString().split('T')[0] ?? 'unset'}, vehicleId: ${r.vehicleId ?? 'none'}`
  ).join('\n');

  const unassignedStops = stops.filter(s => !s.routeId);
  const assignedStops = stops.filter(s => s.routeId);

  const stopSummary = [
    `Total stops: ${stops.length} (${assignedStops.length} assigned, ${unassignedStops.length} unassigned)`,
    ...stops.slice(0, 20).map(s =>
      `- "${s.notes || s.address}" at (${s.latitude}, ${s.longitude}), service: ${s.serviceDurationMin}min, status: ${s.status}, weight: ${s.weightKg ?? 0}kg${
        s.timeWindowStart ? `, window: ${s.timeWindowStart.toISOString().slice(11,16)}-${s.timeWindowEnd?.toISOString().slice(11,16) ?? '?'}` : ''
      }${s.routeId ? `, route: ${routes.find(r => r.id === s.routeId)?.name ?? s.routeId}` : ', UNASSIGNED'}`
    ),
    stops.length > 20 ? `... and ${stops.length - 20} more stops` : ''
  ].filter(Boolean).join('\n');

  const vehicleById = new Map(vehicles.map(v => [v.id, v.name]));
  const routeDetails = routes.map(r => {
    const routeStops = stops.filter(s => s.routeId === r.id);
    return `Route "${r.name}" (vehicle: ${r.vehicleId ? vehicleById.get(r.vehicleId) ?? 'unknown' : 'none'}): ${routeStops.length} stops`;
  }).join('\n');

  return `## Fleet Overview (${new Date().toISOString().split('T')[0]})

### Vehicles (${vehicles.length})
${vehicleSummary || 'No vehicles'}

### Routes (${routes.length})
${routeSummary || 'No routes'}

### Route Assignments
${routeDetails || 'No route assignments'}

### Stops
${stopSummary || 'No stops'}`;
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
