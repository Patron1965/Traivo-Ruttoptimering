import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadConfig, PILOT_CONTROL_IDS, REPLIT_PILOT_CONTROL_IDS } from "./config.ts";
import { JsonLogger } from "./logger.ts";
import { loadPostgresSettings } from "./postgres-config.ts";
import { PostgresAuthStore, type SqlClient } from "./postgres-store.ts";
import { POSTGRES_SCHEMA } from "./postgres-schema.ts";
import { assessHealth, assessPilotRouteAccess } from "./readiness.ts";
import type { AuthTransaction, HealthcareIdentity } from "./types.ts";

// Fixed test keys and identities below are synthetic, never deployment credentials.
const sessionKey = Buffer.alloc(32, 1).toString("base64");
const auditKey = Buffer.alloc(32, 2).toString("base64");
const sessionKey2 = Buffer.alloc(32, 3).toString("base64");
const auditKey2 = Buffer.alloc(32, 4).toString("base64");
const env = {
  NODE_ENV: "production", PORT: "3000", BASE_PATH: "/",
  SITHS_STORE_BACKEND: "postgres", SITHS_BOOTSTRAP_ONLY: "true",
  SITHS_OIDC_PROFILE: "region-stockholm-test",
  SITHS_EXPECTED_REPLIT_PROJECT_ID: "synthetic-target", REPL_ID: "synthetic-target",
  DATABASE_URL: "postgresql://synthetic:synthetic@db.example/synthetic",
  SITHS_SESSION_KEY: sessionKey, SITHS_AUDIT_KEY: auditKey, SITHS_AUDIT_RETENTION_DAYS: "7",
};
const config = loadConfig(env, "synthetic-source");
const logs: string[] = [];
const targetLogger = new JsonLogger((line) => logs.push(line));
const identity: HealthcareIdentity = {
  hsaId: "SE-SYNTHETIC-HSA-TEST", loa: "synthetic-loa",
  issuer: "https://synthetic.example", authenticatedAt: new Date().toISOString(),
  assignments: [{
    id: "synthetic-assignment", careProviderId: "synthetic-provider", careProviderName: "Synthetic",
    organizationalUnitId: "synthetic-unit", organizationalUnitName: "Synthetic unit",
    purpose: "synthetic-test", startsAt: null, endsAt: null,
  }],
};
let directory: string;
let database: PGlite;
let ddlCalls = 0;
const sql: SqlClient = {
  async query(statement, parameters) {
    if (statement === POSTGRES_SCHEMA) {
      ddlCalls++;
      await database.exec(statement);
      return { rows: [] };
    }
    const result = await database.query<Record<string, unknown>>(statement, parameters);
    return { rows: result.rows };
  },
};
const makeStore = (settings = config) => new PostgresAuthStore(settings, sql, targetLogger);

test.before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "siths-pg-test-"));
  database = new PGlite(directory);
  await makeStore().initialize();
});
test.after(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });

test("Replit PostgreSQL rejects the originating/shared project before database access", () => {
  assert.throws(() => loadConfig(env, null), /separate Replit project/);
  assert.throws(() => loadConfig(env, "synthetic-target"), /separate Replit project/);
  assert.throws(() => loadConfig({ ...env, REPL_ID: "another-project" }, "synthetic-source"), /separate Replit project/);
  assert.throws(() => loadConfig({ ...env, SITHS_SESSION_KEY: "" }, "synthetic-source"), /32-byte keys/);
  assert.throws(() => loadConfig({ ...env, SITHS_AUDIT_KEY: sessionKey }, "synthetic-source"), /independent keys/);
  assert.throws(() => loadConfig({ ...env, SITHS_SESSION_PREVIOUS_KEYS: "invalid" }, "synthetic-source"), /32-byte keys/);
  assert.equal(new URL(config.postgres!.databaseUrl).searchParams.get("sslmode"), "verify-full");
  assert.throws(() => loadPostgresSettings({ ...env, DATABASE_URL: "https://db.example" }, "synthetic-source"), /DATABASE_URL/);
});

test("Replit bootstrap is technically healthy but cannot authenticate, even with synthetic approvals", () => {
  const probe = { ok: true, backend: "postgres" as const, region: null };
  assert.equal(assessHealth(config, probe), true);
  assert.equal(config.devHarnessEnabled, false);
  assert.equal(config.oidcConfigured, false);
  assert.equal(assessPilotRouteAccess(config, probe).ready, false);
  const evidence = (controls: readonly string[]) => JSON.stringify({
    version: 1,
    approvals: controls.map((controlId) => ({
      controlId, status: "approved", evidenceId: "synthetic-evidence",
      owner: "synthetic-owner", verifiedAt: "2026-10-13T00:00:00.000Z",
    })),
  });
  const approvedBootstrap = loadConfig({
    ...env, SITHS_READINESS_EVIDENCE_MANIFEST: evidence(REPLIT_PILOT_CONTROL_IDS),
  }, "synthetic-source");
  assert.equal(approvedBootstrap.missingPilotControlIds.length, 0);
  assert.equal(assessPilotRouteAccess(approvedBootstrap, probe).ready, false);
  const awsEvidence = loadConfig({
    ...env, SITHS_READINESS_EVIDENCE_MANIFEST: evidence(PILOT_CONTROL_IDS),
  }, "synthetic-source");
  assert.deepEqual(awsEvidence.missingPilotControlIds, [
    "isolated-replit-project-geography-verified", "region-service-agreement-approved",
  ]);
  assert.throws(() => loadConfig({ ...env, SITHS_OIDC_CLIENT_ID: "synthetic" }, "synthetic-source"), /incomplete|Bootstrap/);
  assert.throws(() => loadConfig({ ...env, SITHS_BOOTSTRAP_ONLY: "false" }, "synthetic-source"), /fail-closed/);
  assert.throws(() => loadConfig({ ...env, SITHS_STORE_BACKEND: "memory" }, "synthetic-source"), /Bootstrap/);
});

test("PostgreSQL refuses populated non-SITHS databases before applying schema", async () => {
  const before = ddlCalls;
  await database.exec("CREATE TABLE public.synthetic_other_customer (id integer)");
  try {
    await assert.rejects(makeStore().initialize(), /DATABASE_NOT_DEDICATED/);
    assert.equal(ddlCalls, before);
    assert.equal((await makeStore().probe()).ok, false);
  } finally {
    await database.exec("DROP TABLE public.synthetic_other_customer");
  }
  assert.equal((await makeStore().probe()).ok, true);
});

test("Encrypted sessions survive database/store restart and expose no identity or opaque ID in stored rows", async () => {
  const session = await makeStore().createSession(identity, identity.assignments[0]!, "restart-test");
  const rows = await database.query("SELECT * FROM siths_federation.auth");
  const serialized = JSON.stringify(rows.rows);
  assert.ok(!serialized.includes(identity.hsaId));
  assert.ok(!serialized.includes(session.id));
  assert.ok(!serialized.includes("synthetic-assignment"));
  await database.close();
  database = new PGlite(directory);
  assert.deepEqual(await makeStore().getSession(session.id), session);
  await makeStore().deleteSession(session.id);
  assert.equal(await makeStore().getSession(session.id), null);
});

test("Browser-bound transactions and pending identities have a single winner across stores", async () => {
  const now = Date.now();
  const transaction: AuthTransaction = {
    state: "synthetic-state", nonce: "synthetic-nonce", pkceVerifier: "synthetic-pkce",
    browserBindingHash: "synthetic-binding", redirectUri: "https://test.example/api/siths/callback",
    returnPath: "/", correlationId: "synthetic-correlation", expiresAt: now + 300_000,
  };
  const first = makeStore();
  const second = makeStore();
  await first.putTransaction(transaction);
  assert.equal(await second.consumeTransaction(transaction.state, "wrong-binding"), null);
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    (i % 2 ? first : second).consumeTransaction(transaction.state, transaction.browserBindingHash)));
  assert.equal(attempts.filter(Boolean).length, 1);
  const pending = await first.createPending(identity, "pending-test");
  assert.deepEqual(await second.getPending(pending.id), pending);
  const pendingAttempts = await Promise.all([
    first.consumePending(pending.id), second.consumePending(pending.id),
  ]);
  assert.equal(pendingAttempts.filter(Boolean).length, 1);
  assert.equal(await second.getPending(pending.id), null);
  const expired = { ...transaction, state: "synthetic-expired", expiresAt: now - 1 };
  await first.putTransaction(expired);
  assert.equal(await second.consumeTransaction(expired.state, expired.browserBindingHash), null);
});

test("Token replay protection is atomic across instances and retains the clock-skew window", async () => {
  const now = Math.floor(Date.now() / 1000);
  const attempts = await Promise.all(Array.from({ length: 12 }, () =>
    makeStore().claimTokenReplay("synthetic-hash", now + 300, now)));
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(await makeStore().claimTokenReplay("synthetic-skew", now - 5, now), true);
  assert.equal(await makeStore().claimTokenReplay("synthetic-skew", now - 5, now + 1), false);
  assert.equal(await makeStore().claimTokenReplay("synthetic-too-old", now - 31, now), false);
});

test("Session ciphertext and expiry changes fail closed; expiry logs once across instances", async () => {
  const session = await makeStore().createSession(identity, identity.assignments[0]!, "tamper-test");
  const key = `session:${createHash("sha256").update(session.id).digest("hex")}`;
  await database.query("UPDATE siths_federation.auth SET expires_at=expires_at+60000 WHERE record_key=$1", [key]);
  await assert.rejects(makeStore().getSession(session.id), /INTEGRITY_INVALID/);
  await makeStore().deleteSession(session.id);
  const expired = await makeStore().createSession(
    identity, identity.assignments[0]!, "expiry-test", Date.now() - config.sessionTtlMs - 1,
  );
  await Promise.all([makeStore().getSession(expired.id), makeStore().getSession(expired.id)]);
  const events = await makeStore().listAuditForCorrelation("expiry-test");
  assert.equal(events.filter((event) => event.eventType === "session_expired").length, 1);
});

test("Audit is correlation-scoped, sanitized and protected against update/delete/truncate", async () => {
  const store = makeStore();
  const one = await store.appendAudit("login_started", "informational", null, "audit-test");
  await store.appendAudit("logout", "success", null, "audit-other");
  const two = await store.appendAudit("logout", "success", null, "audit-test", Date.now() + 1);
  assert.deepEqual((await store.listAuditForCorrelation("audit-test")).map((event) => event.id), [two.id, one.id]);
  assert.ok(!logs.join("\n").includes(identity.hsaId));
  await assert.rejects(database.query("UPDATE siths_federation.audit SET mac='tampered' WHERE id=$1", [one.id]), /AUDIT_APPEND_ONLY/);
  await assert.rejects(database.query("DELETE FROM siths_federation.audit WHERE id=$1", [one.id]), /RETENTION_NOT_REACHED/);
  await assert.rejects(database.exec("TRUNCATE siths_federation.audit"), /AUDIT_APPEND_ONLY/);
  // Approved synthetic tamper test in the embedded fixture only, never a live database.
  await database.exec("ALTER TABLE siths_federation.audit DISABLE TRIGGER audit_mutation_guard");
  try {
    await database.query("UPDATE siths_federation.audit SET mac='tampered' WHERE id=$1", [one.id]);
  } finally {
    await database.exec("ALTER TABLE siths_federation.audit ENABLE TRIGGER audit_mutation_guard");
  }
  await assert.rejects(store.listAuditForCorrelation("audit-test"), /AUDIT_INTEGRITY_INVALID/);
});

test("Key rotation reads retained keys and fails closed when verification/decryption keys are removed", async () => {
  const original = makeStore();
  const session = await original.createSession(identity, identity.assignments[0]!, "rotation-test");
  const audit = await original.appendAudit("login_started", "informational", null, "rotation-test");
  const rotatedConfig = {
    ...config,
    postgres: { ...config.postgres!, sessionKeys: [sessionKey2, sessionKey], auditKeys: [auditKey2, auditKey] },
  };
  const rotated = makeStore(rotatedConfig);
  assert.deepEqual(await rotated.getSession(session.id), session);
  assert.equal((await rotated.listAuditForCorrelation("rotation-test"))[0]!.id, audit.id);
  const newSession = await rotated.createSession(identity, identity.assignments[0]!, "new-key-test");
  assert.deepEqual(await rotated.getSession(newSession.id), newSession);
  await assert.rejects(original.getSession(newSession.id), /INTEGRITY_INVALID/);
  const removed = makeStore({
    ...config, postgres: { ...config.postgres!, sessionKeys: [sessionKey2], auditKeys: [auditKey2] },
  });
  await assert.rejects(removed.getSession(session.id), /INTEGRITY_INVALID/);
  await assert.rejects(removed.listAuditForCorrelation("rotation-test"), /MAC_KEY_NOT_ALLOWED/);
});

test("Cleanup respects audit retention and never deletes recent audit on a future cleanup argument", async () => {
  const store = makeStore();
  const old = await store.appendAudit("logout", "success", null, "retention-test", Date.now() - 8 * 86_400_000);
  const recent = await store.appendAudit("login_started", "informational", null, "retention-test");
  await store.cleanup(Date.now() + 100 * 86_400_000);
  const rows = await database.query<{ id: string }>("SELECT id FROM siths_federation.audit WHERE id IN ($1,$2)", [old.id, recent.id]);
  assert.deepEqual(rows.rows.map((row) => row.id), [recent.id]);
});
