import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { realtimeRelayConnected } from "../services/realtime-relay";
import { isOsrmConfigured } from "../services/osrm";

const router: IRouter = Router();
const startedAt = Date.now();

router.get("/healthz", async (_req, res) => {
  const memUsage = process.memoryUsage();
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  let dbStatus: "ok" | "error" = "ok";
  let dbLatencyMs: number | null = null;

  try {
    const t0 = Date.now();
    await db.execute(sql`SELECT 1`);
    dbLatencyMs = Date.now() - t0;
  } catch {
    dbStatus = "error";
  }

  const overallStatus = dbStatus === "ok" ? "ok" : "degraded";

  res.status(overallStatus === "ok" ? 200 : 503).json({
    status: overallStatus,
    // Availability remains separate from launch readiness. No endpoints,
    // credentials, tenant IDs or operational record counts are exposed.
    operationalDependencies: {
      realtimeRelay: realtimeRelayConnected() ? "connected" : "disconnected",
      configuredRoadProvider: isOsrmConfigured(),
      errorReportingConfigured: Boolean(process.env.SENTRY_DSN),
    },
    uptime: uptimeSeconds,
    database: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
    },
    memory: {
      rssBytes: memUsage.rss,
      heapUsedBytes: memUsage.heapUsed,
      heapTotalBytes: memUsage.heapTotal,
      rssMb: Math.round(memUsage.rss / 1024 / 1024),
      heapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
    },
  });
});

export default router;
