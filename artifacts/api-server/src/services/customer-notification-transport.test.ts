import assert from "node:assert/strict";
import { test } from "node:test";
import { customerTransport, rejectionOutcome } from "./customer-notification-transport";
import { randomUUID } from "node:crypto";

test("only definitive request rejection allows another submission", () => {
  for (const status of [400, 401, 403, 422]) assert.equal(rejectionOutcome(status), "rejected");
  for (const status of [408, 409, 429, 500, 502, 503, 504, 200, 202]) assert.equal(rejectionOutcome(status), "unknown");
});

test("LINK transport never converts timeout, malformed acceptance or 5xx into retryable rejection", async () => {
  const values = {
    SMS_PROVIDER: "linkmobility", LINK_MOBILITY_API_VARIANT: "common",
    LINK_USERNAME: "synthetic", LINK_PASSWORD: "synthetic",
    LINK_PLATFORM_ID: "SMSC", LINK_PLATFORM_PARTNER_ID: "synthetic",
    LINK_GATE_ID: "synthetic", LINK_MOBILITY_SENDER: "Traivo",
    LINK_MOBILITY_BASE_URL: "https://n-eu.linkmobility.io/sms",
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const original = globalThis.fetch;
  const organizationId = randomUUID();
  let calls = 0;
  try {
    Object.assign(process.env, values);
    globalThis.fetch = async () => { calls++; throw new DOMException("Synthetic timeout", "TimeoutError"); };
    assert.equal(await customerTransport.sendSms("+46700000000", "Synthetic message", organizationId), "unknown");
    assert.equal(calls, 1, "transport never retries");
    for (const [response, expected] of [
      [Response.json({ resultCode: 1005, messageId: "synthetic" }), "sent"],
      [Response.json({ resultCode: 1005 }), "unknown"],
      [new Response("malformed"), "unknown"],
      [new Response("", { status: 503 }), "unknown"],
      [new Response("", { status: 403 }), "rejected"],
    ] as const) {
      globalThis.fetch = async () => response;
      assert.equal(await customerTransport.sendSms("+46700000000", "Synthetic message", organizationId), expected);
    }
    globalThis.fetch = async () => { throw new Error("Must not submit invalid SMS"); };
    assert.equal(await customerTransport.sendSms("invalid", "Synthetic", organizationId), "rejected");
    assert.equal(await customerTransport.sendSms("+46700000000", "x".repeat(460), organizationId), "rejected");
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
