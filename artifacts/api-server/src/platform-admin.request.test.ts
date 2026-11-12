import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import express from "express";
import { createPlatformSupportRouter } from "./routes/platform-support";
import { authMiddleware, requirePlatformAdmin } from "./middleware/auth";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { db, auditLogTable, organizationsTable, passwordResetTokensTable, sessionsTable, usersTable, supportAccessTable, pool } from "@workspace/db";
import { createSession, validateAndTouchSession, validateSessionWithoutTouch } from "./lib/session";
import { hashPassword } from "./lib/password";
import { collectOrgData } from "./lib/export-service";
import { sendTenantEvent, type WsClient } from "./ws";
import { getEnvConfig } from "./lib/env-config";

const runId = randomUUID();
const organizations = [randomUUID(), randomUUID()];
const users = [randomUUID(), randomUUID(), randomUUID()];
const sessionIds: string[] = [];
const extraOrganizations: string[] = [];
let restoreEmail: () => void;
let server: Server;
let base = "";
let platformToken = "";
let tenantAToken = "";
let tenantBToken = "";
let emailCode = "";

async function request(path: string, token: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Connection: "close", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) as Record<string, any> };
}

test("support summary is audited, session-bound, tenant-isolated and cannot write", async () => {
  assert.equal((await request("/platform/support-access", tenantAToken, "POST", { organizationId: organizations[1], reason: "Support test" })).status, 403);
  const opened = await request("/platform/support-access", platformToken, "POST", { organizationId: organizations[1], reason: "Support test" });
  assert.equal(opened.status, 201);
  const headers = { "X-Support-Access": opened.body.token };
  const summary = await request("/platform/support-access/current", platformToken, "GET", undefined, headers);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.organization.id, organizations[1]);
  assert.equal(summary.body.userCount, 1);
  assert.equal(summary.body.readOnly, true);
  assert.ok(!JSON.stringify(summary.body).includes(`Platform A ${runId}`));
  assert.equal((await request("/platform/support-access/current", tenantBToken, "GET", undefined, headers)).status, 403);
  assert.equal((await request("/platform/support-access/current", platformToken, "PATCH", { name: "changed" }, headers)).status, 403);
  const otherSession = await createSession({ userId: users[0], organizationId: organizations[0] });
  await db.update(sessionsTable).set({ mfaVerifiedAt: new Date() }).where(eq(sessionsTable.id, otherSession.session.id));
  sessionIds.push(otherSession.session.id);
  assert.equal((await request("/platform/support-access/current", otherSession.token, "GET", undefined, headers)).status, 403);
  await db.update(usersTable).set({ isPlatformAdmin: false }).where(eq(usersTable.id, users[0]));
  try {
    assert.equal((await request("/platform/support-access/current", platformToken, "GET", undefined, headers)).status, 403);
  } finally {
    await db.update(usersTable).set({ isPlatformAdmin: true }).where(eq(usersTable.id, users[0]));
  }
  assert.equal((await request("/platform/support-access/current", platformToken, "DELETE", undefined, headers)).status, 200);
  assert.equal((await request("/platform/support-access/current", platformToken, "GET", undefined, headers)).status, 403);
  const events = await db.select().from(auditLogTable).where(and(eq(auditLogTable.userId, users[0]), eq(auditLogTable.resourceId, organizations[1])));
  for (const action of ["platform.support.enter", "platform.support.read", "platform.support.exit"]) assert.ok(events.some(event => event.action === action));
  assert.ok(!JSON.stringify(events).includes(opened.body.token));
  const expiring = await request("/platform/support-access", otherSession.token, "POST", { organizationId: organizations[1], reason: "Expiry test" });
  assert.equal(expiring.status, 201);
  await db.update(supportAccessTable).set({ expires: new Date(Date.now() - 1000) }).where(eq(supportAccessTable.actor, users[0]));
  assert.equal((await request("/platform/support-access/current", otherSession.token, "GET", undefined, { "X-Support-Access": expiring.body.token })).status, 403);
});

test("fresh independent support router reads shared grant and revocation is cross-instance", async () => {
  const brand = await request("/branding", tenantBToken);
  assert.equal(brand.status, 200);
  assert.equal(brand.body.displayName, `Platform B ${runId}`);
  const opened = await request("/platform/support-access", platformToken, "POST", { organizationId: organizations[1], reason: "Shared storage test" });
  assert.equal(opened.status, 201);
  const hash = createHash("sha256").update(opened.body.token).digest("hex");
  const [stored] = await db.select().from(supportAccessTable).where(eq(supportAccessTable.tokenHash, hash));
  assert.equal(stored.target, organizations[1]);
  assert.ok(!JSON.stringify(stored).includes(opened.body.token));
  // Constructed AFTER grant creation: no router-local state can be reused.
  const secondApp = express();
  secondApp.use(express.json(), authMiddleware());
  secondApp.use("/api", requirePlatformAdmin(), createPlatformSupportRouter());
  const second = createServer(secondApp);
  await new Promise<void>(resolve => second.listen(0, "127.0.0.1", resolve));
  const address = second.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/platform/support-access/current`;
  const headers = { Authorization: `Bearer ${platformToken}`, "X-Support-Access": opened.body.token, Connection: "close" };
  try {
    const summary = await fetch(url, { headers });
    assert.equal(summary.status, 200);
    assert.equal(((await summary.json()) as { organization: { id: string } }).organization.id, organizations[1]);
    assert.equal((await fetch(url, { headers, method: "DELETE" })).status, 200);
    assert.equal((await request("/platform/support-access/current", platformToken, "GET", undefined, { "X-Support-Access": opened.body.token })).status, 403);
    assert.equal((await fetch(url, { headers })).status, 403);
  } finally { await new Promise<void>(resolve => second.close(() => resolve())); }
});

before(async () => {
  const originalTestMode = process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
  delete process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
  const originalMfaKey = process.env.PLATFORM_MFA_ENCRYPTION_KEY;
  process.env.PLATFORM_MFA_ENCRYPTION_KEY = "ba".repeat(32);
  const originalProxy = ReplitConnectors.prototype.proxy;
  const originalOrigin = process.env.AUTH_APP_ORIGIN;
  const originalSender = process.env.SENDGRID_FROM_EMAIL;
  process.env.AUTH_APP_ORIGIN = "https://test.example";
  process.env.SENDGRID_FROM_EMAIL = "sender@example.test";
  ReplitConnectors.prototype.proxy = async function (...args) {
    const html = (args[2]?.body as { html?: string } | undefined)?.html;
    const code = html?.match(/>(\d{6})<\/p>/)?.[1];
    if (code) emailCode = code;
    return new Response(null, { status: 202 });
  };
  restoreEmail = () => {
    if (originalTestMode === undefined) delete process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
    else process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = originalTestMode;
    if (originalMfaKey === undefined) delete process.env.PLATFORM_MFA_ENCRYPTION_KEY;
    else process.env.PLATFORM_MFA_ENCRYPTION_KEY = originalMfaKey;
    ReplitConnectors.prototype.proxy = originalProxy;
    if (originalOrigin === undefined) delete process.env.AUTH_APP_ORIGIN;
    else process.env.AUTH_APP_ORIGIN = originalOrigin;
    if (originalSender === undefined) delete process.env.SENDGRID_FROM_EMAIL;
    else process.env.SENDGRID_FROM_EMAIL = originalSender;
  };
  await db.insert(organizationsTable).values([
    { id: organizations[0], name: `Platform A ${runId}`, email: `a-${runId}@example.test` },
    { id: organizations[1], name: `Platform B ${runId}`, email: `b-${runId}@example.test` },
  ]);
  await db.insert(usersTable).values([
    { id: users[0], organizationId: organizations[0], name: `Platform ${runId}`, email: `platform-${runId}@example.test`, role: "admin", isPlatformAdmin: true, passwordHash: await hashPassword("Mfa-fixture-password-1") },
    { id: users[1], organizationId: organizations[0], name: `Admin A ${runId}`, email: `admin-a-${runId}@example.test`, role: "admin" },
    { id: users[2], organizationId: organizations[1], name: `Admin B ${runId}`, email: `admin-b-${runId}@example.test`, role: "admin" },
  ]);
  const tokens = await Promise.all(users.map(async (userId, index) => {
    const { token, session } = await createSession({ userId, organizationId: organizations[index === 2 ? 1 : 0] });
    sessionIds.push(session.id);
    return token;
  }));
  [platformToken, tenantAToken, tenantBToken] = tokens;
  // Existing platform authorization fixtures represent an MFA-verified session.
  await db.update(sessionsTable).set({ mfaVerifiedAt: new Date() }).where(eq(sessionsTable.userId, users[0]));
  // This multi-flow suite shares one IP and exceeds the normal 100-request budget.
  // Change only the limiter constructed for this isolated test app.
  const config = getEnvConfig();
  const originalLimit = config.RATE_LIMIT_MAX;
  config.RATE_LIMIT_MAX = 500;
  let app;
  try { app = (await import("./app")).default; }
  finally { config.RATE_LIMIT_MAX = originalLimit; }
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

test("temporary password-only mode preserves authorization, recovery, locks and live session policy", async () => {
  const credentials = { email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1" };
  process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = "true";
  try {
    assert.equal((await request("/auth/login", "", "POST", { ...credentials, password: "wrong" })).status, 401);
    const login = await request("/auth/login", "", "POST", credentials);
    assert.equal(login.status, 200);
    assert.equal(login.body.mfaRequired, undefined);
    assert.equal(login.body.user.platformPasswordOnlyTestMode, true);
    const token = login.body.token;
    assert.ok(token);
    const passwordSession = await validateSessionWithoutTouch(token);
    assert.ok(passwordSession);
    assert.equal(passwordSession.mfaVerifiedAt, null);
    let sent = 0;
    let closed = 0;
    const client = {
      ws: { readyState: 1, send: (_message: string, done: () => void) => { sent++; done(); }, close: () => { closed++; } },
      sessionId: passwordSession.id, sessionToken: token, userId: users[0],
      organizationId: organizations[0], role: "admin", driverProfileId: null, driverVehicleId: null,
    } as unknown as WsClient;
    await sendTenantEvent(client, "test event");
    assert.equal(sent, 1);
    assert.equal(closed, 0);
    assert.equal((await request("/auth/me", token)).body.user.platformPasswordOnlyTestMode, true);
    assert.equal((await request("/platform/organizations", token)).status, 200);
    assert.equal((await request("/platform/organizations", tenantAToken)).status, 403);
    const tenantUsers = await request("/app-users", token);
    assert.equal(tenantUsers.status, 200);
    assert.ok(!(tenantUsers.body as unknown as Array<{ id: string }>).some(user => user.id === users[2]));
    for (const field of ["lockedUntil", "mfaLockedUntil"] as const) {
      await db.update(usersTable).set({ [field]: new Date(Date.now() + 60_000) }).where(eq(usersTable.id, users[0]));
      assert.equal((await request("/auth/login", "", "POST", credentials)).status, 423);
      assert.equal(await validateAndTouchSession(token), null);
      assert.equal(await validateSessionWithoutTouch(token), null);
      await db.update(usersTable).set({ [field]: null }).where(eq(usersTable.id, users[0]));
    }
    await db.update(usersTable).set({ mfaRecoveryRequired: true }).where(eq(usersTable.id, users[0]));
    assert.equal((await request("/auth/login", "", "POST", credentials)).body.code, "PLATFORM_MFA_RECOVERY_REQUIRED");
    assert.equal((await request("/auth/me", token)).status, 401);
    assert.equal((await request("/platform/organizations", token)).status, 401);
    assert.equal(await validateSessionWithoutTouch(token), null);
    await db.update(usersTable).set({ mfaRecoveryRequired: false }).where(eq(usersTable.id, users[0]));
    process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = "false";
    assert.equal((await request("/auth/me", token)).status, 401);
    assert.equal((await request("/platform/organizations", token)).status, 401);
    assert.equal((await request("/app-users", token)).status, 401);
    assert.equal(await validateAndTouchSession(token), null);
    assert.equal(await validateSessionWithoutTouch(token), null);
    assert.equal((await request("/auth/login", "", "POST", credentials)).body.mfaRequired, true);
    await sendTenantEvent(client, "must not send");
    assert.equal(sent, 1);
    assert.equal(closed, 1);
    // Genuine MFA sessions continue to work after the test mode is disabled.
    assert.equal((await request("/platform/organizations", platformToken)).status, 200);
  } finally {
    delete process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
    await db.update(usersTable).set({ mfaRecoveryRequired: false, lockedUntil: null, mfaLockedUntil: null })
      .where(eq(usersTable.id, users[0]));
  }
});

test("platform login requires email MFA and rejects replay and authenticator enrollment", async () => {
  await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, users[0]));
  const login = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.mfaRequired, true);
  assert.equal(login.body.enrollmentRequired, false);
  assert.equal(login.body.token, undefined);
  const setCookie = login.headers.get("set-cookie") ?? "";
  const pendingToken = decodeURIComponent(setCookie.match(/routeai_session=([^;]+)/)?.[1] ?? "");
  assert.ok(pendingToken);
  assert.equal((await request("/auth/me", pendingToken)).status, 401);
  assert.equal((await request("/platform/organizations", pendingToken)).status, 401);
  assert.equal((await request("/auth/mfa/status", pendingToken)).body.enrollmentRequired, false);
  const competing = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  assert.equal(competing.status, 429);
  const start = await request("/auth/mfa/enroll", pendingToken, "POST");
  assert.equal(start.status, 410);
  assert.equal(start.headers.get("cache-control"), "no-store");
  const wrong = await request("/auth/mfa/verify", pendingToken, "POST", { code: "not-valid" });
  assert.equal(wrong.status, 400);
  const code = emailCode;
  const verified = await request("/auth/mfa/verify", pendingToken, "POST", { code });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.recoveryCodes, undefined);
  assert.equal((await request("/platform/organizations", pendingToken)).status, 200);
  assert.equal((await request("/auth/me", platformToken)).status, 200);
  const appUsers = await request("/app-users", pendingToken);
  assert.equal(appUsers.status, 200);
  const listedPlatform = (appUsers.body as unknown as Array<Record<string, unknown>>)
    .find(entry => entry.id === users[0]);
  assert.ok(listedPlatform);
  for (const secretName of ["mfaSecret", "mfaPendingSecret", "mfaPendingSessionId", "mfaLastStep",
    "mfaRecoveryHashes", "mfaFailedAttempts", "mfaFailureWindowStartedAt", "mfaLockedUntil"])
    assert.equal(Object.hasOwn(listedPlatform, secretName), false, secretName);
  const exportedPlatform = (await collectOrgData(organizations[0])).tables.users
    .find(entry => entry.id === users[0]);
  assert.ok(exportedPlatform);
  for (const secretName of ["mfaSecret", "mfaPendingSecret", "mfaPendingSessionId", "mfaLastStep",
    "mfaRecoveryHashes", "mfaFailedAttempts", "mfaFailureWindowStartedAt", "mfaLockedUntil"])
    assert.equal(Object.hasOwn(exportedPlatform, secretName), false, `export: ${secretName}`);
  assert.equal((await request("/auth/mfa/verify", pendingToken, "POST", { code })).status, 401);
  await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, users[0]));
  const second = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  const secondToken = decodeURIComponent((second.headers.get("set-cookie") ?? "").match(/routeai_session=([^;]+)/)?.[1] ?? "");
  assert.equal(second.body.enrollmentRequired, false);
  if (code !== emailCode) assert.equal((await request("/auth/mfa/verify", secondToken, "POST", { code })).status, 401);
  const recovery = emailCode;
  const redeemed = await request("/auth/mfa/verify", secondToken, "POST", { code: emailCode });
  assert.equal(redeemed.status, 200);
  await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, users[0]));
  const third = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  const thirdToken = decodeURIComponent((third.headers.get("set-cookie") ?? "").match(/routeai_session=([^;]+)/)?.[1] ?? "");
  if (recovery !== emailCode) assert.equal((await request("/auth/mfa/verify", thirdToken, "POST", { code: recovery })).status, 401);
  await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, users[0]));
  const fourth = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  const fourthToken = decodeURIComponent((fourth.headers.get("set-cookie") ?? "").match(/routeai_session=([^;]+)/)?.[1] ?? "");
  const concurrent = await Promise.all([fourthToken, fourthToken].map(token =>
    request("/auth/mfa/verify", token, "POST", { code: emailCode })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 401]);
  await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, users[0]));
  const expired = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  const expiredToken = decodeURIComponent((expired.headers.get("set-cookie") ?? "").match(/routeai_session=([^;]+)/)?.[1] ?? "");
  const [expiringSession] = await db.select({ id: sessionsTable.id }).from(sessionsTable).where(eq(sessionsTable.tokenHash, createHash("sha256").update(expiredToken).digest("hex")));
  await db.update(sessionsTable).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(sessionsTable.id, expiringSession.id));
  assert.equal((await request("/auth/mfa/verify", expiredToken, "POST", { code: emailCode })).status, 401);
  const challengeTokens: string[] = [];
  const wrongCodes = new Map<string, string>();
  for (let i = 0; i < 2; i++) {
    await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, users[0]));
    const attempt = await request("/auth/login", "", "POST", {
      email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
    });
    challengeTokens.push(decodeURIComponent((attempt.headers.get("set-cookie") ?? "").match(/routeai_session=([^;]+)/)?.[1] ?? ""));
    wrongCodes.set(challengeTokens.at(-1)!, String((Number(emailCode) + 1) % 1_000_000).padStart(6, "0"));
  }
  for (const token of challengeTokens) {
    for (let i = 0; i < 4; i++) {
      assert.equal((await request("/auth/mfa/verify", token, "POST", { code: wrongCodes.get(token) })).status, 401);
    }
  }
  const lockedAttempt = await request("/auth/login", "", "POST", {
    email: `platform-${runId}@example.test`, password: "Mfa-fixture-password-1",
  });
  const lockedToken = decodeURIComponent((lockedAttempt.headers.get("set-cookie") ?? "").match(/routeai_session=([^;]+)/)?.[1] ?? "");
  assert.equal((await request("/auth/mfa/status", lockedToken)).status, 401);
  await db.update(usersTable).set({ mfaLockedUntil: null, mfaFailedAttempts: 0, mfaFailureWindowStartedAt: null })
    .where(eq(usersTable.id, users[0]));
  const active = await createSession({ userId: users[0], organizationId: organizations[0] });
  sessionIds.push(active.session.id);
  await db.update(sessionsTable).set({ mfaVerifiedAt: new Date() }).where(eq(sessionsTable.id, active.session.id));
  platformToken = active.token;
});

after(async () => {
  restoreEmail?.();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  const ids = [...organizations, ...extraOrganizations];
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, ids));
  await db.delete(sessionsTable).where(inArray(sessionsTable.organizationId, ids));
  await db.delete(passwordResetTokensTable).where(inArray(passwordResetTokensTable.userId,
    db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.organizationId, ids))));
  await db.delete(usersTable).where(inArray(usersTable.organizationId, ids));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, ids));
  await pool.end();
});

test("tenant admins cannot list, create, invite, edit, or reset across organizations", async () => {
  for (const token of [tenantAToken, tenantBToken]) {
    assert.equal((await request(`/platform/security-events/${randomUUID()}/check-delivery`, token, "POST", {})).status, 403);
    for (const [path, method] of [["/platform/cuopt/status", "GET"], ["/platform/cuopt/test-connection", "POST"]] as const) {
      const deniedCuopt = await request(path, token, method);
      assert.equal(deniedCuopt.status, 403);
    }
    const path = `/platform/organizations/${organizations[1]}/users`;
    const denied = await Promise.all([
      request("/platform/organizations", token),
      request("/platform/organizations", token, "POST", { name: "Forbidden", email: "x@example.test" }),
      request(`/platform/organizations/${organizations[1]}`, token, "PATCH", { name: "Forbidden" }),
      request(path, token),
      request(path, token, "POST", { name: "Forbidden", email: "x@example.test", role: "admin" }),
      request(`${path}/${users[2]}`, token, "PATCH", { role: "viewer" }),
      request(`${path}/${users[2]}/reset-password`, token, "POST"),
    ]);
    for (const result of denied) {
      assert.equal(result.status, 403);
      assert.equal(JSON.stringify(result.body).includes(`Admin B ${runId}`), false);
    }
  }
  assert.equal((await request(`/users/${users[2]}`, tenantAToken)).status, 404);
  assert.equal((await request(`/app-users/${users[0]}`, tenantAToken, "PUT", { password: "Takeover-123" })).status, 403);
  assert.equal((await request(`/app-users/${users[0]}`, tenantAToken, "DELETE")).status, 403);
});

test("Traivo-only security and provider costs reject tenant roles and expose no cross-tenant data", async () => {
  const privatePaths = [
    "/platform/security-events",
    "/platform/usage/rates",
    `/platform/organizations/${organizations[1]}/usage?month=2026-01`,
    "/platform/cuopt/status",
    "/platform/organizations",
  ];
  for (const token of [tenantAToken, tenantBToken]) {
    for (const path of privatePaths) assert.equal((await request(path, token)).status, 403, path);
    assert.equal((await request("/platform/usage/rates", token, "PUT", {
      provider: "forbidden", operation: "forbidden", effectiveFrom: "2026-01-01T00:00:00Z", unitCostOre: 1,
    })).status, 403);
  }
  for (const role of ["dispatcher", "viewer"] as const) {
    await db.update(usersTable).set({ role }).where(eq(usersTable.id, users[1]));
    try {
      for (const path of privatePaths) assert.equal((await request(path, tenantAToken)).status, 403, `${role} ${path}`);
    } finally {
      await db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, users[1]));
    }
  }
  const audit = await request("/platform/security-events", platformToken);
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.body.items));
  assert.ok(audit.body.items.every((item: { action: string }) => item.action.startsWith("platform.")));
  assert.equal((await request("/platform/usage/rates", platformToken)).status, 200);
});

test("platform code delivery lookup is scoped to recorded sends and stores only evidence", async () => {
  const eventId = randomUUID(), providerId = randomUUID(), attemptId = randomUUID();
  const original = ReplitConnectors.prototype.proxy;
  let lookups = 0;
  await db.insert(auditLogTable).values({
    id: eventId, userId: users[0], organizationId: null, action: "platform.email_code.accepted",
    resourceType: "auth", resourceId: attemptId, method: "SYSTEM", path: "/platform/email-code",
    metadata: { providerId },
  });
  ReplitConnectors.prototype.proxy = async (_connector, path, options) => {
    lookups++;
    assert.equal(path, `/emails/${providerId}`);
    assert.equal(options?.method, "GET");
    return new Response(JSON.stringify({ id: providerId, last_event: "delivered", html: "DO_NOT_LOG" }));
  };
  try {
    assert.equal((await request(`/platform/security-events/${eventId}/check-delivery`, tenantAToken, "POST", {})).status, 403);
    assert.equal(lookups, 0);
    assert.equal((await request(`/platform/security-events/${randomUUID()}/check-delivery`, platformToken, "POST", {})).status, 404);
    assert.equal(lookups, 0);
    const result = await request(`/platform/security-events/${eventId}/check-delivery`, platformToken, "POST", {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { outcome: "delivered" });
    const events = await db.select().from(auditLogTable).where(eq(auditLogTable.resourceId, attemptId));
    assert.ok(events.some(event => event.action === "platform.email_code.delivered"));
    assert.ok(events.every(event => event.organizationId === null));
    assert.equal(JSON.stringify(events).includes("DO_NOT_LOG"), false);
  } finally {
    ReplitConnectors.prototype.proxy = original;
    await db.delete(auditLogTable).where(eq(auditLogTable.resourceId, attemptId));
  }
});

test("organization contact edit validates inputs, preserves identity and branding, and audits tenant-scoped changes", async () => {
  const path = `/platform/organizations/${organizations[1]}`;
  const original = (await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizations[1])))[0];
  const originalUser = (await db.select().from(usersTable).where(eq(usersTable.id, users[2])))[0];
  for (const [target, body] of [
    [path, {}], [path, { name: "  " }], [path, { email: "not-an-email" }],
    [path, { operatingMode: "invalid" }], [path, { name: "N".repeat(201) }],
    [path, { notifyDelivered: true }], [path, { name: "Valid", notifyDelivered: true }],
    ["/platform/organizations/not-a-uuid", { name: "Invalid" }],
  ] as const) assert.equal((await request(target, platformToken, "PATCH", body)).status, 400);
  assert.equal((await request(`/platform/organizations/${randomUUID()}`, platformToken, "PATCH", { name: "Missing" })).status, 404);
  try {
    // Rename the default branding along with the legal name.
    await db.update(organizationsTable).set({ brandDisplayName: original.name }).where(eq(organizationsTable.id, original.id));
    const updated = await request(path, platformToken, "PATCH", {
      name: `  Changed ${runId}  `, email: `  CONTACT-${runId}@EXAMPLE.TEST  `, operatingMode: "mixed",
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.id, original.id);
    assert.equal(updated.body.name, `Changed ${runId}`);
    assert.equal(updated.body.email, `contact-${runId}@example.test`);
    assert.equal(updated.body.operatingMode, "mixed");
    const [stored] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, original.id));
    assert.equal(stored.brandDisplayName, updated.body.name);
    assert.equal((await request(`/platform/organizations?search=${encodeURIComponent(`Changed ${runId}`)}`, platformToken)).body.items[0].id, original.id);
    assert.equal((await request(`/platform/organizations/${original.id}/users`, platformToken)).body[0].email, originalUser.email);
    assert.equal((await request("/branding", tenantBToken)).body.displayName, updated.body.name);
    const [audit] = await db.select().from(auditLogTable).where(and(eq(auditLogTable.action, "platform.organization.update"), eq(auditLogTable.resourceId, original.id)));
    assert.equal((audit.diff as Record<string, any>).targetOrganizationId, original.id);
    assert.equal((audit.diff as Record<string, any>).email.to, updated.body.email);
    assert.ok(!JSON.stringify(audit).includes("password"));

    // A deliberate customer-facing brand is not replaced by later legal-name edits.
    await db.update(organizationsTable).set({ brandDisplayName: "Custom customer brand" }).where(eq(organizationsTable.id, original.id));
    assert.equal((await request(path, platformToken, "PATCH", { name: "New legal name" })).status, 200);
    const [branded] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, original.id));
    assert.equal(branded.brandDisplayName, "Custom customer brand");
    assert.equal((await request(`/platform/organizations/${organizations[0]}/users`, tenantBToken)).status, 403);
  } finally {
    await db.update(organizationsTable).set({
      name: original.name, email: original.email, operatingMode: original.operatingMode,
      brandDisplayName: original.brandDisplayName,
    }).where(eq(organizationsTable.id, original.id));
  }
});

test("platform administrator can page/search companies and manage only the selected organization's users", async () => {
  const cuoptStatus = await request("/platform/cuopt/status", platformToken);
  assert.equal(cuoptStatus.status, 200);
  assert.equal(typeof cuoptStatus.body.keyPresent, "boolean");
  assert.equal(cuoptStatus.body.message.includes("NVIDIA_CUOPT_API_KEY"), false);
  const page = await request(`/platform/organizations?search=${encodeURIComponent(runId)}&page=1&pageSize=1`, platformToken);
  assert.equal(page.status, 200);
  assert.equal(page.body.total, 2);
  assert.equal(page.body.items.length, 1);
  const second = await request(`/platform/organizations?search=${encodeURIComponent(runId)}&page=2&pageSize=1`, platformToken);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.items[0].id, page.body.items[0].id);

  const created = await request("/platform/organizations", platformToken, "POST", {
    name: `New ${runId}`, email: `new-${runId}@example.test`, operatingMode: "field_service",
  });
  assert.equal(created.status, 201);
  extraOrganizations.push(created.body.id);
  assert.equal(created.body.operatingMode, "field_service");
  assert.equal((await request(`/platform/organizations/${organizations[1]}/users`, platformToken)).body[0].name, `Admin B ${runId}`);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users`, platformToken)).body.length, 2);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users/${users[2]}`, platformToken, "PATCH", { role: "viewer" })).status, 404);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users/${users[2]}/reset-password`, platformToken, "POST")).status, 404);
  assert.equal((await request(`/platform/organizations/${organizations[1]}/users/${users[2]}`, platformToken, "PATCH", { role: "viewer" })).status, 409);
  const updated = await request(`/platform/organizations/${organizations[1]}/users/${users[2]}`, platformToken, "PATCH", { name: `Updated B ${runId}` });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.role, "admin");
  assert.equal(updated.body.isPlatformAdmin, false);
  assert.equal((await request(`/platform/organizations/${organizations[1]}/users`, tenantAToken)).status, 403);
  const [audit] = await db.select().from(auditLogTable).where(and(
    eq(auditLogTable.organizationId, organizations[0]), eq(auditLogTable.action, "platform.user.update"),
    eq(auditLogTable.resourceId, users[2]),
  ));
  assert.equal((audit.diff as Record<string, any>).targetOrganizationId, organizations[1]);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users/${users[0]}`, platformToken, "PATCH", { role: "viewer" })).status, 403);
});

test("invitations and reset links remain scoped to the selected organization and never return credentials", async () => {
  const email = `invited-${runId}@example.test`;
  const invite = await request(`/platform/organizations/${organizations[1]}/users`, platformToken, "POST", {
    name: `Invited ${runId}`, email, role: "dispatcher", isPlatformAdmin: true, password: "ignored",
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.equal(invite.body.isPlatformAdmin, false);
  assert.equal(JSON.stringify(invite.body).includes("password"), false);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users/${invite.body.id}/reset-password`, platformToken, "POST")).status, 404);
  const reset = await request(`/platform/organizations/${organizations[1]}/users/${invite.body.id}/reset-password`, platformToken, "POST");
  assert.equal(reset.status, 202, JSON.stringify(reset.body));
  assert.equal(JSON.stringify(reset.body).includes("token"), false);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users`, tenantAToken)).status, 403);
  assert.equal((await request(`/app-users/${invite.body.id}`, tenantAToken, "PUT", { role: "admin" })).status, 404);
  const [stored] = await db.select().from(usersTable).where(eq(usersTable.id, invite.body.id));
  assert.equal(stored.passwordHash, null);
  const tokens = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, invite.body.id));
  assert.equal(tokens.length, 2);
  assert.ok(tokens[0].usedAt || tokens[1].usedAt);
});

test("company profile survives reload, clears optional values, and cannot cross tenant boundary", async () => {
  const details = { registrationNumber: "TEST-123", contactPerson: "Test contact", phone: "+46000",
    street: "Test street", postalCode: "12345", city: "Test city", country: "Test country", invoiceEmail: `invoice-${runId}@example.test` };
  const created = await request("/platform/organizations", platformToken, "POST", {
    name: `Profile ${runId}`, email: `profile-${runId}@example.test`, companyDetails: details,
  });
  assert.equal(created.status, 201);
  extraOrganizations.push(created.body.id);
  assert.deepEqual(created.body.companyDetails, details);
  const path = `/platform/organizations/${created.body.id}`;
  assert.equal((await request(path, tenantAToken, "PATCH", { companyDetails: { city: "Forbidden" } })).status, 403);
  assert.equal((await request(path, platformToken, "PATCH", { companyDetails: { invoiceEmail: "bad" } })).status, 400);
  const saved = await request(path, platformToken, "PATCH", { companyDetails: { ...details, phone: null } });
  assert.equal(saved.status, 200);
  const reloaded = await request(`/platform/organizations?search=${encodeURIComponent(`Profile ${runId}`)}`, platformToken);
  assert.deepEqual(reloaded.body.items[0].companyDetails, { ...details, phone: null });
  assert.equal((await request(`/platform/organizations/${randomUUID()}`, platformToken, "PATCH", { companyDetails: details })).status, 404);
});

test("login changes enforce global uniqueness, revoke credentials, and disabling denies old sessions and login", async () => {
  const id = randomUUID();
  const email = `identity-${runId}@example.test`;
  const password = `Test-password-${runId}`;
  await db.insert(usersTable).values({ id, organizationId: organizations[1], name: "Identity test", email,
    role: "dispatcher", passwordHash: await hashPassword(password) });
  const path = `/platform/organizations/${organizations[1]}/users/${id}`;
  const otherPath = `/platform/organizations/${organizations[0]}/users/${id}`;
  const [other] = await db.select().from(usersTable).where(eq(usersTable.id, users[1]));
  assert.equal((await request(path, tenantAToken, "PATCH", { email: "forbidden@example.test" })).status, 403);
  assert.equal((await request(otherPath, platformToken, "PATCH", { name: "Wrong tenant" })).status, 404);
  assert.equal((await request(path, platformToken, "PATCH", { email: other.email.toUpperCase() })).status, 409);
  assert.equal((await request(`/platform/organizations/${organizations[1]}/users`, platformToken, "POST", {
    name: "Duplicate login", email: other.email.toUpperCase(), role: "dispatcher",
  })).status, 409);
  const session = await createSession({ userId: id, organizationId: organizations[1] });
  await db.insert(passwordResetTokensTable).values({ userId: id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
  const changedEmail = `changed-${runId}@example.test`;
  const changed = await request(path, platformToken, "PATCH", { email: changedEmail.toUpperCase(), name: "Changed" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.email, changedEmail);
  assert.equal(JSON.stringify(changed.body).includes("password"), false);
  const [oldSession] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, session.session.id));
  assert.ok(oldSession.revokedAt);
  const resets = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, id));
  assert.ok(resets.every(token => token.usedAt));
  assert.equal((await request("/auth/me", session.token)).status, 401);
  assert.equal((await request("/auth/login", "", "POST", { email, password })).status, 401);
  assert.equal((await request("/auth/login", "", "POST", { email: changedEmail.toUpperCase(), password })).status, 200);
  const newSession = await createSession({ userId: id, organizationId: organizations[1] });
  assert.equal((await request(path, platformToken, "PATCH", { isActive: false })).status, 200);
  assert.equal((await request("/auth/me", newSession.token)).status, 401);
  assert.equal((await request("/auth/login", "", "POST", { email: changedEmail, password })).status, 401);
  assert.equal((await request(`${path}/reset-password`, platformToken, "POST")).status, 403);
  assert.equal((await request(path, platformToken, "PATCH", { isActive: true })).status, 200);
  assert.equal((await request("/auth/login", "", "POST", { email: changedEmail, password })).status, 200);
  // Even a pre-existing, unrevoked session cannot bypass a fresh disabled flag.
  const fresh = await createSession({ userId: id, organizationId: organizations[1] });
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, id));
  assert.equal((await request("/auth/me", fresh.token)).status, 401);
  assert.equal((await request(`/platform/organizations/${organizations[1]}/users/${users[2]}`, platformToken, "PATCH", { isActive: false })).status, 409);
  assert.equal((await request(`/platform/organizations/${organizations[0]}/users/${users[0]}`, platformToken, "PATCH", { email: changedEmail })).status, 403);
});

test("concurrent admin demotions cannot remove the last active administrator", async () => {
  const org = randomUUID();
  extraOrganizations.push(org);
  await db.insert(organizationsTable).values({ id: org, name: `Race ${runId}`, email: `race-${runId}@example.test` });
  const ids = [randomUUID(), randomUUID()];
  await db.insert(usersTable).values(ids.map((id, i) => ({
    id, organizationId: org, name: `Admin ${i}`, email: `race-${i}-${runId}@example.test`, role: "admin" as const,
  })));
  const results = await Promise.all(ids.map(id => request(`/platform/organizations/${org}/users/${id}`, platformToken, "PATCH", { role: "viewer" })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const remaining = await db.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.role, "admin"), eq(usersTable.isActive, true)));
  assert.equal(remaining.length, 1);
});