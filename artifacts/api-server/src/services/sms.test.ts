import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { isSmsConfigured, normalizePhone, sendSms } from "./sms";
import { isValidLinkSender } from "./link-sms";
import { validateCustomerServiceProviders } from "../routes/platform-services";
import { DEFAULT_ORGANIZATION_SERVICE_POLICY } from "./organization-service-policy";

const smsEnvKeys = [
  "SMS_PROVIDER",
  "LINK_MOBILITY_API_TOKEN",
  "LINK_USERNAME",
  "LINK_PASSWORD",
  "LINK_PLATFORM_ID",
  "LINK_PLATFORM_PARTNER_ID",
  "LINK_GATE_ID",
  "LINK_MOBILITY_SENDER",
  "LINK_MOBILITY_API_VARIANT", "LINK_MOBILITY_BASE_URL",
  "LINK_USERNAME", "LINK_PASSWORD", "LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "ELKS_API_USERNAME",
  "ELKS_API_PASSWORD",
  "ELKS_FROM_NUMBER",
] as const;

const originalEnv = Object.fromEntries(smsEnvKeys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of smsEnvKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of smsEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
});

function configureCommon() {
  Object.assign(process.env, {
    SMS_PROVIDER: "linkmobility", LINK_MOBILITY_API_VARIANT: "common",
    LINK_MOBILITY_BASE_URL: "https://n-eu.linkmobility.io/sms",
    LINK_USERNAME: "test-user", LINK_PASSWORD: "test-password",
    LINK_PLATFORM_ID: "test-platform", LINK_PLATFORM_PARTNER_ID: "test-partner",
    LINK_MOBILITY_SENDER: "Traivo", LINK_GATE_ID: "test-gate",
  });
}

test("Common uses the assigned endpoint, basic auth and confirmed platform IDs", async () => {
  configureCommon();
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://n-eu.linkmobility.io/sms/send");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("Authorization"),
      `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      source: "Traivo", sourceTON: "ALPHANUMERIC", destination: "+46701234567",
      destinationTON: "MSISDN", userData: "Test", dcs: "TEXT",
      platformId: "test-platform", platformPartnerId: "test-partner",
      useDeliveryReport: true, deliveryReportGates: ["test-gate"], ignoreResponse: false, tariff: 0,
    });
    return Response.json({ resultCode: 1005, messageId: "test-message" });
  };
  assert.equal(isSmsConfigured(), true);
  assert.equal(await sendSms("0701234567", "Test"), true);
});

test("Common fails closed without IDs even if MyLINK credentials are available", async () => {
  configureCommon();
  delete process.env.LINK_PLATFORM_ID;
  process.env.LINK_MOBILITY_API_TOKEN = "do-not-use";
  globalThis.fetch = async () => { throw new Error("must not send"); };
  assert.equal(isSmsConfigured(), false);
  assert.equal(await sendSms("0701234567", "Test"), false);
});

test("Common refuses non-allowlisted destinations and invalid sender", () => {
  configureCommon();
  for (const url of ["http://n-eu.linkmobility.io/sms", "https://example.test/sms",
    "https://n-eu.linkmobility.io/sms?redirect=1", "https://user:pass@n-eu.linkmobility.io/sms"]) {
    process.env.LINK_MOBILITY_BASE_URL = url;
    assert.equal(isSmsConfigured(), false);
  }
  process.env.LINK_MOBILITY_BASE_URL = "https://n-eu.linkmobility.io/sms";
  process.env.LINK_MOBILITY_SENDER = "123";
  assert.equal(isSmsConfigured(), false);
});

test("Common requires an explicit acceptance response, not just HTTP success", async () => {
  configureCommon();
  for (const body of [{ resultCode: 106 }, { messageId: "x" }, { resultCode: 1005 }, null]) {
    globalThis.fetch = async () => Response.json(body);
    assert.equal(await sendSms("0701234567", "Test"), false);
  }
  for (const status of [204, 401, 403, 429, 500]) {
    globalThis.fetch = async () => new Response(null, { status });
    assert.equal(await sendSms("0701234567", "Test"), false);
  }
});

test("Common never retries an ambiguous network failure", async () => {
  configureCommon();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("timeout"); };
  assert.equal(await sendSms("0701234567", "Test"), false);
  assert.equal(calls, 1);
});

test("normalizes Swedish and international phone numbers", () => {
  assert.equal(normalizePhone("070-123 45 67"), "+46701234567");
  assert.equal(normalizePhone("0046 (70) 123-45-67"), "+46701234567");
  assert.equal(normalizePhone("+46 70 123 45 67"), "+46701234567");
});

test("does not silently fall back when LINK Mobility is selected without credentials", async () => {
  process.env.SMS_PROVIDER = "linkmobility";
  delete process.env.LINK_MOBILITY_API_TOKEN;
  delete process.env.LINK_MOBILITY_SENDER;
  process.env.TWILIO_ACCOUNT_SID = "legacy";
  process.env.TWILIO_AUTH_TOKEN = "legacy";
  process.env.TWILIO_FROM_NUMBER = "+461234";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };

  assert.equal(isSmsConfigured(), false);
  assert.equal(await sendSms("0701234567", "Test"), false);
  assert.equal(called, false);
});

test("sends the Common API message contract with Basic Auth", async () => {
  process.env.SMS_PROVIDER = "linkmobility";
  process.env.LINK_USERNAME = "test-user";
  process.env.LINK_PASSWORD = "test-password";
  process.env.LINK_PLATFORM_ID = "SMSC";
  process.env.LINK_PLATFORM_PARTNER_ID = "test-partner";
  process.env.LINK_GATE_ID = "test-gate";
  process.env.LINK_MOBILITY_SENDER = "Traivo";
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify([{ messageId: "test-id" }]), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  assert.equal(isSmsConfigured(), true);
  assert.equal(await sendSms("070-123 45 67", "Öppna rutten: https://example.test/driver-app/?routeId=1"), true);
  assert.equal(request?.url, "https://n-eu.linkmobility.io/sms/send");
  assert.equal(new Headers(request?.init?.headers).get("Authorization"),
    `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    source: "Traivo",
    sourceTON: "ALPHANUMERIC",
    destination: "+46701234567",
    userData: "Öppna rutten: https://example.test/driver-app/?routeId=1",
    platformId: "SMSC",
    platformPartnerId: "test-partner",
    useDeliveryReport: true,
    deliveryReportGates: ["test-gate"],
  });
});

test("organization provider validation accepts Common API credentials without a MyLINK token", () => {
  for (const key of ["LINK_USERNAME", "LINK_PASSWORD", "LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID", "LINK_GATE_ID"]) {
    process.env[key] = "synthetic";
  }
  delete process.env.LINK_MOBILITY_API_TOKEN;
  process.env.LINK_MOBILITY_SENDER = "Traivo";
  process.env.SMS_PROVIDER = "linkmobility";
  const policy = { ...DEFAULT_ORGANIZATION_SERVICE_POLICY, smsProvider: "linkmobility" as const };
  assert.equal(validateCustomerServiceProviders(policy), null);
  assert.equal(isSmsConfigured(), true);
  process.env.LINK_MOBILITY_SENDER = "123";
  assert.notEqual(validateCustomerServiceProviders(policy), null);
  assert.equal(isSmsConfigured(), false);
  process.env.LINK_MOBILITY_SENDER = "Traivo";
  delete process.env.LINK_GATE_ID;
  assert.notEqual(validateCustomerServiceProviders(policy), null);
  assert.equal(isSmsConfigured(), false);
});

test("sender follows LINK's documented letter-first, 2–11 character format", () => {
  for (const source of ["Traivo", "Ab", "A1234567890"]) assert.equal(isValidLinkSender(source), true);
  for (const source of ["1Traivo", "A", "", "A12345678901", "Traivo AB"]) {
    assert.equal(isValidLinkSender(source), false);
  }
});

test("missing account identifiers block sends before contacting LINK", async () => {
  process.env.SMS_PROVIDER = "linkmobility";
  process.env.LINK_USERNAME = "synthetic";
  process.env.LINK_PASSWORD = "synthetic";
  process.env.LINK_GATE_ID = "synthetic";
  process.env.LINK_MOBILITY_SENDER = "Traivo";
  globalThis.fetch = async () => { assert.fail("must not contact provider"); };
  for (const key of ["LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID"]) {
    process.env.LINK_PLATFORM_ID = "SMSC";
    process.env.LINK_PLATFORM_PARTNER_ID = "test-partner";
    delete process.env[key];
    assert.equal(isSmsConfigured(), false);
    assert.equal(await sendSms("0701234567", "Test"), false);
  }
});
