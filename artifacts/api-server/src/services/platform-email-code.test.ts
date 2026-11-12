import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { db, usersTable, organizationsTable, sessionsTable, auditLogTable } from "@workspace/db";
import { createAuthRouter, hashPassword } from "../routes/auth";
import { sendPlatformEmailCode } from "./platform-email-code";

test("password plus email: single-use, session binding, expiry, resend, provider failure and account lockout", async () => {
  // This synthetic tenant never sends real messages or changes existing accounts.
  const organizationId = randomUUID(), userId = randomUUID();
  const email = `email-code-${userId}@example.invalid`;
  const password = randomUUID();
  const previousMode = process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
  process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = "false";
  let latestCode = "", sends = 0, mailWorks = true;
  const app = express();
  app.use(express.json(), cookieParser());
  app.use("/api", createAuthRouter(id => sendPlatformEmailCode(id, async payload => {
    sends++;
    assert.equal(payload.to, email);
    latestCode = payload.html.match(/>(\d{6})<\/p>/)![1];
    return { outcome: mailWorks ? "accepted" : "rejected" };
  })));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const request = async (path: string, cookie = "", body?: object) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json().catch(() => null),
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const allowSend = () => db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) })
    .where(eq(sessionsTable.userId, userId));
  const login = () => request("login", "", { email, password });
  try {
    await db.insert(organizationsTable).values({ id: organizationId, name: "Isolated email MFA acceptance", email });
    await db.insert(usersTable).values({ id: userId, organizationId, name: "Synthetic operator", email,
      role: "admin", isPlatformAdmin: true, passwordHash: await hashPassword(password) });
    assert.equal((await request("login", "", { email, password: "wrong" })).status, 401);
    assert.equal(sends, 0);
    const first = await login();
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { mfaRequired: true, enrollmentRequired: false });
    const diagnostics = (await db.select().from(auditLogTable).where(eq(auditLogTable.userId, userId)))
      .filter(entry => entry.action.startsWith("platform.email_code."));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].action, "platform.email_code.accepted");
    assert.equal(diagnostics[0].organizationId, null, "tenant audit queries must not see code diagnostics");
    assert.equal(diagnostics[0].userEmail, null);
    assert.equal(JSON.stringify(diagnostics).includes(latestCode), false);
    assert.equal(JSON.stringify(diagnostics).includes(password), false);
    assert.equal((await request("me", first.cookie)).status, 401);
    assert.equal((await request("mfa/enroll", first.cookie, {})).status, 410);
    const [stored] = await db.select().from(sessionsTable).where(eq(sessionsTable.userId, userId));
    assert.notEqual(stored.mfaEmailCodeHash, latestCode);
    const consumed = await Promise.all([1, 2].map(() => request("mfa/verify", first.cookie, { code: latestCode })));
    assert.deepEqual(consumed.map(result => result.status).sort(), [200, 401]);
    const verifiedBody = consumed.find(result => result.status === 200)!.body as { token: string; user: { id: string } };
    assert.equal(verifiedBody.token, decodeURIComponent(first.cookie.split("=")[1]));
    assert.equal(verifiedBody.user.id, userId);
    const rejectedBody = consumed.find(result => result.status === 401)!.body as Record<string, unknown>;
    assert.equal(rejectedBody.token, undefined);
    assert.equal((await request("me", first.cookie)).status, 200);
    assert.equal((await request("mfa/verify", first.cookie, { code: latestCode })).status, 401);

    await allowSend();
    const second = await login();
    assert.equal(second.status, 200);
    const oldCode = latestCode;
    assert.equal((await request("mfa/resend", second.cookie, {})).status, 429);
    assert.equal((await login()).status, 429, "fresh sessions cannot bypass account send throttle");
    await allowSend();
    assert.equal((await request("mfa/resend", second.cookie, {})).status, 204);
    // A fresh challenge may randomly equal the previous six digits; avoid a probabilistic assertion.
    if (oldCode !== latestCode)
      assert.equal((await request("mfa/verify", second.cookie, { code: oldCode })).status, 401);
    assert.equal((await request("mfa/verify", first.cookie, { code: latestCode })).status, 401);
    assert.equal((await request("mfa/verify", second.cookie, { code: latestCode })).status, 200);

    await allowSend(); mailWorks = false;
    const failedMail = await login();
    assert.equal(failedMail.status, 503);
    assert.equal((await request("mfa/verify", failedMail.cookie, { code: latestCode })).status, 401);
    mailWorks = true; await allowSend();
    const expired = await login();
    await db.update(sessionsTable).set({ mfaEmailExpiresAt: new Date(Date.now() - 1000) }).where(eq(sessionsTable.userId, userId));
    assert.equal((await request("mfa/verify", expired.cookie, { code: latestCode })).status, 401);

    await allowSend();
    const changedEmail = await login();
    await db.update(usersTable).set({ email: `changed-${email}` }).where(eq(usersTable.id, userId));
    assert.equal((await request("mfa/verify", changedEmail.cookie, { code: latestCode })).status, 401);
    await db.update(usersTable).set({ email }).where(eq(usersTable.id, userId));
    await allowSend();
    const revoked = await login();
    await db.update(sessionsTable).set({ revokedAt: new Date() }).where(eq(sessionsTable.userId, userId));
    assert.equal((await request("mfa/verify", revoked.cookie, { code: latestCode })).status, 401);

    await allowSend();
    await db.update(usersTable).set({ mfaFailedAttempts: 0, mfaFailureWindowStartedAt: null }).where(eq(usersTable.id, userId));
    const locked = await login();
    const badCode = String((Number(latestCode) + 1) % 1_000_000).padStart(6, "0");
    for (let attempt = 0; attempt < 8; attempt++)
      assert.equal((await request("mfa/verify", locked.cookie, { code: badCode })).status, 401);
    assert.equal((await request("mfa/verify", locked.cookie, { code: latestCode })).status, 401);
    assert.equal((await login()).status, 423);
  } finally {
    server.close(); await once(server, "close");
    await db.delete(auditLogTable).where(eq(auditLogTable.userId, userId));
    await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    if (previousMode === undefined) delete process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
    else process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = previousMode;
  }
});
