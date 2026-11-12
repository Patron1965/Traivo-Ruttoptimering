import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Express } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  db,
  driversTable,
  organizationsTable,
  passwordResetTokensTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { ensureBootstrapAdmin } from "./lib/bootstrap-admin";
import { issuePasswordReset } from "./lib/password-recovery";
import { hashPassword } from "./lib/password";
import { hashToken, onSessionRevoked, createSession, validateAndTouchSession } from "./lib/session";

const runId = randomUUID();
const organizationIds = [randomUUID(), randomUUID()];
const adminIds = [randomUUID(), randomUUID()];
const driverIds = [randomUUID(), randomUUID(), randomUUID()];
const createdUserIds: string[] = [];
const createdSessionIds: string[] = [];
const tokenValues = {
  current: `reset-current-${runId}`,
  previous: `reset-previous-${runId}`,
};

let app: Express;
let server: Server;
let baseUrl = "";
let adminToken = "";
let otherAdminToken = "";
let userPasswordHash = "";
let connectorCalls = 0;
let restoreConnector: (() => void) | undefined;
let stopSessionListener: (() => void) | undefined;
const revokedSessionIds = new Set<string>();

function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

async function request(path: string, init: RequestInit = {}, token = adminToken): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  headers.set("Connection", "close");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

function body(value: unknown): string {
  return JSON.stringify(value);
}

async function createAdminSession(userId: string, organizationId: string): Promise<string> {
  const session = await createSession({
    userId,
    organizationId,
    userAgent: "auth-recovery-regression-test",
  });
  createdSessionIds.push(session.session.id);
  return session.token;
}

before(async () => {
  // These values intentionally point to test-only data. The connector proxy
  // is stubbed below, so this suite never sends an email.
  process.env.AUTH_APP_ORIGIN = "https://auth-recovery-tests.example";
  process.env.SENDGRID_FROM_EMAIL = "verified-test-sender@example.test";
  process.env.SENDGRID_FROM_NAME = "Auth recovery tests";

  const originalProxy = ReplitConnectors.prototype.proxy;
  ReplitConnectors.prototype.proxy = async function () {
    connectorCalls += 1;
    return new Response(null, { status: 500 });
  };
  restoreConnector = () => {
    ReplitConnectors.prototype.proxy = originalProxy;
  };

  await db.insert(organizationsTable).values([
    { id: organizationIds[0], name: `Auth recovery A ${runId}`, email: `org-a-${runId}@example.test` },
    { id: organizationIds[1], name: `Auth recovery B ${runId}`, email: `org-b-${runId}@example.test` },
  ]);
  userPasswordHash = await hashPassword("Initial-password-1");
  await db.insert(usersTable).values([
    {
      id: adminIds[0],
      organizationId: organizationIds[0],
      name: "Recovery admin A",
      email: `admin-a-${runId}@example.test`,
      role: "admin",
      passwordHash: userPasswordHash,
    },
    {
      id: adminIds[1],
      organizationId: organizationIds[1],
      name: "Recovery admin B",
      email: `admin-b-${runId}@example.test`,
      role: "admin",
      passwordHash: userPasswordHash,
    },
  ]);
  await db.insert(driversTable).values([
    {
      id: driverIds[0],
      organizationId: organizationIds[0],
      name: "Driver A",
      email: `driver-a-${runId}@example.test`,
    },
    {
      id: driverIds[1],
      organizationId: organizationIds[1],
      name: "Driver B",
      email: `driver-b-${runId}@example.test`,
    },
    {
      id: driverIds[2],
      organizationId: organizationIds[0],
      name: "Driver C",
      email: `driver-c-${runId}@example.test`,
    },
  ]);

  adminToken = await createAdminSession(adminIds[0], organizationIds[0]);
  otherAdminToken = await createAdminSession(adminIds[1], organizationIds[1]);
  stopSessionListener = onSessionRevoked((sessionId) => revokedSessionIds.add(sessionId));

  ({ default: app } = await import("./app"));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  restoreConnector?.();
  stopSessionListener?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await db.delete(passwordResetTokensTable).where(
    inArray(passwordResetTokensTable.userId, [...adminIds, ...createdUserIds]),
  );
  await db.delete(sessionsTable).where(
    inArray(sessionsTable.id, createdSessionIds),
  );
  await db.delete(usersTable).where(
    inArray(usersTable.id, [...adminIds, ...createdUserIds]),
  );
  await db.delete(driversTable).where(inArray(driversTable.id, driverIds));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
});

test("forgot-password is public, generic for unknown/known delivery failures, and explicit when config is missing", async () => {
  const known = await request("/api/auth/forgot-password", {
    method: "POST",
    body: body({ email: `admin-a-${runId}@example.test` }),
  }, "");
  const unknown = await request("/api/auth/forgot-password", {
    method: "POST",
    body: body({ email: `nobody-${runId}@example.test` }),
  }, "");

  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await jsonBody(known), await jsonBody(unknown));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(connectorCalls, 1, "unknown addresses must not invoke SendGrid");

  const previousSender = process.env.SENDGRID_FROM_EMAIL;
  process.env.SENDGRID_FROM_EMAIL = "";
  const missingKnown = await request("/api/auth/forgot-password", {
    method: "POST",
    body: body({ email: `admin-a-${runId}@example.test` }),
  }, "");
  const missingUnknown = await request("/api/auth/forgot-password", {
    method: "POST",
    body: body({ email: `nobody-${runId}@example.test` }),
  }, "");
  assert.equal(missingKnown.status, 503);
  assert.equal(missingUnknown.status, 503);
  assert.deepEqual(await jsonBody(missingKnown), await jsonBody(missingUnknown));
  process.env.SENDGRID_FROM_EMAIL = previousSender;
});

test("reset-password is single-use, expires, invalidates older links, and revokes sessions/websockets", async () => {
  const now = new Date();
  await db.insert(passwordResetTokensTable).values([
    {
      userId: adminIds[0],
      tokenHash: hashToken(tokenValues.current),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    },
    {
      userId: adminIds[0],
      tokenHash: hashToken(tokenValues.previous),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    },
  ]);
  const sessionA = await createSession({ userId: adminIds[0], organizationId: organizationIds[0] });
  const sessionB = await createSession({ userId: adminIds[0], organizationId: organizationIds[0] });
  createdSessionIds.push(sessionA.session.id, sessionB.session.id);

  const reset = await request("/api/auth/reset-password", {
    method: "POST",
    body: body({ token: tokenValues.current, password: "New-password-2" }),
  }, "");
  assert.equal(reset.status, 200);
  assert.equal(typeof (await jsonBody(reset)).message, "string");
  assert.equal(await validateAndTouchSession(sessionA.token), null);
  assert.equal(await validateAndTouchSession(sessionB.token), null);
  assert.ok(await validateAndTouchSession(otherAdminToken));
  assert.equal(revokedSessionIds.has(sessionA.session.id), true);
  assert.equal(revokedSessionIds.has(sessionB.session.id), true);

  const replay = await request("/api/auth/reset-password", {
    method: "POST",
    body: body({ token: tokenValues.current, password: "New-password-3" }),
  }, "");
  assert.equal(replay.status, 400);
  const oldLink = await request("/api/auth/reset-password", {
    method: "POST",
    body: body({ token: tokenValues.previous, password: "New-password-3" }),
  }, "");
  assert.equal(oldLink.status, 400);

  const expiredToken = `expired-${runId}`;
  await db.insert(passwordResetTokensTable).values({
    userId: adminIds[1],
    tokenHash: hashToken(expiredToken),
    expiresAt: new Date(Date.now() - 1),
  });
  const expired = await request("/api/auth/reset-password", {
    method: "POST",
    body: body({ token: expiredToken, password: "New-password-3" }),
  }, "");
  assert.equal(expired.status, 400);

  // The reset intentionally revoked the fixture admin's original session;
  // obtain a fresh bearer session before exercising admin surfaces.
  adminToken = await createAdminSession(adminIds[0], organizationIds[0]);
});

test("admin driver linking is org-scoped, unique under concurrency, and unlinking self preserves admin role", async () => {
  const first = await request("/api/app-users", {
    method: "POST",
    body: body({
      name: `Linked A ${runId}`,
      email: `linked-a-${runId}@example.test`,
      role: "driver",
      password: "Driver-password-1",
    }),
  });
  assert.equal(first.status, 201);
  const firstUser = await jsonBody(first);
  const firstUserId = String(firstUser.id);
  createdUserIds.push(firstUserId);

  const crossOrg = await request(`/api/app-users/${firstUserId}/driver-link`, {
    method: "POST",
    body: body({ driverProfileId: driverIds[1] }),
  });
  assert.equal(crossOrg.status, 404);

  const second = await request("/api/app-users", {
    method: "POST",
    body: body({
      name: `Linked B ${runId}`,
      email: `linked-b-${runId}@example.test`,
      role: "driver",
      password: "Driver-password-1",
    }),
  });
  assert.equal(second.status, 201);
  const secondUserId = String((await jsonBody(second)).id);
  createdUserIds.push(secondUserId);

  const concurrent = await Promise.all([
    request(`/api/app-users/${firstUserId}/driver-link`, {
      method: "POST",
      body: body({ driverProfileId: driverIds[0] }),
    }),
    request(`/api/app-users/${secondUserId}/driver-link`, {
      method: "POST",
      body: body({ driverProfileId: driverIds[0] }),
    }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);

  const selfLink = await request(`/api/app-users/${adminIds[0]}/driver-link`, {
    method: "POST",
    body: body({ driverProfileId: driverIds[2] }),
  });
  assert.equal(selfLink.status, 200);
  const selfUnlink = await request(`/api/app-users/${adminIds[0]}/driver-link`, {
    method: "DELETE",
  });
  assert.equal(selfUnlink.status, 200);
  const users = await request("/api/app-users");
  assert.equal(users.status, 200);
  const admin = (await users.json() as Array<Record<string, unknown>>)
    .find((candidate) => candidate.id === adminIds[0]);
  assert.equal(admin?.role, "admin");
  assert.equal(admin?.driverProfileId, null);
});

test("concurrent tenant creates and edits reserve normalized login emails globally", async () => {
  const normalized = `collision-${runId}@example.test`;
  const create = (token: string, email: string) => request("/api/app-users", {
    method: "POST", body: body({ name: "Collision test", email, role: "dispatcher" }),
  }, token);
  const attempts = await Promise.all([
    create(adminToken, `  ${normalized.toUpperCase()}  `),
    create(otherAdminToken, normalized),
  ]);
  assert.deepEqual(attempts.map((response) => response.status).sort(), [201, 409]);
  for (const response of attempts) {
    if (response.status === 201) createdUserIds.push(String((await jsonBody(response)).id));
  }

  const first = await create(adminToken, `edit-a-${runId}@example.test`);
  const second = await create(otherAdminToken, `edit-b-${runId}@example.test`);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstId = String((await jsonBody(first)).id);
  const secondId = String((await jsonBody(second)).id);
  createdUserIds.push(firstId, secondId);
  const target = `edit-shared-${runId}@example.test`;
  const edit = (token: string, id: string, email: string) => request(`/api/app-users/${id}`, {
    method: "PUT", body: body({ email }),
  }, token);
  const edited = await Promise.all([
    edit(adminToken, firstId, ` ${target.toUpperCase()} `),
    edit(otherAdminToken, secondId, target),
  ]);
  assert.deepEqual(edited.map((response) => response.status).sort(), [200, 409]);
  const matching = await db.select({ id: usersTable.id }).from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${target}`);
  assert.equal(matching.length, 1);
  assert.equal((await edit(adminToken, firstId, ` ${normalized} `)).status, 409);
  // A disabled identity still owns the login identifier.
  const [owner] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(sql`lower(trim(${usersTable.email})) = ${normalized}`);
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, owner.id));
  assert.equal((await create(otherAdminToken, normalized)).status, 409);
});

test("unique login succeeds and existing duplicate identities fail closed for login, recovery, reset, and bootstrap", async () => {
  const positive = await request("/api/auth/login", {
    method: "POST", body: body({ email: `ADMIN-B-${runId}@EXAMPLE.TEST`, password: "Initial-password-1" }),
  }, "");
  assert.equal(positive.status, 200);
  const response = await jsonBody(positive);
  assert.equal((response.user as { id: string }).id, adminIds[1]);
  if (typeof response.token === "string") {
    const session = await validateAndTouchSession(response.token);
    if (session) createdSessionIds.push(session.id);
  }

  const index = await db.execute(sql`select 1 from pg_indexes where schemaname = 'public' and tablename = 'users' and indexname = 'users_login_email_unique'`);
  assert.equal(index.rows.length, 0, "development schema must not have the deferred unique index");

  const email = `ambiguous-${runId}@example.test`;
  const ids = [randomUUID(), randomUUID()];
  createdUserIds.push(...ids);
  await db.insert(usersTable).values([
    { id: ids[0], organizationId: organizationIds[0], name: "Account A", email,
      role: "admin", passwordHash: userPasswordHash },
    { id: ids[1], organizationId: organizationIds[0], name: "Account B", email: ` ${email.toUpperCase()} `,
      role: "admin", isPlatformAdmin: true, passwordHash: userPasswordHash },
  ]);
  const login = await request("/api/auth/login", {
    method: "POST", body: body({ email, password: "Initial-password-1" }),
  }, "");
  assert.equal(login.status, 401);
  const callsBefore = connectorCalls;
  const forgot = await request("/api/auth/forgot-password", {
    method: "POST", body: body({ email }),
  }, "");
  assert.equal(forgot.status, 202);
  assert.equal(connectorCalls, callsBefore);
  assert.equal(await issuePasswordReset(email, { userId: ids[0], waitForDelivery: true }), false);
  assert.equal(connectorCalls, callsBefore);
  const resetToken = `ambiguous-reset-${runId}`;
  await db.insert(passwordResetTokensTable).values({
    userId: ids[0], tokenHash: hashToken(resetToken), expiresAt: new Date(Date.now() + 60_000),
  });
  const reset = await request("/api/auth/reset-password", {
    method: "POST", body: body({ token: resetToken, password: "Another-Password-1" }),
  }, "");
  assert.equal(reset.status, 400);
  const stored = await db.select({ usedAt: passwordResetTokensTable.usedAt }).from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.tokenHash, hashToken(resetToken)));
  assert.equal(stored[0]?.usedAt, null);

  const previous = {
    enabled: process.env.ENABLE_BOOTSTRAP_ADMIN,
    email: process.env.BOOTSTRAP_ADMIN_PUBLIC_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    orgId: process.env.BOOTSTRAP_ORGANIZATION_ID,
    orgName: process.env.BOOTSTRAP_ORGANIZATION_NAME,
  };
  try {
    process.env.ENABLE_BOOTSTRAP_ADMIN = "true";
    process.env.BOOTSTRAP_ADMIN_PUBLIC_EMAIL = email;
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "Test-only-password-1";
    process.env.BOOTSTRAP_ORGANIZATION_ID = organizationIds[0];
    delete process.env.BOOTSTRAP_ORGANIZATION_NAME;
    await ensureBootstrapAdmin();
    const unchanged = await db.select({ passwordHash: usersTable.passwordHash }).from(usersTable)
      .where(eq(usersTable.id, ids[1]));
    assert.equal(unchanged[0]?.passwordHash, userPasswordHash);
  } finally {
    for (const [key, value] of Object.entries({
      ENABLE_BOOTSTRAP_ADMIN: previous.enabled,
      BOOTSTRAP_ADMIN_PUBLIC_EMAIL: previous.email,
      BOOTSTRAP_ADMIN_PASSWORD: previous.password,
      BOOTSTRAP_ORGANIZATION_ID: previous.orgId,
      BOOTSTRAP_ORGANIZATION_NAME: previous.orgName,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});