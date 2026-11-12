import assert from "node:assert/strict";
import test from "node:test";
import { classifyDriverLinkError, createSingleFlight, parseAccessFragment, parseAccessUrl } from "./driver-link.ts";

const TOKEN = "a".repeat(40) + "_-Z";

test("parses only a 43-char fragment token", () => {
  assert.equal(parseAccessFragment(`#access=${TOKEN}`), TOKEN);
  assert.equal(parseAccessFragment(`x=1&access=${TOKEN}`), TOKEN);
  assert.equal(parseAccessFragment("#access=short"), null);
  assert.equal(parseAccessFragment(""), null);
  assert.equal(parseAccessUrl(`https://h/activate?access=${TOKEN}`), null);
  assert.equal(parseAccessUrl(`driver-app://activate#access=${TOKEN}`), TOKEN);
});

test("strict-mode double effects redeem once and never retry failures", async () => {
  const once = createSingleFlight<string>();
  let calls = 0;
  const run = async () => { calls++; return "route-7"; };
  const [a, b] = await Promise.all([once(TOKEN, run), once(TOKEN, run)]);
  assert.equal(a, "route-7"); assert.equal(b, "route-7"); assert.equal(calls, 1);
  let failCalls = 0;
  const fail = () => { failCalls++; return Promise.reject(Object.assign(new Error("x"), { status: 0 })); };
  await assert.rejects(once("t2", fail));
  await assert.rejects(once("t2", fail));
  assert.equal(failCalls, 1);
});

test("classifies errors", () => {
  assert.equal(classifyDriverLinkError({ status: 401, code: "DRIVER_LINK_INVALID" }), "invalid");
  assert.equal(classifyDriverLinkError({ status: 403, code: "DRIVER_ACCESS_UNAVAILABLE" }), "unavailable");
  assert.equal(classifyDriverLinkError({ status: 0 }), "network");
  assert.equal(classifyDriverLinkError({ status: 500 }), "generic");
});
