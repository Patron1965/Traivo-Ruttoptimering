import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, organizationsTable, usersTable, sessionsTable, stopsTable, customerNotificationAttemptsTable, auditLogTable } from "@workspace/db";
import app from "./app";
import { createSession } from "./lib/session";
import { manageCustomerLink } from "./services/customer-links";
import { customerTransport } from "./services/customer-notification-transport";

test("manual customer SMS: full-app roles, tenant isolation, preview, CAS, resend, unknown outcomes and safe links", async () => {
  const orgs = [randomUUID(), randomUUID()];
  const stopId = randomUUID();
  const actorId = randomUUID();
  const originalTransport = { ...customerTransport };
  const oldBase = process.env.PUBLIC_TRACKING_BASE_URL;
  const oldSecret = process.env.SESSION_SECRET;
  process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.test";
  process.env.SESSION_SECRET = "synthetic-only-sms-secret-at-least-32-characters";
  let calls = 0;
  let outcome: "sent" | "unknown" | "rejected" = "sent";
  let available = true;
  customerTransport.configuredProvider = () => available ? "linkmobility" : null;
  customerTransport.sendSms = async (_recipient, message) => {
    assert.match(message, /https:\/\/tracking\.example\.test\/track\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(message, /LEGACY/);
    calls++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return outcome;
  };
  customerTransport.sendEmail = async () => { throw new Error("SMS must not call email"); };
  const server = createServer(app);
  try {
    await db.insert(organizationsTable).values(orgs.map(id => ({ id, name: "Synthetic SMS", email: `${id}@fixture.invalid` })));
    await db.insert(stopsTable).values({ id: stopId, organizationId: orgs[0], address: "Synthetic delivery", latitude: 59.3, longitude: 18.1,
      contactPhone: "070 000 00 00", trackingCode: `LEGACY-${stopId}` });
    const tokens: Record<string, string> = {};
    for (const [role, tenant] of [["admin", 0], ["dispatcher", 0], ["viewer", 0], ["driver", 0], ["admin", 1]] as const) {
      const id = role === "admin" && tenant === 0 ? actorId : randomUUID();
      await db.insert(usersTable).values({ id, organizationId: orgs[tenant], name: "Synthetic SMS actor", email: `${id}@fixture.invalid`, role });
      tokens[`${role}${tenant}`] = (await createSession({ userId: id, organizationId: orgs[tenant], userAgent: "synthetic-sms-test" })).token;
    }
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/api/stops/${stopId}/customer-link/sms`;
    async function request(actor: string | null, body?: object) {
      const res = await fetch(endpoint, { method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", connection: "close", ...(actor ? { authorization: `Bearer ${tokens[actor]}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: await res.json() as Record<string, any>, headers: res.headers };
    }
    const input = (data: Record<string, any>, resend = false) => ({ revision: data.revision, confirmation: data.confirmation, resend });
    assert.equal((await request(null)).status, 401);
    for (const actor of ["viewer0", "driver0"]) {
      assert.equal((await request(actor)).status, 403);
      assert.equal((await request(actor, { revision: -1, confirmation: "a".repeat(64), resend: false })).status, 403);
    }
    assert.equal((await request("admin1")).status, 404);
    assert.equal((await request("admin1", { revision: -1, confirmation: "a".repeat(64), resend: false })).status, 404);
    assert.match((await request("admin0")).data.blockedReason, /kundlänken/);
    const link = await manageCustomerLink(stopId, orgs[0], "create");
    assert.ok(link.url);
    const before = (await db.select().from(stopsTable).where(eq(stopsTable.id, stopId)))[0];
    let preview = await request("dispatcher0");
    assert.match(preview.headers.get("cache-control")!, /no-store/);
    assert.equal(preview.data.recipient, "+46700000000");
    assert.ok(preview.data.message.includes(link.url));
    available = false;
    assert.match((await request("admin0")).data.blockedReason, /LINK Mobility/);
    assert.equal((await request("admin0", input(preview.data))).status, 409);
    assert.equal((await manageCustomerLink(stopId, orgs[0])).url, link.url);
    available = true;
    for (const phone of [null, "invalid"]) {
      await db.update(stopsTable).set({ contactPhone: phone }).where(eq(stopsTable.id, stopId));
      const invalid = await request("admin0");
      assert.ok(invalid.data.blockedReason);
      assert.equal((await request("admin0", input(invalid.data))).status, 409);
    }
    await db.update(stopsTable).set({ contactPhone: "070 000 00 00" }).where(eq(stopsTable.id, stopId));
    // A changed/revoked link invalidates confirmation, never restores it.
    await manageCustomerLink(stopId, orgs[0], "revoke");
    assert.equal((await request("admin0", input(preview.data))).status, 409);
    assert.equal(calls, 0);
    await manageCustomerLink(stopId, orgs[0], "replace");
    assert.equal((await request("admin0", input(preview.data))).status, 409);
    preview = await request("admin0");
    const submitted = input(preview.data);
    const parallel = await Promise.all([request("admin0", submitted), request("dispatcher0", submitted)]);
    assert(parallel.every(r => r.status === 200));
    assert.equal(calls, 1, "simultaneous requests share one durable claim");
    assert.equal((await request("admin0", submitted)).status, 200);
    assert.equal(calls, 1, "lost response retry cannot send again");
    preview = await request("admin0");
    assert.equal(preview.data.status, "sent");
    assert.equal((await request("admin0", input(preview.data))).status, 409);
    outcome = "unknown";
    const resend = input(preview.data, true);
    assert.equal((await request("admin0", resend)).data.status, "unknown");
    await request("admin0", resend);
    assert.equal(calls, 2, "unknown outcomes are not retried with the same confirmation");
    outcome = "rejected";
    preview = await request("admin0");
    assert.equal((await request("admin0", input(preview.data, true))).data.status, "rejected");
    assert.equal(calls, 3);
    const [attempt] = await db.select().from(customerNotificationAttemptsTable).where(eq(customerNotificationAttemptsTable.stopId, stopId));
    assert.equal(attempt.revision, 2);
    await db.update(customerNotificationAttemptsTable).set({ status: "sending", updatedAt: new Date(Date.now() - 120_000) }).where(eq(customerNotificationAttemptsTable.id, attempt.id));
    assert.equal((await request("admin0")).data.status, "unknown", "abandoned sending is uncertain, not eligible for automatic retry");
    const logs = await db.select().from(auditLogTable).where(eq(auditLogTable.resourceId, stopId));
    assert.equal(logs.filter(row => row.action === "customer_sms_resend").length, 2);
    assert(logs.some(row => row.action === "customer_sms_send" && row.userId === actorId));
    assert.doesNotMatch(JSON.stringify(logs), /\/track\/|070 000|46700000000/);
    assert.deepEqual((await db.select().from(stopsTable).where(eq(stopsTable.id, stopId)))[0], before, "SMS does not mutate execution or route assignment");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    Object.assign(customerTransport, originalTransport);
    if (oldBase === undefined) delete process.env.PUBLIC_TRACKING_BASE_URL; else process.env.PUBLIC_TRACKING_BASE_URL = oldBase;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    await db.delete(sessionsTable).where(inArray(sessionsTable.organizationId, orgs));
    await db.delete(customerNotificationAttemptsTable).where(inArray(customerNotificationAttemptsTable.organizationId, orgs));
    await db.delete(stopsTable).where(inArray(stopsTable.organizationId, orgs));
    await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, orgs));
    await db.delete(usersTable).where(inArray(usersTable.organizationId, orgs));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgs));
  }
});
