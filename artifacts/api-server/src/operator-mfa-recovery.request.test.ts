import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, mock } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable, usersTable, sessionsTable, passwordResetTokensTable, supportAccessTable, auditLogTable, platformMfaRecoveryGrantsTable as grants } from "@workspace/db";
import app from "./app";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { issueOperatorRecovery, redeemOperatorRecovery, requireOperatorRecoveryPolicy } from "./lib/platform-mfa-recovery";
import { createSession, hashToken, validateAndTouchSession } from "./lib/session";
import { hashPassword } from "./lib/password";
import { encryptMfaSecret, hashRecoveryCode, newMfaSecret, totpAt } from "./lib/platform-mfa";
import { resetPassword } from "./lib/password-recovery";
import { getEnvConfig } from "./lib/env-config";
import { collectOrgData } from "./lib/export-service";

test("offline recovery: fail closed, revocation, restricted enrollment, replay, replacement and reset races", async () => {
  assert.equal(process.env.NODE_ENV, "test", "Disposable fixtures must never run in production");
  const org = randomUUID(), id = randomUUID(), email = `operator-recovery-${id}@example.test`;
  const password = "Disposable-test-password-112!";
  const oldSecret = newMfaSecret();
  const tempDir = await mkdtemp(join(tmpdir(), "operator-recovery-test-"));
  const envPolicy = process.env.PLATFORM_MFA_RECOVERY_POLICY;
  const envKey = process.env.PLATFORM_MFA_ENCRYPTION_KEY;
  process.env.PLATFORM_MFA_ENCRYPTION_KEY = "ab".repeat(32);
  let emailCode = "";
  const originalProxy = ReplitConnectors.prototype.proxy;
  ReplitConnectors.prototype.proxy = async function (...args) {
    emailCode = (args[2]?.body as { html: string }).html.match(/>(\d{6})<\/p>/)![1];
    return new Response(null, { status: 202 });
  };
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const request = async (path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth${path}`, { method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), Connection: "close" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: res.status === 204 ? {} : await res.json() as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  const issue = async () => {
    let token = "";
    const result = await issueOperatorRecovery({ userId: id, expectedEmail: email.toUpperCase(),
      operatorRef: "test-operator", incidentRef: "TEST-112", confirmation: "REVOKE-AND-REQUIRE-MFA" },
    async value => { token = value; });
    return { token, ...result };
  };
  try {
    await db.insert(organizationsTable).values({ id: org, name: "Disposable operator recovery test", email });
    await db.insert(usersTable).values({ id, organizationId: org, name: "Disposable operator",
      email, passwordHash: await hashPassword(password), role: "admin", isPlatformAdmin: true,
      mfaSecret: encryptMfaSecret(oldSecret), mfaRecoveryHashes: [hashRecoveryCode("old-code-112")] });
    for (const policy of [undefined, "disabled", "hardware", "OPERATOR"]) {
      if (policy === undefined) delete process.env.PLATFORM_MFA_RECOVERY_POLICY;
      else process.env.PLATFORM_MFA_RECOVERY_POLICY = policy;
      assert.throws(requireOperatorRecoveryPolicy);
      await assert.rejects(issue);
    }
    process.env.PLATFORM_MFA_RECOVERY_POLICY = "operator";
    // Guard-only production-mode probes: neither may reach a transaction.
    const blockedTransaction = mock.method(db, "transaction", async () => { throw new Error("Unexpected database access"); });
    try {
      process.env.NODE_ENV = "production";
      await assert.rejects(issue, /Explicit production confirmation required/);
      await assert.rejects(() => issueOperatorRecovery({
        userId: id, expectedEmail: email, operatorRef: "test", incidentRef: "TEST",
        confirmation: "REVOKE-AND-REQUIRE-MFA", productionConfirmation: `PRODUCTION:${randomUUID()}`,
      }, async () => { assert.fail("must not deliver"); }), /Explicit production confirmation required/);
      assert.equal(blockedTransaction.mock.callCount(), 0);
    } finally {
      process.env.NODE_ENV = "test";
      blockedTransaction.mock.restore();
    }
    await db.update(usersTable).set({ isPlatformAdmin: false }).where(eq(usersTable.id, id));
    try { await assert.rejects(issue, /Active platform account/); }
    finally { await db.update(usersTable).set({ isPlatformAdmin: true }).where(eq(usersTable.id, id)); }
    const original = await createSession({ userId: id, organizationId: org });
    await db.update(sessionsTable).set({ mfaVerifiedAt: new Date() }).where(eq(sessionsTable.id, original.session.id));
    await db.insert(passwordResetTokensTable).values({ userId: id, tokenHash: hashToken("reset-before"),
      expiresAt: new Date(Date.now() + 60_000) });
    await db.insert(supportAccessTable).values({ actor: id, session: hashToken(original.token), tokenHash: hashToken("support"),
      target: org, reason: "fixture", expires: new Date(Date.now() + 60_000) });
    // Failed protected-file delivery must not alter the account.
    await assert.rejects(() => issueOperatorRecovery({ userId: id, expectedEmail: email, operatorRef: "test",
      incidentRef: "TEST", confirmation: "REVOKE-AND-REQUIRE-MFA" }, async () => { throw new Error("disk full"); }));
    assert.ok(await validateAndTouchSession(original.token));
    // Fail the audit insert after revocations/secret removal, proving the entire
    // real database transaction rolls back and the token is never delivered.
    const realTransaction = db.transaction.bind(db);
    const auditFailure = mock.method(db, "transaction", (async (callback) => realTransaction(async tx => {
      const realInsert = tx.insert.bind(tx);
      const insertFailure = mock.method(tx, "insert", ((table) => {
        if (Object.is(table, auditLogTable)) throw new Error("Injected audit failure");
        return realInsert(table);
      }) as typeof tx.insert);
      try { return await callback(tx); }
      finally { insertFailure.mock.restore(); }
    })) as typeof db.transaction);
    try { await assert.rejects(issue, /Injected audit failure/); }
    finally { auditFailure.mock.restore(); }
    assert.ok(await validateAndTouchSession(original.token));
    const [unchanged] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(unchanged.mfaRecoveryRequired, false);
    assert.ok(unchanged.mfaSecret);
    assert.equal((await db.select().from(grants).where(eq(grants.userId, id))).length, 0);
    assert.equal((await db.select().from(supportAccessTable).where(eq(supportAccessTable.actor, id))).length, 1);
    const [unchangedReset] = await db.select().from(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, id));
    assert.equal(unchangedReset.usedAt, null);
    const first = await issue();
    assert.match(first.token, /^[a-f0-9]{64}$/);
    assert.equal(await validateAndTouchSession(original.token), null);
    assert.equal((await db.select().from(supportAccessTable).where(eq(supportAccessTable.actor, id))).length, 0);
    assert.equal(await resetPassword("reset-before", password), false);
    await assert.rejects(() => createSession({ userId: id, organizationId: org }));
    assert.equal((await request("/login", { email, password })).status, 401);
    assert.equal(await redeemOperatorRecovery(email, "wrong", first.token), null);
    // Expiry never clears the persisted gate.
    await db.update(grants).set({ expiresAt: new Date(0) }).where(eq(grants.id, first.grantId));
    assert.equal(await redeemOperatorRecovery(email, password, first.token), null);
    await assert.rejects(() => createSession({ userId: id, organizationId: org }));
    const second = await issue();
    assert.equal(await redeemOperatorRecovery(email, password, first.token), null);
    const redeemed = await request("/mfa/operator-recovery", { email, password, recoveryToken: second.token });
    assert.equal(redeemed.status, 200);
    assert.deepEqual(redeemed.body, { mfaRequired: true, enrollmentRequired: false });
    assert.ok(redeemed.cookie);
    assert.equal(await redeemOperatorRecovery(email, password, second.token), null);
    assert.equal((await request("/me", undefined, redeemed.cookie)).status, 401);
    assert.equal((await request("/mfa/verify", { code: "old-code-112" }, redeemed.cookie)).status, 400);
    assert.equal((await request("/mfa/verify", { code: totpAt(oldSecret, Math.floor(Date.now() / 30_000)) }, redeemed.cookie)).status, 401);
    const enrolled = await request("/mfa/enroll", {}, redeemed.cookie);
    assert.equal(enrolled.status, 410);
    const previousCode = emailCode;
    process.env.PLATFORM_MFA_RECOVERY_POLICY = "future-policy";
    assert.equal((await request("/mfa/verify", { code: previousCode }, redeemed.cookie)).status, 503);
    process.env.PLATFORM_MFA_RECOVERY_POLICY = "operator";
    const third = await issue();
    assert.equal((await request("/mfa/verify", { code: previousCode }, redeemed.cookie)).status, 401);
    // Reset after approval revokes enrollment sessions but cannot remove the gate.
    await db.insert(passwordResetTokensTable).values({ userId: id, tokenHash: hashToken("reset-after"),
      expiresAt: new Date(Date.now() + 60_000) });
    assert.equal(await resetPassword("reset-after", password), true);
    await assert.rejects(() => createSession({ userId: id, organizationId: org }));
    const [a, b] = await Promise.all([redeemOperatorRecovery(email, password, third.token), redeemOperatorRecovery(email, password, third.token)]);
    assert.equal([a, b].filter(Boolean).length, 1, "single-use under concurrent redemption");
    const cookie = `routeai_session=${a || b}`;
    await db.update(sessionsTable).set({ mfaEmailSentAt: new Date(Date.now() - 61_000) }).where(eq(sessionsTable.userId, id));
    const fresh = await request("/mfa/resend", {}, cookie);
    assert.equal(fresh.status, 204);
    const code = emailCode;
    const verified = await request("/mfa/verify", { code }, cookie);
    assert.equal(verified.status, 200);
    assert.equal(verified.body.recoveryCodes, undefined);
    assert.equal((await request("/me", undefined, cookie)).status, 200);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.equal(user.mfaRecoveryRequired, false);
    assert.equal(user.mfaLastStep, null);
    assert.equal((await request("/mfa/verify", { code }, cookie)).status, 401);
    const events = await db.select().from(auditLogTable).where(eq(auditLogTable.userId, id));
    for (const action of ["approved", "replaced", "redeemed", "failed", "completed"])
      assert.ok(events.some(e => e.action === `platform.mfa.operator_recovery.${action}`), action);
    for (const secret of [first.token, second.token, third.token, password, code])
      assert.ok(!JSON.stringify(events).includes(secret));
    assert.ok(!("mfaRecoveryRequired" in verified.body.user));
    // The actual offline entrypoint writes exclusively with owner-only permissions.
    const tokenFile = join(tempDir, "grant");
    const cliArgs = ["exec", "tsx", "src/cli/platform-mfa-recovery.ts", "--user-id", id,
      "--expected-email", email, "--operator-ref", "test-cli", "--incident-ref", "TEST-CLI",
      "--confirm", "REVOKE-AND-REQUIRE-MFA", "--token-file", tokenFile];
    const output = await promisify(execFile)("pnpm", cliArgs, { env: process.env });
    const cliToken = (await readFile(tokenFile, "utf8")).trim();
    assert.match(cliToken, /^[a-f0-9]{64}$/);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.ok(!output.stdout.includes(cliToken) && !output.stderr.includes(cliToken));
    await assert.rejects(() => promisify(execFile)("pnpm", cliArgs, { env: process.env }));
    assert.equal((await readFile(tokenFile, "utf8")).trim(), cliToken, "existing file is never overwritten");
    for (let i = 0; i < getEnvConfig().ACCOUNT_LOCKOUT_THRESHOLD; i++)
      assert.equal(await redeemOperatorRecovery(email, "incorrect", cliToken), null);
    assert.equal(await redeemOperatorRecovery(email, password, cliToken), null, "lockout applies even to a valid grant");
    const [locked] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    assert.ok(locked.lockedUntil && locked.lockedUntil.getTime() > Date.now());
    const exported = JSON.stringify(await collectOrgData(org));
    assert.ok(!exported.includes("mfaRecoveryRequired"));
    assert.ok(!exported.includes(cliToken));
    assert.ok(!exported.includes("expectedEmail"));
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/mfa/operator-recovery`, {
        method: "POST", headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ email, password, recoveryToken: "0".repeat(64) }),
      });
      if (res.status === 429) limited = true;
      await res.text();
    }
    assert.ok(limited, "HTTP recovery endpoint is rate limited");
  } finally {
    ReplitConnectors.prototype.proxy = originalProxy;
    process.env.NODE_ENV = "test";
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.delete(supportAccessTable).where(eq(supportAccessTable.actor, id));
    await db.delete(grants).where(eq(grants.userId, id));
    await db.delete(passwordResetTokensTable).where(eq(passwordResetTokensTable.userId, id));
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, id));
    await db.delete(auditLogTable).where(eq(auditLogTable.userId, id));
    await db.delete(usersTable).where(eq(usersTable.id, id));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org));
    if (envPolicy === undefined) delete process.env.PLATFORM_MFA_RECOVERY_POLICY; else process.env.PLATFORM_MFA_RECOVERY_POLICY = envPolicy;
    if (envKey === undefined) delete process.env.PLATFORM_MFA_ENCRYPTION_KEY; else process.env.PLATFORM_MFA_ENCRYPTION_KEY = envKey;
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});