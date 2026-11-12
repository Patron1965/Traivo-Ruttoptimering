import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, stopsTable, routesTable, organizationsTable, customerLinksTable, auditLogTable } from "@workspace/db";
import customerLinksRouter from "./customer-links";
import publicTrackingRouter from "./public-tracking";
import { auditMiddleware } from "../middleware/audit";
import { existingCustomerTrackingUrl, DAY_MS, effectiveExpiry, trackingBaseUrl } from "../services/customer-links";
import type { UserRole } from "../middleware/auth";

const orgs = [randomUUID(), randomUUID()];
const stopIds: string[] = [];
const routeIds: string[] = [];
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
const oldBase = process.env.PUBLIC_TRACKING_BASE_URL;
const oldSecret = process.env.SESSION_SECRET;
const invalid = { error: "Länken är inte tillgänglig.", code: "TRACKING_UNAVAILABLE" };

before(async () => {
  process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.test/app/";
  process.env.SESSION_SECRET = "test-only-customer-link-secret-32-characters";
  await db.insert(organizationsTable).values(orgs.map((id) => ({
    id, name: "Isolated secure tracking test", email: `${id}@example.test`,
    brandDisplayName: "PRIVATE DRAFT", brandLogoUrl: "https://private.example.test/draft.png",
  })));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Authenticated identity fixture, never derived from query/body.
    if (req.headers["x-test-role"]) req.user = {
      id: orgs[0], name: "Test actor", email: "actor@example.test",
      organizationId: req.headers["x-test-tenant"] === "b" ? orgs[1] : orgs[0],
      role: req.headers["x-test-role"] as UserRole, driverProfileId: null,
    };
    next();
  });
  app.use(auditMiddleware);
  app.use("/api", customerLinksRouter, publicTrackingRouter);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(stopsTable).where(inArray(stopsTable.organizationId, orgs));
  await db.delete(routesTable).where(inArray(routesTable.organizationId, orgs));
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, orgs));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgs));
  if (oldBase === undefined) delete process.env.PUBLIC_TRACKING_BASE_URL; else process.env.PUBLIC_TRACKING_BASE_URL = oldBase;
  if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
});
async function stop(tenant = 0, routeId?: string) {
  const id = randomUUID(); stopIds.push(id);
  await db.insert(stopsTable).values({
    id, organizationId: orgs[tenant], routeId, address: "Synthetic private delivery",
    latitude: 59.3, longitude: 18.1, trackingCode: `LEGACY-${id}`,
    contactName: "PRIVATE CONTACT", contactEmail: "private@example.test", contactPhone: "PRIVATE PHONE",
    notes: "PRIVATE INTERNAL NOTES",
  });
  return id;
}
async function request(path: string, role?: UserRole, action?: string, tenant = "a", extra: object = {}) {
  const response = await fetch(`${base}${path}`, {
    method: action ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(role ? { "x-test-role": role, "x-test-tenant": tenant } : {}) },
    ...(action ? { body: JSON.stringify({ action, ...extra }) } : {}),
  });
  return { response, status: response.status, body: await response.json() as Record<string, any> };
}
const management = (id: string) => `/api/stops/${id}/customer-link`;
const publicPath = (url: string) => `/api/track/${new URL(url).pathname.split("/").at(-1)}`;
async function create(id: string) {
  const result = await request(management(id), "dispatcher", "create");
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "active");
  return result.body.url as string;
}
function noCache(response: Response) {
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("x-robots-tag")!, /noindex/);
}

test("anonymous/viewer/driver denied both management methods; two tenants remain isolated", async () => {
  const id = await stop();
  for (const role of [undefined, "viewer", "driver"] as const) {
    for (const action of [undefined, "create", "replace", "revoke"]) {
      const result = await request(management(id), role, action);
      assert.equal(result.status, role ? 403 : 401);
      noCache(result.response);
      assert.ok(result.body.code);
    }
  }
  for (const role of ["admin", "dispatcher"] as const) {
    assert.equal((await request(management(id), role)).body.status, "none");
    assert.equal((await request(`${management(id)}?organizationId=${orgs[0]}`, role, undefined, "b")).status, 404);
    assert.equal((await request(management(id), role, "create", "b")).status, 404);
    assert.equal((await request(management(id), role, "revoke", "b")).status, 404);
  }
  assert.equal((await request(management(id), "admin", "create", "a", { organizationId: orgs[1] })).status, 400);
});

test("minimal public allowlist, no branding/proofs/contacts/route progress; legacy fails uniformly", async () => {
  const id = await stop();
  const url = await create(id);
  assert.match(url, /^https:\/\/tracking\.example\.test\/app\/track\/[A-Za-z0-9_-]{43}$/);
  const result = await request(publicPath(url));
  noCache(result.response);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["status", "address", "latitude", "longitude", "timeWindowStart", "timeWindowEnd", "brand", "tracking", "arrival"].sort());
  assert.deepEqual(Object.keys(result.body.tracking).sort(), ["state", "position", "lastUpdatedAt", "freshUntil", "reason"].sort());
  assert.deepEqual(Object.keys(result.body.arrival).sort(), ["plannedAt", "estimatedAt", "source", "calculatedAt", "reason"].sort());
  assert.equal(result.body.brand, null);
  assert.equal(result.body.status, "scheduled");
  for (const path of [`/api/track/LEGACY-${id}`, "/api/track/unknown", `/api/track/${"a".repeat(43)}`]) {
    const result = await request(path);
    assert.equal(result.status, 404); assert.deepEqual(result.body, invalid); noCache(result.response);
  }
  // An authenticated tenant B still receives only the exact public allowlist.
  assert.deepEqual((await request(publicPath(url), "admin", undefined, "b")).body, result.body);
  const [stored] = await db.select().from(customerLinksTable).where(eq(customerLinksTable.stopId, id));
  assert.equal(JSON.stringify(stored).includes(url.split("/").at(-1)!), false);
  assert.equal(stored.tokenHash.length, 64);
  assert.ok(stored.expiresAt.getTime() <= stored.createdAt.getTime() + 7 * DAY_MS);
});

test("revocation immediate, explicit replacement only, automatic notifications cannot remint", async () => {
  const id = await stop();
  assert.equal(await existingCustomerTrackingUrl(id, orgs[0]), null);
  const first = await create(id);
  assert.equal(await existingCustomerTrackingUrl(id, orgs[0]), first);
  assert.equal((await request(management(id), "admin", "create")).body.url, first);
  const revoked = await request(management(id), "dispatcher", "revoke");
  assert.equal(revoked.body.status, "revoked"); assert.equal(revoked.body.url, null); noCache(revoked.response);
  assert.deepEqual((await request(publicPath(first))).body, invalid);
  assert.equal(await existingCustomerTrackingUrl(id, orgs[0]), null);
  assert.equal((await request(management(id), "admin", "create")).status, 409);
  const replacement = await request(management(id), "admin", "replace");
  assert.equal(replacement.status, 200); assert.notEqual(replacement.body.url, first);
  assert.equal((await request(publicPath(replacement.body.url))).status, 200);
  assert.equal((await request(publicPath(first))).status, 404);
  const none = await stop();
  assert.equal((await request(management(none), "admin", "revoke")).body.status, "revoked");
  assert.equal(await existingCustomerTrackingUrl(none, orgs[0]), null);
});

test("parallel creates converge and replacements/revoke serialize on stop lock", async () => {
  const id = await stop();
  const results = await Promise.all(Array.from({ length: 5 }, () => request(management(id), "admin", "create")));
  assert.equal(new Set(results.map((r) => r.body.url)).size, 1);
  const changes = await Promise.all(["replace", "revoke", "replace"].map((action) => request(management(id), "admin", action)));
  assert.ok(changes.every((r) => r.status === 200));
  const final = await request(management(id), "admin");
  for (const changed of changes.filter((r) => r.body.url)) {
    assert.equal((await request(publicPath(changed.body.url))).status, changed.body.url === final.body.url ? 200 : 404);
  }
});

test("seven-day expiry and terminal boundaries, unknown terminal time fails closed, reopen cannot extend", async () => {
  const id = await stop();
  const url = await create(id);
  await db.update(customerLinksTable).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(customerLinksTable.stopId, id));
  assert.equal((await request(publicPath(url))).status, 404);
  assert.equal((await request(management(id), "admin")).body.status, "expired");
  for (const status of ["completed", "failed", "skipped"] as const) {
    const terminalId = await stop();
    const terminalUrl = await create(terminalId);
    const terminalAt = new Date(Date.now() - DAY_MS + 120_000);
    await db.update(stopsTable).set({ status, terminalAt }).where(eq(stopsTable.id, terminalId));
    const visible = await request(publicPath(terminalUrl));
    assert.equal(visible.status, 200);
    assert.equal(visible.body.status, status === "completed" ? "delivered" : "failed");
    const current = await request(management(terminalId), "admin");
    assert.equal(Date.parse(current.body.expiresAt), terminalAt.getTime() + DAY_MS);
    await db.update(stopsTable).set({ status: "pending", terminalAt: null }).where(eq(stopsTable.id, terminalId));
    assert.equal((await request(management(terminalId), "admin")).body.expiresAt, current.body.expiresAt);
    const replaced = await request(management(terminalId), "admin", "replace");
    assert.equal(replaced.body.expiresAt, current.body.expiresAt);
    assert.equal((await request(publicPath(terminalUrl))).status, 404);
    await db.update(stopsTable).set({ status, terminalAt: new Date(Date.now() - DAY_MS) }).where(eq(stopsTable.id, terminalId));
    assert.equal((await request(publicPath(replaced.body.url))).status, 404);
    assert.equal((await request(management(terminalId), "admin", "replace")).status, 409);
    await db.update(stopsTable).set({ terminalAt: null }).where(eq(stopsTable.id, terminalId));
    assert.equal((await request(publicPath(replaced.body.url))).status, 404);
  }
  const exact = new Date("2026-01-01T00:00:00Z");
  assert.equal(effectiveExpiry({ status: "completed", terminalAt: exact }, { expiresAt: new Date(exact.getTime() + 7 * DAY_MS) }).getTime(), exact.getTime() + DAY_MS);
});

test("stop deletion, archive and route deletion permanently invalidate the public URL", async () => {
  const routeId = randomUUID(); routeIds.push(routeId);
  await db.insert(routesTable).values({ id: routeId, organizationId: orgs[0], name: "Synthetic route", date: new Date() });
  const id = await stop(0, routeId);
  const url = await create(id);
  await db.update(stopsTable).set({ routeId: null }).where(eq(stopsTable.id, id));
  await db.delete(routesTable).where(eq(routesTable.id, routeId));
  assert.equal((await request(publicPath(url))).status, 404);
  assert.equal((await request(management(id), "admin")).body.status, "revoked");
  const deletedId = await stop(); const deletedUrl = await create(deletedId);
  await db.delete(stopsTable).where(eq(stopsTable.id, deletedId));
  assert.equal((await request(publicPath(deletedUrl))).status, 404);
  assert.equal((await request(management(deletedId), "admin")).status, 404);
  const archivedId = await stop(); const archivedUrl = await create(archivedId);
  await db.update(stopsTable).set({ archivedAt: new Date() }).where(eq(stopsTable.id, archivedId));
  assert.equal((await request(publicPath(archivedUrl))).status, 404);
});

test("configuration is explicit HTTPS and never Host/dev-domain fallback; audit contains no URL/token", async () => {
  const saved = process.env.PUBLIC_TRACKING_BASE_URL;
  for (const bad of ["", "http://example.com", "https://localhost", "https://127.0.0.1", "https://app.replit.dev", "https://app.repl.co", "https://u:p@example.com", "https://example.com?foo=1"]) {
    process.env.PUBLIC_TRACKING_BASE_URL = bad;
    assert.equal(trackingBaseUrl(), null);
  }
  const id = await stop();
  const unavailable = await request(management(id), "admin", "create");
  assert.equal(unavailable.status, 503);
  process.env.PUBLIC_TRACKING_BASE_URL = saved;
  const url = await create(id);
  await request(management(id), "admin", "revoke", "a", { url, token: url.split("/").at(-1) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const logs = await db.select().from(auditLogTable).where(and(eq(auditLogTable.organizationId, orgs[0]), eq(auditLogTable.resourceId, id)));
  assert.ok(logs.length);
  assert.equal(JSON.stringify(logs).includes(url), false);
  assert.equal(JSON.stringify(logs).includes(url.split("/").at(-1)!), false);
});

test("public abuse limit also returns no-store generic error", async () => {
  let last;
  for (let i = 0; i < 65; i++) last = await request("/api/track/invalid");
  assert.equal(last!.status, 429); assert.deepEqual(last!.body, invalid); noCache(last!.response);
});