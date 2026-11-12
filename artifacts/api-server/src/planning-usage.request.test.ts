import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import {
  auditLogTable,
  db,
  organizationsTable,
  planningUsageEventsTable,
  planningUsagePoliciesTable,
  planningUsageRatesTable,
  planningUsageRevenueTable,
  pool,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import { createSession } from "./lib/session";
import { authMiddleware, requireAuth } from "./middleware/auth";
import { optimizeWithALNS, type ALNSNode, type ALNSVehicle } from "./services/alns";
import { clearOsrmCache } from "./services/osrm";
import { recordUsage } from "./services/usage";
import { runWithUsageContext } from "./services/usage-context";

const runId = randomUUID();
const organizationIds = [randomUUID(), randomUUID()];
const userIds = [randomUUID(), randomUUID(), randomUUID()];
const sessionIds: string[] = [];
const provider = `planning-usage-test-${runId}`;
const operation = "matrix";
const reportMonth = "2026-07";
let server: Server;
let optimizationServer: Server;
let base = "";
let optimizationBase = "";
let platformToken = "";
let tenantAToken = "";
let tenantBToken = "";

async function request(path: string, token: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})) as Record<string, any>,
  };
}

async function optimizationRequest(path: string, token: string, jobId: string) {
  return new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const body = JSON.stringify({});
    const outgoing = httpRequest(`${optimizationBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Test-Job-Id": jobId,
        Connection: "close",
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(responseBody || "{}") as Record<string, any>,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function usageEvent(
  organizationId: string,
  eventKey: string,
  occurredAt: string,
  fields: Partial<typeof planningUsageEventsTable.$inferInsert> = {},
) {
  return {
    organizationId,
    eventKey,
    category: "geocoding",
    provider,
    operation,
    outcome: "success",
    occurredAt: new Date(occurredAt),
    ...fields,
  };
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: organizationIds[0], name: `Usage A ${runId}`, email: `usage-a-${runId}@example.test` },
    { id: organizationIds[1], name: `Usage B ${runId}`, email: `usage-b-${runId}@example.test` },
  ]);
  await db.insert(usersTable).values([
    {
      id: userIds[0],
      organizationId: organizationIds[0],
      name: `Usage Platform ${runId}`,
      email: `usage-platform-${runId}@example.test`,
      role: "admin",
      isPlatformAdmin: true,
    },
    {
      id: userIds[1],
      organizationId: organizationIds[0],
      name: `Usage Admin A ${runId}`,
      email: `usage-admin-a-${runId}@example.test`,
      role: "admin",
    },
    {
      id: userIds[2],
      organizationId: organizationIds[1],
      name: `Usage Admin B ${runId}`,
      email: `usage-admin-b-${runId}@example.test`,
      role: "admin",
    },
  ]);
  const sessions = await Promise.all(userIds.map(async (userId, index) => {
    const organizationId = index === 2 ? organizationIds[1] : organizationIds[0];
    const { token, session } = await createSession({ userId, organizationId });
    sessionIds.push(session.id);
    return token;
  }));
  [platformToken, tenantAToken, tenantBToken] = sessions;

  await db.insert(planningUsageEventsTable).values([
    usageEvent(organizationIds[0], `boundary-before-${runId}`, "2026-06-30T23:59:59.999Z", {
      units: 100,
    }),
    usageEvent(organizationIds[0], `july-start-${runId}`, "2026-07-01T00:00:00.000Z", {
      units: 2,
    }),
    usageEvent(organizationIds[0], `july-failure-${runId}`, "2026-07-15T12:00:00.000Z", {
      outcome: "failure",
      units: 3,
      retry: true,
    }),
    usageEvent(organizationIds[0], `july-cache-${runId}`, "2026-07-20T12:00:00.000Z", {
      cacheStatus: "hit",
      units: 100,
    }),
    usageEvent(organizationIds[0], `july-unknown-${runId}`, "2026-07-25T12:00:00.000Z", {
      provider: `${provider}-unpriced`,
      operation: "lookup",
      units: 4,
    }),
    usageEvent(organizationIds[0], `july-end-${runId}`, "2026-07-31T23:59:59.999Z", {
      units: 1,
    }),
    usageEvent(organizationIds[0], `boundary-after-${runId}`, "2026-08-01T00:00:00.000Z", {
      units: 100,
    }),
    usageEvent(organizationIds[1], `other-tenant-${runId}`, "2026-07-10T12:00:00.000Z", {
      units: 500,
    }),
  ]);

  const { default: app } = await import("./app");
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;

  const testNodes: ALNSNode[] = [{
    id: `usage-meter-stop-${runId}`,
    latitude: 59.3303,
    longitude: 18.0696,
    timeWindowStart: null,
    timeWindowEnd: null,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  }];
  const testVehicles: ALNSVehicle[] = [{
    id: `usage-meter-vehicle-${runId}`,
    vehicleType: "van",
    capacityKg: 1_000,
    capacityVolume: 10,
    rangeKm: null,
  }];
  const optimizationTestApp = express();
  optimizationTestApp.use(express.json());
  optimizationTestApp.use(authMiddleware());
  optimizationTestApp.use((req, res, next) => {
    if (!req.user) { next(); return; }
    const jobId = req.get("X-Test-Job-Id") ?? randomUUID();
    res.locals.usageTestJobId = jobId;
    runWithUsageContext({ organizationId: req.user.organizationId, jobId }, next);
  });
  optimizationTestApp.post("/optimize/:mode", requireAuth(), async (req, res) => {
    const invoke = () => optimizeWithALNS(
      testNodes,
      testVehicles,
      59.3293,
      18.0686,
      new Date("2026-08-19T07:00:00.000Z"),
      { timeLimitMs: 25, maxIterations: 1, maxNoImprovementIterations: 1, localSearchTimeLimitMs: 1 },
      req.params.mode === "failure"
        ? () => { throw new Error("intentional progress callback failure"); }
        : undefined,
    );
    const finish = async (respond: boolean) => {
      try {
        await invoke();
        if (respond) res.json({ status: "complete" });
      } catch (error) {
        if (respond) {
          res.status(500).json({ error: error instanceof Error ? error.message : "Optimization failed" });
        }
      }
    };
    if (req.params.mode === "set-immediate") {
      res.status(202).json({ status: "scheduled" });
      setImmediate(() => { void finish(false); });
      return;
    }
    await finish(true);
  });
  optimizationServer = createServer(optimizationTestApp);
  await new Promise<void>((resolve) => optimizationServer.listen(0, "127.0.0.1", resolve));
  const optimizationAddress = optimizationServer.address();
  assert.ok(optimizationAddress && typeof optimizationAddress !== "string");
  optimizationBase = `http://127.0.0.1:${optimizationAddress.port}`;
});

after(async () => {
  optimizationServer?.closeAllConnections();
  await new Promise<void>((resolve) => optimizationServer?.close(() => resolve()) ?? resolve());
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, organizationIds));
  await db.delete(planningUsageEventsTable)
    .where(inArray(planningUsageEventsTable.organizationId, organizationIds));
  await db.delete(planningUsagePoliciesTable)
    .where(inArray(planningUsagePoliciesTable.organizationId, organizationIds));
  await db.delete(planningUsageRevenueTable)
    .where(inArray(planningUsageRevenueTable.organizationId, organizationIds));
  await db.delete(planningUsageRatesTable).where(eq(planningUsageRatesTable.provider, provider));
  await db.delete(sessionsTable).where(inArray(sessionsTable.id, sessionIds));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  await pool.end();
});

test("usage, settings, and global rates are platform-admin-only across two organizations", async () => {
  const organizationAUsage = `/platform/organizations/${organizationIds[0]}/usage?month=${reportMonth}`;
  const organizationBUsage = `/platform/organizations/${organizationIds[1]}/usage?month=${reportMonth}`;
  const settingsPath = `/platform/organizations/${organizationIds[0]}/usage/settings?month=${reportMonth}`;
  const settings = {
    warnStops: 12,
    blockStops: 24,
    warnMonthlyRuns: 5,
    blockMonthlyRuns: 10,
    revenueOre: 8_500,
  };
  const rate = {
    provider,
    operation,
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    unitCostOre: 10,
  };

  for (const token of [tenantAToken, tenantBToken]) {
    const denied = await Promise.all([
      request(organizationAUsage, token),
      request(organizationBUsage, token),
      request(settingsPath, token, "PUT", settings),
      request("/platform/usage/rates", token),
      request("/platform/usage/rates", token, "PUT", rate),
    ]);
    for (const result of denied) assert.equal(result.status, 403);
  }

  const savedSettings = await request(settingsPath, platformToken, "PUT", settings);
  assert.equal(savedSettings.status, 200, JSON.stringify(savedSettings.body));
  assert.deepEqual(savedSettings.body.settings, settings);

  const savedRate = await request("/platform/usage/rates", platformToken, "PUT", rate);
  assert.equal(savedRate.status, 200, JSON.stringify(savedRate.body));
  assert.equal(savedRate.body.unitCostOre, 10);
  const updatedRate = await request("/platform/usage/rates", platformToken, "PUT", {
    ...rate,
    unitCostOre: 11,
  });
  assert.equal(updatedRate.status, 200);
  assert.equal(updatedRate.body.unitCostOre, 11);

  const rates = await request("/platform/usage/rates", platformToken);
  assert.equal(rates.status, 200);
  assert.equal(rates.body.rates.filter((item: { provider: string }) => item.provider === provider).length, 1);
  const organizationA = await request(organizationAUsage, platformToken);
  const organizationB = await request(organizationBUsage, platformToken);
  assert.equal(organizationA.status, 200, JSON.stringify(organizationA.body));
  assert.equal(organizationB.status, 200, JSON.stringify(organizationB.body));
  assert.equal(organizationA.body.settings.revenueOre, 8_500);
  assert.equal(organizationA.body.settings.warnStops, 12);
  assert.equal(organizationB.body.settings.revenueOre, null);
  assert.equal(organizationB.body.settings.warnStops, null);

  const [storedRate] = await db.select().from(planningUsageRatesTable)
    .where(and(
      eq(planningUsageRatesTable.provider, provider),
      eq(planningUsageRatesTable.operation, operation),
    ));
  assert.equal(storedRate.unitCostOre, 11);
});

test("usage report uses UTC month boundaries and reports dated prices, unknown cost, outcomes, cache and retries", async () => {
  const response = await request(
    `/platform/organizations/${organizationIds[0]}/usage?month=${reportMonth}`,
    platformToken,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { summary, breakdown } = response.body;

  // July includes the exact start and final millisecond, but excludes adjacent
  // months. The one unknown provider price makes the aggregate cost unknown.
  assert.equal(summary.unknownCost, true);
  assert.equal(summary.estimatedCostOre, null);
  assert.equal(summary.revenueOre, 8_500);
  assert.equal(summary.marginOre, null);
  assert.equal(breakdown.reduce((total: number, line: { calls: number }) => total + line.calls, 0), 5);

  const success = breakdown.find((line: any) =>
    line.provider === provider && line.outcome === "success" && line.cacheStatus === null,
  );
  const failureRetry = breakdown.find((line: any) =>
    line.provider === provider && line.outcome === "failure" && line.retry,
  );
  const cacheHit = breakdown.find((line: any) =>
    line.provider === provider && line.cacheStatus === "hit",
  );
  const unknown = breakdown.find((line: any) => line.provider === `${provider}-unpriced`);
  assert.equal(success.calls, 2);
  assert.equal(success.units, 3);
  assert.equal(success.estimatedCostOre, 33);
  assert.equal(failureRetry.calls, 1);
  assert.equal(failureRetry.estimatedCostOre, 33);
  assert.equal(cacheHit.calls, 1);
  assert.equal(cacheHit.estimatedCostOre, 0);
  assert.equal(cacheHit.units, 100);
  assert.equal(unknown.unknownCost, undefined);
  assert.equal(unknown.estimatedCostOre, null);
  assert.equal(unknown.units, 4);

  const invalidMonth = await request(
    `/platform/organizations/${organizationIds[0]}/usage?month=2026-13`,
    platformToken,
  );
  assert.equal(invalidMonth.status, 400);
});

test("usage event recording is idempotent per organization and retains provider result measures", async () => {
  const eventKey = `recorded-${runId}`;
  await recordUsage({
    organizationId: organizationIds[0],
    eventKey,
    category: "geocoding",
    provider,
    operation: "recorded",
    outcome: "failure",
    units: 2,
    durationMs: 125,
    cacheStatus: "miss",
    retry: true,
  });
  await recordUsage({
    organizationId: organizationIds[0],
    eventKey,
    category: "geocoding",
    provider,
    operation: "recorded",
    outcome: "success",
    units: 99,
    cacheStatus: "hit",
  });

  const events = await db.select().from(planningUsageEventsTable).where(and(
    eq(planningUsageEventsTable.organizationId, organizationIds[0]),
    eq(planningUsageEventsTable.eventKey, eventKey),
  ));
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "failure");
  assert.equal(events[0].units, 2);
  assert.equal(events[0].durationMs, 125);
  assert.equal(events[0].cacheStatus, "miss");
  assert.equal(events[0].retry, true);

  await recordUsage({
    organizationId: organizationIds[1],
    eventKey,
    category: "geocoding",
    provider,
    operation: "recorded",
    outcome: "success",
  });
  const sameKeyOtherOrganization = await db.select().from(planningUsageEventsTable).where(and(
    eq(planningUsageEventsTable.organizationId, organizationIds[1]),
    eq(planningUsageEventsTable.eventKey, eventKey),
  ));
  assert.equal(sameKeyOtherOrganization.length, 1);
});

test("ALNS metering follows authenticated tenant context through direct and setImmediate calls, including failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input)).pathname;
    const coordinates = path.split("/").pop()?.split(";").filter(Boolean) ?? [];
    const matrix = coordinates.map((_, row) =>
      coordinates.map((__, column) => row === column ? 0 : 1_000));
    const durations = coordinates.map((_, row) =>
      coordinates.map((__, column) => row === column ? 0 : 120));
    return new Response(JSON.stringify({ code: "Ok", distances: matrix, durations }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  clearOsrmCache();

  const directJobId = `direct-${runId}`;
  const deferredJobId = `deferred-${runId}`;
  const failedJobId = `failed-${runId}`;
  try {
    const direct = await optimizationRequest("/optimize/direct", tenantAToken, directJobId);
    assert.equal(direct.status, 200, JSON.stringify(direct.body));
    const deferred = await optimizationRequest("/optimize/set-immediate", tenantBToken, deferredJobId);
    assert.equal(deferred.status, 202);
    const failure = await optimizationRequest("/optimize/failure", tenantAToken, failedJobId);
    assert.equal(failure.status, 500);
    assert.match(failure.body.error, /intentional progress callback failure/);

    const deadline = Date.now() + 10_000;
    let measured: Array<typeof planningUsageEventsTable.$inferSelect> = [];
    while (Date.now() < deadline) {
      measured = await db.select().from(planningUsageEventsTable).where(and(
        inArray(planningUsageEventsTable.organizationId, organizationIds),
        eq(planningUsageEventsTable.category, "optimization"),
        eq(planningUsageEventsTable.operation, "alns"),
      ));
      if (measured.some((event) => event.jobId === deferredJobId)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const directEvent = measured.find((event) => event.jobId === directJobId);
    const deferredEvent = measured.find((event) => event.jobId === deferredJobId);
    const failedEvent = measured.find((event) => event.jobId === failedJobId);
    assert.ok(directEvent, "direct synchronous optimization should be metered");
    assert.ok(deferredEvent, "setImmediate optimization should retain its usage context");
    assert.ok(failedEvent, "failed ALNS invocation should be metered");
    assert.equal(directEvent.organizationId, organizationIds[0]);
    assert.equal(directEvent.outcome, "success");
    assert.equal(deferredEvent.organizationId, organizationIds[1]);
    assert.equal(deferredEvent.outcome, "success");
    assert.equal(failedEvent.organizationId, organizationIds[0]);
    assert.equal(failedEvent.outcome, "failure");
    for (const event of [directEvent, deferredEvent, failedEvent]) {
      assert.equal(event.stopCount, 1);
      assert.equal(event.engine, "alns");
      assert.equal(event.sizeClass, "small");
      assert.ok(event.durationMs !== null && event.durationMs >= 0);
      assert.ok(event.units !== null && event.units >= 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});