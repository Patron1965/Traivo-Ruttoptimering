import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable, routesTable } from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import orgSettingsRouter from "./org-settings";

test("organization planning allowances reject decimals and negatives at the HTTP boundary", async () => {
  const organizationId = randomUUID();
  const user: AuthUser = {
    id: randomUUID(),
    name: "Allowance settings test",
    email: `${organizationId}@example.test`,
    role: "admin",
    organizationId,
    driverProfileId: null,
  };
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Allowance settings test",
    email: `${organizationId}@example.test`,
  });
  const routeId = randomUUID();
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    name: "Policy evidence route",
    date: new Date("2026-09-06T07:00:00.000Z"),
    status: "optimized",
    planRevision: 6,
    geographicOverlapExplanation: {
      status: "confirmed",
      reasonCode: "WORKING_HOURS",
      message: "Kontrollerat par",
      analyzedPairCount: 1,
      scope: { vehicleIds: [randomUUID(), randomUUID()], stopIds: [randomUUID(), randomUUID()] },
    },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(orgSettingsRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    // Reproduce the former frontend failure: GET includes a nullable,
    // unrelated configuration that cannot be PUT back as a notification edit.
    const endpoint = `http://127.0.0.1:${port}/organizations/${organizationId}/settings`;
    const settings = await (await fetch(endpoint)).json();
    assert.equal(settings.customerNotifications, null);
    const replay = await fetch(endpoint, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /meddelandemallarna/);
    for (const [field, value] of [
      ["maxDriverOvertimeMin", 1.5],
      ["maxDriverOvertimeMin", -1],
      ["allowLateStopsMin", 2.5],
      ["allowLateStopsMin", -1],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/organizations/${organizationId}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      assert.equal(response.status, 400, `${field}=${value} should be rejected`);
    }
    const [organization] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    assert.equal(organization.maxDriverOvertimeMin, 0);
    assert.equal(organization.allowLateStopsMin, 0);

    const response = await fetch(`http://127.0.0.1:${port}/organizations/${organizationId}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        autoBalance: false, snapToRoad: true, defaultRouteType: "delivery",
        defaultServiceDurationMin: 3, maxDriverOvertimeMin: 30, allowLateStopsMin: 10,
      }),
    });
    assert.equal(response.status, 200);
    const saved = await (await fetch(endpoint)).json();
    assert.equal(saved.maxDriverOvertimeMin, 30);
    assert.equal(saved.allowLateStopsMin, 10);
    assert.equal(saved.defaultServiceDurationMin, 3);
    assert.equal(saved.autoBalance, false);
    assert.equal(saved.snapToRoad, true);
    assert.equal(saved.customerNotifications, null);
    assert.equal(saved.stopRetentionEnabled, settings.stopRetentionEnabled);
    assert.equal(saved.operatingMode, settings.operatingMode);
    const [route] = await db
      .select({
        explanation: routesTable.geographicOverlapExplanation,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(route.explanation, null);
    assert.equal(route.planRevision, 6);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});