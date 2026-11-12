import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, auditLogTable, organizationRoutingProvidersTable, organizationsTable,
  sessionsTable, usersTable,
} from "@workspace/db";
import { authMiddleware, requirePlatformAdmin } from "./middleware/auth";
import { createSession } from "./lib/session";
import platformRoutingRouter from "./routes/platform-routing";
import {
  resolveBoundRoutingProvider,
  resolveOrganizationRoutingProvider,
} from "./services/routing-provider-config";

const fixture = randomUUID();
const organizationIds = [randomUUID(), randomUUID()];
const userIds = [randomUUID(), randomUUID()];
const sessionIds: string[] = [];
const auditSecret = `synthetic-token-${fixture}`;
const urls = {
  north: `https://north-${fixture}.invalid/osrm`,
  west: `https://west-${fixture}.invalid/osrm`,
  locked: `https://locked-${fixture}.invalid/osrm`,
};
let server: Server;
let base = "";
let platformToken = "";
let tenantToken = "";
let oldOsrm: string | undefined;
let oldCatalog: string | undefined;
let oldToken: string | undefined;
let oldLockedToken: string | undefined;
let oldNodeEnv: string | undefined;

function configureCatalog(options: { changedNorth?: boolean } = {}): void {
  process.env.OSRM_BASE_URL = `https://shared-${fixture}.invalid/osrm`;
  process.env.ROUTING_SERVER_CATALOG_JSON = JSON.stringify([
    { id: "north", name: "North test", baseUrl: options.changedNorth ? `${urls.north}/v2` : urls.north },
    { id: "west", name: "West test", baseUrl: urls.west },
    { id: "locked", name: "Locked test", baseUrl: urls.locked, authTokenEnv: "TEST_ROUTING_AUTH_TOKEN" },
  ]);
  process.env.TEST_ROUTING_AUTH_TOKEN = auditSecret;
}

async function request(path: string, token: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})) as Record<string, any>,
  };
}

before(async () => {
  oldOsrm = process.env.OSRM_BASE_URL;
  oldCatalog = process.env.ROUTING_SERVER_CATALOG_JSON;
  oldToken = process.env.OSRM_AUTH_TOKEN;
  oldLockedToken = process.env.TEST_ROUTING_AUTH_TOKEN;
  oldNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  configureCatalog();
  await db.insert(organizationsTable).values([
    { id: organizationIds[0], name: `Routing platform ${fixture}`, email: `routing-platform-${fixture}@example.test` },
    { id: organizationIds[1], name: `Routing tenant ${fixture}`, email: `routing-tenant-${fixture}@example.test` },
  ]);
  await db.insert(usersTable).values([
    {
      id: userIds[0], organizationId: organizationIds[0], name: `Routing platform ${fixture}`,
      email: `routing-platform-user-${fixture}@example.test`, role: "admin", isPlatformAdmin: true,
    },
    {
      id: userIds[1], organizationId: organizationIds[1], name: `Routing tenant ${fixture}`,
      email: `routing-tenant-user-${fixture}@example.test`, role: "admin",
    },
  ]);
  const platformSession = await createSession({ userId: userIds[0], organizationId: organizationIds[0] });
  const tenantSession = await createSession({ userId: userIds[1], organizationId: organizationIds[1] });
  platformToken = platformSession.token;
  tenantToken = tenantSession.token;
  sessionIds.push(platformSession.session.id, tenantSession.session.id);
  await db.update(sessionsTable).set({ mfaVerifiedAt: new Date() }).where(inArray(sessionsTable.id, sessionIds));

  const app = express();
  app.use(express.json(), authMiddleware());
  app.use("/api/platform", requirePlatformAdmin());
  app.use("/api", platformRoutingRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
  await db.delete(auditLogTable).where(and(
    eq(auditLogTable.action, "platform.organization.routing.update"),
    inArray(auditLogTable.resourceId, organizationIds),
  ));
  if (sessionIds.length) await db.delete(sessionsTable).where(inArray(sessionsTable.id, sessionIds));
  await db.delete(organizationRoutingProvidersTable)
    .where(inArray(organizationRoutingProvidersTable.organizationId, organizationIds));
  await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  if (oldOsrm === undefined) delete process.env.OSRM_BASE_URL;
  else process.env.OSRM_BASE_URL = oldOsrm;
  if (oldCatalog === undefined) delete process.env.ROUTING_SERVER_CATALOG_JSON;
  else process.env.ROUTING_SERVER_CATALOG_JSON = oldCatalog;
  if (oldToken === undefined) delete process.env.OSRM_AUTH_TOKEN;
  else process.env.OSRM_AUTH_TOKEN = oldToken;
  if (oldLockedToken === undefined) delete process.env.TEST_ROUTING_AUTH_TOKEN;
  else process.env.TEST_ROUTING_AUTH_TOKEN = oldLockedToken;
  if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = oldNodeEnv;
});

test("platform routing API returns safe status, assigns catalog IDs, rejects URLs/unknown IDs, and clears to inherit", async () => {
  const platformStatus = await request("/platform/routing", platformToken);
  assert.equal(platformStatus.status, 200);
  assert.equal(platformStatus.body.shared.configured, true);
  assert.deepEqual(platformStatus.body.dedicated.map((entry: { id: string }) => entry.id), ["north", "west", "locked"]);
  const serializedStatus = JSON.stringify(platformStatus.body);
  for (const endpoint of Object.values(urls)) assert.equal(serializedStatus.includes(endpoint), false);
  assert.equal(serializedStatus.includes(auditSecret), false);

  const orgId = organizationIds[1];
  const initial = await request(`/platform/organizations/${orgId}/routing`, platformToken);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, {
    organizationId: orgId, serverId: null, effectiveServerId: "shared", configured: true,
  });
  const set = await request(`/platform/organizations/${orgId}/routing`, platformToken, "PUT", { serverId: "north" });
  assert.equal(set.status, 200);
  assert.equal(set.body.serverId, "north");
  assert.equal((await request(`/platform/organizations/${orgId}/routing`, platformToken)).body.effectiveServerId, "north");

  assert.equal((await request(`/platform/organizations/${orgId}/routing`, platformToken, "PUT", {
    serverId: "not-in-catalog",
  })).status, 400);
  assert.equal((await request(`/platform/organizations/${orgId}/routing`, platformToken, "PUT", {
    serverId: urls.west,
  })).status, 400);
  assert.equal((await request(`/platform/organizations/${orgId}/routing`, platformToken, "PUT", {
    serverId: "west", endpoint: urls.west,
  })).status, 400);

  const clear = await request(`/platform/organizations/${orgId}/routing`, platformToken, "PUT", { serverId: null });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.serverId, null);
  assert.equal(clear.body.effectiveServerId, "shared");
  assert.equal((await request(`/platform/organizations/${orgId}/routing`, platformToken)).body.serverId, null);

  assert.equal((await request(`/platform/organizations/${randomUUID()}/routing`, platformToken)).status, 404);
  assert.equal((await request(`/platform/organizations/${randomUUID()}/routing`, platformToken, "PUT", {
    serverId: null,
  })).status, 404);
  assert.equal((await request(`/platform/organizations/${orgId}/routing`, tenantToken)).status, 403);
  assert.equal((await request(`/platform/organizations/${orgId}/routing`, tenantToken, "PUT", {
    serverId: "north",
  })).status, 403);

  const events = await db.select().from(auditLogTable).where(and(
    eq(auditLogTable.action, "platform.organization.routing.update"),
    eq(auditLogTable.resourceId, orgId),
  ));
  assert.equal(events.length, 2);
  const auditJson = JSON.stringify(events);
  assert.ok(auditJson.includes('"from":null'));
  assert.ok(auditJson.includes('"to":"north"'));
  for (const endpoint of Object.values(urls)) assert.equal(auditJson.includes(endpoint), false);
  assert.equal(auditJson.includes(auditSecret), false);
});

test("bound routing providers remain stable across preference changes and reject cross-tenant/stale/missing-auth bindings", async () => {
  const orgA = organizationIds[0];
  const orgB = organizationIds[1];
  await db.insert(organizationRoutingProvidersTable).values({ organizationId: orgA, serverId: "north" });
  const selected = await resolveOrganizationRoutingProvider(orgA);
  assert.equal(selected.binding.serverId, "north");

  await db.update(organizationRoutingProvidersTable).set({ serverId: "west", updatedAt: new Date() })
    .where(eq(organizationRoutingProvidersTable.organizationId, orgA));
  const current = await resolveOrganizationRoutingProvider(orgA);
  assert.equal(current.binding.serverId, "west");
  const oldBound = await resolveBoundRoutingProvider(orgA, selected.binding);
  const oldBoundAgain = await resolveBoundRoutingProvider(orgA, selected.binding);
  assert.equal(oldBound.cacheKey, oldBoundAgain.cacheKey);
  assert.equal(oldBound.cacheKey, selected.provider.cacheKey);

  await assert.rejects(resolveBoundRoutingProvider(orgB, selected.binding), /konfiguration har ändrats/);
  configureCatalog({ changedNorth: true });
  await assert.rejects(resolveBoundRoutingProvider(orgA, selected.binding), /konfiguration har ändrats/);

  configureCatalog();
  await db.update(organizationRoutingProvidersTable).set({ serverId: "locked", updatedAt: new Date() })
    .where(eq(organizationRoutingProvidersTable.organizationId, orgA));
  const lockedBinding = await resolveOrganizationRoutingProvider(orgA);
  assert.equal(lockedBinding.binding.serverId, "locked");
  delete process.env.TEST_ROUTING_AUTH_TOKEN;
  await assert.rejects(resolveBoundRoutingProvider(orgA, lockedBinding.binding), /token som inte är konfigurerad/);
  await assert.rejects(
    resolveOrganizationRoutingProvider(randomUUID()),
    /Organisationen finns inte/,
  );
  // A missing credential is an error; the resolver never falls back to shared.
  assert.equal(lockedBinding.binding.serverId, "locked");
});