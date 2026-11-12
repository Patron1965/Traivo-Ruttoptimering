import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { Express } from "express";
import {
  db,
  deliveryProofsTable,
  documentsTable,
  driversTable,
  organizationsTable,
  organizationServicePoliciesTable,
  pool,
  routesTable,
  routeExecutionsTable,
  routeMessagesTable,
  routeMessageReadReceiptsTable,
  shopifyIntegrationsTable,
  stopsTable,
  subscriptionPlansTable,
  subscriptionsTable,
  usersTable,
  vehiclePositionsTable,
  vehiclesTable,
  stopMessagesTable,
  stopMessageThreadsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import { createSession } from "./lib/session";
import { broadcastTenantEvent, setupWebSocket } from "./ws";
import { recordProofExecutionEvent } from "./services/execution-event-service";
import { captureRouteDispatchSnapshot } from "./services/route-dispatch-snapshot-service";
import { prohibitExternalTestConnections } from "./lib/tenant-test-network";
import { listJobs } from "./services/job-queue";

type TenantFixture = {
  organizationId: string;
  userId: string;
  token: string;
  vehicleId: string;
  stopId: string;
  driverUserId: string;
  driverProfileId: string;
  driverToken: string;
  marker: string;
};

type WsMutationActor = {
  role: "admin" | "driver" | "viewer";
  organizationId: string;
  token: string;
};

const runId = randomUUID();
const schema = `tenant_request_${runId.replaceAll("-", "")}`;
let schemaCreated = false;
let restoreNetwork: (() => void) | undefined;
const orgIds = [randomUUID(), randomUUID()];
const userIds = [randomUUID(), randomUUID()];
const driverUserIds = [randomUUID(), randomUUID()];
const driverProfileIds = [randomUUID(), randomUUID()];
const wsRoleUserIds = [randomUUID(), randomUUID()];
const vehicleIds = [randomUUID(), randomUUID()];
const routeIds = [randomUUID(), randomUUID()];
const stopIds = [randomUUID(), randomUUID()];
const markers = [`TENANT_A_${runId}`, `TENANT_B_${runId}`];
const concurrentVehicleId = randomUUID();
const concurrentDriverId = randomUUID();
const concurrentStopIds = [randomUUID(), randomUUID(), randomUUID()];
const tenants: TenantFixture[] = [];
const wsMutationActors: WsMutationActor[] = [];
let server: Server;
let wss: WebSocketServer;
let aiServer: Server;
let app: Express;
let baseUrl = "";
const capturedAiRequests: string[] = [];
const originalAiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const originalAiApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
const syntheticGeocodingRequests: string[] = [];

async function request(
  tenant: TenantFixture,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tenant.token}`);
  headers.set("Connection", "close");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function expectStatusWithoutMarker(
  response: Response,
  status: 403 | 404,
  forbiddenMarker: string,
) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  assert.equal(text.includes(forbiddenMarker), false, text);
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

// Synthetic accepted handoff evidence, captured by the canonical immutable
// serializer. This fixture does not exercise approval or send notifications.
async function captureFixtureHandoff(routeId: string) {
  await db.transaction(async (tx) => {
    const [route] = await tx.select().from(routesTable).where(eq(routesTable.id, routeId)).for("update");
    assert.ok(route?.handoffDriverId);
    assert.equal(route.handoffStatus, "accepted");
    assert.equal(route.handoffVersion, route.planRevision);
    const stops = await tx.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
    await captureRouteDispatchSnapshot(tx, route, stops, route.handoffDriverId, new Date());
  });
}

before(async () => {
  restoreNetwork = prohibitExternalTestConnections();
  // ERP import always attempts address verification, even with supplied
  // coordinates. A synthetic no-match response tests coordinate preservation
  // without contacting a real geocoder or claiming verified address quality.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const nominatim = new URL(process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org");
    if (url.origin === nominatim.origin && url.pathname.endsWith("/search")) {
      syntheticGeocodingRequests.push(url.searchParams.get("q")!);
      return new Response("[]", { headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  const client = await pool.connect();
  try {
    // Read the development catalog first, then clone structure only. No ordinary
    // tenant rows or globally polled jobs are visible to this test process.
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    for (const { tablename } of tables.rows) {
      const quoted = tablename.replaceAll('"', '""');
      await client.query(`CREATE TABLE "${schema}"."${quoted}" (LIKE public."${quoted}" INCLUDING ALL)`);
    }
    pool.options.options = `-c search_path=${schema}`;
    await client.query(`SET search_path TO "${schema}"`);
  } finally {
    client.release();
  }
  aiServer = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    capturedAiRequests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "tenant-ok" } }] })}\n\n` +
      "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", resolve));
  const aiAddress = aiServer.address();
  assert.ok(aiAddress && typeof aiAddress !== "string");
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = `http://127.0.0.1:${aiAddress.port}/v1`;
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-only-placeholder";

  await db.insert(organizationsTable).values([
    { id: orgIds[0], name: markers[0], email: `${runId}-a@example.test` },
    { id: orgIds[1], name: markers[1], email: `${runId}-b@example.test` },
  ]);
  await db.insert(organizationServicePoliciesTable).values(orgIds.map((organizationId) => ({
    organizationId,
    policy: {
      districtEnabled: false, roadProvider: "osrm" as const, geocodingProvider: "nominatim" as const,
      smsProvider: "disabled" as const, emailEnabled: false, aiEnabled: true, cuoptEnabled: false,
    },
  })));
  await db.insert(usersTable).values([
    {
      id: userIds[0],
      organizationId: orgIds[0],
      name: markers[0],
      email: `${runId}-a@example.test`,
      role: "admin",
    },
    {
      id: userIds[1],
      organizationId: orgIds[1],
      name: markers[1],
      email: `${runId}-b@example.test`,
      role: "admin",
    },
    {
      id: wsRoleUserIds[0],
      organizationId: orgIds[0],
      name: `Driver ${markers[0]}`,
      email: `${runId}-ws-driver@example.test`,
      role: "driver",
    },
    {
      id: wsRoleUserIds[1],
      organizationId: orgIds[0],
      name: `Viewer ${markers[0]}`,
      email: `${runId}-ws-viewer@example.test`,
      role: "viewer",
    },
    ...driverUserIds.map((id, index) => ({
      id,
      organizationId: orgIds[index],
      name: `Driver ${markers[index]}`,
      email: `${runId}-driver-${index}@example.test`,
      role: "driver" as const,
      driverProfileId: driverProfileIds[index],
    })),
  ]);

  for (let index = 0; index < 2; index++) {
    const { token } = await createSession({
      userId: userIds[index],
      organizationId: orgIds[index],
      userAgent: "tenant-isolation-request-test",
    });
    tenants.push({
      organizationId: orgIds[index],
      userId: userIds[index],
      token,
      vehicleId: vehicleIds[index],
      stopId: stopIds[index],
      driverUserId: driverUserIds[index],
      driverProfileId: driverProfileIds[index],
      driverToken: (await createSession({
        userId: driverUserIds[index],
        organizationId: orgIds[index],
        userAgent: "tenant-isolation-driver-test",
      })).token,
      marker: markers[index],
    });
  }
  wsMutationActors.push({
    role: "admin",
    organizationId: tenants[0].organizationId,
    token: tenants[0].token,
  });
  for (const [index, role] of (["driver", "viewer"] as const).entries()) {
    const { token } = await createSession({
      userId: wsRoleUserIds[index],
      organizationId: orgIds[0],
      userAgent: `tenant-isolation-ws-${role}-test`,
    });
    wsMutationActors.push({ role, organizationId: orgIds[0], token });
  }

  await db.insert(vehiclesTable).values(tenants.map((tenant, index) => ({
    id: tenant.vehicleId,
    organizationId: tenant.organizationId,
    name: tenant.marker,
    licensePlate: `T${index}-${runId.slice(0, 6)}`,
  })));
  await db.insert(driversTable).values(tenants.map((tenant, index) => ({
    id: tenant.driverProfileId,
    organizationId: tenant.organizationId,
    name: `Driver ${tenant.marker}`,
    email: `${runId}-profile-${index}@example.test`,
    vehicleId: tenant.vehicleId,
  })));
  await db.insert(routesTable).values(tenants.map((tenant, index) => ({
    id: routeIds[index],
    organizationId: tenant.organizationId,
    vehicleId: tenant.vehicleId,
    name: tenant.marker,
    date: new Date(),
    status: "in_progress" as const,
    planRevision: 0,
    handoffStatus: "accepted" as const,
    handoffVersion: 0,
    handoffDriverId: tenant.driverProfileId,
  })));
  await db.insert(vehiclePositionsTable).values(tenants.map((tenant, index) => ({
    organizationId: tenant.organizationId,
    vehicleId: tenant.vehicleId,
    routeId: routeIds[index],
    latitude: 59.3 + index,
    longitude: 18.0 + index,
    source: tenant.marker,
  })));
  await db.insert(stopsTable).values(tenants.map((tenant, index) => ({
    id: tenant.stopId,
    organizationId: tenant.organizationId,
    address: tenant.marker,
    latitude: 59.4 + index,
    longitude: 18.1 + index,
    notes: tenant.marker,
    routeId: routeIds[index],
    sequenceOrder: index,
  })));
  await db.insert(deliveryProofsTable).values(tenants.map((tenant) => ({
    stopId: tenant.stopId,
    proofType: "barcode",
    data: tenant.marker,
    notes: tenant.marker,
  })));
  for (const routeId of routeIds) await captureFixtureHandoff(routeId);
  await db.insert(documentsTable).values(tenants.map((tenant) => ({
    organizationId: tenant.organizationId,
    uploadedBy: tenant.userId,
    name: tenant.marker,
    fileUrl: `/objects/${tenant.marker}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 10,
  })));
  await db.insert(shopifyIntegrationsTable).values(tenants.map((tenant, index) => ({
    organizationId: tenant.organizationId,
    shopDomain: `${runId.slice(0, 8)}-${index}.myshopify.com`,
    accessToken: `secret-${tenant.marker}`,
  })));

  let [plan] = await db
    .select({ id: subscriptionPlansTable.id })
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.tier, "starter"))
    .limit(1);
  if (!plan) {
    [plan] = await db
      .insert(subscriptionPlansTable)
      .values({ tier: "starter", name: "Starter", featuresJson: "[]" })
      .onConflictDoNothing()
      .returning({ id: subscriptionPlansTable.id });
    if (!plan) {
      [plan] = await db
        .select({ id: subscriptionPlansTable.id })
        .from(subscriptionPlansTable)
        .where(eq(subscriptionPlansTable.tier, "starter"))
        .limit(1);
    }
  }
  assert.ok(plan);
  await db.insert(subscriptionsTable).values(tenants.map((tenant, index) => ({
    organizationId: tenant.organizationId,
    planId: plan.id,
    status: "active" as const,
    stopsUsedThisMonth: 100 + index,
  })));

  ({ default: app } = await import("./app"));
  server = createServer(app);
  wss = setupWebSocket(server, { startBroadcasts: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  // Import jobs are process-local but asynchronous. Drain them before removing
  // their private schema, including when an assertion interrupted polling.
  const pendingJobs = () => orgIds.flatMap((organizationId) => listJobs({ organizationId }))
    .filter((job) => job.status === "queued" || job.status === "running");
  const drainDeadline = Date.now() + 30_000;
  while (pendingJobs().length && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(pendingJobs().length, 0, "Fixture workers must finish before schema cleanup");
  for (const client of wss?.clients ?? []) client.terminate();
  await Promise.race([
    new Promise<void>((resolve) => wss?.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  aiServer?.closeAllConnections();
  if (aiServer?.listening) await new Promise<void>((resolve) => aiServer.close(() => resolve()));
  if (originalAiBaseUrl == null) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = originalAiBaseUrl;
  if (originalAiApiKey == null) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = originalAiApiKey;

  await new Promise((resolve) => setTimeout(resolve, 25));
  const cleanupErrors: unknown[] = [];
  const cleanup = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (schemaCreated) {
    // Drop the entire isolated lifecycle, including asynchronous audit rows,
    // threads, receipts and immutable snapshots. Never clean ordinary tables,
    // even if setup failed before establishing the private search_path.
    await cleanup(() => pool.query("SELECT 1"));
    await cleanup(() => pool.query(`DROP SCHEMA "${schema}" CASCADE`));
    await cleanup(async () => {
      const remaining = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
      assert.equal(remaining.rowCount, 0, "Disposable tenant schema was not removed");
    });
  }
  await cleanup(() => pool.end());
  globalThis.fetch = originalFetch;
  await cleanup(async () => restoreNetwork?.());
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to clean up tenant-isolation fixtures");
  }
});

test("route map endpoints are explicit on list/detail, tenant scoped and use the caller's route revision", async () => {
  const tenant = tenants[0];
  // Accepted snapshots deliberately have no positions; working planning inputs differ.
  await db.update(routesTable).set({
    optimizationResourceSnapshot: { driver: {
      startLatitude: 59.3, startLongitude: 18.1, endLatitude: 59.4, endLongitude: 18.2,
    } } as any,
  }).where(eq(routesTable.id, routeIds[0]));
  try {
    const viewer = wsMutationActors.find((actor) => actor.role === "viewer")!;
    const dispatcherId = randomUUID();
    await db.insert(usersTable).values({
      id: dispatcherId, organizationId: tenant.organizationId,
      name: "Map projection dispatcher", email: `${dispatcherId}@example.test`, role: "dispatcher",
    });
    const dispatcher = await createSession({
      userId: dispatcherId, organizationId: tenant.organizationId,
      userAgent: "route-map-test", ipAddress: "127.0.0.1",
    });
    const actors = [
      { ...tenant, expected: { start: { latitude: 59.3, longitude: 18.1 }, end: { latitude: 59.4, longitude: 18.2 } } },
      { ...tenant, token: dispatcher.token, expected: { start: { latitude: 59.3, longitude: 18.1 }, end: { latitude: 59.4, longitude: 18.2 } } },
      { ...tenant, token: viewer.token, expected: { start: { latitude: 59.3, longitude: 18.1 }, end: { latitude: 59.4, longitude: 18.2 } } },
      { ...tenant, token: tenant.driverToken, expected: { start: null, end: null } },
    ];
    for (const actor of actors) {
      for (const path of [`/api/routes?organizationId=${tenant.organizationId}`, `/api/routes/${routeIds[0]}`]) {
        const response = await request(actor, path);
        assert.equal(response.status, 200, await response.clone().text());
        const body = await response.json();
        const route = Array.isArray(body) ? body.find((row) => row.id === routeIds[0]) : body;
        assert.deepEqual(route.mapEndpoints, actor.expected);
        assert.equal(route.depotSnapshot, null, "must not fabricate verified depot evidence");
        if (Array.isArray(body)) assert.ok(body.every((row) => row.organizationId === tenant.organizationId));
      }
      const foreign = await request(actor, `/api/routes/${routeIds[1]}`);
      assert.ok([403, 404].includes(foreign.status));
    }
    const outgoing = await request(tenant, `/api/routes/outgoing-view?routeIds=${routeIds[0]}`);
    assert.equal(outgoing.status, 200);
    const outgoingBody = await outgoing.json() as { routes: Array<{ mapEndpoints: unknown }> };
    assert.deepEqual(outgoingBody.routes[0].mapEndpoints, { start: null, end: null });
  } finally {
    await db.update(routesTable).set({ optimizationResourceSnapshot: null }).where(eq(routesTable.id, routeIds[0]));
  }
});

test("dashboard accepts the session tenant and rejects a foreign tenant", async () => {
  const own = await request(tenants[0], `/api/dashboard/stats?organizationId=${orgIds[0]}`);
  assert.equal(own.status, 200);
  assert.equal((await own.json() as { totalStops: number }).totalStops, 1);

  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/dashboard/stats?organizationId=${orgIds[1]}`),
    403,
    markers[1],
  );
});

test("concurrent route plans serialize vehicle booking, roll back the loser, and keep tenant scope", async () => {
  const planningDate = new Date("2027-03-15T07:00:00.000Z");
  await db.insert(vehiclesTable).values({
    id: concurrentVehicleId,
    organizationId: tenants[0].organizationId,
    name: `Concurrent vehicle ${runId}`,
    licensePlate: `CON-${runId.slice(0, 6)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: concurrentDriverId,
    organizationId: tenants[0].organizationId,
    vehicleId: concurrentVehicleId,
    name: `Concurrent driver ${runId}`,
    isActive: true,
  });
  await db.insert(stopsTable).values([
    {
      id: concurrentStopIds[0],
      organizationId: tenants[0].organizationId,
      address: `Concurrent stop A ${runId}`,
      latitude: 59.3293,
      longitude: 18.0686,
      serviceDurationMin: 5,
      weightKg: 10,
      volumeM3: 0.1,
    },
    {
      id: concurrentStopIds[1],
      organizationId: tenants[0].organizationId,
      address: `Concurrent stop B ${runId}`,
      // Coincident jobs deliberately require no provider legs: this test
      // exercises atomic booking, not road-data quality or routing services.
      latitude: 59.3293,
      longitude: 18.0686,
      serviceDurationMin: 5,
      weightKg: 10,
      volumeM3: 0.1,
    },
    {
      id: concurrentStopIds[2],
      organizationId: tenants[1].organizationId,
      address: `Foreign concurrent stop ${runId}`,
      latitude: 59.3313,
      longitude: 18.0706,
      serviceDurationMin: 5,
      weightKg: 10,
      volumeM3: 0.1,
    },
  ]);

  const bodyFor = (stopId: string) => jsonBody({
    stopIds: [stopId],
    pairs: [{ vehicleId: concurrentVehicleId, driverId: concurrentDriverId }],
    date: planningDate.toISOString(),
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  });
  const [first, second] = await Promise.all([
    request(tenants[0], "/api/import/route-plans", {
      method: "POST",
      body: bodyFor(concurrentStopIds[0]),
    }),
    request(tenants[0], "/api/import/route-plans", {
      method: "POST",
      body: bodyFor(concurrentStopIds[1]),
    }),
  ]);
  assert.deepEqual(
    [first.status, second.status].sort((left, right) => left - right),
    [200, 409],
  );

  const savedRoutes = await db.select({ id: routesTable.id })
    .from(routesTable)
    .where(eq(routesTable.vehicleId, concurrentVehicleId));
  assert.equal(savedRoutes.length, 1);
  const tenantStops = await db.select({
    id: stopsTable.id,
    routeId: stopsTable.routeId,
    trackingCode: stopsTable.trackingCode,
  }).from(stopsTable).where(inArray(stopsTable.id, concurrentStopIds.slice(0, 2)));
  assert.equal(tenantStops.filter((stop) => stop.routeId != null).length, 1);
  const rejectedStop = tenantStops.find((stop) => stop.routeId == null);
  assert.ok(rejectedStop);
  assert.equal(rejectedStop.trackingCode, null);

  const foreignResponse = await request(tenants[1], "/api/import/route-plans", {
    method: "POST",
    body: bodyFor(concurrentStopIds[2]),
  });
  assert.equal(foreignResponse.status, 400, await foreignResponse.text());
  const [foreignStop] = await db.select({
    routeId: stopsTable.routeId,
    trackingCode: stopsTable.trackingCode,
  }).from(stopsTable).where(eq(stopsTable.id, concurrentStopIds[2]));
  assert.equal(foreignStop.routeId, null);
  assert.equal(foreignStop.trackingCode, null);
});

test("tracking/GPS accepts own telemetry and hides foreign vehicles and routes", async () => {
  const own = await request(tenants[0], `/api/tracking/history/vehicle/${vehicleIds[0]}`);
  assert.equal(own.status, 200);
  const positions = await own.json() as Array<{ latitude: number }>;
  assert.equal(positions.length, 1);
  assert.equal(positions[0].latitude, 59.3);

  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/tracking/history/vehicle/${vehicleIds[1]}`),
    404,
    markers[1],
  );

  const ownRoute = await request(tenants[0], `/api/tracking/history/route/${routeIds[0]}`);
  assert.equal(ownRoute.status, 200);
  assert.equal((await ownRoute.json() as unknown[]).length, 1);
  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/tracking/history/route/${routeIds[1]}`),
    404,
    markers[1],
  );

  const missingRoute = await request(tenants[0], "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      latitude: 59.31,
      longitude: 18.01,
    }),
  });
  assert.equal(missingRoute.status, 400);
  assert.equal((await missingRoute.json() as { code?: string }).code, "ROUTE_ID_REQUIRED");

  const missingExecution = await request(tenants[0], "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: `admin-no-execution-${runId}`,
      latitude: 59.31,
      longitude: 18.01,
    }),
  });
  assert.equal(missingExecution.status, 409);
  assert.equal((await missingExecution.json() as { code?: string }).code, "ROUTE_SESSION_NOT_STARTED");

  const adminSessionId = `admin-gps-${runId}`;
  await db.insert(routeExecutionsTable).values({
    organizationId: tenants[0].organizationId,
    routeId: routeIds[0],
    driverId: tenants[0].driverProfileId,
    planVersion: 0,
    status: "active",
    startedAt: new Date(),
    startClientEventId: adminSessionId,
    startedByUserId: tenants[0].userId,
  });
  const ownWrite = await request(tenants[0], "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      organizationId: orgIds[0],
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: adminSessionId,
      latitude: 59.31,
      longitude: 18.01,
    }),
  });
  assert.equal(ownWrite.status, 200);
  await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.startClientEventId, adminSessionId));
  await expectStatusWithoutMarker(
    await request(tenants[0], "/api/tracking/location", {
      method: "POST",
      body: jsonBody({
        organizationId: orgIds[1],
        vehicleId: vehicleIds[1],
        routeId: routeIds[1],
        clientSessionId: `foreign-${runId}`,
        latitude: 60.31,
        longitude: 19.01,
      }),
    }),
    403,
    markers[1],
  );
});

test("driver GPS requires the current route execution and route id", async () => {
  const driver = {
    ...tenants[0],
    token: tenants[0].driverToken,
    userId: tenants[0].driverUserId,
  };
  const missingRoute = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      latitude: 59.31,
      longitude: 18.01,
    }),
  });
  assert.equal(missingRoute.status, 400);
  assert.equal((await missingRoute.json() as { code?: string }).code, "ROUTE_ID_REQUIRED");

  await db.insert(routeExecutionsTable).values({
    organizationId: tenants[0].organizationId,
    routeId: routeIds[0],
    driverId: tenants[1].driverProfileId,
    planVersion: 0,
    status: "active",
    startedAt: new Date(),
    startClientEventId: `wrong-driver-${runId}`,
    startedByUserId: tenants[0].userId,
  });
  const unstarted = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: `wrong-driver-${runId}`,
      latitude: 59.31,
      longitude: 18.01,
    }),
  });
  assert.equal(unstarted.status, 409);
  assert.equal((await unstarted.json() as { code?: string }).code, "ROUTE_SESSION_NOT_STARTED");
  await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.startClientEventId, `wrong-driver-${runId}`));

  const wrongTenantRoute = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[1],
      clientSessionId: `wrong-tenant-${runId}`,
      latitude: 59.31,
      longitude: 18.01,
    }),
  });
  assert.equal(wrongTenantRoute.status, 403);

  const occurredAt = new Date(Date.now() - 1_000).toISOString();
  const start = await request(driver, "/api/tracking/route-session", {
    method: "POST",
    body: jsonBody({
      routeId: routeIds[0],
      action: "start",
      clientSessionId: `session-${runId}`,
      occurredAt,
    }),
  });
  assert.equal(start.status, 201, await start.text());

  const replayStartWithoutTimestamp = await request(driver, "/api/tracking/route-session", {
    method: "POST",
    body: jsonBody({
      routeId: routeIds[0],
      action: "start",
      clientSessionId: `session-${runId}`,
    }),
  });
  assert.equal(replayStartWithoutTimestamp.status, 200, await replayStartWithoutTimestamp.text());

  const accepted = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: `session-${runId}`,
      latitude: 59.31,
      longitude: 18.01,
      timestamp: Date.now(),
    }),
  });
  assert.equal(accepted.status, 200, await accepted.text());

  const stale = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: `session-${runId}`,
      latitude: 59.32,
      longitude: 18.02,
      timestamp: Date.now() - 3 * 60_000,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code?: string }).code, "STALE_POSITION");

  const prematureEnd = await request(driver, "/api/tracking/route-session", {
    method: "POST",
    body: jsonBody({
      routeId: routeIds[0],
      action: "end",
      clientSessionId: `premature-end-${runId}`,
      occurredAt: new Date().toISOString(),
    }),
  });
  assert.equal(prematureEnd.status, 409);
  assert.equal((await prematureEnd.json() as { code?: string }).code, "ROUTE_STOPS_REMAIN");

  await db
    .update(stopsTable)
    .set({ status: "completed" })
    .where(eq(stopsTable.id, stopIds[0]));
  const end = await request(driver, "/api/tracking/route-session", {
    method: "POST",
    body: jsonBody({
      routeId: routeIds[0],
      action: "end",
      clientSessionId: `session-${runId}`,
      occurredAt: new Date().toISOString(),
    }),
  });
  assert.equal(end.status, 201, await end.text());

  const replayEndWithoutTimestamp = await request(driver, "/api/tracking/route-session", {
    method: "POST",
    body: jsonBody({
      routeId: routeIds[0],
      action: "end",
      clientSessionId: `session-${runId}`,
    }),
  });
  assert.equal(replayEndWithoutTimestamp.status, 200, await replayEndWithoutTimestamp.text());

  const ended = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: `session-${runId}`,
      latitude: 59.33,
      longitude: 18.03,
    }),
  });
  assert.equal(ended.status, 409);
  assert.equal((await ended.json() as { code?: string }).code, "ROUTE_EXECUTION_ENDED");

  await db
    .update(routesTable)
    .set({ planRevision: 1, handoffVersion: 1, status: "in_progress" })
    .where(eq(routesTable.id, routeIds[0]));
  await captureFixtureHandoff(routeIds[0]);
  const currentPlanWithoutExecution = await request(driver, "/api/tracking/location", {
    method: "POST",
    body: jsonBody({
      vehicleId: vehicleIds[0],
      routeId: routeIds[0],
      clientSessionId: `current-plan-${runId}`,
      latitude: 59.34,
      longitude: 18.04,
    }),
  });
  assert.equal(currentPlanWithoutExecution.status, 409);
  assert.equal(
    (await currentPlanWithoutExecution.json() as { code?: string }).code,
    "ROUTE_SESSION_NOT_STARTED",
  );
  await db
    .update(routesTable)
    .set({ planRevision: 0, handoffVersion: 0, dispatchSnapshotVersion: 0 })
    .where(eq(routesTable.id, routeIds[0]));
});

test("stop messages are tenant-scoped, idempotent, and expose read receipts", async () => {
  const driver = {
    ...tenants[0],
    token: tenants[0].driverToken,
    userId: tenants[0].driverUserId,
  };
  const created = await request(driver, `/api/stops/${stopIds[0]}/messages`, {
    method: "POST",
    body: jsonBody({ body: "Arrived at the customer", clientMessageId: `message-${runId}` }),
  });
  const createdBody = await created.text();
  assert.equal(created.status, 201, createdBody);
  const message = JSON.parse(createdBody) as { message: { id: string } };

  const duplicate = await request(driver, `/api/stops/${stopIds[0]}/messages`, {
    method: "POST",
    body: jsonBody({ body: "Arrived at the customer", clientMessageId: `message-${runId}` }),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);

  const marked = await request(tenants[0], `/api/stops/${stopIds[0]}/messages/read`, {
    method: "POST",
    body: jsonBody({ messageIds: [message.message.id] }),
  });
  assert.equal(marked.status, 200);

  const own = await request(driver, `/api/stops/${stopIds[0]}/messages`);
  assert.equal(own.status, 200);
  const ownBody = await own.json() as { messages: Array<{ readReceipts: Array<{ userId: string }> }> };
  assert.equal(ownBody.messages[0]?.readReceipts.some((receipt) => receipt.userId === tenants[0].userId), true);

  const foreign = await request(driver, `/api/stops/${stopIds[1]}/messages`);
  await expectStatusWithoutMarker(foreign, 404, markers[1]);
  await expectStatusWithoutMarker(await request(driver, `/api/stops/${stopIds[1]}/messages`, {
    method: "POST",
    body: jsonBody({ body: "Must not reach foreign stop", clientMessageId: `foreign-message-${runId}` }),
  }), 403, markers[1]);
});

test("photo proof exception events are stale-plan safe and idempotent", async () => {
  const driver = {
    ...tenants[0],
    token: tenants[0].driverToken,
    userId: tenants[0].driverUserId,
  };
  const stale = await request(driver, `/api/stops/${stopIds[0]}/exceptions`, {
    method: "POST",
    body: jsonBody({
      category: "customer_unavailable",
      comment: "No one answered",
      proofStage: "delivery",
      photoData: "not-a-photo",
      clientEventId: `exception-stale-${runId}`,
      planVersion: 99,
      occurredAt: new Date().toISOString(),
    }),
  });
  assert.equal(stale.status, 409);

  const args = {
    organizationId: tenants[0].organizationId,
    actorUserId: tenants[0].driverUserId,
    driverProfileId: tenants[0].driverProfileId,
    role: "driver" as const,
    stopId: stopIds[0],
    clientEventId: `exception-${runId}`,
    planVersion: 0,
    occurredAt: new Date().toISOString(),
    proof: {
      proofType: "photo",
      proofStage: "delivery" as const,
      fileUrl: `/private/exceptions/${runId}.jpg`,
      data: null,
      notes: "customer_unavailable: No one answered",
      contentHash: `hash-${runId}`,
    },
  };
  const first = await recordProofExecutionEvent(args);
  const second = await recordProofExecutionEvent(args);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.proof.id, first.proof.id);
});

test("route execution reads the accepted revised plan and completed end retries are idempotent", async () => {
  const driver = {
    ...tenants[0],
    token: tenants[0].driverToken,
    userId: tenants[0].driverUserId,
  };
  await db
    .update(routesTable)
    .set({
      planRevision: 1,
      handoffVersion: 1,
      dispatchSnapshotVersion: 1,
      handoffStatus: "accepted",
      status: "in_progress",
    })
    .where(eq(routesTable.id, routeIds[0]));

  const startClientEventId = `revised-start-${runId}`;
  const started = await request(driver, `/api/routes/${routeIds[0]}/execution/start`, {
    method: "POST",
    body: jsonBody({
      clientEventId: startClientEventId,
      startedAt: new Date().toISOString(),
    }),
  });
  const startedBody = await started.json() as {
    execution: { planVersion: number; status: string };
    duplicate: boolean;
  };
  assert.equal(started.status, 201);
  assert.equal(startedBody.duplicate, false);
  assert.equal(startedBody.execution.planVersion, 1);
  assert.equal(startedBody.execution.status, "active");

  const currentSession = await request(driver, `/api/tracking/route-session/${routeIds[0]}`);
  const currentSessionBody = await currentSession.json() as {
    routeId: string;
    clientSessionId: string;
    status: string;
  };
  assert.equal(currentSession.status, 200);
  assert.equal(currentSessionBody.routeId, routeIds[0]);
  assert.equal(currentSessionBody.clientSessionId, startClientEventId);
  assert.equal(currentSessionBody.status, "active");

  await db
    .update(routesTable)
    .set({ handoffStatus: "sent" })
    .where(eq(routesTable.id, routeIds[0]));
  const revokedSession = await request(driver, `/api/tracking/route-session/${routeIds[0]}`);
  assert.equal(revokedSession.status, 409);
  await db
    .update(routesTable)
    .set({ handoffStatus: "accepted", handoffVersion: 1 })
    .where(eq(routesTable.id, routeIds[0]));

  await db
    .update(stopsTable)
    .set({ status: "completed" })
    .where(eq(stopsTable.id, stopIds[0]));
  const endClientEventId = `revised-end-${runId}`;
  const endedAt = new Date().toISOString();
  const ended = await request(driver, `/api/routes/${routeIds[0]}/execution/end`, {
    method: "POST",
    body: jsonBody({ clientEventId: endClientEventId, endedAt }),
  });
  const endedBody = await ended.json() as {
    execution: { planVersion: number; status: string; summary: unknown };
    duplicate: boolean;
  };
  assert.equal(ended.status, 201);
  assert.equal(endedBody.duplicate, false);
  assert.equal(endedBody.execution.planVersion, 1);
  assert.equal(endedBody.execution.status, "ended");
  assert.ok(endedBody.execution.summary);

  const retry = await request(driver, `/api/routes/${routeIds[0]}/execution/end`, {
    method: "POST",
    body: jsonBody({ clientEventId: endClientEventId, endedAt }),
  });
  const retryBody = await retry.json() as typeof endedBody;
  assert.equal(retry.status, 200);
  assert.equal(retryBody.duplicate, true);
  assert.deepEqual(retryBody.execution.summary, endedBody.execution.summary);

  const executions = await db
    .select()
    .from(routeExecutionsTable)
    .where(and(
      eq(routeExecutionsTable.organizationId, tenants[0].organizationId),
      eq(routeExecutionsTable.routeId, routeIds[0]),
      eq(routeExecutionsTable.planVersion, 1),
    ));
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.endClientEventId, endClientEventId);
});

test("tracking route-session resumes a legacy ended session and ends with the original id without timestamps", async () => {
  const driver = {
    ...tenants[0],
    token: tenants[0].driverToken,
    userId: tenants[0].driverUserId,
  };
  const legacyRouteId = randomUUID();
  const legacyStopId = randomUUID();
  const clientSessionId = `legacy-mobile-session-${runId}`;
  const startedAt = new Date("2026-09-09T07:00:00.000Z");
  const legacyEndedAt = new Date("2026-09-09T09:00:00.000Z");

  await db.insert(routesTable).values({
    id: legacyRouteId,
    organizationId: tenants[0].organizationId,
    vehicleId: tenants[0].vehicleId,
    name: `Legacy mobile route ${runId}`,
    date: startedAt,
    status: "in_progress",
    planRevision: 5,
    handoffStatus: "accepted",
    handoffVersion: 5,
    handoffDriverId: tenants[0].driverProfileId,
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: legacyStopId,
    organizationId: tenants[0].organizationId,
    routeId: legacyRouteId,
    address: `Legacy mobile stop ${runId}`,
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    sequenceOrder: 0,
  });
  await db.insert(routeExecutionsTable).values({
    organizationId: tenants[0].organizationId,
    routeId: legacyRouteId,
    driverId: tenants[0].driverProfileId,
    planVersion: 5,
    status: "ended",
    startedAt,
    endedAt: legacyEndedAt,
    startClientEventId: clientSessionId,
    endClientEventId: clientSessionId,
    startedByUserId: tenants[0].driverUserId,
    endedByUserId: tenants[0].driverUserId,
    summary: {
      totalStops: 1,
      completedStops: 0,
      failedStops: 0,
      skippedStops: 0,
      pendingStops: 1,
      durationMin: 120,
      distanceKm: null,
    },
  });

  try {
    await captureFixtureHandoff(legacyRouteId);
    const beforeResume = await request(
      driver,
      `/api/tracking/route-session/${legacyRouteId}`,
    );
    const beforeResumeText = await beforeResume.text();
    assert.equal(beforeResume.status, 200, beforeResumeText);
    const beforeResumeBody = JSON.parse(beforeResumeText) as {
      status: string;
      clientSessionId: string;
    };
    assert.equal(beforeResumeBody.status, "ended");
    assert.equal(beforeResumeBody.clientSessionId, clientSessionId);

    const resumed = await request(driver, "/api/tracking/route-session", {
      method: "POST",
      body: jsonBody({
        routeId: legacyRouteId,
        action: "start",
        clientSessionId,
      }),
    });
    const resumedText = await resumed.text();
    assert.equal(resumed.status, 201, resumedText);
    assert.equal((JSON.parse(resumedText) as { status: string }).status, "active");

    await db
      .update(stopsTable)
      .set({ status: "completed" })
      .where(eq(stopsTable.id, legacyStopId));
    const finished = await request(driver, "/api/tracking/route-session", {
      method: "POST",
      body: jsonBody({
        routeId: legacyRouteId,
        action: "end",
        clientSessionId,
      }),
    });
    const finishedText = await finished.text();
    assert.equal(finished.status, 201, finishedText);
    assert.equal((JSON.parse(finishedText) as { status: string }).status, "ended");

    const [execution] = await db
      .select({
        status: routeExecutionsTable.status,
        endClientEventId: routeExecutionsTable.endClientEventId,
      })
      .from(routeExecutionsTable)
      .where(eq(routeExecutionsTable.routeId, legacyRouteId));
    assert.equal(execution?.status, "ended");
    assert.equal(execution?.endClientEventId, clientSessionId);
  } finally {
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, legacyRouteId));
    await db.delete(stopsTable).where(eq(stopsTable.routeId, legacyRouteId));
    await db.delete(routesTable).where(eq(routesTable.id, legacyRouteId));
  }
});

test("AI builds context from the session tenant and rejects a foreign tenant before processing", async () => {
  const callsBefore = capturedAiRequests.length;
  const own = await request(tenants[0], "/api/ai/chat", {
    method: "POST",
    body: jsonBody({
      organizationId: orgIds[0],
      messages: [{ role: "user", content: "Summarize my fleet" }],
    }),
  });
  const ownText = await own.text();
  assert.equal(own.status, 200, ownText);
  assert.equal(capturedAiRequests.length, callsBefore + 1);
  const aiRequest = capturedAiRequests.at(-1) ?? "";
  assert.equal(aiRequest.includes(markers[0]), true);
  assert.equal(aiRequest.includes(markers[1]), false);

  await expectStatusWithoutMarker(
    await request(tenants[0], "/api/ai/chat", {
      method: "POST",
      body: jsonBody({
        organizationId: orgIds[1],
        messages: [{ role: "user", content: "Summarize my fleet" }],
      }),
    }),
    403,
    markers[1],
  );
  assert.equal(capturedAiRequests.length, callsBefore + 1);
});

test("Shopify status exposes only the authenticated tenant", async () => {
  const own = await request(tenants[0], `/api/integrations/shopify/status/${orgIds[0]}`);
  const ownText = await own.text();
  assert.equal(own.status, 200, ownText);
  assert.match(ownText, new RegExp(`${runId.slice(0, 8)}-0\\.myshopify\\.com`));
  assert.equal(ownText.includes(markers[1]), false);

  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/integrations/shopify/status/${orgIds[1]}`),
    403,
    markers[1],
  );
});

test("subscription reads reject an explicit foreign tenant", async () => {
  const own = await request(tenants[0], `/api/subscription?organizationId=${orgIds[0]}`);
  const ownText = await own.text();
  assert.equal(own.status, 200, ownText);
  assert.equal(ownText.includes(orgIds[0]), true);
  assert.equal(ownText.includes(orgIds[1]), false);

  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/subscription?organizationId=${orgIds[1]}`),
    403,
    markers[1],
  );
});

test("ERP import runs for the session tenant and hides its job from another tenant", async () => {
  const row = {
    address: markers[0],
    latitude: 59.5,
    longitude: 18.2,
    serviceMin: 15,
    externalRef: markers[0],
  };
  await expectStatusWithoutMarker(
    await request(tenants[0], "/api/import/orders", {
      method: "POST",
      body: jsonBody({ organizationId: orgIds[1], rows: [row] }),
    }),
    403,
    markers[1],
  );

  const own = await request(tenants[0], "/api/import/orders", {
    method: "POST",
    body: jsonBody({ organizationId: orgIds[0], rows: [row] }),
  });
  const accepted = await own.json() as { jobId: string };
  assert.equal(own.status, 202);
  await expectStatusWithoutMarker(
    await request(tenants[1], `/api/import/jobs/${accepted.jobId}`),
    404,
    markers[0],
  );

  let job: { status?: string; result?: { created?: number } } = {};
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await request(tenants[0], `/api/import/jobs/${accepted.jobId}`);
    assert.equal(response.status, 200);
    job = await response.json() as typeof job;
    if (job.status === "completed") break;
    // Nominatim's real rate limiter is retained even for synthetic responses.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(job.status, "completed");
  assert.equal(job.result?.created, 1);
  assert.ok(syntheticGeocodingRequests.length > 0, "ERP verification used the synthetic geocoder");
});

test("exports contain own rows and reject an explicit foreign tenant", async () => {
  const own = await request(
    tenants[0],
    `/api/export?type=stops&format=json&organizationId=${orgIds[0]}`,
  );
  const ownText = await own.text();
  assert.equal(own.status, 200, ownText);
  assert.equal(ownText.includes(markers[0]), true);
  assert.equal(ownText.includes(markers[1]), false);

  await expectStatusWithoutMarker(
    await request(
      tenants[0],
      `/api/export?type=stops&format=json&organizationId=${orgIds[1]}`,
    ),
    403,
    markers[1],
  );
});

test("documents and proof metadata never cross tenant boundaries", async () => {
  const documents = await request(tenants[0], `/api/documents?organizationId=${orgIds[0]}`);
  const documentsText = await documents.text();
  assert.equal(documents.status, 200, documentsText);
  assert.equal(documentsText.includes(markers[0]), true);
  assert.equal(documentsText.includes(markers[1]), false);

  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/documents?organizationId=${orgIds[1]}`),
    403,
    markers[1],
  );

  const ownProof = await request(tenants[0], `/api/stops/${stopIds[0]}/proofs`);
  const proofText = await ownProof.text();
  assert.equal(ownProof.status, 200, proofText);
  assert.equal(proofText.includes(markers[0]), true);
  assert.equal(proofText.includes(markers[1]), false);

  await expectStatusWithoutMarker(
    await request(tenants[0], `/api/stops/${stopIds[1]}/proofs`),
    404,
    markers[1],
  );
});

async function connectTenantSocket(tenant: Pick<TenantFixture, "organizationId" | "token">): Promise<{
  socket: WebSocket;
  messages: string[];
}> {
  const messages: string[] = [];
  const socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws", {
    headers: { Authorization: `Bearer ${tenant.token}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket subscribe timed out")), 2_000);
    socket.on("open", () => {
      setTimeout(() => socket.send(jsonBody({
        type: "subscribe",
        organizationId: tenants[1].organizationId,
      })), 75);
    });
    socket.on("message", (raw) => {
      const message = raw.toString();
      messages.push(message);
      if (message.includes('"type":"subscribed"')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.on("error", reject);
  });
  return { socket, messages };
}

async function sendDisruptionAndWaitForError(
  socket: WebSocket,
  routeId: string,
): Promise<{ type: string; code: string; message: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("WebSocket disruption rejection timed out"));
    }, 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        code?: string;
        message?: string;
      };
      if (message.code !== "WS_MUTATION_NOT_ALLOWED") return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message as { type: string; code: string; message: string });
    };
    socket.on("message", onMessage);
    socket.send(jsonBody({
      type: "disruption",
      disruptionType: "traffic_delay",
      routeIds: [routeId],
      reason: "must not mutate over websocket",
    }));
  });
}

test("WebSocket disruptions fail closed for viewer, driver, and admin without route writes", async () => {
  const routesBefore = await db
    .select({ id: routesTable.id, planRevision: routesTable.planRevision })
    .from(routesTable)
    .where(inArray(routesTable.id, routeIds));
  const stopsBefore = await db
    .select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
      sequenceOrder: stopsTable.sequenceOrder,
    })
    .from(stopsTable)
    .where(inArray(stopsTable.id, stopIds));

  for (const actor of wsMutationActors) {
    const client = await connectTenantSocket(actor);
    for (const routeId of [routeIds[0], routeIds[1]]) {
      const rejection = await sendDisruptionAndWaitForError(client.socket, routeId);
      assert.deepEqual(rejection, {
        type: "error",
        code: "WS_MUTATION_NOT_ALLOWED",
        message: "WebSocket disruption mutations are not allowed; use the authorized HTTP planning API.",
      }, `${actor.role} did not receive the stable disruption rejection`);
    }
    assert.equal(
      client.messages.some((message) => message.includes('"type":"disruption:ack"')),
      false,
      `${actor.role} received a disruption acknowledgement`,
    );
    await new Promise<void>((resolve) => {
      client.socket.once("close", () => resolve());
      client.socket.terminate();
    });
  }

  const routesAfter = await db
    .select({ id: routesTable.id, planRevision: routesTable.planRevision })
    .from(routesTable)
    .where(inArray(routesTable.id, routeIds));
  const stopsAfter = await db
    .select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
      sequenceOrder: stopsTable.sequenceOrder,
    })
    .from(stopsTable)
    .where(inArray(stopsTable.id, stopIds));
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(byId(routesAfter), byId(routesBefore));
  assert.deepEqual(byId(stopsAfter), byId(stopsBefore));
});

test("WebSocket tenant scope comes from the session and events never leak", async () => {
  const [a, b] = await Promise.all([
    connectTenantSocket(tenants[0]),
    connectTenantSocket(tenants[1]),
  ]);
  assert.equal(a.messages[0].includes(orgIds[0]), true);
  assert.equal(a.messages[0].includes(orgIds[1]), false);
  assert.equal(b.messages[0].includes(orgIds[1]), true);

  await broadcastTenantEvent(orgIds[0], "tenant-isolation", { marker: markers[0] });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(a.messages.some((message) => message.includes(markers[0])), true);
  assert.equal(b.messages.some((message) => message.includes(markers[0])), false);

  await broadcastTenantEvent(orgIds[1], "tenant-isolation", { marker: markers[1] });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(b.messages.some((message) => message.includes(markers[1])), true);
  assert.equal(a.messages.some((message) => message.includes(markers[1])), false);

  await Promise.all([a.socket, b.socket].map((socket) => new Promise<void>((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
    socket.terminate();
  })));
});