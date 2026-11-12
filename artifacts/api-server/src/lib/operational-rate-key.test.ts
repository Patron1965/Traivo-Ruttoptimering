import assert from "node:assert/strict";
import { test } from "node:test";
import { operationalRateKey } from "./operational-rate-key";

test("authenticated users sharing a gateway have separate budgets", () => {
  const req = { method: "GET", ip: "127.0.0.1", user: { id: "a", organizationId: "org" } };
  assert.notEqual(operationalRateKey(req), operationalRateKey({ ...req, user: { ...req.user, id: "b" } }));
  assert.notEqual(operationalRateKey(req), operationalRateKey({ ...req, method: "POST" }));
  assert.equal(operationalRateKey(req), operationalRateKey({ ...req, ip: "10.0.0.2" }));
  assert.notEqual(operationalRateKey(req), operationalRateKey({ ...req, user: { ...req.user, organizationId: "other" } }));
});

test("anonymous callers remain IP limited and cannot obtain separate read/write budgets", () => {
  assert.equal(operationalRateKey({ method: "GET", ip: "127.0.0.1" }), "127.0.0.1");
  assert.equal(operationalRateKey({ method: "POST", ip: "127.0.0.1" }), "127.0.0.1");
});
