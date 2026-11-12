import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  organizationsTable,
  planningUsageEventsTable,
  planningUsagePoliciesTable,
  planningUsageRatesTable,
  planningUsageRevenueTable,
} from "@workspace/db";
import { logAdminEvent } from "../lib/security-log";
import { handleError } from "../lib/errors";
import { getUsagePolicy } from "../services/usage";

const router: IRouter = Router();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");
const orgParamsSchema = z.object({ organizationId: z.guid() });
const monthQuerySchema = z.object({ month: monthSchema });
const policySchema = z.object({
  warnStops: z.number().int().nonnegative().nullable(),
  blockStops: z.number().int().nonnegative().nullable(),
  warnMonthlyRuns: z.number().int().nonnegative().nullable(),
  blockMonthlyRuns: z.number().int().nonnegative().nullable(),
});
const settingsBodySchema = policySchema.extend({
  revenueOre: z.number().int().nonnegative().nullable(),
});
const rateBodySchema = z.object({
  provider: z.string().trim().min(1).max(120),
  operation: z.string().trim().min(1).max(120),
  effectiveFrom: z.string().datetime({ offset: true }),
  unitCostOre: z.number().finite().nonnegative(),
});

function utcMonthRange(month: string): { start: Date; end: Date } {
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
}

function hasCacheHit(cacheStatus: string | null): boolean {
  return cacheStatus !== null && ["hit", "cache_hit", "cached"].includes(cacheStatus.toLowerCase());
}

router.get("/platform/organizations/:organizationId/usage", async (req, res): Promise<void> => {
  const params = orgParamsSchema.safeParse(req.params);
  const query = monthQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Invalid organization ID or month; expected month=YYYY-MM" });
    return;
  }
  try {
    const organizationId = params.data.organizationId;
    const month = query.data.month;
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).limit(1);
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }

    const { start, end } = utcMonthRange(month);
    const [events, rates, [revenue], policy] = await Promise.all([
      db.select().from(planningUsageEventsTable).where(and(
        eq(planningUsageEventsTable.organizationId, organizationId),
        gte(planningUsageEventsTable.occurredAt, start),
        lt(planningUsageEventsTable.occurredAt, end),
      )).orderBy(asc(planningUsageEventsTable.occurredAt)),
      db.select().from(planningUsageRatesTable)
        .orderBy(asc(planningUsageRatesTable.effectiveFrom)),
      db.select({ revenueOre: planningUsageRevenueTable.revenueOre }).from(planningUsageRevenueTable)
        .where(and(
          eq(planningUsageRevenueTable.organizationId, organizationId),
          eq(planningUsageRevenueTable.month, month),
        )).limit(1),
      getUsagePolicy(organizationId),
    ]);

    const grouped = new Map<string, {
      provider: string;
      operation: string;
      category: string;
      outcome: string;
      cacheStatus: string | null;
      retry: boolean;
      units: number | null;
      calls: number;
      estimatedCostOre: number | null;
      unknownCost: boolean;
    }>();
    let totalCost = 0;
    let unknownCost = false;
    const byJob = new Map<string, {
      jobId: string;
      status: string;
      stopCount: number | null;
      engine: string | null;
      sizeClass: string | null;
      durationMs: number | null;
      occurredAt: Date;
      latestAt: Date;
    }>();
    const stopsByRun = new Map<string, number>();
    const executedRunIds = new Set<string>();

    for (const event of events) {
      const key = JSON.stringify([
        event.provider, event.operation, event.category, event.outcome, event.cacheStatus, event.retry,
      ]);
      const line = grouped.get(key) ?? {
        provider: event.provider,
        operation: event.operation,
        category: event.category,
        outcome: event.outcome,
        cacheStatus: event.cacheStatus,
        retry: event.retry,
        units: null,
        calls: 0,
        estimatedCostOre: 0,
        unknownCost: false,
      };
      line.calls += 1;

      const internalCompute = event.category === "optimization" &&
        event.provider === "internal" && event.operation === "optimization_compute";
      // Convention: internal optimization_compute units default to elapsed
      // seconds. Other units must be supplied by the provider integration.
      const units = event.units ?? (internalCompute && event.durationMs !== null
        ? event.durationMs / 1000
        : null);
      if (units !== null) line.units = (line.units ?? 0) + units;

      let eventCost: number | null;
      if (hasCacheHit(event.cacheStatus)) {
        eventCost = 0;
      } else if (units === 0) {
        eventCost = 0;
      } else {
        const rate = rates.filter((candidate) =>
          candidate.provider === event.provider &&
          candidate.operation === event.operation &&
          candidate.effectiveFrom.getTime() <= event.occurredAt.getTime(),
        ).at(-1);
        eventCost = rate && units !== null ? units * rate.unitCostOre : null;
      }
      if (eventCost === null) {
        line.unknownCost = true;
        line.estimatedCostOre = null;
        unknownCost = true;
      } else if (!line.unknownCost) {
        line.estimatedCostOre = (line.estimatedCostOre ?? 0) + eventCost;
        totalCost += eventCost;
      }
      grouped.set(key, line);

      if (event.category === "optimization") {
        const runKey = event.jobId ?? `event:${event.eventKey}`;
        if (event.operation !== "job_state") {
          executedRunIds.add(runKey);
        }
        if (event.jobId) {
          const existing = byJob.get(event.jobId);
          if (!existing) {
            byJob.set(event.jobId, {
              jobId: event.jobId,
              status: event.outcome,
              stopCount: event.stopCount,
              engine: event.engine,
              sizeClass: event.sizeClass,
              durationMs: event.durationMs,
              occurredAt: event.occurredAt,
              latestAt: event.occurredAt,
            });
          } else {
            if (event.stopCount !== null) {
              existing.stopCount = existing.stopCount === null
                ? event.stopCount
                : Math.max(existing.stopCount, event.stopCount);
            }
            if (event.durationMs !== null) {
              existing.durationMs = (existing.durationMs ?? 0) + event.durationMs;
            }
            if (event.occurredAt.getTime() < existing.occurredAt.getTime()) existing.occurredAt = event.occurredAt;
            if (event.occurredAt.getTime() >= existing.latestAt.getTime()) {
              existing.latestAt = event.occurredAt;
              existing.status = event.outcome;
              existing.engine = event.engine;
              existing.sizeClass = event.sizeClass;
            }
          }
        }
        if (event.stopCount !== null && event.operation !== "job_state") {
          stopsByRun.set(runKey, Math.max(stopsByRun.get(runKey) ?? 0, event.stopCount));
        }
      }
    }

    const jobs = [...byJob.values()]
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, 100)
      .map(({ latestAt: _latestAt, ...job }) => job);
    const runs = executedRunIds.size;
    const plannedStops = [...stopsByRun.values()].reduce((sum, value) => sum + value, 0);
    const isLarge = (job: { stopCount: number | null; sizeClass: string | null }) =>
      (job.stopCount !== null && (job.stopCount > 100 ||
        (policy.warnStops !== null && job.stopCount > policy.warnStops))) ||
      ["large", "xlarge", "extra-large"].includes((job.sizeClass ?? "").toLowerCase());
    const revenueOre = revenue?.revenueOre ?? null;
    const estimatedCostOre = unknownCost ? null : totalCost;
    res.json({
      month,
      summary: {
        runs,
        largeRuns: [...byJob.values()].filter((job) => executedRunIds.has(job.jobId) && isLarge(job)).length,
        plannedStops,
        estimatedCostOre,
        revenueOre,
        marginOre: revenueOre === null || estimatedCostOre === null ? null : revenueOre - estimatedCostOre,
        unknownCost,
      },
      breakdown: [...grouped.values()].map(({ unknownCost: _unknownCost, ...line }) => line),
      jobs,
      settings: { ...policy, revenueOre },
      rates: rates.map((rate) => ({
        provider: rate.provider,
        operation: rate.operation,
        effectiveFrom: rate.effectiveFrom,
        unitCostOre: rate.unitCostOre,
      })),
    });
  } catch (error) { handleError(res, error); }
});

router.put("/platform/organizations/:organizationId/usage/settings", async (req, res): Promise<void> => {
  const params = orgParamsSchema.safeParse(req.params);
  const query = monthQuerySchema.safeParse(req.query);
  const body = settingsBodySchema.safeParse(req.body);
  if (!params.success || !query.success || !body.success) {
    res.status(400).json({ error: "Invalid organization, month, usage policy, or revenue" });
    return;
  }
  try {
    const organizationId = params.data.organizationId;
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).limit(1);
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }
    const [oldPolicy] = await db.select().from(planningUsagePoliciesTable)
      .where(eq(planningUsagePoliciesTable.organizationId, organizationId)).limit(1);
    const [oldRevenue] = await db.select().from(planningUsageRevenueTable).where(and(
      eq(planningUsageRevenueTable.organizationId, organizationId),
      eq(planningUsageRevenueTable.month, query.data.month),
    )).limit(1);
    const policy = {
      warnStops: body.data.warnStops,
      blockStops: body.data.blockStops,
      warnMonthlyRuns: body.data.warnMonthlyRuns,
      blockMonthlyRuns: body.data.blockMonthlyRuns,
    };
    await db.transaction(async (tx) => {
      await tx.insert(planningUsagePoliciesTable).values({
        organizationId,
        ...policy,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: planningUsagePoliciesTable.organizationId,
        set: { ...policy, updatedAt: new Date() },
      });
      await tx.insert(planningUsageRevenueTable).values({
        organizationId,
        month: query.data.month,
        revenueOre: body.data.revenueOre,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [planningUsageRevenueTable.organizationId, planningUsageRevenueTable.month],
        set: { revenueOre: body.data.revenueOre, updatedAt: new Date() },
      });
    });
    await logAdminEvent({
      req,
      action: "platform.usage.settings.update",
      resourceType: "organization",
      resourceId: organizationId,
      statusCode: 200,
      diff: {
        targetOrganizationId: organizationId,
        month: query.data.month,
        policy: { from: oldPolicy ? {
          warnStops: oldPolicy.warnStops,
          blockStops: oldPolicy.blockStops,
          warnMonthlyRuns: oldPolicy.warnMonthlyRuns,
          blockMonthlyRuns: oldPolicy.blockMonthlyRuns,
        } : null, to: policy },
        revenueOre: { from: oldRevenue?.revenueOre ?? null, to: body.data.revenueOre },
      },
    });
    res.json({ settings: { ...policy, revenueOre: body.data.revenueOre } });
  } catch (error) { handleError(res, error); }
});

router.get("/platform/usage/rates", async (_req, res): Promise<void> => {
  try {
    const rates = await db.select().from(planningUsageRatesTable)
      .orderBy(asc(planningUsageRatesTable.provider), asc(planningUsageRatesTable.operation),
        desc(planningUsageRatesTable.effectiveFrom));
    res.json({ rates: rates.map((rate) => ({
      provider: rate.provider,
      operation: rate.operation,
      effectiveFrom: rate.effectiveFrom,
      unitCostOre: rate.unitCostOre,
    })) });
  } catch (error) { handleError(res, error); }
});

router.put("/platform/usage/rates", async (req, res): Promise<void> => {
  const body = rateBodySchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid provider rate" }); return; }
  try {
    const rate = {
      provider: body.data.provider,
      operation: body.data.operation,
      effectiveFrom: new Date(body.data.effectiveFrom),
      unitCostOre: body.data.unitCostOre,
    };
    const [saved] = await db.insert(planningUsageRatesTable).values(rate).onConflictDoUpdate({
      target: [
        planningUsageRatesTable.provider,
        planningUsageRatesTable.operation,
        planningUsageRatesTable.effectiveFrom,
      ],
      set: { unitCostOre: rate.unitCostOre },
    }).returning();
    await logAdminEvent({
      req,
      action: "platform.usage.rate.update",
      resourceType: "organization",
      resourceId: null,
      statusCode: 200,
      diff: {
        provider: rate.provider,
        operation: rate.operation,
        effectiveFrom: rate.effectiveFrom.toISOString(),
        unitCostOre: rate.unitCostOre,
      },
    });
    res.json({
      provider: saved.provider,
      operation: saved.operation,
      effectiveFrom: saved.effectiveFrom,
      unitCostOre: saved.unitCostOre,
    });
  } catch (error) { handleError(res, error); }
});

export default router;