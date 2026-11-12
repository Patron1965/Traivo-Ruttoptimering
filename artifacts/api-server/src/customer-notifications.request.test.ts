import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db, pool, organizationsTable, organizationServicePoliciesTable,
  usersTable, sessionsTable, vehiclesTable, driversTable, planningDraftsTable,
  routesTable, stopsTable, routePlanApprovalsTable, routeDispatchSnapshotsTable,
  routeAcknowledgementsTable, routeExecutionsTable, executionEventsTable,
  customerNotificationAttemptsTable, deliveryNotificationsTable, auditLogTable,
} from "@workspace/db";
import { createSession } from "./lib/session";
import type { EmailPayload } from "./services/resend-email";

// Run with test:customer-notification-flow. Only provider boundaries are mocked:
// auth, HTTP routing, approval, dispatch, execution and notification claims are real.
const organizationId = randomUUID();
const plannerId = randomUUID();
const driverUserId = randomUUID();
const driverId = randomUUID();
const vehicleId = randomUUID();
const draftId = randomUUID();
const planId = randomUUID();
const routeId = randomUUID();
const stopIds = Array.from({ length: 5 }, () => randomUUID());
const date = new Date("2026-11-02T08:00:00.000Z");
const nativeFetch = globalThis.fetch;
const oldTrackingBase = process.env.PUBLIC_TRACKING_BASE_URL;
const oldSecret = process.env.SESSION_SECRET;
const calls: Array<{ channel: string; recipient: string; event: string }> = [];
const unexpectedNetwork: string[] = [];
let server: Server | undefined;
let baseUrl = "";
let plannerToken = "";
let driverToken = "";

const events = ["planned", "approaching", "completed"] as const;
const customerNotifications = {
  channel: "both" as const,
  events: Object.fromEntries(events.map(event => [event, {
    enabled: true, sms: `${event} {{address}}`,
    subject: event, email: `${event} {{address}}`,
  }])),
};

async function request(actor: "planner" | "driver", path: string, body: unknown, status = 200) {
  const response = await nativeFetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${actor === "planner" ? plannerToken : driverToken}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${path}: ${text}`);
  return JSON.parse(text);
}

// Seed only planning inputs/optimizer evidence, never approvals, dispatch
// snapshots, acceptance, execution events or notification claims.
async function seedOptimizationEvidence(revision: number) {
  const { materialResourceSnapshot, materialResourceSnapshotHash } =
    await import("./services/route-plan-approval-service");
  const [vehicle] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
  const [driver] = await db.select().from(driversTable).where(eq(driversTable.id, driverId));
  const stops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
  await db.update(routesTable).set({
    planRevision: revision, totalStops: stops.length,
    optimizationResourceSnapshot: materialResourceSnapshot(vehicle!, driver!, stops, []),
    optimizationResourceSnapshotHash: materialResourceSnapshotHash(vehicle!, driver!, stops, []),
  }).where(eq(routesTable.id, routeId));
}

async function addStop(index: number) {
  await db.insert(stopsTable).values({
    id: stopIds[index]!, organizationId, routeId, planningPlanId: planId,
    address: `Synthetic notification stop ${index}`, latitude: 59.3293, longitude: 18.0686,
    sequenceOrder: index + 1, status: "pending", planningDate: date,
    contactPhone: `MOCK-ONLY-${index}`, contactEmail: `customer-${index}@fixture.invalid`,
  });
  const { manageCustomerLink } = await import("./services/customer-links");
  await manageCustomerLink(stopIds[index]!, organizationId, "create");
}

type Expected = { event: typeof events[number]; stop: number };
const expected: Expected[] = [];

async function assertNotifications(label: string) {
  const keys = expected.flatMap(({ event, stop }) =>
    ["sms", "email"].map(channel => `${stopIds[stop]}:${event}:${channel}`)).sort();
  // Senders run after the HTTP response. Wait for exact, settled DB claims and
  // provider calls, then require a quiet interval to catch duplicate side effects.
  const deadline = Date.now() + 8_000;
  let stableSince = 0;
  while (true) {
    const attempts = await db.select().from(customerNotificationAttemptsTable)
      .where(eq(customerNotificationAttemptsTable.organizationId, organizationId));
    const actual = attempts.map(a => `${a.stopId}:${a.event}:${a.channel}`).sort();
    const providerKeys = calls.map(call => {
      const stop = stopIds.findIndex((_, i) => call.recipient ===
        (call.channel === "sms" ? `MOCK-ONLY-${i}` : `customer-${i}@fixture.invalid`));
      return `${stopIds[stop]}:${call.event}:${call.channel}`;
    }).sort();
    const matches = JSON.stringify(actual) === JSON.stringify(keys)
      && JSON.stringify(providerKeys) === JSON.stringify(keys)
      && attempts.every(a => a.status === "sent");
    if (matches) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 200) break;
    } else stableSince = 0;
    if (Date.now() >= deadline) {
      assert.deepEqual(actual, keys, `${label}: exact event/stop/channel claims`);
      assert.deepEqual(providerKeys, keys, `${label}: exact provider calls`);
      assert.ok(attempts.every(a => a.status === "sent"), `${label}: sends settled`);
      assert.fail(`${label}: notifications did not settle`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(unexpectedNetwork, [], "No unmocked external request is permitted");
}

before(async () => {
  assert.equal(process.env.NODE_ENV, "test");
  process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.test";
  process.env.SESSION_SECRET = "synthetic-http-notification-secret-32-characters";
  // Fail closed even if a future integration is introduced into this journey.
  globalThis.fetch = async () => {
    unexpectedNetwork.push("Blocked unmocked fetch");
    throw new Error("External network is disabled in customer notification integration tests");
  };
  const sms = await import("./services/sms");
  mock.module("./services/sms.ts", { namedExports: {
    ...sms,
    configuredProvider: () => "linkmobility",
    sendSms: async (recipient: string, message: string, orgId: string) => {
      assert.equal(orgId, organizationId);
      assert.ok(recipient.startsWith("MOCK-ONLY-"));
      calls.push({ channel: "sms", recipient, event: message.split(" ")[0]! });
      return true;
    },
  } });
  mock.module("./services/resend-email.ts", { namedExports: {
    sendRecoveryEmail: async () => { throw new Error("Unexpected recovery email"); },
    sendEmail: async (payload: EmailPayload, orgId: string) => {
      assert.equal(orgId, organizationId);
      assert.ok(payload.to.endsWith("@fixture.invalid"));
      calls.push({ channel: "email", recipient: payload.to, event: payload.subject });
      return true;
    },
  } });
  // Customer delivery now has its own provider boundary (separate from
  // recovery mail and driver SMS). Keep the real notification service intact.
  const customerProvider = await import("./services/customer-notification-transport");
  const mockedSms = await import("./services/sms");
  const mockedEmail = await import("./services/resend-email");
  mock.module("./services/customer-notification-transport.ts", { namedExports: {
    ...customerProvider,
    customerTransport: {
      configuredProvider: mockedSms.configuredProvider,
      sendSms: async (to: string, message: string, orgId: string) => {
        await mockedSms.sendSms(to, message, orgId);
        return "sent";
      },
      sendEmail: async (payload: EmailPayload, orgId: string) => {
        await mockedEmail.sendEmail(payload, orgId);
        return "sent";
      },
    },
  } });
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Synthetic HTTP notifications", email: `${organizationId}@fixture.invalid`,
    customerNotifications,
  });
  await db.insert(organizationServicePoliciesTable).values({
    organizationId,
    policy: { roadProvider: "disabled", geocodingProvider: "disabled", smsProvider: "linkmobility",
      emailEnabled: true, aiEnabled: false, cuoptEnabled: false, districtEnabled: false },
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId, organizationId, name: "Synthetic resource", licensePlate: "MOCK-ONLY",
    capacityKg: 10000, capacityVolume: 100,
  });
  // No driver contact/push token and no webhook/integration in this tenant.
  await db.insert(driversTable).values({
    id: driverId, organizationId, vehicleId, name: "Synthetic driver",
    startLatitude: 59.3293, startLongitude: 18.0686,
  });
  await db.insert(usersTable).values([
    { id: plannerId, organizationId, name: "Synthetic planner", email: `${plannerId}@fixture.invalid`, role: "dispatcher" },
    { id: driverUserId, organizationId, name: "Synthetic driver", email: `${driverUserId}@fixture.invalid`, role: "driver", driverProfileId: driverId },
  ]);
  await db.insert(planningDraftsTable).values({
    id: draftId, organizationId, name: "Synthetic notification draft", startAt: date, state: { step: "approval" },
  });
  const { normalizePlanningInputs } = await import("./services/import-route-workflow");
  const depot = { address: "Synthetic depot", latitude: 59.3293, longitude: 18.0686,
    verifiedAt: date.toISOString(), verification: { source: "synthetic_test" } };
  await db.insert(routesTable).values({
    id: routeId, organizationId, vehicleId, draftId, planId, name: "Synthetic notification route",
    date, status: "optimized", planRevision: 1, totalStops: 4,
    notifyApproaching: true, notifyDelivered: true,
    depotSnapshot: { start: depot, end: depot },
    optimizationPlanningSnapshot: normalizePlanningInputs(null),
  });
  for (let i = 0; i < 4; i++) await addStop(i);
  await seedOptimizationEvidence(1);
  plannerToken = (await createSession({ userId: plannerId, organizationId })).token;
  driverToken = (await createSession({ userId: driverUserId, organizationId })).token;
  const { default: app } = await import("./app");
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (oldTrackingBase === undefined) delete process.env.PUBLIC_TRACKING_BASE_URL; else process.env.PUBLIC_TRACKING_BASE_URL = oldTrackingBase;
  if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  try {
    await db.delete(deliveryNotificationsTable).where(eq(deliveryNotificationsTable.routeId, routeId));
    // Cleanup runs even when setup or an assertion fails, scoped to this UUID.
    for (const table of [
      customerNotificationAttemptsTable, auditLogTable, executionEventsTable,
      routeExecutionsTable, routeAcknowledgementsTable, routeDispatchSnapshotsTable,
      routePlanApprovalsTable, stopsTable, routesTable, sessionsTable, usersTable,
      planningDraftsTable, driversTable, vehiclesTable, organizationServicePoliciesTable,
    ]) await db.delete(table).where(eq(table.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  } finally {
    mock.restoreAll();
    globalThis.fetch = nativeFetch;
    await pool.end();
  }
});

test("approved dispatch, accepted driving, terminal stops and approved redispatch send exact customer channels", async () => {
  const dispatch = (revision: number, status = 200) => request("planner", `/routes/${routeId}/dispatch`,
    { driverId, planRevision: revision }, status);
  const approve = (revision: number) => request("planner", `/import/route-plans/${planId}/approve`,
    { routes: [{ routeId, planRevision: revision, driverId }] });

  await assertNotifications("planning alone");
  await dispatch(1, 409);
  await assertNotifications("unapproved dispatch");
  await approve(1);
  await assertNotifications("approval alone");
  await dispatch(1);
  for (let stop = 0; stop < 4; stop++) expected.push({ event: "planned", stop });
  await assertNotifications("first dispatch");
  await dispatch(1);
  await assertNotifications("dispatch retry");

  const start = { clientEventId: randomUUID() };
  await request("driver", `/routes/${routeId}/execution/start`, start, 409);
  await assertNotifications("unaccepted start");
  for (const status of ["received", "opened", "accepted"]) {
    await request("driver", `/routes/${routeId}/handoff`, { status, version: 1 });
  }
  await assertNotifications("acceptance alone");
  await request("driver", `/routes/${routeId}/execution/start`, start, 201);
  expected.push({ event: "approaching", stop: 0 });
  await assertNotifications("accepted start");
  await request("driver", `/routes/${routeId}/execution/start`, start);
  await assertNotifications("start retry");

  for (const [stop, type] of ["completed", "failed", "skipped"].entries()) {
    const body = {
      clientEventId: randomUUID(), type, planVersion: 1, occurredAt: new Date().toISOString(),
      ...(type === "skipped" ? { skipReason: "OTHER", comment: "Synthetic skip" } : {}),
    };
    await request("driver", `/stops/${stopIds[stop]}/execution-events`, body, 201);
    if (type === "completed") expected.push({ event: "completed", stop });
    expected.push({ event: "approaching", stop: stop + 1 });
    await assertNotifications(type);
    await request("driver", `/stops/${stopIds[stop]}/execution-events`, body);
    await assertNotifications(`${type} retry`);
  }

  // Keep an existing pending stop so redispatch must deduplicate it as well
  // as exclude completed/failed/skipped stops from planned messages.
  await addStop(4);
  await seedOptimizationEvidence(2);
  await assertNotifications("new working stop");
  await dispatch(2, 409);
  await assertNotifications("unapproved redispatch");
  await approve(2);
  await assertNotifications("redispatch approval alone");
  await dispatch(2);
  expected.push({ event: "planned", stop: 4 });
  await assertNotifications("approved redispatch");
  await dispatch(2);
  await assertNotifications("redispatch retry");
  assert.equal(calls.filter(c => c.channel === "sms").length, 10);
  assert.equal(calls.filter(c => c.channel === "email").length, 10);
});
