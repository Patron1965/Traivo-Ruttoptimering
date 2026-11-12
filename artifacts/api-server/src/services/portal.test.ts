import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { once } from "node:events";
import { and, eq, inArray } from "drizzle-orm";
import { db, organizationsTable, usersTable, sessionsTable, customersTable, stopsTable, vehiclesTable, driversTable,
  routesTable, routeDispatchSnapshotsTable, routeExecutionsTable, vehiclePositionsTable, portalAccountsTable,
  portalTokensTable, portalContactsTable, organizationServicePoliciesTable } from "@workspace/db";
import app from "../app";
import { createPortalRouter, PORTAL_COOKIE } from "../routes/portal";
import { createPortalAdminRouter } from "../routes/portal-admin";
import { authMiddleware } from "../middleware/auth";
import { createSession } from "../lib/session";
import { hashPassword } from "../lib/password";
import { captureRouteDispatchSnapshot } from "./route-dispatch-snapshot-service";
import { startRouteExecution } from "./route-execution-service";
import { loginPortal, portalSession, resetPortalPassword, redeemPortalAccess, portalTokenHash } from "./portal-auth";
import { listPortalOrders } from "./portal-order-history";

test("portal HTTP isolation, historical IDs, explicit grants, invitation/reset, execution freshness and revocation", async () => {
  // PostgreSQL permits these IDs; list/detail/admin paths must agree on them.
  const historicalId = () => `${randomUUID().slice(0, 14)}0000-0000-${randomUUID().slice(-12)}`;
  const orgs = [randomUUID(), randomUUID()];
  const [org, foreign] = orgs;
  const userId = randomUUID(), customerA = randomUUID(), customerB = randomUUID();
  const stopA = historicalId(), stopB = randomUUID(), foreignStop = historicalId();
  const vehicleId = historicalId(), driverId = randomUUID(), routeId = randomUUID();
  const sent: string[] = [];
  const harness = express();
  harness.use(express.json(), cookieParser());
  harness.use("/api/portal", createPortalRouter({ mail: async payload => { sent.push(payload.html); return true; }, road: async () => 60 }));
  harness.use(authMiddleware());
  harness.use("/api", createPortalAdminRouter(async payload => { sent.push(payload.html); return true; }));
  harness.use(app);
  const server = harness.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, cookie = "", method = "GET", body?: unknown, headers?: Record<string, string>) =>
    fetch(`${base}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  const password = `test-only-${randomUUID()}`;
  try {
    await db.insert(organizationsTable).values(orgs.map(id => ({ id, name: "Portal isolated fixture", email: `${id}@fixture.invalid` })));
    await db.insert(organizationServicePoliciesTable).values({ organizationId: org,
      policy: { roadProvider: "disabled", geocodingProvider: "disabled", smsProvider: "disabled", emailEnabled: false,
        aiEnabled: false, cuoptEnabled: false, districtEnabled: false } });
    await db.insert(usersTable).values({ id: userId, organizationId: org, role: "admin", name: "Portal fixture admin", email: `${userId}@fixture.invalid` });
    const staff = `routeai_session=${(await createSession({ userId, organizationId: org })).token}`;
    await db.insert(customersTable).values([{ id: customerA, organizationId: org, name: "Customer A" }, { id: customerB, organizationId: org, name: "Customer B" }]);
    await db.insert(vehiclesTable).values({ id: vehicleId, organizationId: org, name: "Public resource", licensePlate: "TEST-PORTAL" });
    await db.insert(driversTable).values({ id: driverId, organizationId: org, vehicleId, name: "Private driver name", phone: "PRIVATE-PHONE" });
    await db.insert(routesTable).values({ id: routeId, organizationId: org, vehicleId, name: "Portal test",
      date: new Date("2026-11-01T23:15:00Z"), status: "in_progress", planRevision: 1, handoffVersion: 1,
      handoffStatus: "accepted", handoffDriverId: driverId, totalStops: 2 });
    await db.insert(stopsTable).values([
      { id: stopA, organizationId: org, customerId: customerA, routeId, address: "Approved address A", latitude: 59.3, longitude: 18.1, sequenceOrder: 1,
        planningDate: new Date("2026-11-01T23:15:00Z"), notes: "INTERNAL-SECRET", executionComment: "PRIVATE-EXECUTION", contactPhone: "PRIVATE-CUSTOMER" },
      { id: stopB, organizationId: org, customerId: customerB, routeId, address: "SECRET-OTHER-ADDRESS", latitude: 59.4, longitude: 18.2, sequenceOrder: 2 },
      { id: foreignStop, organizationId: foreign, address: "FOREIGN-SECRET", latitude: 59, longitude: 18 },
    ]);
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const routeStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.transaction(tx => captureRouteDispatchSnapshot(tx, route, routeStops, driverId, new Date()));
    const input = { name: "Portal A", email: `${randomUUID()}@fixture.invalid`, enabled: true, customerIds: [customerA], stopIds: [] };
    const response = await request("/portal-admin/accounts", staff, "POST", input);
    assert.equal(response.status, 201);
    const account = await response.json() as { id: string };
    const historicalAccountId = historicalId();
    await db.update(portalAccountsTable).set({ id: historicalAccountId }).where(eq(portalAccountsTable.id, account.id));
    account.id = historicalAccountId;
    assert.equal(sent.length, 0, "Saving does not send");
    assert.equal((await request(`/portal-admin/accounts/${account.id}`, staff, "PUT", input)).status, 200);
    assert.equal((await request(`/portal-admin/accounts/${account.id}`, staff, "PUT", { ...input, stopIds: [foreignStop] })).status, 400);
    assert.equal((await request(`/portal-admin/accounts/${account.id}/invite`, staff, "POST")).status, 204);
    assert.equal(sent.length, 1);
    const token = /#token=([a-f0-9]+)/.exec(sent[0])![1];
    assert.ok(sent[0].includes("/portal/access#token="));
    assert.equal(await resetPortalPassword(token, password), false, "Login token cannot set a password");
    assert.equal((await request("/portal/access", "", "POST", { token }, { origin: "https://untrusted.invalid" })).status, 403);
    const expired = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await db.insert(portalTokensTable).values({ hash: portalTokenHash(expired), accountId: account.id, purpose: "login", expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await redeemPortalAccess(expired), null, "Expired link rejected");
    await db.update(portalAccountsTable).set({ enabled: false }).where(eq(portalAccountsTable.id, account.id));
    assert.equal(await redeemPortalAccess(token), null, "Disabled account rejected without consuming link");
    await db.update(portalAccountsTable).set({ enabled: true }).where(eq(portalAccountsTable.id, account.id));
    const raced = await Promise.all([request("/portal/access", "", "POST", { token }), request("/portal/access", "", "POST", { token })]);
    assert.deepEqual(raced.map(r => r.status).sort(), [200, 401], "Concurrent redemption has exactly one winner");
    const loginResponse = raced.find(r => r.status === 200)!;
    assert.equal(loginResponse.status, 200);
    assert.equal((await request("/portal/access", "", "POST", { token })).status, 401, "Single use link");
    const cookie = loginResponse.headers.get("set-cookie")!.split(";")[0];
    assert.ok(cookie.startsWith(PORTAL_COOKIE));
    assert.equal((await request("/stops", cookie)).status, 401, "Customer cookie cannot authenticate internal API");
    assert.equal((await request("/portal/me", staff)).status, 401, "Staff cookie cannot authenticate portal");
    assert.equal((await request("/portal-admin/accounts", cookie)).status, 401);
    assert.equal((await request(`/portal/orders/${stopB}`, cookie)).status, 404);
    assert.equal((await request(`/portal/orders/${foreignStop}`, cookie)).status, 404);
    assert.equal((await request("/portal/orders/not-a-guid", cookie)).status, 404);
    const { items: orders } = await (await request("/portal/orders", cookie)).json() as { items: { id: string; date: string; status: string }[] };
    assert.deepEqual(orders.map((x: { id: string }) => x.id), [stopA]);
    assert.equal(orders[0].date, "2026-11-02", "Swedish midnight");
    assert.equal(orders[0].status, "scheduled", "Sent/accepted is not actual start");
    const readDetail = async () => {
      const response = await request(`/portal/orders/${stopA}`, cookie);
      assert.equal(response.status, 200, "An order listed with a historical ID must be readable");
      return await response.json() as {
      completedAt: string | null;
      order: { status: string; address: string };
      contact: { name: string } | null;
      delivery: { tracking: { state: string; position: unknown } };
      };
    };
    let detail = await readDetail();
    assert.equal(detail.contact, null);
    assert.equal((await request(`/portal-admin/contacts/${vehicleId}`, staff, "PUT", { enabled: true, name: "Approved work contact", phone: "+46812345678" })).status, 200);
    await db.update(stopsTable).set({ address: "DRAFT-SECRET" }).where(eq(stopsTable.id, stopA));
    const execution = await startRouteExecution({ routeId, clientEventId: randomUUID(),
      actor: { organizationId: org, actorUserId: userId, role: "admin", driverProfileId: null } });
    detail = await readDetail();
    assert.equal(detail.order.status, "started");
    assert.equal(detail.order.address, "Approved address A", "Never working draft address");
    assert.equal(detail.contact?.name, "Approved work contact");
    assert.equal(detail.delivery.tracking.position, null, "No GPS fabricated");
    await db.insert(vehiclePositionsTable).values({ organizationId: org, routeId, vehicleId, executionId: execution.execution.id,
      startClientEventId: execution.execution.startClientEventId, latitude: 59.301, longitude: 18.101, recordedAt: new Date() });
    detail = await readDetail();
    assert.equal(detail.delivery.tracking.state, "live");
    assert.equal(detail.order.status, "on_the_way");
    const serialized = JSON.stringify(detail);
    for (const value of ["PRIVATE-PHONE", "PRIVATE-EXECUTION", "INTERNAL-SECRET", "SECRET-OTHER-ADDRESS", "DRAFT-SECRET", "FOREIGN-SECRET", "PRIVATE-CUSTOMER"])
      assert.ok(!serialized.includes(value), value);
    await db.update(vehiclePositionsTable).set({ recordedAt: new Date(Date.now() - 180_000) }).where(eq(vehiclePositionsTable.organizationId, org));
    detail = await readDetail();
    assert.equal(detail.delivery.tracking.state, "stale"); assert.equal(detail.delivery.tracking.position, null);
    await db.update(routeExecutionsTable).set({ status: "ended", endedAt: new Date() }).where(eq(routeExecutionsTable.id, execution.execution.id));
    detail = await readDetail();
    assert.equal(detail.order.status, "paused"); assert.equal(detail.contact, null);
    await db.update(routeExecutionsTable).set({ status: "active", endedAt: null }).where(eq(routeExecutionsTable.id, execution.execution.id));
    await db.update(routesTable).set({ status: "cancelled" }).where(eq(routesTable.id, routeId));
    detail = await readDetail();
    assert.equal(detail.order.status, "cancelled"); assert.equal(detail.delivery.tracking.position, null);
    await db.update(routesTable).set({ status: "in_progress" }).where(eq(routesTable.id, routeId));
    await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, stopA));
    detail = await readDetail();
    assert.equal(detail.order.status, "completed"); assert.equal(detail.contact, null); assert.equal(detail.delivery.tracking.position, null);
    assert.equal(detail.completedAt, null, "Do not infer missing completion time");
    const completedAt = new Date("2026-11-04T11:25:00Z");
    await db.update(stopsTable).set({ terminalAt: completedAt }).where(eq(stopsTable.id, stopA));
    detail = await readDetail();
    assert.equal(detail.completedAt, completedAt.toISOString());
    const other = await request("/portal-admin/accounts", staff, "POST", { ...input, name: "Portal B",
      email: `${randomUUID()}@fixture.invalid`, customerIds: [customerB] });
    const otherAccount = await other.json() as { id: string; email: string };
    await db.update(portalAccountsTable).set({ passwordHash: await hashPassword(password) }).where(eq(portalAccountsTable.id, otherAccount.id));
    const loginB = await loginPortal(otherAccount.email, password);
    const cookieB = `${PORTAL_COOKIE}=${loginB!.token}`;
    assert.equal((await request(`/portal/orders/${stopA}`, cookieB)).status, 404);
    assert.equal((await request(`/portal/orders/${stopB}`, cookieB)).status, 200);
    // A working resource change must not silently change the customer's contact.
    const vehicle2 = randomUUID(), driver2 = randomUUID();
    await db.insert(vehiclesTable).values({ id: vehicle2, organizationId: org, name: "Resource 2", licensePlate: "PORTAL-2" });
    await db.insert(driversTable).values({ id: driver2, organizationId: org, name: "Private 2", vehicleId: vehicle2 });
    await db.update(routesTable).set({ vehicleId: vehicle2, planRevision: 2 }).where(eq(routesTable.id, routeId));
    const readB = async () => await (await request(`/portal/orders/${stopB}`, cookieB)).json() as {
      order: { status: string }; contact: { name: string } | null; delivery: { tracking: { position: unknown } };
    };
    assert.equal((await readB()).contact?.name, "Approved work contact");
    await db.update(routesTable).set({ handoffVersion: 2, handoffDriverId: driver2 }).where(eq(routesTable.id, routeId));
    const [newRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const newStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.transaction(tx => captureRouteDispatchSnapshot(tx, newRoute, newStops, driver2, new Date()));
    assert.equal((await readB()).order.status, "scheduled");
    await startRouteExecution({ routeId, clientEventId: randomUUID(),
      actor: { organizationId: org, actorUserId: userId, role: "admin", driverProfileId: null } });
    assert.equal((await readB()).contact, null, "New resource has no implicitly copied private number");
    await request(`/portal-admin/contacts/${vehicle2}`, staff, "PUT", { enabled: true, name: "Approved second contact", phone: "+46812345679" });
    assert.equal((await readB()).contact?.name, "Approved second contact");
    assert.equal((await readB()).delivery.tracking.position, null, "Previous resource GPS not reused");
    await db.update(stopsTable).set({ status: "skipped" }).where(eq(stopsTable.id, stopB));
    assert.equal((await readB()).contact, null);
    assert.equal((await readB()).order.status, "skipped");
    // Large histories: the full authorized selection is filtered before paging.
    const historyRoute = randomUUID();
    await db.insert(routesTable).values({ id: historyRoute, organizationId: org, vehicleId: vehicle2,
      name: "History route", date: new Date("2026-06-30T22:30:00Z"), status: "in_progress",
      planRevision: 1, handoffVersion: 1, handoffStatus: "accepted", handoffDriverId: driver2, totalStops: 20 });
    const spreadRoutes = Array.from({ length: 80 }, () => randomUUID());
    await db.insert(routesTable).values(spreadRoutes.map(id => ({ id, organizationId: org, vehicleId: vehicle2,
      name: "Distributed history", date: new Date("2026-06-30T22:30:00Z"), status: "in_progress" as const,
      planRevision: 1, handoffVersion: 1, handoffStatus: "accepted" as const, handoffDriverId: driver2, totalStops: 7 })));
    const historyIds: string[] = Array.from({ length: 620 }, () => randomUUID());
    await db.insert(stopsTable).values(historyIds.map((id, index) => ({
      id, organizationId: org, customerId: customerA,
      routeId: index < 20 ? historyRoute : index < 580 ? spreadRoutes[Math.floor((index - 20) / 7)] : null,
      sequenceOrder: index < 20 ? index + 1 : ((index - 20) % 7) + 1,
      externalRef: `HISTORY-${String(index).padStart(4, "0")}`, address: index === 619 ? "Literal 100%_ Street" : "History address",
      latitude: 59.3, longitude: 18.1,
      planningDate: new Date("2026-06-30T22:30:00Z"),
      timeWindowStart: new Date("2026-06-30T22:30:00Z"), timeWindowEnd: new Date("2026-06-30T23:30:00Z"),
      createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + Math.floor(index / 3) * 1000),
    })));
    const [hr] = await db.select().from(routesTable).where(eq(routesTable.id, historyRoute));
    const hs = await db.select().from(stopsTable).where(eq(stopsTable.routeId, historyRoute));
    await db.transaction(tx => captureRouteDispatchSnapshot(tx, hr, hs, driver2, new Date()));
    const distributed = await db.select().from(routesTable).where(inArray(routesTable.id, spreadRoutes));
    const distributedStops = await db.select().from(stopsTable).where(inArray(stopsTable.routeId, spreadRoutes));
    await db.transaction(async tx => {
      for (const route of distributed)
        await captureRouteDispatchSnapshot(tx, route, distributedStops.filter(s => s.routeId === route.id), driver2, new Date());
    });
    type Page = { items: { id: string; status: string; date: string; timeWindowStart: string }[]; total: number; nextCursor: string | null; asOf: string };
    const page = async (query = "", who = cookie): Promise<Page> => {
      const response = await request(`/portal/orders${query}`, who);
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as Page;
    };
    assert.equal((await page("?limit=100")).total, 621);
    const [portalAccount] = await db.select().from(portalAccountsTable).where(eq(portalAccountsTable.id, account.id));
    let historyReads = 0;
    const countedDatabase = { execute: ((...args: Parameters<typeof db.execute>) => {
      historyReads++; return db.execute(...args);
    }) as typeof db.execute };
    const narrowPage = await listPortalOrders(portalAccount, { search: "HISTORY-0000", limit: 1 }, false, countedDatabase);
    assert.equal(narrowPage.total, 1);
    assert.equal(historyReads, 1, "81 dispatched history routes use one database statement, not per-route reads");
    const seen = new Set<string>();
    let cursor: string | null = null;
    let asOf: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}), ...(asOf ? { asOf } : {}) });
      const current = await page(`?${query}`);
      assert.equal(current.total, 621);
      for (const order of current.items) { assert.ok(!seen.has(order.id), "No duplicates between pages"); seen.add(order.id); }
      cursor = current.nextCursor; asOf = current.asOf;
    } while (cursor);
    assert.equal(seen.size, 621, "No truncation above 500");
    const chronological = [...historyIds].sort((a, b) =>
      Math.floor(historyIds.indexOf(b) / 3) - Math.floor(historyIds.indexOf(a) / 3) || b.localeCompare(a));
    assert.deepEqual([...seen], [stopA, ...chronological], "Newest first across pages, UUID breaks identical timestamps");
    assert.ok(!seen.has(stopB) && !seen.has(foreignStop));
    assert.equal((await page("?search=HISTORY-0619")).total, 1);
    assert.equal((await page("?search=HISTORY-0619")).items[0].timeWindowStart, "2026-06-30T22:30:00.000Z");
    assert.equal((await page("?search=HISTORY-0000")).items[0].timeWindowStart, "2026-06-30T22:30:00.000Z");
    assert.equal((await page("?search=100%25_")).total, 1, "Search treats percent/underscore literally");
    assert.equal((await page("?search=HISTORY", cookieB)).total, 0);
    assert.equal((await page("?from=2026-07-01&to=2026-07-01")).total, 620, "Swedish summer date for draft and outgoing orders");
    assert.equal((await page("?from=2026-11-02&to=2026-11-02")).total, 1, "Swedish winter date");
    assert.equal((await request("/portal/orders?from=2026-02-30", cookie)).status, 400);
    assert.equal((await request("/portal/orders?from=2026-11-02&to=2026-11-01", cookie)).status, 400);
    assert.equal((await request("/portal/orders?limit=101", cookie)).status, 400);
    assert.equal((await request("/portal/orders?cursor=not-a-uuid", cookie)).status, 400);
    assert.equal((await request("/portal/orders?asOf=not-a-date", cookie)).status, 400);
    assert.equal((await page("?status=started")).total, 0, "Accepted dispatch is not a start");
    await startRouteExecution({ routeId: historyRoute, clientEventId: randomUUID(),
      actor: { organizationId: org, actorUserId: userId, role: "admin", driverProfileId: null } });
    assert.equal((await page("?status=started")).total, 20);
    const activePage = await page("/active?limit=10");
    assert.equal(activePage.total, 20); assert.equal(activePage.items.length, 10);
    assert.ok(activePage.nextCursor);
    assert.equal((await page("/active?limit=10&cursor=" + activePage.nextCursor)).items.length, 10);
    await db.update(stopsTable).set({ address: "UNAPPROVED-HISTORY", planningDate: new Date("2027-01-01") }).where(eq(stopsTable.id, historyIds[0]));
    assert.equal((await page("?search=UNAPPROVED-HISTORY")).total, 0, "Filters cannot search working drafts");
    assert.equal((await page("?from=2026-07-01&to=2026-07-01")).total, 620);
    // List projection must retain the same fail-closed evidence checks as detail.
    await db.update(driversTable).set({ isActive: false }).where(eq(driversTable.id, driver2));
    assert.equal((await page("?search=HISTORY-0000")).total, 0, "Invalid recipient must not expose snapshot or draft values");
    assert.equal((await page("?status=unavailable")).total, 581);
    await db.update(driversTable).set({ isActive: true }).where(eq(driversTable.id, driver2));
    // Mutable execution status does not reorder history while the customer pages.
    const before = await page("?limit=100");
    await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, historyIds[1]));
    const after = await page(`?limit=100&asOf=${encodeURIComponent(before.asOf)}`);
    assert.deepEqual(after.items.map(o => o.id), before.items.map(o => o.id));
    const removedId = before.items.find(o => historyIds.indexOf(o.id) >= 20)!.id;
    await db.update(stopsTable).set({ archivedAt: new Date() }).where(eq(stopsTable.id, removedId));
    const lateId = randomUUID();
    await db.insert(stopsTable).values({ id: lateId, organizationId: org, customerId: customerA,
      address: "Added during browsing", latitude: 59, longitude: 18,
      createdAt: new Date(Date.parse(before.asOf) + 1000) });
    const remaining = new Set<string>();
    cursor = before.nextCursor;
    do {
      const current = await page(`?limit=100&cursor=${cursor}&asOf=${encodeURIComponent(before.asOf)}`);
      assert.equal(current.total, 620, "Count reflects scope removal but not new orders outside the browsing boundary");
      for (const order of current.items) { assert.ok(!remaining.has(order.id)); remaining.add(order.id); }
      cursor = current.nextCursor;
    } while (cursor);
    assert.equal(remaining.size, 521, "Removing an earlier row never skips a later one");
    assert.ok(!remaining.has(lateId), "New orders cannot shift an ongoing browse");
    assert.equal((await request(`/portal-admin/accounts/${account.id}`, staff, "PUT", { ...input, enabled: false })).status, 200);
    assert.equal((await request("/portal/orders", cookie)).status, 401, "Live session revoked");
    assert.equal(await loginPortal(input.email, password), null);
    assert.equal((await request("/portal/logout", cookieB, "POST", undefined, { origin: "https://evil.invalid" })).status, 403);
    assert.equal((await request("/portal/logout", cookieB, "POST")).status, 204);
    assert.equal(await portalSession(loginB!.token), null);
  } finally {
    server.close(); server.closeAllConnections();
    await db.delete(portalAccountsTable).where(inArray(portalAccountsTable.organizationId, orgs));
    await db.delete(portalContactsTable).where(inArray(portalContactsTable.organizationId, orgs));
    await db.delete(vehiclePositionsTable).where(inArray(vehiclePositionsTable.organizationId, orgs));
    await db.delete(routeExecutionsTable).where(inArray(routeExecutionsTable.organizationId, orgs));
    await db.delete(routeDispatchSnapshotsTable).where(inArray(routeDispatchSnapshotsTable.organizationId, orgs));
    await db.delete(stopsTable).where(inArray(stopsTable.organizationId, orgs));
    await db.delete(routesTable).where(inArray(routesTable.organizationId, orgs));
    await db.delete(driversTable).where(inArray(driversTable.organizationId, orgs));
    await db.delete(vehiclesTable).where(inArray(vehiclesTable.organizationId, orgs));
    await db.delete(customersTable).where(inArray(customersTable.organizationId, orgs));
    await db.delete(sessionsTable).where(inArray(sessionsTable.organizationId, orgs));
    await db.delete(usersTable).where(inArray(usersTable.organizationId, orgs));
    await db.delete(organizationServicePoliciesTable).where(inArray(organizationServicePoliciesTable.organizationId, orgs));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgs));
  }
});
