import assert from "node:assert/strict";
import { test } from "node:test";
import { commonSmsConfiguration, sendCommonSms } from "./link-common-sms";

test("Common notification adapter uses confirmed account identifiers and delivery gate", async () => {
  const values = {
    LINK_USERNAME: "synthetic", LINK_PASSWORD: "synthetic",
    LINK_PLATFORM_ID: "SMSC", LINK_PLATFORM_PARTNER_ID: "synthetic-partner",
    LINK_GATE_ID: "synthetic-gate", LINK_MOBILITY_SENDER: "Traivo",
    LINK_MOBILITY_BASE_URL: "https://n-eu.linkmobility.io/sms",
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const original = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, values);
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), "https://n-eu.linkmobility.io/sms/send");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.platformId, "SMSC");
      assert.equal(body.platformPartnerId, "synthetic-partner");
      assert.equal(body.useDeliveryReport, true);
      assert.deepEqual(body.deliveryReportGates, ["synthetic-gate"]);
      return Response.json({ resultCode: 1005, messageId: "synthetic" });
    };
    assert.equal(await sendCommonSms("+46700000000", "Internal test"), true);
    delete process.env.LINK_GATE_ID;
    assert.equal(commonSmsConfiguration(), null);
    assert.equal(await sendCommonSms("+46700000000", "Internal test"), false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
