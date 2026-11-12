import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, organizationsTable, vehiclesTable, driversTable, routesTable, usersTable,
  sessionsTable, driverAccessLinksTable, routeDispatchSnapshotsTable, auditLogTable } from "@workspace/db";
import { issueDriverAccessLink, redeemDriverAccessLink, revokeDriverAccess } from "./driver-access";
import { hashToken, validateAndTouchSession, validateSessionWithoutTouch } from "../lib/session";
import { driverSessionUser } from "../lib/driver-device-policy";
import { authMiddleware, requirePlatformAdmin, requireRole } from "../middleware/auth";
import express from "express";
import { once } from "node:events";

test("SMS activation is single-use; the authorized personal device can reopen without a new session", async () => {
  const org = randomUUID(), other = randomUUID(), driverId = randomUUID(), vehicleId = randomUUID();
  const routeId = randomUUID(), userId = randomUUID();
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    await db.insert(organizationsTable).values([{ id: org, name: "Isolated SMS device", email: `${org}@example.invalid` },
      { id: other, name: "Other isolated tenant", email: `${other}@example.invalid` }]);
    await db.insert(vehiclesTable).values({ id: vehicleId, organizationId: org, name: "Synthetic resource", licensePlate: "TEST" });
    await db.insert(driversTable).values({ id: driverId, organizationId: org, name: "Synthetic driver", vehicleId, phone: "+46700000000" });
    // Deliberately linked to a superuser: the SMS session must never inherit it.
    await db.insert(usersTable).values({ id: userId, organizationId: org, name: "Synthetic admin",
      email: `${userId}@example.invalid`, role: "admin", isPlatformAdmin: true, driverProfileId: driverId });
    const [route] = await db.insert(routesTable).values({
      id: routeId, organizationId: org, name: "Synthetic route", date: new Date(),
      vehicleId, status: "in_progress", planRevision: 1, handoffVersion: 1, dispatchSnapshotVersion: 1,
      handoffDriverId: driverId, handoffStatus: "sent", sentAt: new Date(),
    }).returning();
    await db.insert(routeDispatchSnapshotsTable).values({
      routeId, organizationId: org, planRevision: 1, driverId, capturedAt: new Date(),
      route: { ...route, __snapshotSchema: 2 }, stops: [],
    });
    const issue = () => db.transaction(tx => issueDriverAccessLink(tx, {
      routeId, driverId, organizationId: org, appUrl: `https://example.invalid/driver-app/?routeId=${routeId}`,
    }));
    const tokenFrom = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("access")!;
    const url = await issue();
    assert.equal(new URL(url).pathname, "/driver-app/activate");
    assert.equal(new URL(url).search, "");
    const token = tokenFrom(url);
    const results = await Promise.allSettled([redeemDriverAccessLink(token), redeemDriverAccessLink(token)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "parallel replay loses");
    const result = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof redeemDriverAccessLink>>>).value;
    assert.equal(result.routeId, routeId);
    assert.equal(result.user.role, "driver");
    assert.equal(result.user.isPlatformAdmin, false);
    assert.equal(result.user.driverProfileId, driverId);
    const session = await validateAndTouchSession(result.token);
    assert.ok(session?.driverAccess);
    assert.equal(result.resumed, false);
    await assert.rejects(redeemDriverAccessLink(token), "copied SMS cannot activate a second device");
    await assert.rejects(redeemDriverAccessLink(token, "unrelated-device-token"));
    const reopened = await Promise.all([
      redeemDriverAccessLink(token, result.token),
      redeemDriverAccessLink(token, result.token),
    ]);
    for (const resumed of reopened) {
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.token, result.token);
      assert.equal(resumed.routeId, routeId);
      assert.equal(resumed.user.role, "driver");
      assert.equal(resumed.user.isPlatformAdmin, false);
      assert.deepEqual(resumed.session, result.session, "reopening does not extend session expiry");
    }
    assert.equal((await db.select().from(sessionsTable).where(eq(sessionsTable.organizationId, org))).length, 1);
    await db.update(routesTable).set({ status: "completed" }).where(eq(routesTable.id, routeId));
    assert.equal((await redeemDriverAccessLink(token, result.token)).resumed, true,
      "finishing the route must not break the authorized phone's bookmark");
    await db.update(routesTable).set({ status: "in_progress" }).where(eq(routesTable.id, routeId));
    const unrelatedToken = randomUUID();
    const [unrelated] = await db.insert(sessionsTable).values({
      userId, organizationId: org, tokenHash: hashToken(unrelatedToken),
      expiresAt: session.expiresAt,
    }).returning();
    await assert.rejects(redeemDriverAccessLink(token, unrelatedToken), "staff session cannot reuse driver link");
    await db.update(sessionsTable).set({
      driverAccess: { ...session.driverAccess, driverId: randomUUID() },
    }).where(eq(sessionsTable.id, unrelated.id));
    await assert.rejects(redeemDriverAccessLink(token, unrelatedToken), "another driver's session cannot reuse link");
    await db.update(sessionsTable).set({
      driverAccess: session.driverAccess, organizationId: other,
    }).where(eq(sessionsTable.id, unrelated.id));
    await assert.rejects(redeemDriverAccessLink(token, unrelatedToken), "another tenant's session cannot reuse link");
    await db.delete(sessionsTable).where(eq(sessionsTable.id, unrelated.id));
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId));
    await assert.rejects(redeemDriverAccessLink(token, result.token), "deactivated account cannot reopen");
    await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, userId));
    await db.update(sessionsTable).set({ expiresAt: new Date(0) }).where(eq(sessionsTable.id, session.id));
    await assert.rejects(redeemDriverAccessLink(token, result.token), "expired device session cannot reopen");
    await db.update(sessionsTable).set({ expiresAt: session.expiresAt }).where(eq(sessionsTable.id, session.id));
    await db.update(sessionsTable).set({ lastActivityAt: new Date(Date.now() - 2 * 86400_000) }).where(eq(sessionsTable.id, session.id));
    assert.ok(await validateSessionWithoutTouch(result.token), "no morning password after two days");
    const app = express();
    app.use(authMiddleware());
    app.get("/who", (req, res) => res.json(req.user));
    app.get("/platform", requirePlatformAdmin(), (_req, res) => res.sendStatus(200));
    app.post("/admin", requireRole("admin"), (_req, res) => res.sendStatus(200));
    server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${result.token}` };
    assert.equal((await fetch(`${root}/platform`, { headers })).status, 403);
    assert.equal((await fetch(`${root}/admin`, { method: "POST", headers })).status, 403);
    const principal = await (await fetch(`${root}/who`, { headers })).json() as { role: string; organizationId: string };
    assert.equal(principal.role, "driver"); assert.equal(principal.organizationId, org);
    assert.equal(driverSessionUser({ role: "admin", driverProfileId: null, isPlatformAdmin: true }, session).role, "driver");
    await assert.rejects(db.transaction(tx => issueDriverAccessLink(tx, {
      routeId, driverId, organizationId: other, appUrl: "https://example.invalid/driver-app/",
    })));
    const unused = tokenFrom(await issue());
    await revokeDriverAccess(driverId, org);
    assert.equal(await validateAndTouchSession(result.token), null);
    await assert.rejects(redeemDriverAccessLink(token, result.token), "revocation also blocks consumed links");
    await assert.rejects(redeemDriverAccessLink(unused));
    const phoneBound = tokenFrom(await issue());
    await db.update(driversTable).set({ phone: "+46700000001" }).where(eq(driversTable.id, driverId));
    await assert.rejects(redeemDriverAccessLink(phoneBound));
    const expired = tokenFrom(await issue());
    await db.update(driverAccessLinksTable).set({ expiresAt: new Date(0) }).where(eq(driverAccessLinksTable.driverId, driverId));
    await assert.rejects(redeemDriverAccessLink(expired));
    const changed = tokenFrom(await issue());
    await db.update(routesTable).set({ handoffStatus: "pending" }).where(eq(routesTable.id, routeId));
    await assert.rejects(redeemDriverAccessLink(changed));
    const [originalUser] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    assert.equal(originalUser.role, "admin"); assert.equal(originalUser.isPlatformAdmin, true);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, org));
    await db.delete(sessionsTable).where(eq(sessionsTable.organizationId, org));
    await db.delete(sessionsTable).where(eq(sessionsTable.organizationId, other));
    await db.delete(driverAccessLinksTable).where(eq(driverAccessLinksTable.organizationId, org));
    await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, org));
    await db.delete(routesTable).where(eq(routesTable.organizationId, org));
    await db.delete(usersTable).where(eq(usersTable.organizationId, org));
    await db.delete(driversTable).where(eq(driversTable.organizationId, org));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, org));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, other));
  }
});
