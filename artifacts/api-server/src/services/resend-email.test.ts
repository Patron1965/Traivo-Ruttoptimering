import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { boundedEmailRequest, sendRecoveryEmailDetailed, checkRecoveryEmailDelivery } from "./resend-email";

test("code email diagnostics retain only safe evidence and never retry", async () => {
  const id = "12345678-1234-1234-1234-123456789012";
  let calls = 0;
  let response = new Response(JSON.stringify({ id, html: "SECRET" }), { status: 200 });
  const proxy = mock.method(ReplitConnectors.prototype, "proxy", async () => { calls++; return response; });
  const payload = { to: "test@example.invalid", subject: "SECRET", html: "SECRET" };
  try {
    assert.deepEqual(await sendRecoveryEmailDetailed(payload), { outcome: "accepted", httpStatus: 200, providerId: id });
    response = new Response(JSON.stringify({ message: "SECRET" }), { status: 403 });
    assert.deepEqual(await sendRecoveryEmailDetailed(payload), { outcome: "rejected", httpStatus: 403 });
    response = new Response("SECRET", { status: 503 });
    assert.deepEqual(await sendRecoveryEmailDetailed(payload), { outcome: "unknown", httpStatus: 503 });
    assert.equal(calls, 3);
    response = new Response(JSON.stringify({ id, last_event: "delivered", html: "SECRET" }));
    assert.equal(await checkRecoveryEmailDelivery(id), "delivered");
    response = new Response(JSON.stringify({ id, last_event: "sent" }));
    assert.equal(await checkRecoveryEmailDelivery(id), "unconfirmed");
    response = new Response("SECRET", { status: 401 });
    assert.equal(await checkRecoveryEmailDelivery(id), "unavailable");
    const before = calls;
    assert.equal(await checkRecoveryEmailDelivery("invalid/SECRET"), "unavailable");
    assert.equal(calls, before);
    proxy.mock.mockImplementation(async () => { calls++; throw new Error("SECRET"); });
    assert.deepEqual(await sendRecoveryEmailDetailed(payload), { outcome: "unknown" });
    const count = calls;
    assert.equal(await boundedEmailRequest(() => new Promise(() => {}), "timeout", 1), "timeout");
    assert.equal(calls, count);
  } finally { proxy.mock.restore(); }
});
