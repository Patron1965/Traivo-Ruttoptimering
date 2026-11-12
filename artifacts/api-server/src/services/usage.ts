import { and, eq, gte, lt } from "drizzle-orm";
import { db, planningUsageEventsTable, planningUsagePoliciesTable } from "@workspace/db";

export type UsagePolicy = {
  warnStops: number | null;
  blockStops: number | null;
  warnMonthlyRuns: number | null;
  blockMonthlyRuns: number | null;
};

export type UsageEventInput = {
  organizationId: string;
  eventKey: string;
  jobId?: string | null;
  category: "optimization" | "geocoding" | "osrm";
  provider: string;
  operation: string;
  outcome: string;
  units?: number;
  durationMs?: number | null;
  cacheStatus?: string | null;
  retry?: boolean;
  stopCount?: number | null;
  sizeClass?: string | null;
  engine?: string | null;
};

const nullPolicy: UsagePolicy = {
  warnStops: null,
  blockStops: null,
  warnMonthlyRuns: null,
  blockMonthlyRuns: null,
};

function utcMonthRange(date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function recordUsage(event: UsageEventInput): Promise<void> {
  // Events deliberately contain provider/operation metrics only; no addresses,
  // coordinates, request payloads, or customer-entered content are persisted.
  await db.insert(planningUsageEventsTable).values({
    organizationId: event.organizationId,
    eventKey: event.eventKey,
    jobId: event.jobId ?? null,
    category: event.category,
    provider: event.provider,
    operation: event.operation,
    outcome: event.outcome,
    units: event.units ?? null,
    durationMs: event.durationMs ?? null,
    cacheStatus: event.cacheStatus ?? null,
    retry: event.retry ?? false,
    stopCount: event.stopCount ?? null,
    sizeClass: event.sizeClass ?? null,
    engine: event.engine ?? null,
  }).onConflictDoNothing({
    target: [planningUsageEventsTable.organizationId, planningUsageEventsTable.eventKey],
  });
}

export async function getUsagePolicy(organizationId: string): Promise<UsagePolicy> {
  const [policy] = await db.select({
    warnStops: planningUsagePoliciesTable.warnStops,
    blockStops: planningUsagePoliciesTable.blockStops,
    warnMonthlyRuns: planningUsagePoliciesTable.warnMonthlyRuns,
    blockMonthlyRuns: planningUsagePoliciesTable.blockMonthlyRuns,
  }).from(planningUsagePoliciesTable)
    .where(eq(planningUsagePoliciesTable.organizationId, organizationId)).limit(1);
  return policy ?? nullPolicy;
}

export async function checkOptimizationUsage(
  organizationId: string,
  stopCount: number,
): Promise<{ warnings: string[]; blocked: string | null; estimatedCostOre: number | null }> {
  const policy = await getUsagePolicy(organizationId);
  const { start, end } = utcMonthRange();
  const events = await db.select({
    eventKey: planningUsageEventsTable.eventKey,
    jobId: planningUsageEventsTable.jobId,
  }).from(planningUsageEventsTable).where(and(
    eq(planningUsageEventsTable.organizationId, organizationId),
    eq(planningUsageEventsTable.category, "optimization"),
    eq(planningUsageEventsTable.operation, "alns"),
    gte(planningUsageEventsTable.occurredAt, start),
    lt(planningUsageEventsTable.occurredAt, end),
  ));
  const runs = new Set(events.map((event) => event.jobId ?? `event:${event.eventKey}`)).size;
  const warnings: string[] = [];
  let blocked: string | null = null;

  if (policy.blockStops !== null && stopCount > policy.blockStops) {
    blocked = `Planeringen överskrider företagets gräns på ${policy.blockStops} stopp.`;
  } else if (policy.warnStops !== null && stopCount > policy.warnStops) {
    warnings.push(`Planeringen överskrider varningsnivån på ${policy.warnStops} stopp.`);
  }
  if (!blocked && policy.blockMonthlyRuns !== null && runs >= policy.blockMonthlyRuns) {
    blocked = `Företaget har nått gränsen på ${policy.blockMonthlyRuns} optimeringar denna månad.`;
  } else if (policy.warnMonthlyRuns !== null && runs >= policy.warnMonthlyRuns) {
    warnings.push(`Företaget har nått varningsnivån på ${policy.warnMonthlyRuns} optimeringar denna månad.`);
  }

  // Planning time is only billable when a dated provider/operation rate is
  // available. A prospective check has no duration or call-count estimate, so
  // its cost remains unknown rather than inventing a historical/plan-based rate.
  const isLargeJob = stopCount > 100 || (policy.warnStops !== null && stopCount > policy.warnStops);
  if (isLargeJob) {
    warnings.push("Kostnadsrisken för denna stora planering är okänd före körning. Ingen extern optimeringsmotor används automatiskt.");
  }
  return { warnings, blocked, estimatedCostOre: null };
}