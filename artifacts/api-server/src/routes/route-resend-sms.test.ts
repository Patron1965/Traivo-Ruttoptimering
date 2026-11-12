import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import test from "node:test";
import { useLinkSmsTestEnvironment } from "../services/link-sms-test-env";
useLinkSmsTestEnvironment();
import { and, eq } from "drizzle-orm";
import {
  auditLogTable,
  db,
  driversTable,
  organizationsTable,
  routesTable,
  routeDispatchSnapshotsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser, UserRole } from "../middleware/auth";
import routesRouter from "./routes";

const nativeFetch = globalThis.fetch;

async function seedSyntheticDispatchEvidence(organizationId: string) {
  const drivers = await db.select().from(driversTable).where(eq(driversTable.organizationId, organizationId));
  for (const driver of drivers) {
    const [vehicle] = await db.insert(vehiclesTable).values({
      organizationId, name: "SMS fixture resource", licensePlate: "TEST",
    }).returning();
    await db.update(driversTable).set({ vehicleId: vehicle.id }).where(eq(driversTable.id, driver.id));
    await db.update(routesTable).set({ vehicleId: vehicle.id }).where(eq(routesTable.handoffDriverId, driver.id));
  }
  const routes = await db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId));
  for (const route of routes) {
    // Deliberately stale test routes retain missing evidence.
    if (route.planRevision !== route.handoffVersion || !route.handoffDriverId) continue;
    await db.update(routesTable).set({ dispatchSnapshotVersion: route.planRevision })
      .where(eq(routesTable.id, route.id));
    await db.insert(routeDispatchSnapshotsTable).values({
      routeId: route.id, organizationId, planRevision: route.planRevision,
      driverId: route.handoffDriverId, capturedAt: new Date(),
      route: { ...route, __snapshotSchema: 2 }, stops: [],
    });
  }
}

function appFor(organizationId: string, role: UserRole): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Route SMS test",
      email: "route-sms@example.test",
      role,
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
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

test("resend SMS is tenant-scoped, guards the saved recipient, and leaves handoff fields unchanged", async () => {
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const routeId = randomUUID();
  const driverId = randomUUID();
  const otherDriverId = randomUUID();
  const planningDate = new Date("2026-09-12T08:00:00.000Z");
  const previousProvider = process.env.SMS_PROVIDER;
  const previousToken = process.env.LINK_MOBILITY_API_TOKEN;
  const previousSender = process.env.LINK_MOBILITY_SENDER;
  const previousFetch = globalThis.fetch;
  let providerRequest: { url: string; init?: RequestInit } | undefined;

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Route SMS test",
      email: `${organizationId}@example.test`,
    },
    {
      id: foreignOrganizationId,
      name: "Foreign Route SMS test",
      email: `${foreignOrganizationId}@example.test`,
    },
  ]);

  try {
    await db.insert(driversTable).values([
      {
        id: driverId,
        organizationId,
        name: "Saved recipient",
        phone: "070-123 45 67",
        isActive: true,
      },
      {
        id: otherDriverId,
        organizationId,
        name: "Different recipient",
        phone: "070-765 43 21",
        isActive: true,
      },
    ]);
    await db.insert(routesTable).values({
      id: routeId,
      organizationId,
      planId: randomUUID(),
      name: "SMS resend route",
      status: "in_progress",
      date: planningDate,
      totalStops: 2,
      planRevision: 4,
      handoffStatus: "accepted",
      handoffVersion: 4,
      handoffDriverId: driverId,
    });

    await seedSyntheticDispatchEvidence(organizationId);
    process.env.SMS_PROVIDER = "linkmobility";
    process.env.LINK_MOBILITY_API_TOKEN = "test-token";
    process.env.LINK_MOBILITY_SENDER = "Traivo";
    globalThis.fetch = async (url, init) => {
      providerRequest = { url: String(url), init };
      return new Response(JSON.stringify({ resultCode: 1005, messageId: "test-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const viewer = await post(
      appFor(organizationId, "viewer"),
      `/routes/${routeId}/resend-sms`,
      { driverId },
    );
    assert.equal(viewer.status, 403);
    assert.equal(providerRequest, undefined);

    const foreignTenant = await post(
      appFor(foreignOrganizationId, "dispatcher"),
      `/routes/${routeId}/resend-sms`,
      { driverId },
    );
    assert.equal(foreignTenant.status, 404);
    assert.equal(providerRequest, undefined);

    const wrongRecipient = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${routeId}/resend-sms`,
      { driverId: otherDriverId },
    );
    assert.equal(wrongRecipient.status, 409);
    assert.equal(wrongRecipient.body.code, "recipient_mismatch");
    assert.equal(providerRequest, undefined);

    const [before] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const response = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${routeId}/resend-sms`,
      { driverId },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "sent");
    assert.equal(response.body.code, "sms_sent");
    assert.equal(response.body.driverId, driverId);
    const capturedProviderRequest = providerRequest as {
      url: string;
      init?: RequestInit;
    } | undefined;
    assert.ok(capturedProviderRequest);
    assert.equal(capturedProviderRequest.url, "https://n-eu.linkmobility.io/sms/send");
    const sentPayload = JSON.parse(String(capturedProviderRequest.init?.body)) as {
      destination: string;
      userData: string;
    };
    assert.equal(sentPayload.destination, "+46701234567");
    assert.match(sentPayload.userData, /\/activate#access=[A-Za-z0-9_-]{43}/);

    const [after] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.deepEqual(
      {
        status: after.status,
        planRevision: after.planRevision,
        handoffStatus: after.handoffStatus,
        handoffVersion: after.handoffVersion,
        handoffDriverId: after.handoffDriverId,
        sentAt: after.sentAt,
        receivedAt: after.receivedAt,
        openedAt: after.openedAt,
        acceptedAt: after.acceptedAt,
        rejectedAt: after.rejectedAt,
        rejectionReason: after.rejectionReason,
      },
      {
        status: before.status,
        planRevision: before.planRevision,
        handoffStatus: before.handoffStatus,
        handoffVersion: before.handoffVersion,
        handoffDriverId: before.handoffDriverId,
        sentAt: before.sentAt,
        receivedAt: before.receivedAt,
        openedAt: before.openedAt,
        acceptedAt: before.acceptedAt,
        rejectedAt: before.rejectedAt,
        rejectionReason: before.rejectionReason,
      },
    );

    const auditRows = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.organizationId, organizationId),
      eq(auditLogTable.resourceId, routeId),
      eq(auditLogTable.action, "route.sms_resend"),
    ));
    assert.ok(auditRows.some((row) => (row.metadata as { outcome?: string } | null)?.outcome === "sent"));
    assert.doesNotMatch(JSON.stringify(auditRows), /0701234567|\+46701234567|test-token/);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [
      ["SMS_PROVIDER", previousProvider],
      ["LINK_MOBILITY_API_TOKEN", previousToken],
      ["LINK_MOBILITY_SENDER", previousSender],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  }
});

test("resend SMS reports safe provider statuses, rejects stale routes, and rate-limits retries", async () => {
  const organizationId = randomUUID();
  const driverId = randomUUID();
  const noPhoneDriverId = randomUUID();
  const noConfigRouteId = randomUUID();
  const missingPhoneRouteId = randomUUID();
  const failedRouteId = randomUUID();
  const staleRouteId = randomUUID();
  const completedRouteId = randomUUID();
  const rateLimitedRouteId = randomUUID();
  const previousProvider = process.env.SMS_PROVIDER;
  const previousToken = process.env.LINK_MOBILITY_API_TOKEN;
  const previousSender = process.env.LINK_MOBILITY_SENDER;
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  let providerStatus = 200;

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Route SMS status test",
    email: `${organizationId}@example.test`,
  });

  try {
    await db.insert(driversTable).values([
      {
        id: driverId,
        organizationId,
        name: "Configured recipient",
        phone: "0701234567",
        isActive: true,
      },
      {
        id: noPhoneDriverId,
        organizationId,
        name: "Recipient without phone",
        phone: null,
        isActive: true,
      },
    ]);
    await db.insert(routesTable).values([
      {
        id: noConfigRouteId,
        organizationId,
        name: "No config route",
        status: "in_progress",
        date: new Date("2026-09-12T08:00:00.000Z"),
        planRevision: 1,
        handoffStatus: "sent",
        handoffVersion: 1,
        handoffDriverId: driverId,
      },
      {
        id: missingPhoneRouteId,
        organizationId,
        name: "Missing phone route",
        status: "in_progress",
        date: new Date("2026-09-12T08:00:00.000Z"),
        planRevision: 1,
        handoffStatus: "sent",
        handoffVersion: 1,
        handoffDriverId: noPhoneDriverId,
      },
      {
        id: failedRouteId,
        organizationId,
        name: "Provider failure route",
        status: "in_progress",
        date: new Date("2026-09-12T08:00:00.000Z"),
        planRevision: 1,
        handoffStatus: "sent",
        handoffVersion: 1,
        handoffDriverId: driverId,
      },
      {
        id: staleRouteId,
        organizationId,
        name: "Stale handoff route",
        status: "in_progress",
        date: new Date("2026-09-12T08:00:00.000Z"),
        planRevision: 2,
        handoffStatus: "sent",
        handoffVersion: 1,
        handoffDriverId: driverId,
      },
      {
        id: completedRouteId,
        organizationId,
        name: "Completed route",
        status: "completed",
        date: new Date("2026-09-12T08:00:00.000Z"),
        planRevision: 1,
        handoffStatus: "accepted",
        handoffVersion: 1,
        handoffDriverId: driverId,
      },
      {
        id: rateLimitedRouteId,
        organizationId,
        name: "Rate limited route",
        status: "in_progress",
        date: new Date("2026-09-12T08:00:00.000Z"),
        planRevision: 1,
        handoffStatus: "sent",
        handoffVersion: 1,
        handoffDriverId: driverId,
      },
    ]);

    await seedSyntheticDispatchEvidence(organizationId);
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://n-eu.linkmobility.io/sms/send");
      providerCalls += 1;
      return new Response(JSON.stringify({ resultCode: 1005, messageId: "test-id" }), { status: providerStatus });
    };
    process.env.SMS_PROVIDER = "linkmobility";
    delete process.env.LINK_MOBILITY_API_TOKEN;
    delete process.env.LINK_MOBILITY_SENDER;

    const notConfigured = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${noConfigRouteId}/resend-sms`,
      { driverId },
    );
    assert.equal(notConfigured.status, 200);
    assert.equal(notConfigured.body.status, "not_configured");
    assert.equal(notConfigured.body.code, "sms_not_configured");
    assert.equal(providerCalls, 0);

    const missingPhone = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${missingPhoneRouteId}/resend-sms`,
      { driverId: noPhoneDriverId },
    );
    assert.equal(missingPhone.status, 200);
    assert.equal(missingPhone.body.status, "missing_phone");
    assert.equal(missingPhone.body.code, "sms_missing_phone");
    assert.equal(providerCalls, 0);

    process.env.LINK_MOBILITY_API_TOKEN = "test-token";
    process.env.LINK_MOBILITY_SENDER = "Traivo";
    providerStatus = 500;
    const failed = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${failedRouteId}/resend-sms`,
      { driverId },
    );
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.code, "sms_failed");
    assert.equal(providerCalls, 1);

    const stale = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${staleRouteId}/resend-sms`,
      { driverId },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "handoff_stale");
    assert.equal(providerCalls, 1);

    const completed = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${completedRouteId}/resend-sms`,
      { driverId },
    );
    assert.equal(completed.status, 409);
    assert.equal(completed.body.code, "route_not_active");
    assert.equal(providerCalls, 1);

    providerStatus = 200;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sent = await post(
        appFor(organizationId, "dispatcher"),
        `/routes/${rateLimitedRouteId}/resend-sms`,
        { driverId },
      );
      assert.equal(sent.status, 200);
      assert.equal(sent.body.status, "sent");
    }
    assert.equal(providerCalls, 4);
    const rateLimited = await post(
      appFor(organizationId, "dispatcher"),
      `/routes/${rateLimitedRouteId}/resend-sms`,
      { driverId },
    );
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.body.code, "resend_rate_limited");
    assert.equal(providerCalls, 4);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [
      ["SMS_PROVIDER", previousProvider],
      ["LINK_MOBILITY_API_TOKEN", previousToken],
      ["LINK_MOBILITY_SENDER", previousSender],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});