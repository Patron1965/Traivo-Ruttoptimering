import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import { DynamoDbAuthStore, type StoreProbe } from "./store.ts";

const productionEnvironment = {
  NODE_ENV: "production",
  PORT: "0",
  BASE_PATH: "/siths-care-poc/",
  SITHS_OIDC_ISSUER: "https://issuer.example",
  SITHS_OIDC_CLIENT_ID: "synthetic-client",
  SITHS_OIDC_REDIRECT_URI:
    "https://care.example/siths-care-poc/api/siths/callback",
  SITHS_STORE_BACKEND: "dynamodb",
  SITHS_AWS_REGION: "eu-north-1",
  SITHS_AUTH_TABLE: "auth",
  SITHS_AUDIT_TABLE: "audit",
  SITHS_AUTH_KMS_KEY_ARN: "arn:aws:kms:eu-north-1:123456789012:key/auth",
  SITHS_AUDIT_HMAC_KEY_ARN:
    "arn:aws:kms:eu-north-1:123456789012:key/current-audit",
  SITHS_AUDIT_RETENTION_DAYS: "90",
};

async function reservePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function restoreEnvironment(
  snapshot: Record<string, string | undefined>,
): void {
  for (const key of Object.keys(snapshot)) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("production login is rejected until the pilot evidence gate is approved", async () => {
  const port = await reservePort();
  const environmentKeys = Object.keys(productionEnvironment);
  const environmentSnapshot = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  const originalProbe = DynamoDbAuthStore.prototype.probe;
  const healthyDynamoProbe: StoreProbe = {
    ok: true,
    backend: "dynamodb",
    region: "eu-north-1",
  };

  DynamoDbAuthStore.prototype.probe = async () => healthyDynamoProbe;
  Object.assign(process.env, { ...productionEnvironment, PORT: String(port) });

  let pilotServer: Server | undefined;
  try {
    const application = await import("./index.ts?readiness-gate-integration");
    pilotServer = application.server;
    await once(pilotServer, "listening");

    const response = await fetch(
      `http://127.0.0.1:${port}/siths-care-poc/api/siths/login/start`,
      {
        method: "POST",
        headers: {
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ returnPath: "/siths-care-poc/" }),
      },
    );

    assert.equal(response.status, 503);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(
      body.error,
      "Pilotdriften är inte godkänd för identitetshantering.",
    );
    assert.equal(body.code, "PILOT_NOT_READY");
    assert.match(String(body.correlationId), /^[0-9a-f-]{36}$/i);
  } finally {
    if (pilotServer?.listening) {
      await new Promise<void>((resolve, reject) =>
        pilotServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
    DynamoDbAuthStore.prototype.probe = originalProbe;
    restoreEnvironment(environmentSnapshot);
  }
});