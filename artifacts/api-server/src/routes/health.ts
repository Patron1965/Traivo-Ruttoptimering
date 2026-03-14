import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();
const startedAt = Date.now();

router.get("/healthz", async (_req, res) => {
  let dbStatus = "ok";
  let dbLatencyMs: number | null = null;

  try {
    const t0 = Date.now();
    await db.execute(sql`SELECT 1`);
    dbLatencyMs = Date.now() - t0;
  } catch {
    dbStatus = "error";
  }

  const mem = process.memoryUsage();

  res.json({
    status: dbStatus === "ok" ? "ok" : "degraded",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    database: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
    },
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
  });
});

export default router;
