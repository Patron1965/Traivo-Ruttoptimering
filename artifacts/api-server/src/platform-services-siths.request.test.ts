import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, mock, test } from "node:test";
import express from "express";
import * as schema from "@workspace/db/schema";
import { createPlatformServicesStore } from "./test-utils/platform-services-store";
import { REGION_STOCKHOLM_TENANT_ID } from "./services/organization-login-preference";

// Only the database boundary is replaced. The actual router, validation,
// requirePlatformAdmin and login-status helpers run through HTTP.
// The eligible ID exists ONLY in this in-memory fixture, never in a real DB.
const eligibleId = REGION_STOCKHOLM_TENANT_ID;
const otherId = "00000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-000000000003";
const store = createPlatformServicesStore([eligibleId, otherId]);
const policy = {
  preferredLoginService: "siths" as const,
  roadProvider: "disabled" as const, geocodingProvider: "disabled" as const,
  smsProvider: "disabled" as const,
  emailEnabled: false, aiEnabled: false, cuoptEnabled: false, districtEnabled: false,
};
let server: Server;
let base: string;
type ServiceResponse = {
  organizationId: string;
  revision: number;
  policy: schema.OrganizationServicePolicy;
  sithsEligible: boolean;
  activeLoginService: string;
  loginConnectionStatus: string;
};

before(async () => {
  mock.module("@workspace/db", {
    namedExports: {
      ...schema, db: store.db,
      pool: new Proxy({}, { get() { throw new Error("Real database access is forbidden in this fixture"); } }),
    },
  });
  const { default: router } = await import("./routes/platform-services");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.header("X-Test-Actor");
    if (actor) req.user = {
      id: actorId, organizationId: eligibleId, role: "admin",
      isPlatformAdmin: actor === "platform",
      name: "Synthetic admin", email: "fixture@example.invalid", driverProfileId: null,
    };
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/platform/organizations`;
});

beforeEach(() => store.reset());
after(async () => {
  if (server) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  mock.restoreAll();
});

async function request(id: string, body?: unknown, actor = "platform", expectedStatus = 200) {
  const response = await fetch(`${base}/${id}/services`, {
    method: body === undefined ? "GET" : "PUT",
    headers: { "Content-Type": "application/json", Connection: "close",
      ...(actor ? { "X-Test-Actor": actor } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(result));
  if (expectedStatus === 200) assert.equal(response.headers.get("cache-control"), "no-store");
  return result as ServiceResponse;
}

function assertSithsStatus(body: Record<string, unknown>) {
  assert.equal(body.sithsEligible, true);
  assert.equal(body.loginConnectionStatus, "not_configured");
  assert.equal(body.activeLoginService, "password");
}

test("eligible customer persists SITHS, reads it back and keeps password active", async () => {
  const initial = await request(eligibleId);
  assert.equal(initial.revision, 0);
  assert.equal(initial.policy.preferredLoginService, "password");
  const saved = await request(eligibleId, { revision: 0, policy });
  assertSithsStatus(saved);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.policy, policy);
  const reread = await request(eligibleId);
  assert.deepEqual(reread, saved);
  const state = store.snapshot();
  assert.deepEqual(state.policies.get(eligibleId)?.policy, policy);
  assert.equal(state.policies.get(eligibleId)?.revision, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].organizationId, eligibleId);
  assert.equal(state.audits[0].userId, actorId);
  assert.equal(state.audits[0].action, "platform.organization.services.update");
  assert.deepEqual(state.audits[0].metadata, { revision: 1 });
  assert.deepEqual((state.audits[0].diff as { servicePolicy: { to: unknown } }).servicePolicy.to, policy);
  const other = await request(otherId);
  assert.equal(other.revision, 0);
  assert.equal(other.policy.preferredLoginService, "password");
  assert.equal(other.sithsEligible, false);
  assert.equal(state.policies.has(otherId), false);
});

test("legacy service edits omit the preference without resetting stored SITHS", async () => {
  await request(eligibleId, { revision: 0, policy });
  const { preferredLoginService: _omitted, ...legacy } = policy;
  const updated = { ...legacy, emailEnabled: true };
  const saved = await request(eligibleId, { revision: 1, policy: updated });
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.policy, { ...updated, preferredLoginService: "siths" });
  assertSithsStatus(saved);
  assert.deepEqual(await request(eligibleId), saved);
  const state = store.snapshot();
  assert.deepEqual(state.policies.get(eligibleId)?.policy, saved.policy);
  assert.equal(state.audits.length, 2);
  assert.deepEqual(state.audits[1].diff, { servicePolicy: { from: policy, to: saved.policy } });
});

test("stale revision cannot reset SITHS or write a policy or audit event", async () => {
  await request(eligibleId, { revision: 0, policy });
  const previous = store.snapshot();
  const writes = store.writeCount();
  await request(eligibleId, {
    revision: 0, policy: { ...policy, preferredLoginService: "password", emailEnabled: true },
  }, "platform", 409);
  assert.deepEqual(store.snapshot(), previous);
  assert.equal(store.writeCount(), writes);
  const reread = await request(eligibleId);
  assert.equal(reread.revision, 1);
  assert.deepEqual(reread.policy, policy);
  assertSithsStatus(reread);
});

test("ineligible customer cannot acquire SITHS and leaves no persistent or audit changes", async () => {
  await request(eligibleId, { revision: 0, policy });
  await request(otherId, { revision: 0, policy: { ...policy, preferredLoginService: "password" } });
  const previous = store.snapshot();
  const writes = store.writeCount();
  await request(otherId, { revision: 1, policy }, "platform", 400);
  assert.deepEqual(store.snapshot(), previous);
  assert.equal(store.writeCount(), writes);
  const reread = await request(otherId);
  assert.equal(reread.revision, 1);
  assert.equal(reread.policy.preferredLoginService, "password");
  assert.equal(reread.loginConnectionStatus, "active");
});

test("ordinary tenant admin and unauthenticated callers cannot read or mutate the eligible customer", async () => {
  await request(eligibleId, { revision: 0, policy });
  const previous = store.snapshot();
  const writes = store.writeCount();
  for (const [actor, status] of [["tenant", 403], ["", 401]] as const) {
    await request(eligibleId, undefined, actor, status);
    await request(eligibleId, {
      revision: 1, policy: { ...policy, preferredLoginService: "password" },
    }, actor, status);
    assert.deepEqual(store.snapshot(), previous);
    assert.equal(store.writeCount(), writes);
  }
  assertSithsStatus(await request(eligibleId));
});
