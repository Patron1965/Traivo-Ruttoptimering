import assert from "node:assert/strict";
import test from "node:test";
import { DevIdentityHarness } from "./dev-harness.ts";
import {
  apiPrefixForBasePath,
  isApiPrefixPath,
  loadConfig,
  normalizeBasePath,
  PILOT_CONTROL_IDS,
  parseReadinessEvidenceManifest,
} from "./config.ts";
import { IdTokenVerifier } from "./oidc.ts";
import { assessHealth, assessReadiness } from "./readiness.ts";
import { JsonLogger } from "./logger.ts";
import {
  emitSecurityError,
  hashBrowserBinding,
  SecurityError,
  serializeCookie,
} from "./security.ts";
import {
  AuthStores,
  hasEnabledExpiresAtTtl,
  hasExactKeySchema,
} from "./store.ts";
import {
  configureApiBasePath,
  customFetch,
} from "../../../lib/api-client-react/src/custom-fetch.ts";

function errorCode(error: unknown) {
  return error instanceof SecurityError ? error.code : "UNKNOWN";
}

function memoryVerifier() {
  return new IdTokenVerifier(new AuthStores(15 * 60_000));
}

const currentAuditKey =
  "arn:aws:kms:eu-north-1:123456789012:key/current-audit";
const previousAuditKey =
  "arn:aws:kms:eu-north-1:123456789012:key/previous-audit";

function productionEnv() {
  return {
    NODE_ENV: "production",
    PORT: "3000",
    BASE_PATH: "/siths-care-poc/",
    SITHS_OIDC_ISSUER: "https://issuer.example",
    SITHS_OIDC_CLIENT_ID: "synthetic-client",
    SITHS_OIDC_REDIRECT_URI:
      "https://care.example/siths-care-poc/api/siths/callback",
    SITHS_STORE_BACKEND: "dynamodb",
    SITHS_AWS_REGION: "eu-north-1",
    SITHS_AUTH_TABLE: "auth",
    SITHS_AUDIT_TABLE: "audit",
    SITHS_AUTH_KMS_KEY_ARN:
      "arn:aws:kms:eu-north-1:123456789012:key/auth",
    SITHS_AUDIT_HMAC_KEY_ARN: currentAuditKey,
    SITHS_AUDIT_RETENTION_DAYS: "90",
  };
}

function completeEvidenceManifest() {
  return JSON.stringify({
    version: 1,
    approvals: PILOT_CONTROL_IDS.map((controlId) => ({
      controlId,
      status: "approved",
      evidenceId: `evidence-${controlId}`,
      owner: "security-owner",
      verifiedAt: "2026-01-15T10:00:00.000Z",
    })),
  });
}

test("synthetic valid identity is accepted with one active assignment", async () => {
  const harness = new DevIdentityHarness(memoryVerifier());
  const identity = await harness.run("valid");
  assert.equal(identity.hsaId, "SE-SYNTHETIC-HSA-0001");
  assert.equal(identity.loa, "loa3");
  assert.equal(identity.assignments.length, 1);
});

test("synthetic identity can require explicit assignment selection", async () => {
  const harness = new DevIdentityHarness(memoryVerifier());
  const identity = await harness.run("valid_multiple_assignments");
  assert.equal(identity.assignments.length, 2);
  assert.notEqual(identity.assignments[0]?.id, identity.assignments[1]?.id);
});

const rejectedScenarios = [
  ["tampered_signature", "TOKEN_SIGNATURE_INVALID"],
  ["wrong_issuer", "TOKEN_ISSUER_INVALID"],
  ["wrong_audience", "TOKEN_AUDIENCE_INVALID"],
  ["wrong_nonce", "TOKEN_NONCE_INVALID"],
  ["replay", "TOKEN_REPLAYED"],
  ["expired", "TOKEN_EXPIRED"],
  ["low_loa", "LOA_TOO_LOW"],
  ["missing_hsa_id", "HSA_ID_REQUIRED"],
  ["missing_assignment", "ASSIGNMENT_REQUIRED"],
] as const;

for (const [scenario, expectedCode] of rejectedScenarios) {
  test(`synthetic scenario ${scenario} is rejected`, async () => {
    const harness = new DevIdentityHarness(memoryVerifier());
    await assert.rejects(
      harness.run(scenario),
      (error) => errorCode(error) === expectedCode,
    );
  });
}

test("OIDC state transactions are one-time and expire closed", async () => {
  const stores = new AuthStores(15 * 60_000);
  const now = Date.now();
  await stores.putTransaction({
    state: "one-time-state",
    nonce: "nonce",
    pkceVerifier: "verifier",
    browserBindingHash: "correct-browser-binding",
    redirectUri: "https://example.invalid/callback",
    returnPath: "/siths-care-poc/",
    correlationId: "correlation",
    expiresAt: now + 1_000,
  });
  assert.equal(
    await stores.consumeTransaction(
      "one-time-state",
      "wrong-browser-binding",
      now,
    ),
    null,
  );
  assert.ok(
    await stores.consumeTransaction(
      "one-time-state",
      "correct-browser-binding",
      now,
    ),
  );
  assert.equal(
    await stores.consumeTransaction(
      "one-time-state",
      "correct-browser-binding",
      now,
    ),
    null,
  );

  await stores.putTransaction({
    state: "expired-state",
    nonce: "nonce",
    pkceVerifier: "verifier",
    browserBindingHash: "correct-browser-binding",
    redirectUri: "https://example.invalid/callback",
    returnPath: "/siths-care-poc/",
    correlationId: "correlation",
    expiresAt: now - 1,
  });
  assert.equal(
    await stores.consumeTransaction(
      "expired-state",
      "correct-browser-binding",
      now,
    ),
    null,
  );
});

test("OIDC browser binding cookie is callback-scoped and cross-site-return safe", () => {
  const cookie = serializeCookie(
    "__Secure-siths_transaction",
    "synthetic-binding",
    300,
    true,
    { path: "/siths-care-poc/api/siths/callback", sameSite: "Lax" },
  );
  assert.match(cookie, /^__Secure-siths_transaction=/);
  assert.match(cookie, /Path=\/siths-care-poc\/api\/siths\/callback/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.notEqual(
    hashBrowserBinding("synthetic-binding"),
    "synthetic-binding",
  );
});

test("production fails closed and can never enable the synthetic harness", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        PORT: "3000",
        BASE_PATH: "/siths-care-poc/",
      }),
    /fail-closed/,
  );

  const config = loadConfig({
    ...productionEnv(),
    SITHS_DEV_HARNESS: "true",
  });
  assert.equal(config.oidcConfigured, true);
  assert.equal(config.devHarnessEnabled, false);
});

test("production rejects memory, wrong region, and incomplete DynamoDB settings", () => {
  const base = {
    NODE_ENV: "production",
    PORT: "3000",
    SITHS_OIDC_ISSUER: "https://issuer.example",
    SITHS_OIDC_CLIENT_ID: "client",
    SITHS_OIDC_REDIRECT_URI:
      "https://care.example/siths-care-poc/api/siths/callback",
  };
  assert.throws(
    () => loadConfig({ ...base, SITHS_STORE_BACKEND: "memory" }),
    /storage is fail-closed/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        SITHS_STORE_BACKEND: "dynamodb",
        SITHS_AWS_REGION: "eu-west-1",
      }),
    /storage is fail-closed/,
  );
});

test("readiness evidence manifest accepts v1 approvals and rejects malformed data", () => {
  const parsed = parseReadinessEvidenceManifest(completeEvidenceManifest());
  assert.equal(parsed?.version, 1);
  assert.equal(parsed?.approvals.length, PILOT_CONTROL_IDS.length);
  assert.equal(parseReadinessEvidenceManifest(undefined), null);

  for (const manifest of [
    "{",
    JSON.stringify({ version: 2, approvals: [] }),
    JSON.stringify({
      version: 1,
      approvals: [
        {
          controlId: "duplicate",
          status: "approved",
          evidenceId: "one",
          owner: "owner",
          verifiedAt: "2026-01-01T00:00:00Z",
        },
        {
          controlId: "duplicate",
          status: "approved",
          evidenceId: "two",
          owner: "owner",
          verifiedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }),
    JSON.stringify({
      version: 1,
      approvals: [
        {
          controlId: "control",
          status: "pending",
          evidenceId: "evidence",
          owner: "owner",
          verifiedAt: "2026-01-01T00:00:00Z",
        },
      ],
    }),
    JSON.stringify({
      version: 1,
      approvals: [
        {
          controlId: "control",
          status: "approved",
          evidenceId: "",
          owner: "owner",
          verifiedAt: "not-a-date",
        },
      ],
    }),
  ]) {
    assert.throws(() => parseReadinessEvidenceManifest(manifest));
  }
});

test("production readiness exposes only missing control IDs", () => {
  const config = loadConfig(productionEnv());
  const failedProbe = {
    ok: false,
    backend: "dynamodb" as const,
    region: "eu-north-1",
    error: "DYNAMODB_PROBE_FAILED",
  };
  const blocked = assessReadiness(config, failedProbe);
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, PILOT_CONTROL_IDS);

  const approvedConfig = loadConfig({
    ...productionEnv(),
    SITHS_READINESS_EVIDENCE_MANIFEST: completeEvidenceManifest(),
  });
  assert.deepEqual(
    assessReadiness(approvedConfig, { ...failedProbe, ok: true }).blockers,
    [],
  );
  assert.equal(
    assessReadiness(approvedConfig, { ...failedProbe, ok: true }).ready,
    true,
  );
  const technicalFailure = assessReadiness(approvedConfig, failedProbe);
  assert.equal(technicalFailure.ready, false);
  assert.deepEqual(technicalFailure.blockers, []);
});

test("development memory remains ready with blockers", () => {
  const config = loadConfig({ NODE_ENV: "development", PORT: "3000" });
  const assessment = assessReadiness(config, {
    ok: true,
    backend: "memory",
    region: null,
  });
  assert.equal(assessment.ready, true);
  assert.ok(assessment.blockers.length > 0);
});

test("technical health ignores evidence but requires probe and valid production config", () => {
  const production = loadConfig(productionEnv());
  const healthyProbe = {
    ok: true,
    backend: "dynamodb" as const,
    region: "eu-north-1",
  };
  assert.equal(production.missingPilotControlIds.length > 0, true);
  assert.equal(assessHealth(production, healthyProbe), true);
  assert.equal(
    assessHealth(production, { ...healthyProbe, ok: false }),
    false,
  );
  assert.equal(
    assessHealth({ ...production, oidcConfigured: false }, healthyProbe),
    false,
  );
  assert.equal(
    assessHealth(
      { ...production, storeBackend: "memory", awsRegion: null },
      healthyProbe,
    ),
    false,
  );

  const development = loadConfig({ NODE_ENV: "development", PORT: "3000" });
  assert.equal(
    assessHealth(development, {
      ok: true,
      backend: "memory",
      region: null,
    }),
    true,
  );
  assert.equal(
    assessHealth(development, {
      ok: false,
      backend: "memory",
      region: null,
    }),
    false,
  );
});

test("production retention is explicit and bounded", () => {
  const { SITHS_AUDIT_RETENTION_DAYS: _retention, ...withoutRetention } =
    productionEnv();
  assert.throws(
    () => loadConfig(withoutRetention),
    /SITHS_AUDIT_RETENTION_DAYS is required/,
  );
  for (const value of ["0", "3651", "1.5", "invalid"]) {
    assert.throws(
      () =>
        loadConfig({
          ...productionEnv(),
          SITHS_AUDIT_RETENTION_DAYS: value,
        }),
      /must be an integer/,
    );
  }
  assert.equal(
    loadConfig({ NODE_ENV: "development", PORT: "3000" }).auditRetentionDays,
    90,
  );
});

test("base path normalization and production callback matching fail closed", () => {
  assert.equal(normalizeBasePath("/siths-care-poc"), "/siths-care-poc/");
  assert.equal(normalizeBasePath("/siths//care/"), "/siths/care/");
  assert.equal(apiPrefixForBasePath("/"), "/api/siths");
  assert.equal(
    apiPrefixForBasePath("/siths-care-poc/"),
    "/siths-care-poc/api/siths",
  );
  assert.equal(
    isApiPrefixPath(
      "/siths-care-poc/api/siths/session",
      "/siths-care-poc/api/siths",
    ),
    true,
  );
  assert.equal(
    isApiPrefixPath(
      "/siths-care-poc/api/siths-evil/session",
      "/siths-care-poc/api/siths",
    ),
    false,
  );
  for (const unsafe of [
    "relative",
    "//external.example/path",
    "/safe/../escape",
    "/safe?query=1",
    "/safe#fragment",
    "/safe%2fescape",
  ]) {
    assert.throws(() => normalizeBasePath(unsafe), /BASE_PATH/);
  }
  for (const redirect of [
    "https://care.example/api/siths/callback",
    "https://care.example/siths-care-poc/api/siths/callback/extra",
    "https://care.example/siths-care-poc/api/siths/callback?query=1",
    "https://care.example/siths-care-poc/api/siths/callback#fragment",
  ]) {
    assert.throws(
      () =>
        loadConfig({
          ...productionEnv(),
          SITHS_OIDC_REDIRECT_URI: redirect,
        }),
      /must exactly match the artifact callback path/,
    );
  }
});

test("custom fetch prefixes only root API string URLs after configuration", async () => {
  const originalFetch = globalThis.fetch;
  const inputs: Array<RequestInfo | URL> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    inputs.push(input);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await customFetch("/api/root-default");
    configureApiBasePath("/siths-care-poc");
    await customFetch("/api/siths/session");
    await customFetch("/assets/application.js");
    await customFetch("https://external.example/api/resource");
    const urlObject = new URL("https://external.example/api/object");
    await customFetch(urlObject);

    assert.equal(inputs[0], "/api/root-default");
    assert.equal(inputs[1], "/siths-care-poc/api/siths/session");
    assert.equal(inputs[2], "/assets/application.js");
    assert.equal(inputs[3], "https://external.example/api/resource");
    assert.equal(inputs[4], urlObject);
    assert.throws(
      () => configureApiBasePath("//external.example/"),
      /safe absolute pathname/,
    );
  } finally {
    configureApiBasePath("/");
    globalThis.fetch = originalFetch;
  }
});

test("audit HMAC verification allowlist always includes the current key", () => {
  const config = loadConfig({
    ...productionEnv(),
    SITHS_AUDIT_HMAC_VERIFY_KEY_ARNS: `${previousAuditKey},${currentAuditKey},${previousAuditKey}`,
  });
  assert.deepEqual(config.auditHmacVerifyKeyArns, [
    currentAuditKey,
    previousAuditKey,
  ]);
  assert.throws(
    () =>
      loadConfig({
        ...productionEnv(),
        SITHS_AUDIT_HMAC_VERIFY_KEY_ARNS: "not-an-arn",
      }),
    /must contain KMS key ARNs/,
  );
});

test("memory store has asynchronous one-time pending and active revocation semantics", async () => {
  const stores = new AuthStores(60_000);
  const identity = await new DevIdentityHarness(memoryVerifier()).run("valid");
  const pending = await stores.createPending(identity, "correlation");
  assert.ok(await stores.getPending(pending.id));
  assert.ok(await stores.consumePending(pending.id));
  assert.equal(await stores.consumePending(pending.id), null);

  const session = await stores.createSession(
    identity,
    identity.assignments[0]!,
    "correlation",
  );
  assert.ok(await stores.getSession(session.id));
  await stores.deleteSession(session.id);
  assert.equal(await stores.getSession(session.id), null);
});

test("replay claims are shared by verifiers using the same store", async () => {
  const store = new AuthStores(60_000);
  const first = new DevIdentityHarness(new IdTokenVerifier(store));
  await assert.rejects(
    first.run("replay"),
    (error) => errorCode(error) === "TOKEN_REPLAYED",
  );
});

test("memory audit listing is correlation-scoped and newest first", async () => {
  const store = new AuthStores(60_000);
  await store.appendAudit("login_started", "informational", null, "one", 1);
  await store.appendAudit("logout", "success", null, "one", 2);
  await store.appendAudit("login_started", "informational", null, "two", 3);
  const events = await store.listAuditForCorrelation("one");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["logout", "login_started"],
  );
});

test("structured logger emits only explicitly supplied JSON fields", () => {
  const lines: string[] = [];
  const target = new JsonLogger((line) => lines.push(line));
  emitSecurityError(
    new SecurityError(
      "TOKEN_REJECTED",
      "secret token and identity must not be logged",
      403,
    ),
    "correlation-safe",
    target,
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    category: "siths_security_error",
    code: "TOKEN_REJECTED",
    status: 403,
    correlationId: "correlation-safe",
  });
  assert.doesNotMatch(lines[0]!, /secret token|identity|message|body/);
});

test("audit append logs the sanitized event only after persistence", async () => {
  const lines: string[] = [];
  const target = new JsonLogger((line) => lines.push(line));
  const store = new AuthStores(60_000, 300_000, target);
  await store.appendAudit(
    "token_rejected",
    "rejected",
    "TOKEN_INVALID",
    "correlation-safe",
    1_700_000_000_000,
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0]!)).sort(), [
    "category",
    "correlationId",
    "eventType",
    "occurredAt",
    "reasonCode",
    "result",
  ]);
});

test("pilot probe schema helpers require ACTIVE exact keys and enabled TTL", () => {
  assert.equal(
    hasExactKeySchema(
      {
        TableStatus: "ACTIVE",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      },
      [{ AttributeName: "pk", KeyType: "HASH" }],
    ),
    true,
  );
  assert.equal(
    hasExactKeySchema(
      {
        TableStatus: "UPDATING",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      },
      [{ AttributeName: "pk", KeyType: "HASH" }],
    ),
    false,
  );
  assert.equal(
    hasExactKeySchema(
      {
        TableStatus: "ACTIVE",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "unexpected", KeyType: "RANGE" },
        ],
      },
      [{ AttributeName: "pk", KeyType: "HASH" }],
    ),
    false,
  );
  assert.equal(
    hasEnabledExpiresAtTtl({
      TimeToLiveStatus: "ENABLED",
      AttributeName: "expiresAt",
    }),
    true,
  );
  assert.equal(
    hasEnabledExpiresAtTtl({
      TimeToLiveStatus: "ENABLING",
      AttributeName: "expiresAt",
    }),
    false,
  );
  assert.equal(
    hasEnabledExpiresAtTtl({
      TimeToLiveStatus: "ENABLED",
      AttributeName: "wrong",
    }),
    false,
  );
});