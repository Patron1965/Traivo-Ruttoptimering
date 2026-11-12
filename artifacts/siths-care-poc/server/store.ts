import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  DescribeTimeToLiveCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type KeySchemaElement,
  type TableDescription,
  type TimeToLiveDescription,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  GenerateMacCommand,
  KMSClient,
  VerifyMacCommand,
} from "@aws-sdk/client-kms";
import type { BrokerConfig } from "./config.ts";
import { JsonLogger, logger } from "./logger.ts";
import { PostgresAuthStore } from "./postgres-store.ts";
import type {
  AuditEvent,
  AuditEventType,
  AuthTransaction,
  AuthenticatedSession,
  HealthcareAssignment,
  HealthcareIdentity,
  PendingIdentity,
} from "./types.ts";

export interface StoreProbe {
  ok: boolean;
  backend: "memory" | "dynamodb" | "postgres";
  region: string | null;
  error?: string;
}

export interface AuthStore {
  readonly backend: "memory" | "dynamodb" | "postgres";
  readonly region: string | null;
  probe(): Promise<StoreProbe>;
  putTransaction(transaction: AuthTransaction): Promise<void>;
  consumeTransaction(
    state: string,
    browserBindingHash: string,
    now?: number,
  ): Promise<AuthTransaction | null>;
  createPending(
    identity: HealthcareIdentity,
    correlationId: string,
    now?: number,
  ): Promise<PendingIdentity>;
  getPending(id: string | undefined, now?: number): Promise<PendingIdentity | null>;
  consumePending(
    id: string | undefined,
    now?: number,
  ): Promise<PendingIdentity | null>;
  createSession(
    identity: HealthcareIdentity,
    assignment: HealthcareAssignment,
    correlationId: string,
    now?: number,
  ): Promise<AuthenticatedSession>;
  getSession(
    id: string | undefined,
    now?: number,
  ): Promise<AuthenticatedSession | null>;
  deleteSession(id: string | undefined): Promise<void>;
  claimTokenReplay(
    tokenHash: string,
    expiresAtSeconds: number,
    nowSeconds?: number,
  ): Promise<boolean>;
  appendAudit(
    eventType: AuditEventType,
    result: AuditEvent["result"],
    reasonCode: string | null,
    correlationId: string,
    now?: number,
  ): Promise<AuditEvent>;
  listAuditForCorrelation(correlationId: string): Promise<AuditEvent[]>;
  cleanup(now?: number): Promise<void>;
  close?(): Promise<void>;
}

export function opaqueId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const actual = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}

export class MemoryAuthStore implements AuthStore {
  readonly backend = "memory" as const;
  readonly region = null;
  private readonly transactions = new Map<string, AuthTransaction>();
  private readonly pending = new Map<string, PendingIdentity>();
  private readonly sessions = new Map<string, AuthenticatedSession>();
  private readonly replayClaims = new Map<string, number>();
  private readonly auditEvents: AuditEvent[] = [];
  private readonly sessionTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly logger: JsonLogger;

  constructor(
    sessionTtlMs: number,
    pendingTtlMs = 5 * 60_000,
    targetLogger: JsonLogger = logger,
  ) {
    this.sessionTtlMs = sessionTtlMs;
    this.pendingTtlMs = pendingTtlMs;
    this.logger = targetLogger;
  }

  async probe(): Promise<StoreProbe> {
    return { ok: true, backend: this.backend, region: this.region };
  }

  async putTransaction(transaction: AuthTransaction): Promise<void> {
    this.transactions.set(transaction.state, Object.freeze({ ...transaction }));
  }

  async consumeTransaction(
    state: string,
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<AuthTransaction | null> {
    const transaction = this.transactions.get(state);
    if (!transaction) return null;
    if (transaction.expiresAt <= now) {
      this.transactions.delete(state);
      return null;
    }
    if (!safeEqual(transaction.browserBindingHash, browserBindingHash)) return null;
    this.transactions.delete(state);
    return transaction;
  }

  async createPending(
    identity: HealthcareIdentity,
    correlationId: string,
    now = Date.now(),
  ): Promise<PendingIdentity> {
    const pending = Object.freeze({
      id: opaqueId(),
      identity,
      correlationId,
      expiresAt: now + this.pendingTtlMs,
    });
    this.pending.set(pending.id, pending);
    return pending;
  }

  async getPending(
    id: string | undefined,
    now = Date.now(),
  ): Promise<PendingIdentity | null> {
    if (!id) return null;
    const pending = this.pending.get(id);
    if (!pending) return null;
    if (pending.expiresAt <= now) {
      this.pending.delete(id);
      return null;
    }
    return pending;
  }

  async consumePending(
    id: string | undefined,
    now = Date.now(),
  ): Promise<PendingIdentity | null> {
    if (!id) return null;
    const pending = await this.getPending(id, now);
    if (pending) this.pending.delete(id);
    return pending;
  }

  async createSession(
    identity: HealthcareIdentity,
    assignment: HealthcareAssignment,
    correlationId: string,
    now = Date.now(),
  ): Promise<AuthenticatedSession> {
    const session = Object.freeze({
      id: opaqueId(),
      identity,
      activeAssignment: assignment,
      correlationId,
      expiresAt: now + this.sessionTtlMs,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async getSession(
    id: string | undefined,
    now = Date.now(),
  ): Promise<AuthenticatedSession | null> {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= now) {
      this.sessions.delete(id);
      await this.appendAudit(
        "session_expired",
        "informational",
        "SESSION_EXPIRED",
        session.correlationId,
        now,
      );
      return null;
    }
    return session;
  }

  async deleteSession(id: string | undefined): Promise<void> {
    if (id) this.sessions.delete(id);
  }

  async claimTokenReplay(
    tokenHash: string,
    expiresAtSeconds: number,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const claimedUntil = this.replayClaims.get(tokenHash);
    if (claimedUntil && claimedUntil > nowSeconds) return false;
    this.replayClaims.set(tokenHash, expiresAtSeconds);
    return true;
  }

  async appendAudit(
    eventType: AuditEventType,
    result: AuditEvent["result"],
    reasonCode: string | null,
    correlationId: string,
    now = Date.now(),
  ): Promise<AuditEvent> {
    const event = Object.freeze({
      id: randomUUID(),
      occurredAt: new Date(now).toISOString(),
      eventType,
      result,
      reasonCode,
      correlationId,
    });
    this.auditEvents.push(event);
    emitAuditLog(this.logger, event);
    return event;
  }

  async listAuditForCorrelation(correlationId: string): Promise<AuditEvent[]> {
    return this.auditEvents
      .filter((event) => event.correlationId === correlationId)
      .slice(-50)
      .reverse();
  }

  async cleanup(now = Date.now()): Promise<void> {
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(state);
    }
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(id);
    }
    for (const [id] of this.sessions) await this.getSession(id, now);
    const nowSeconds = Math.floor(now / 1000);
    for (const [hash, expiresAt] of this.replayClaims) {
      if (expiresAt <= nowSeconds) this.replayClaims.delete(hash);
    }
  }
}

// Backwards-compatible name for consumers of the original development store.
export class AuthStores extends MemoryAuthStore {}

interface Envelope {
  v: 1;
  encryptedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

type DynamoStoreConfig = Pick<
  BrokerConfig,
  | "sessionTtlMs"
  | "awsRegion"
  | "authTable"
  | "auditTable"
  | "authKmsKeyArn"
  | "auditHmacKeyArn"
  | "auditHmacVerifyKeyArns"
  | "auditRetentionDays"
>;

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function transactionKey(state: string, browserBindingHash: string): string {
  return hashKey(`${state.length}:${state}:${browserBindingHash}`);
}

function canonicalAudit(event: AuditEvent): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      event.id,
      event.occurredAt,
      event.eventType,
      event.result,
      event.reasonCode,
      event.correlationId,
    ]),
  );
}

export function emitAuditLog(target: JsonLogger, event: AuditEvent): void {
  target.emit({
    category: "siths_auth",
    eventType: event.eventType,
    result: event.result,
    reasonCode: event.reasonCode,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
  });
}

export function hasExactKeySchema(
  table: TableDescription | undefined,
  expected: ReadonlyArray<KeySchemaElement>,
): boolean {
  if (table?.TableStatus !== "ACTIVE" || !table.KeySchema) return false;
  if (table.KeySchema.length !== expected.length) return false;
  return expected.every((required) =>
    table.KeySchema!.some(
      (actual) =>
        actual.AttributeName === required.AttributeName &&
        actual.KeyType === required.KeyType,
    ),
  );
}

export function hasEnabledExpiresAtTtl(
  ttl: TimeToLiveDescription | undefined,
): boolean {
  return (
    ttl?.TimeToLiveStatus === "ENABLED" &&
    ttl.AttributeName === "expiresAt"
  );
}

export class DynamoDbAuthStore implements AuthStore {
  readonly backend = "dynamodb" as const;
  readonly region: string;
  private readonly dynamoClient: DynamoDBClient;
  private readonly dynamo: DynamoDBDocumentClient;
  private readonly kms: KMSClient;
  private readonly config: DynamoStoreConfig;
  private readonly logger: JsonLogger;
  private probeCache:
    | { result: StoreProbe; expiresAt: number }
    | undefined;
  private probeInFlight: Promise<StoreProbe> | undefined;

  constructor(config: DynamoStoreConfig, targetLogger: JsonLogger = logger) {
    this.config = config;
    this.region = config.awsRegion!;
    this.dynamoClient = new DynamoDBClient({ region: this.region });
    this.dynamo = DynamoDBDocumentClient.from(this.dynamoClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.kms = new KMSClient({ region: this.region });
    this.logger = targetLogger;
  }

  probe(): Promise<StoreProbe> {
    const now = Date.now();
    if (this.probeCache && this.probeCache.expiresAt > now) {
      return Promise.resolve(this.probeCache.result);
    }
    if (this.probeInFlight) return this.probeInFlight;
    const inFlight = this.runPilotProbe().then((result) => {
      this.probeCache = { result, expiresAt: Date.now() + 30_000 };
      return result;
    });
    this.probeInFlight = inFlight.finally(() => {
      this.probeInFlight = undefined;
    });
    return this.probeInFlight;
  }

  private async runPilotProbe(): Promise<StoreProbe> {
    const probeId = randomUUID();
    const keyHash = hashKey(probeId);
    const authPk = `probe#${keyHash}`;
    const auditPk = `probe#${keyHash}`;
    const auditSk = `${new Date().toISOString()}#${probeId}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    try {
      const [authTable, auditTable, authTtl, auditTtl] = await Promise.all([
        this.dynamoClient.send(
          new DescribeTableCommand({ TableName: this.config.authTable! }),
        ),
        this.dynamoClient.send(
          new DescribeTableCommand({ TableName: this.config.auditTable! }),
        ),
        this.dynamoClient.send(
          new DescribeTimeToLiveCommand({ TableName: this.config.authTable! }),
        ),
        this.dynamoClient.send(
          new DescribeTimeToLiveCommand({ TableName: this.config.auditTable! }),
        ),
      ]);
      if (
        !hasExactKeySchema(authTable.Table, [
          { AttributeName: "pk", KeyType: "HASH" },
        ]) ||
        !hasExactKeySchema(auditTable.Table, [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ]) ||
        !hasEnabledExpiresAtTtl(authTtl.TimeToLiveDescription) ||
        !hasEnabledExpiresAtTtl(auditTtl.TimeToLiveDescription)
      ) {
        throw new Error("PILOT_PROBE_CONFIGURATION_INVALID");
      }

      const envelope = await this.encrypt("probe", keyHash, {
        probeId,
        createdAt: new Date().toISOString(),
      });
      try {
        await this.dynamo.send(
          new PutCommand({
            TableName: this.config.authTable!,
            Item: { pk: authPk, expiresAt, payload: envelope },
          }),
        );
        const authItem = await this.dynamo.send(
          new GetCommand({
            TableName: this.config.authTable!,
            Key: { pk: authPk },
            ConsistentRead: true,
          }),
        );
        if (!authItem.Item) throw new Error("PILOT_PROBE_AUTH_READ_FAILED");
        const decrypted = await this.decrypt<{ probeId: string }>(
          "probe",
          keyHash,
          authItem.Item.payload as Envelope,
        );
        if (decrypted.probeId !== probeId) {
          throw new Error("PILOT_PROBE_AUTH_PAYLOAD_INVALID");
        }
      } finally {
        await this.dynamo.send(
          new DeleteCommand({
            TableName: this.config.authTable!,
            Key: { pk: authPk },
          }),
        );
      }

      const message = randomBytes(32);
      let verifiedMac;
      try {
        const generatedMac = await this.kms.send(
          new GenerateMacCommand({
            KeyId: this.config.auditHmacKeyArn!,
            MacAlgorithm: "HMAC_SHA_256",
            Message: message,
          }),
        );
        if (!generatedMac.Mac) throw new Error("PILOT_PROBE_MAC_MISSING");
        verifiedMac = await this.kms.send(
          new VerifyMacCommand({
            KeyId: this.config.auditHmacKeyArn!,
            MacAlgorithm: "HMAC_SHA_256",
            Message: message,
            Mac: generatedMac.Mac,
          }),
        );
      } finally {
        message.fill(0);
      }
      if (!verifiedMac.MacValid) throw new Error("PILOT_PROBE_MAC_INVALID");

      await this.dynamo.send(
        new PutCommand({
          TableName: this.config.auditTable!,
          Item: {
            pk: auditPk,
            sk: auditSk,
            probeId,
            kind: "pilot_storage_probe",
            expiresAt,
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      const queried = await this.dynamo.send(
        new QueryCommand({
          TableName: this.config.auditTable!,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": auditPk },
          ConsistentRead: true,
        }),
      );
      if (
        !queried.Items?.some(
          (item) => item.sk === auditSk && item.probeId === probeId,
        )
      ) {
        throw new Error("PILOT_PROBE_AUDIT_QUERY_FAILED");
      }
      return { ok: true, backend: this.backend, region: this.region };
    } catch {
      return {
        ok: false,
        backend: this.backend,
        region: this.region,
        error: "STORAGE_PILOT_PROBE_FAILED",
      };
    }
  }

  private async encrypt(
    kind: string,
    keyHash: string,
    payload: unknown,
  ): Promise<Envelope> {
    const context = { store: "siths-auth", kind, keyHash };
    const generated = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.config.authKmsKeyArn!,
        KeySpec: "AES_256",
        EncryptionContext: context,
      }),
    );
    if (!generated.Plaintext) {
      throw new Error("KMS_DATA_KEY_GENERATION_FAILED");
    }
    try {
      if (!generated.CiphertextBlob) {
        throw new Error("KMS_DATA_KEY_GENERATION_FAILED");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", generated.Plaintext, iv);
      cipher.setAAD(Buffer.from(`${kind}:${keyHash}`));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      return {
        v: 1,
        encryptedKey: Buffer.from(generated.CiphertextBlob).toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    } finally {
      generated.Plaintext.fill(0);
    }
  }

  private async decrypt<T>(
    kind: string,
    keyHash: string,
    envelope: Envelope,
  ): Promise<T> {
    if (envelope.v !== 1) throw new Error("ENCRYPTED_PAYLOAD_VERSION_INVALID");
    const decrypted = await this.kms.send(
      new DecryptCommand({
        KeyId: this.config.authKmsKeyArn!,
        CiphertextBlob: Buffer.from(envelope.encryptedKey, "base64"),
        EncryptionContext: { store: "siths-auth", kind, keyHash },
      }),
    );
    if (!decrypted.Plaintext) throw new Error("KMS_DATA_KEY_DECRYPTION_FAILED");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        decrypted.Plaintext,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(`${kind}:${keyHash}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ) as T;
    } finally {
      decrypted.Plaintext.fill(0);
    }
  }

  async putTransaction(transaction: AuthTransaction): Promise<void> {
    const keyHash = transactionKey(
      transaction.state,
      transaction.browserBindingHash,
    );
    const {
      state: _state,
      browserBindingHash: _browserBindingHash,
      ...payload
    } = transaction;
    await this.dynamo.send(
      new PutCommand({
        TableName: this.config.authTable!,
        Item: {
          pk: `transaction#${keyHash}`,
          validUntilMs: transaction.expiresAt,
          expiresAt: Math.ceil(transaction.expiresAt / 1000),
          payload: await this.encrypt("transaction", keyHash, payload),
        },
      }),
    );
  }

  async consumeTransaction(
    state: string,
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<AuthTransaction | null> {
    const keyHash = transactionKey(state, browserBindingHash);
    try {
      const deleted = await this.dynamo.send(
        new DeleteCommand({
          TableName: this.config.authTable!,
          Key: { pk: `transaction#${keyHash}` },
          ConditionExpression: "validUntilMs > :now",
          ExpressionAttributeValues: {
            ":now": now,
          },
          ReturnValues: "ALL_OLD",
        }),
      );
      if (!deleted.Attributes) return null;
      const payload = await this.decrypt<
        Omit<AuthTransaction, "state" | "browserBindingHash">
      >(
        "transaction",
        keyHash,
        deleted.Attributes.payload as Envelope,
      );
      return { state, browserBindingHash, ...payload };
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        return null;
      }
      throw error;
    }
  }

  async createPending(
    identity: HealthcareIdentity,
    correlationId: string,
    now = Date.now(),
  ): Promise<PendingIdentity> {
    const pending: PendingIdentity = {
      id: opaqueId(),
      identity,
      correlationId,
      expiresAt: now + 5 * 60_000,
    };
    const keyHash = hashKey(pending.id);
    const { id: _id, ...payload } = pending;
    await this.dynamo.send(
      new PutCommand({
        TableName: this.config.authTable!,
        Item: {
          pk: `pending#${keyHash}`,
          validUntilMs: pending.expiresAt,
          expiresAt: Math.ceil(pending.expiresAt / 1000),
          payload: await this.encrypt("pending", keyHash, payload),
        },
      }),
    );
    return pending;
  }

  async getPending(
    id: string | undefined,
    now = Date.now(),
  ): Promise<PendingIdentity | null> {
    return this.getEncrypted<PendingIdentity>("pending", id, now);
  }

  async consumePending(
    id: string | undefined,
    now = Date.now(),
  ): Promise<PendingIdentity | null> {
    if (!id) return null;
    const keyHash = hashKey(id);
    try {
      const deleted = await this.dynamo.send(
        new DeleteCommand({
          TableName: this.config.authTable!,
          Key: { pk: `pending#${keyHash}` },
          ConditionExpression: "validUntilMs > :now",
          ExpressionAttributeValues: { ":now": now },
          ReturnValues: "ALL_OLD",
        }),
      );
      if (!deleted.Attributes) return null;
      const payload = await this.decrypt<Omit<PendingIdentity, "id">>(
        "pending",
        keyHash,
        deleted.Attributes.payload as Envelope,
      );
      return { id, ...payload };
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        return null;
      }
      throw error;
    }
  }

  async createSession(
    identity: HealthcareIdentity,
    assignment: HealthcareAssignment,
    correlationId: string,
    now = Date.now(),
  ): Promise<AuthenticatedSession> {
    const session: AuthenticatedSession = {
      id: opaqueId(),
      identity,
      activeAssignment: assignment,
      correlationId,
      expiresAt: now + this.config.sessionTtlMs,
    };
    const keyHash = hashKey(session.id);
    const { id: _id, ...payload } = session;
    await this.dynamo.send(
      new PutCommand({
        TableName: this.config.authTable!,
        Item: {
          pk: `session#${keyHash}`,
          validUntilMs: session.expiresAt,
          expiresAt: Math.ceil(session.expiresAt / 1000),
          payload: await this.encrypt("session", keyHash, payload),
        },
      }),
    );
    return session;
  }

  async getSession(
    id: string | undefined,
    now = Date.now(),
  ): Promise<AuthenticatedSession | null> {
    const session = await this.getEncrypted<AuthenticatedSession>(
      "session",
      id,
      now,
    );
    if (!session && id) return null;
    return session;
  }

  private async getEncrypted<T extends { id: string; expiresAt: number }>(
    kind: "pending" | "session",
    id: string | undefined,
    now: number,
  ): Promise<T | null> {
    if (!id) return null;
    const keyHash = hashKey(id);
    const result = await this.dynamo.send(
      new GetCommand({
        TableName: this.config.authTable!,
        Key: { pk: `${kind}#${keyHash}` },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const payload = await this.decrypt<Omit<T, "id">>(
      kind,
      keyHash,
      result.Item.payload as Envelope,
    );
    if (payload.expiresAt <= now) {
      const deleted = await this.dynamo.send(
        new DeleteCommand({
          TableName: this.config.authTable!,
          Key: { pk: `${kind}#${keyHash}` },
          ReturnValues: "ALL_OLD",
        }),
      );
      if (kind === "session" && deleted.Attributes) {
        const session = payload as unknown as Omit<
          AuthenticatedSession,
          "id"
        >;
        await this.appendAudit(
          "session_expired",
          "informational",
          "SESSION_EXPIRED",
          session.correlationId,
          now,
        );
      }
      return null;
    }
    return { id, ...payload } as T;
  }

  async deleteSession(id: string | undefined): Promise<void> {
    if (!id) return;
    await this.dynamo.send(
      new DeleteCommand({
        TableName: this.config.authTable!,
        Key: { pk: `session#${hashKey(id)}` },
      }),
    );
  }

  async claimTokenReplay(
    tokenHash: string,
    expiresAtSeconds: number,
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const keyHash = hashKey(tokenHash);
    try {
      await this.dynamo.send(
        new PutCommand({
          TableName: this.config.authTable!,
          Item: {
            pk: `replay#${keyHash}`,
            expiresAt: expiresAtSeconds,
          },
          ConditionExpression:
            "attribute_not_exists(pk) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": nowSeconds },
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        return false;
      }
      throw error;
    }
  }

  async appendAudit(
    eventType: AuditEventType,
    result: AuditEvent["result"],
    reasonCode: string | null,
    correlationId: string,
    now = Date.now(),
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: randomUUID(),
      occurredAt: new Date(now).toISOString(),
      eventType,
      result,
      reasonCode,
      correlationId,
    };
    const mac = await this.kms.send(
      new GenerateMacCommand({
        KeyId: this.config.auditHmacKeyArn!,
        MacAlgorithm: "HMAC_SHA_256",
        Message: canonicalAudit(event),
      }),
    );
    if (!mac.Mac) throw new Error("AUDIT_MAC_GENERATION_FAILED");
    await this.dynamo.send(
      new PutCommand({
        TableName: this.config.auditTable!,
        Item: {
          pk: `audit#${hashKey(correlationId)}`,
          sk: `${event.occurredAt}#${event.id}`,
          ...event,
          mac: Buffer.from(mac.Mac).toString("base64"),
          macKeyArn: this.config.auditHmacKeyArn!,
          expiresAt: Math.ceil(
            now / 1000 + this.config.auditRetentionDays! * 86_400,
          ),
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
    emitAuditLog(this.logger, event);
    return event;
  }

  async listAuditForCorrelation(correlationId: string): Promise<AuditEvent[]> {
    const result = await this.dynamo.send(
      new QueryCommand({
        TableName: this.config.auditTable!,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `audit#${hashKey(correlationId)}`,
        },
        ScanIndexForward: false,
        Limit: 50,
      }),
    );
    const events: AuditEvent[] = [];
    for (const item of result.Items ?? []) {
      const event: AuditEvent = {
        id: String(item.id),
        occurredAt: String(item.occurredAt),
        eventType: item.eventType as AuditEventType,
        result: item.result as AuditEvent["result"],
        reasonCode: item.reasonCode === null ? null : String(item.reasonCode),
        correlationId: String(item.correlationId),
      };
      const macKeyArn =
        typeof item.macKeyArn === "string" ? item.macKeyArn : "";
      if (!this.config.auditHmacVerifyKeyArns.includes(macKeyArn)) {
        throw new Error("AUDIT_MAC_KEY_NOT_ALLOWED");
      }
      const verified = await this.kms.send(
        new VerifyMacCommand({
          KeyId: macKeyArn,
          MacAlgorithm: "HMAC_SHA_256",
          Message: canonicalAudit(event),
          Mac: Buffer.from(String(item.mac), "base64"),
        }),
      );
      if (!verified.MacValid) throw new Error("AUDIT_INTEGRITY_INVALID");
      events.push(event);
    }
    return events;
  }

  async cleanup(): Promise<void> {
    // DynamoDB TTL performs asynchronous physical cleanup.
  }
}

export async function createAuthStore(
  config: BrokerConfig,
): Promise<{ store: AuthStore; initialProbe: StoreProbe }> {
  const store: AuthStore =
    config.storeBackend === "dynamodb"
      ? new DynamoDbAuthStore(config)
      : config.storeBackend === "postgres"
        ? new PostgresAuthStore(config)
        : new MemoryAuthStore(config.sessionTtlMs);
  if (store instanceof PostgresAuthStore) await store.initialize();
  return { store, initialProbe: await store.probe() };
}