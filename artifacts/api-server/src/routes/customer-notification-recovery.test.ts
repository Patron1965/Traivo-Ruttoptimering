import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable, customerNotificationAttemptsTable } from "@workspace/db";
import settingsRouter from "./org-settings";
import type { AuthUser } from "../middleware/auth";

test("recovery endpoint rejects foreign tenants, non-admins, malformed recipients and uncertain attempts", async () => {
  const organizationId = randomUUID();
  const foreignId = randomUUID();
  const attemptId = randomUUID();
  let role: AuthUser["role"] = "admin";
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: randomUUID(), organizationId, role, name: "Recovery fixture", email: "recovery@fixture.invalid", driverProfileId: null };
    next();
  });
  app.use(settingsRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const post = (orgId: string, body: unknown, id = attemptId) => fetch(
    `http://127.0.0.1:${port}/organizations/${orgId}/customer-notifications/${id}/recover`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  try {
    await db.insert(organizationsTable).values({ id: organizationId, name: "Recovery endpoint fixture", email: `recovery-${organizationId}@fixture.invalid` });
    await db.insert(customerNotificationAttemptsTable).values({
      id: attemptId, organizationId, stopId: randomUUID(), event: "planned", channel: "email", status: "unknown",
    });
    const input = { revision: 0, recipient: "recipient@fixture.invalid" };
    assert.equal((await post(foreignId, input)).status, 404);
    assert.equal((await post(organizationId, input, randomUUID())).status, 404);
    for (const forbiddenRole of ["viewer", "driver", "dispatcher"] as const) {
      role = forbiddenRole;
      assert.equal((await post(organizationId, input)).status, 403);
    }
    role = "admin";
    assert.equal((await post(organizationId, { ...input, recipient: "not-an-email" })).status, 400);
    assert.equal((await post(organizationId, { ...input, revision: -1 })).status, 400);
    assert.equal((await post(organizationId, input)).status, 409);
    const [unchanged] = await db.select().from(customerNotificationAttemptsTable).where(eq(customerNotificationAttemptsTable.id, attemptId));
    assert.equal(unchanged.status, "unknown");
    assert.equal(unchanged.revision, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(customerNotificationAttemptsTable).where(eq(customerNotificationAttemptsTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
