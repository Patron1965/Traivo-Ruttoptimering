import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import test from "node:test";
import { useLinkSmsTestEnvironment } from "../services/link-sms-test-env";
useLinkSmsTestEnvironment();
import { eq } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  routeAcknowledgementsTable,
  routeDispatchSnapshotsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
  webhooksTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import routesRouter from "./routes";

const nativeFetch = globalThis.fetch;

function appFor(organizationId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Dispatch idempotency test",
      email: "dispatch-idempotency@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(routesRouter);
  return app;
}

async function post(
  app: Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  try {
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

async function createFixture(input: {
  status: "optimized" | "in_progress";
  handoffStatus: "pending" | "sent" | "received" | "opened" | "accepted" | "rejected";
  planRevision: number;
  handoffVersion: number | null;
  handoffDriverId: string | null;
  sentAt?: Date | null;
  receivedAt?: Date | null;
  openedAt?: Date | null;
  acceptedAt?: Date | null;
  rejectedAt?: Date | null;
  rejectionReason?: string | null;
}) {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Dispatch idempotency",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Idempotency vehicle",
    licensePlate: `ID-${vehicleId.slice(0, 8)}`,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Idempotency driver",
    phone: "0701234567",
    isActive: true,
  });
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Idempotent route",
    status: input.status,
    date: new Date("2026-10-12T08:00:00.000Z"),
    planRevision: input.planRevision,
    handoffStatus: input.handoffStatus,
    handoffVersion: input.handoffVersion,
    handoffDriverId: input.handoffDriverId,
    sentAt: input.sentAt,
    receivedAt: input.receivedAt,
    openedAt: input.openedAt,
    acceptedAt: input.acceptedAt,
    rejectedAt: input.rejectedAt,
    rejectionReason: input.rejectionReason,
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    routeId,
    address: "Idempotency stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    sequenceOrder: 1,
  });
  return {
    organizationId,
    vehicleId,
    driverId,
    routeId,
    stopId,
    planRevision: input.planRevision,
  };
}

async function cleanupFixture(organizationId: string) {
  await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, organizationId));
  await db.delete(routeAcknowledgementsTable).where(eq(
    routeAcknowledgementsTable.organizationId,
    organizationId,
  ));
  await db.delete(webhooksTable).where(eq(webhooksTable.organizationId, organizationId));
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
}

function useConfiguredSmsProvider() {
  const previousProvider = process.env.SMS_PROVIDER;
  const previousToken = process.env.LINK_MOBILITY_API_TOKEN;
  const previousSender = process.env.LINK_MOBILITY_SENDER;
  process.env.SMS_PROVIDER = "linkmobility";
  process.env.LINK_MOBILITY_API_TOKEN = "dispatch-idempotency-test";
  process.env.LINK_MOBILITY_SENDER = "Traivo";
  return () => {
    for (const [key, value] of [
      ["SMS_PROVIDER", previousProvider],
      ["LINK_MOBILITY_API_TOKEN", previousToken],
      ["LINK_MOBILITY_SENDER", previousSender],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("dispatch without SMS publishes the same driver handoff without contacting the provider", async () => {
  const fixture = await createFixture({
    status: "optimized", handoffStatus: "pending", planRevision: 0,
    handoffVersion: null, handoffDriverId: null,
  });
  const previousFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => {
    externalCalls++;
    return new Response(null, { status: 202 });
  };
  try {
    const response = await post(appFor(fixture.organizationId), `/routes/${fixture.routeId}/dispatch`,
      { driverId: fixture.driverId, sendSms: false });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((response.body.sms as { status: string }).status, "skipped");
    assert.equal(response.body.ok, true);
    assert.equal(externalCalls, 0);
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.equal(route.handoffDriverId, fixture.driverId);
    assert.equal(route.handoffVersion, 0);
    assert.equal(route.handoffStatus, "sent");
    assert.ok(route.sentAt);
  } finally {
    globalThis.fetch = previousFetch;
    await cleanupFixture(fixture.organizationId);
  }
});

test("concurrent dispatches publish one handoff, SMS, webhook, and lifecycle", async () => {
  const fixture = await createFixture({
    status: "optimized",
    handoffStatus: "pending",
    planRevision: 6,
    handoffVersion: null,
    handoffDriverId: null,
  });
  const restoreSms = useConfiguredSmsProvider();
  const previousFetch = globalThis.fetch;
  let smsCalls = 0;
  let dispatchWebhookCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("linkmobility")) {
      smsCalls += 1;
      return new Response(JSON.stringify({ resultCode: 1005, messageId: "dispatch-idempotency" }), {
        status: 200,
      });
    }
    if (new Headers(init?.headers).get("X-Traivo-Event") === "route.dispatched") {
      dispatchWebhookCalls += 1;
    }
    return new Response(null, { status: 202 });
  };
  try {
    await db.insert(webhooksTable).values({
      organizationId: fixture.organizationId,
      url: "https://example.test/dispatch-hook",
      name: "Dispatch idempotency hook",
      events: "*",
      active: true,
    });
    const app = appFor(fixture.organizationId);
    const responses = await Promise.all([
      post(app, `/routes/${fixture.routeId}/dispatch`, { driverId: fixture.driverId }),
      post(app, `/routes/${fixture.routeId}/dispatch`, { driverId: fixture.driverId }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200]);
    assert.deepEqual(
      responses.map((response) => response.body.sms && (response.body.sms as { status: string }).status).sort(),
      ["sent", "unknown"],
    );
    assert.equal(smsCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(dispatchWebhookCalls, 1);

    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.equal(route.status, "in_progress");
    assert.equal(route.handoffStatus, "sent");
    assert.equal(route.handoffVersion, fixture.planRevision);
    assert.equal(route.handoffDriverId, fixture.driverId);
    assert.ok(route.sentAt);
    assert.equal(route.receivedAt, null);
    assert.equal(route.openedAt, null);
    assert.equal(route.acceptedAt, null);
    assert.equal(route.rejectedAt, null);
    assert.equal((await db.select().from(routeAcknowledgementsTable)
      .where(eq(routeAcknowledgementsTable.routeId, fixture.routeId))).length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    restoreSms();
    await cleanupFixture(fixture.organizationId);
  }
});

test("repeated dispatch of a current accepted handoff is idempotent and does not reset lifecycle", async () => {
  const acceptedAt = new Date("2026-10-12T09:30:00.000Z");
  const fixture = await createFixture({
    status: "in_progress",
    handoffStatus: "accepted",
    planRevision: 4,
    handoffVersion: 4,
    handoffDriverId: null,
    acceptedAt,
  });
  const restoreSms = useConfiguredSmsProvider();
  const previousFetch = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async () => {
    smsCalls += 1;
    return new Response(JSON.stringify([{ messageId: "unexpected" }]), { status: 202 });
  };
  try {
    await db.update(routesTable).set({ handoffDriverId: fixture.driverId, dispatchSnapshotVersion: fixture.planRevision })
      .where(eq(routesTable.id, fixture.routeId));
    const [outgoingRoute] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    const outgoingStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, fixture.routeId));
    await db.insert(routeDispatchSnapshotsTable).values({
      organizationId: fixture.organizationId, routeId: fixture.routeId,
      planRevision: fixture.planRevision, driverId: fixture.driverId,
      capturedAt: new Date(), route: { ...outgoingRoute, __snapshotSchema: 2 }, stops: outgoingStops,
    });
    const response = await post(
      appFor(fixture.organizationId),
      `/routes/${fixture.routeId}/dispatch`,
      { driverId: fixture.driverId },
    );
    assert.equal(response.status, 200);
    assert.equal((response.body.sms as { status: string }).status, "unknown");
    assert.equal((response.body.sms as { sent: boolean }).sent, false);
    assert.equal(response.body.ok, false);
    assert.equal(smsCalls, 0);

    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.equal(route.handoffStatus, "accepted");
    assert.equal(route.handoffVersion, 4);
    assert.equal(route.handoffDriverId, fixture.driverId);
    assert.equal(route.acceptedAt?.toISOString(), acceptedAt.toISOString());
    assert.equal(route.sentAt, null);
    assert.equal(route.receivedAt, null);
    assert.equal(route.openedAt, null);
    assert.equal(route.rejectedAt, null);
    assert.equal((await db.select().from(routeAcknowledgementsTable)
      .where(eq(routeAcknowledgementsTable.routeId, fixture.routeId))).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreSms();
    await cleanupFixture(fixture.organizationId);
  }
});

test("a retry after the dispatch response is discarded preserves a newly accepted current handoff", async () => {
  const fixture = await createFixture({
    status: "optimized",
    handoffStatus: "pending",
    planRevision: 8,
    handoffVersion: null,
    handoffDriverId: null,
  });
  const restoreSms = useConfiguredSmsProvider();
  const previousFetch = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("linkmobility")) smsCalls += 1;
    return new Response(JSON.stringify({ resultCode: 1005, messageId: "lost-response" }), { status: 200 });
  };
  try {
    const app = appFor(fixture.organizationId);
    const first = await post(
      app,
      `/routes/${fixture.routeId}/dispatch`,
      { driverId: fixture.driverId },
    );
    assert.equal(first.status, 200);
    assert.equal((first.body.sms as { status: string }).status, "sent");
    assert.equal(smsCalls, 1);

    const acceptedAt = new Date("2026-10-12T10:00:00.000Z");
    await db.update(routesTable).set({
      handoffStatus: "accepted",
      acceptedAt,
    }).where(eq(routesTable.id, fixture.routeId));

    // The first response was lost by the caller; the retry must only
    // reconcile the current handoff and never send the SMS a second time.
    const retry = await post(
      app,
      `/routes/${fixture.routeId}/dispatch`,
      { driverId: fixture.driverId },
    );
    assert.equal(retry.status, 200);
    assert.equal((retry.body.sms as { status: string }).status, "unknown");
    assert.equal(smsCalls, 1);

    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.equal(route.handoffStatus, "accepted");
    assert.equal(route.handoffVersion, fixture.planRevision);
    assert.equal(route.handoffDriverId, fixture.driverId);
    assert.equal(route.acceptedAt?.toISOString(), acceptedAt.toISOString());
  } finally {
    globalThis.fetch = previousFetch;
    restoreSms();
    await cleanupFixture(fixture.organizationId);
  }
});