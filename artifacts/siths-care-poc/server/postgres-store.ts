import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, randomUUID, timingSafeEqual,
} from "node:crypto";
import pg from "pg";
import type { BrokerConfig } from "./config.ts";
import { JsonLogger, logger } from "./logger.ts";
import { emitAuditLog, opaqueId, type AuthStore, type StoreProbe } from "./store.ts";
import { POSTGRES_SCHEMA } from "./postgres-schema.ts";
import type {
  AuditEvent, AuditEventType, AuthTransaction, AuthenticatedSession,
  HealthcareAssignment, HealthcareIdentity, PendingIdentity,
} from "./types.ts";

export interface SqlClient {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end?(): Promise<void>;
}

type StoreConfig = Pick<BrokerConfig, "postgres" | "sessionTtlMs" | "auditRetentionDays">;
type Envelope = { v: 1; keyId: string; iv: string; tag: string; ciphertext: string };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex");
const recordKey = (kind: string, id: string) => `${kind}:${digest(id)}`;
const canonicalAudit = (event: AuditEvent) => JSON.stringify({
  id: event.id, occurredAt: event.occurredAt, eventType: event.eventType,
  result: event.result, reasonCode: event.reasonCode, correlationId: event.correlationId,
});

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PostgresAuthStore implements AuthStore {
  readonly backend = "postgres" as const;
  // Actual hosting geography is verified by external readiness evidence, not inferred.
  readonly region = null;
  private readonly sql: SqlClient;
  private readonly config: StoreConfig;
  private readonly sessionKeys: Buffer[];
  private readonly auditKeys: Buffer[];
  private readonly targetLogger: JsonLogger;

  constructor(config: StoreConfig, sql?: SqlClient, targetLogger = logger) {
    if (!config.postgres) throw new Error("POSTGRES_CONFIG_REQUIRED");
    this.config = config;
    this.sessionKeys = config.postgres.sessionKeys.map((key) => Buffer.from(key, "base64"));
    this.auditKeys = config.postgres.auditKeys.map((key) => Buffer.from(key, "base64"));
    this.targetLogger = targetLogger;
    this.sql = sql ?? new pg.Pool({
      connectionString: config.postgres.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 7_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 7_000,
      application_name: "siths-isolated-federation-test",
    });
    if (this.sql instanceof pg.Pool) {
      this.sql.on("error", () => {
        console.error("SITHS_POSTGRES_CONNECTION_FAILED");
      });
    }
  }

  private async assertDedicatedDatabase(): Promise<void> {
    const result = await this.sql.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema', 'siths_federation')
      LIMIT 1
    `);
    if (result.rows.length) throw new Error("SITHS_DATABASE_NOT_DEDICATED");
  }

  async initialize(): Promise<void> {
    // Run the isolation check before any DDL, including IF NOT EXISTS statements.
    await this.assertDedicatedDatabase();
    await this.sql.query(POSTGRES_SCHEMA);
  }

  async probe(): Promise<StoreProbe> {
    try {
      await this.assertDedicatedDatabase();
      await this.sql.query("SELECT record_key, expires_at, payload FROM siths_federation.auth LIMIT 0");
      await this.sql.query("SELECT token_hash, expires_at FROM siths_federation.replay LIMIT 0");
      await this.sql.query("SELECT event, mac, key_id FROM siths_federation.audit LIMIT 0");
      const guards = await this.sql.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'siths_federation.audit'::regclass AND tgenabled <> 'D'
          AND tgname IN ('audit_mutation_guard', 'audit_truncate_guard')
      `);
      if (guards.rows.length !== 2) throw new Error("AUDIT_GUARDS_MISSING");
      return { ok: true, backend: this.backend, region: this.region };
    } catch {
      return { ok: false, backend: this.backend, region: this.region, error: "POSTGRES_PROBE_FAILED" };
    }
  }

  private seal(value: unknown, context: string): Envelope {
    const key = this.sessionKeys[0]!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      v: 1, keyId: keyId(key), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
    };
  }

  private open<T>(envelope: Envelope, context: string): T {
    try {
      if (envelope.v !== 1) throw new Error();
      const key = this.sessionKeys.find((candidate) => keyId(candidate) === envelope.keyId);
      if (!key) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as T;
    } catch {
      throw new Error("SITHS_SESSION_INTEGRITY_INVALID");
    }
  }

  private async put(key: string, value: { expiresAt: number }, binding: string | null = null): Promise<void> {
    const context = `auth:${key}:${value.expiresAt}:${binding ?? ""}`;
    await this.sql.query(
      "INSERT INTO siths_federation.auth (record_key, expires_at, binding_hash, payload) VALUES ($1,$2,$3,$4::jsonb)",
      [key, value.expiresAt, binding, JSON.stringify(this.seal(value, context))],
    );
  }

  private decode<T extends { expiresAt: number }>(row: Record<string, unknown>, expectedKey: string): T {
    if (row.record_key !== expectedKey) throw new Error("SITHS_SESSION_KEY_INVALID");
    const expiry = Number(row.expires_at);
    const context = `auth:${expectedKey}:${expiry}:${row.binding_hash ?? ""}`;
    const value = this.open<T>(row.payload as Envelope, context);
    if (value.expiresAt !== expiry) throw new Error("SITHS_SESSION_EXPIRY_INVALID");
    return value;
  }

  private async read<T extends { expiresAt: number }>(key: string, now: number): Promise<T | null> {
    const result = await this.sql.query(
      "SELECT * FROM siths_federation.auth WHERE record_key=$1 AND expires_at>$2", [key, now],
    );
    return result.rows[0] ? this.decode<T>(result.rows[0], key) : null;
  }

  private async consume<T extends { expiresAt: number }>(
    key: string, now: number, binding: string | null = null,
  ): Promise<T | null> {
    // DELETE RETURNING is the single atomic claim across all server instances.
    const result = await this.sql.query(
      "DELETE FROM siths_federation.auth WHERE record_key=$1 AND expires_at>$2 AND binding_hash IS NOT DISTINCT FROM $3 RETURNING *",
      [key, now, binding],
    );
    return result.rows[0] ? this.decode<T>(result.rows[0], key) : null;
  }

  async putTransaction(transaction: AuthTransaction): Promise<void> {
    await this.put(recordKey("transaction", transaction.state), transaction, transaction.browserBindingHash);
  }

  async consumeTransaction(state: string, binding: string, now = Date.now()): Promise<AuthTransaction | null> {
    return this.consume(recordKey("transaction", state), now, binding);
  }

  async createPending(identity: HealthcareIdentity, correlationId: string, now = Date.now()): Promise<PendingIdentity> {
    const pending = { id: opaqueId(), identity, correlationId, expiresAt: now + 5 * 60_000 };
    await this.put(recordKey("pending", pending.id), pending);
    return pending;
  }

  async getPending(id: string | undefined, now = Date.now()): Promise<PendingIdentity | null> {
    return id ? this.read(recordKey("pending", id), now) : null;
  }

  async consumePending(id: string | undefined, now = Date.now()): Promise<PendingIdentity | null> {
    return id ? this.consume(recordKey("pending", id), now) : null;
  }

  async createSession(
    identity: HealthcareIdentity, activeAssignment: HealthcareAssignment,
    correlationId: string, now = Date.now(),
  ): Promise<AuthenticatedSession> {
    const session = { id: opaqueId(), identity, activeAssignment, correlationId, expiresAt: now + this.config.sessionTtlMs };
    await this.put(recordKey("session", session.id), session);
    return session;
  }

  async getSession(id: string | undefined, now = Date.now()): Promise<AuthenticatedSession | null> {
    if (!id) return null;
    const key = recordKey("session", id);
    const expired = await this.sql.query(
      "DELETE FROM siths_federation.auth WHERE record_key=$1 AND expires_at<=$2 RETURNING *", [key, now],
    );
    if (expired.rows[0]) {
      const session = this.decode<AuthenticatedSession>(expired.rows[0], key);
      await this.appendAudit("session_expired", "informational", "SESSION_EXPIRED", session.correlationId, now);
      return null;
    }
    return this.read(key, now);
  }

  async deleteSession(id: string | undefined): Promise<void> {
    if (id) await this.sql.query("DELETE FROM siths_federation.auth WHERE record_key=$1", [recordKey("session", id)]);
  }

  async claimTokenReplay(tokenHash: string, expiresAtSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
    // Preserve replay protection throughout the verifier's 30-second clock tolerance.
    if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds < nowSeconds - 30) return false;
    const retainedUntil = Math.ceil(Math.max(expiresAtSeconds, nowSeconds + 30) * 1000);
    if (!Number.isSafeInteger(retainedUntil)) return false;
    const result = await this.sql.query(`
      INSERT INTO siths_federation.replay (token_hash, expires_at) VALUES ($1,$2)
      ON CONFLICT (token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at
      WHERE siths_federation.replay.expires_at<=$3 RETURNING token_hash
    `, [tokenHash, retainedUntil, nowSeconds * 1000]);
    return result.rows.length === 1;
  }

  async appendAudit(
    eventType: AuditEventType, result: AuditEvent["result"], reasonCode: string | null,
    correlationId: string, now = Date.now(),
  ): Promise<AuditEvent> {
    const event = Object.freeze({ id: randomUUID(), occurredAt: new Date(now).toISOString(), eventType, result, reasonCode, correlationId });
    const expiry = now + this.config.auditRetentionDays * 86_400_000;
    const key = this.auditKeys[0]!;
    const id = keyId(key);
    const mac = createHmac("sha256", key).update(`audit:v1:${id}:${expiry}:${canonicalAudit(event)}`).digest("hex");
    await this.sql.query(
      "INSERT INTO siths_federation.audit (id, correlation_hash, occurred_at, expires_at, event, key_id, mac) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [event.id, digest(correlationId), now, expiry, canonicalAudit(event), id, mac],
    );
    emitAuditLog(this.targetLogger, event);
    return event;
  }

  async listAuditForCorrelation(correlationId: string): Promise<AuditEvent[]> {
    const result = await this.sql.query(
      "SELECT * FROM siths_federation.audit WHERE correlation_hash=$1 AND expires_at>$2 ORDER BY occurred_at DESC, id DESC LIMIT 50",
      [digest(correlationId), Date.now()],
    );
    return result.rows.map((row) => {
      const event = row.event as AuditEvent;
      const key = this.auditKeys.find((candidate) => keyId(candidate) === row.key_id);
      if (!key) throw new Error("AUDIT_MAC_KEY_NOT_ALLOWED");
      const expected = createHmac("sha256", key).update(`audit:v1:${row.key_id}:${Number(row.expires_at)}:${canonicalAudit(event)}`).digest("hex");
      if (
        !equal(expected, String(row.mac)) || event.id !== row.id ||
        event.correlationId !== correlationId || Date.parse(event.occurredAt) !== Number(row.occurred_at)
      ) throw new Error("AUDIT_INTEGRITY_INVALID");
      return event;
    });
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.sql.query("DELETE FROM siths_federation.auth WHERE expires_at<=$1", [now]);
    await this.sql.query("DELETE FROM siths_federation.replay WHERE expires_at<=$1", [now]);
    await this.sql.query(
      "DELETE FROM siths_federation.audit WHERE expires_at<=LEAST($1, floor(extract(epoch FROM clock_timestamp())*1000))",
      [now],
    );
  }

  async close(): Promise<void> { await this.sql.end?.(); }
}
