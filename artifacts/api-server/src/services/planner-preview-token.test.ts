import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePlannerToken, readPlannerToken } from "./planner-preview-token";

test("confirmation token binds exact preview, tenant, actor and expiry", () => {
  const token = issuePlannerToken("org-a", "actor-a", { input: { targetIndex: 3 }, digest: "facts" }, 1000);
  assert.deepEqual(readPlannerToken(token, "org-a", "actor-a", 1001), {
    input: { targetIndex: 3 }, digest: "facts",
  });
  assert.throws(() => readPlannerToken(token, "org-b", "actor-a", 1001));
  assert.throws(() => readPlannerToken(token, "org-a", "actor-b", 1001));
  assert.throws(() => readPlannerToken(token, "org-a", "actor-a", 601000));
});

test("tampered input, malformed signature and extra segments fail closed", () => {
  const token = issuePlannerToken("org", "actor", { targetIndex: 0 }, 1000);
  const [, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ organizationId: "org", userId: "actor",
    expiresAt: 99999999, value: { targetIndex: 7 } })).toString("base64url");
  for (const bad of [`${forged}.${signature}`, `${token}.extra`, "bad.token", "", "x."]) {
    assert.throws(() => readPlannerToken(bad, "org", "actor", 1001));
  }
});
