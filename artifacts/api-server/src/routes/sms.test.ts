import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { once } from "node:events";
import { authorizeWrite } from "../middleware/auth";
import smsRouter from "./sms";

test("SMS endpoint validates, gates roles, and handles provider failures without exposing payloads", async () => {
  const keys = ["LINK_USERNAME", "LINK_PASSWORD", "LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID", "LINK_GATE_ID"];
  const saved = keys.map((key) => process.env[key]);
  const originalFetch = globalThis.fetch;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!req.headers["x-test-role"]) { res.sendStatus(401); return; }
    req.user = {
      role: req.headers["x-test-role"], organizationId: String(req.headers["x-test-org"] ?? "test"),
    } as typeof req.user;
    next();
  });
  app.use(authorizeWrite());
  app.use(smsRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const body = { source: "Traivo", destination: "+46700000000", userData: "Test" };
  const request = (role: string, payload = body, org = "test") =>
    originalFetch(`http://127.0.0.1:${address.port}/send-sms`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-test-role": role, "x-test-org": org },
      body: JSON.stringify(payload),
    });
  try {
    for (const key of keys) delete process.env[key];
    assert.equal((await request("")).status, 401);
    for (const role of ["viewer", "driver", "dispatcher"]) {
      assert.equal((await request(role)).status, 403);
    }
    assert.equal((await request("admin")).status, 503);
    assert.equal((await request("admin", { ...body, source: "toolongsendername" })).status, 400);
    assert.equal((await request("admin", { ...body, destination: "0700000000" })).status, 400);
    assert.equal((await request("admin", { ...body, userData: " " })).status, 400);
    for (const key of keys) process.env[key] = "synthetic";
    globalThis.fetch = async () => new Response(null, { status: 202 });
    const accepted = await request("admin");
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { status: "accepted" });
    assert.equal((await request("admin")).status, 429);
    globalThis.fetch = async () => new Response("sensitive upstream response", { status: 401 });
    const failed = await request("admin", body, "other-test");
    assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes("sensitive"));
    globalThis.fetch = async () => { throw new Error("sensitive exception"); };
    assert.equal((await request("admin", body, "other-test")).status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
    server.close();
  }
});
