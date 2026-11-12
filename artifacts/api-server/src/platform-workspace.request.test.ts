import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, pool, organizationsTable, usersTable, sessionsTable, supportAccessTable, vehiclesTable, auditLogTable } from "@workspace/db";
import { authMiddleware, authorizeWrite, requireAuth } from "./middleware/auth";
import { auditMiddleware } from "./middleware/audit";
import platformRouter from "./routes/platform";
import vehiclesRouter from "./routes/vehicles";
import settingsRouter from "./routes/org-settings";
import { hashToken } from "./lib/session";
import { resolveWorkspace, workspaceHash } from "./lib/workspace-context";
import { canReceiveTenantEvent, setupWebSocket, type WsClient } from "./ws";
import { WebSocket, type WebSocketServer } from "ws";

const home = randomUUID(), other = randomUUID(), actor = randomUUID(), ordinary = randomUUID();
const orgIds: string[] = [home, other];
const sessionToken = randomUUID(), ordinaryToken = randomUUID();
let server: ReturnType<express.Express["listen"]>;
let wss: WebSocketServer;
let origin: string;
let workspace: string;
let target: string;
const json = (response: Response) => response.json() as Promise<Record<string, string>>;

// Keep the fixture independent of server startup/PORT and the environment.
// Production uses validateAndTouchSession, including its MFA/idle policy.
async function fixtureSession(token: string) {
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
  return session && !session.revokedAt ? session : null;
}
async function request(path: string, method = "GET", body?: unknown, context?: string, login = sessionToken) {
  return fetch(`${origin}${path}`, { method, headers: {
    Authorization: `Bearer ${login}`, "Content-Type": "application/json",
    ...(context ? { "X-Traivo-Workspace": context } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

before(async () => {
  await db.insert(organizationsTable).values(orgIds.map(id => ({ id, name: `Workspace test ${id}`, email: `${id}@example.test` })));
  await db.insert(usersTable).values([
    { id: actor, organizationId: home, name: "Workspace actor", email: `${actor}@example.test`, role: "admin", isPlatformAdmin: true },
    { id: ordinary, organizationId: other, name: "Ordinary admin", email: `${ordinary}@example.test`, role: "admin" },
  ]);
  await db.insert(sessionsTable).values([
    { userId: actor, organizationId: home, tokenHash: hashToken(sessionToken), mfaVerifiedAt: new Date(), expiresAt: new Date(Date.now() + 3600000) },
    { userId: ordinary, organizationId: other, tokenHash: hashToken(ordinaryToken), expiresAt: new Date(Date.now() + 3600000) },
  ]);
  const app = express();
  app.use(express.json(), authMiddleware(fixtureSession), authorizeWrite(), auditMiddleware, requireAuth());
  app.get("/effective-user", (req, res) => res.json(req.user));
  app.use(platformRouter, vehiclesRouter, settingsRouter);
  server = app.listen(0);
  wss = setupWebSocket(server, { startBroadcasts: false, validateSession: fixtureSession });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (wss) {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.delete(supportAccessTable).where(eq(supportAccessTable.actor, actor));
  await db.delete(vehiclesTable).where(inArray(vehiclesTable.organizationId, orgIds));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [actor, ordinary]));
  await db.delete(usersTable).where(inArray(usersTable.id, [actor, ordinary]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [actor, ordinary]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, orgIds));
  await pool.end();
});

test("Superuser creates an empty company and manages it without another identity", async () => {
  const created = await request("/platform/organizations", "POST", { name: `Workspace customer ${actor}`, email: `${actor}-customer@example.test`, operatingMode: "transport" });
  assert.equal(created.status, 201);
  target = (await json(created)).id;
  orgIds.push(target); // registered before any later assertions for teardown
  const entered = await request("/platform/workspace", "POST", { organizationId: target });
  assert.equal(entered.status, 201);
  workspace = (await json(entered)).token;
  const effective = await json(await request("/effective-user", "GET", undefined, workspace));
  assert.equal(effective.id, actor);
  assert.equal(effective.email, `${actor}@example.test`);
  assert.equal(effective.organizationId, target);
  assert.equal(effective.homeOrganizationId, home);
  const [permanent] = await db.select().from(usersTable).where(eq(usersTable.id, actor));
  assert.equal(permanent.organizationId, home);
  assert.equal((await db.select().from(usersTable).where(eq(usersTable.organizationId, target))).length, 0);

  const vehicle = await request("/vehicles", "POST", { organizationId: target, name: "Workspace vehicle",
    licensePlate: "TEST", vehicleType: "fossil", capacityKg: 100, capacityVolume: 5 }, workspace);
  assert.equal(vehicle.status, 201);
  const vehicleId = (await json(vehicle)).id;
  assert.equal((await request(`/vehicles/${vehicleId}`, "PUT", { name: "Updated" }, workspace)).status, 200);
  assert.equal((await request(`/vehicles/${vehicleId}`, "GET", undefined, undefined, ordinaryToken)).status, 404);
  assert.equal((await request(`/organizations/${other}/settings`, "PUT", { operatingMode: "mixed" }, workspace)).status, 404);
  assert.equal((await request(`/organizations/${target}/settings`, "PUT", { operatingMode: "mixed" }, workspace)).status, 200);
  const settings = await json(await request(`/organizations/${target}/settings`, "GET", undefined, workspace));
  assert.equal(settings.operatingMode, "mixed");
  assert.equal((await request(`/vehicles/${vehicleId}`, "DELETE", undefined, workspace)).status, 204);
  const [audit] = await db.select().from(auditLogTable).where(and(eq(auditLogTable.userId, actor), eq(auditLogTable.action, "platform.workspace.enter")));
  assert.equal(audit.resourceId, target);
  assert.equal((audit.diff as { targetOrganizationId: string }).targetOrganizationId, target);
});

test("ordinary admins, forged credentials and cross-target scopes fail closed", async () => {
  assert.equal((await request("/platform/workspace", "POST", { organizationId: target }, undefined, ordinaryToken)).status, 403);
  assert.equal((await request("/effective-user", "GET", undefined, workspace, ordinaryToken)).status, 403);
  assert.equal((await request("/effective-user", "GET", undefined, randomUUID())).status, 403);
  assert.equal((await request(`/vehicles?organizationId=${other}`, "GET", undefined, workspace)).status, 403);
  assert.equal((await request(`/organizations/${target}/settings`, "PUT", { organizationId: other, operatingMode: "transport" }, workspace)).status, 403);
  // A read-only support grant cannot be used for operational access.
  const support = randomUUID();
  await db.insert(supportAccessTable).values({ tokenHash: hashToken(support), actor, session: hashToken(sessionToken),
    target, reason: "workspace: forged reason", expires: new Date(Date.now() + 60000) });
  assert.equal(await resolveWorkspace(support, hashToken(sessionToken), actor), null);
});

test("websocket handshake pins the verified target and denies forged credentials and subscriptions", { timeout: 10000 }, async () => {
  async function connect(context: string, login: string = sessionToken) {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws`, [`workspace.${context}`],
      { headers: { Authorization: `Bearer ${login}` } });
    await once(socket, "open");
    return socket;
  }
  const socket = await connect(workspace);
  const reply = once(socket, "message");
  socket.send(JSON.stringify({ type: "subscribe", organizationId: target }));
  const [raw] = await reply;
  assert.equal(JSON.parse(raw.toString()).organizationId, target);
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ type: "subscribe", organizationId: other }));
  assert.equal((await closed)[0], 1008);
  for (const [context, login] of [[randomUUID(), sessionToken], [workspace, ordinaryToken]]) {
    const denied = await connect(context, login);
    assert.equal((await once(denied, "close"))[0], 1008);
  }
});

test("switch revokes stale tabs and isolates outgoing websocket events", async () => {
  const oldWorkspace = workspace;
  const session = await fixtureSession(sessionToken);
  assert.ok(session);
  const client = { workspaceToken: workspace, sessionToken, sessionId: session.id, userId: actor, organizationId: target } as WsClient;
  assert.equal(await canReceiveTenantEvent(client, fixtureSession), true);
  assert.equal(await canReceiveTenantEvent({ ...client, organizationId: other }, fixtureSession), false);
  const entered = await request("/platform/workspace", "POST", { organizationId: other }, workspace);
  assert.equal(entered.status, 201);
  workspace = (await json(entered)).token;
  assert.equal((await request("/effective-user", "GET", undefined, oldWorkspace)).status, 403);
  assert.equal(await canReceiveTenantEvent(client, fixtureSession), false);
  const left = await request("/platform/workspace", "DELETE", undefined, workspace);
  assert.equal(left.status, 200);
  assert.equal((await request("/effective-user", "GET", undefined, workspace)).status, 403);
  assert.equal((await json(await request("/effective-user"))).organizationId, home);
});

test("expiry and platform privilege revocation deny context on every lookup", async () => {
  const entered = await request("/platform/workspace", "POST", { organizationId: target });
  workspace = (await json(entered)).token;
  await db.update(supportAccessTable).set({ expires: new Date(0) }).where(eq(supportAccessTable.tokenHash, workspaceHash(workspace)));
  assert.equal((await request("/effective-user", "GET", undefined, workspace)).status, 403);
  const fresh = await request("/platform/workspace", "POST", { organizationId: target });
  workspace = (await json(fresh)).token;
  await db.update(usersTable).set({ isPlatformAdmin: false }).where(eq(usersTable.id, actor));
  assert.equal((await request("/effective-user", "GET", undefined, workspace)).status, 403);
});