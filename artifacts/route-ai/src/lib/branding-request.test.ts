import { test } from "node:test";
import assert from "node:assert/strict";
import { brandingRequest } from "./branding-request";

test("branding requests carry session credentials and preserve write payloads", async (t) => {
  const calls: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response("{}", { status: 200 });
  });
  for (const method of ["GET", "PUT", "POST", "DELETE"]) {
    const body = method === "PUT" || method === "POST" ? '{"displayName":"Example"}' : undefined;
    await brandingRequest("/api/branding", { method, body });
    assert.deepEqual(calls.at(-1), { method, body, credentials: "include" });
  }
});

test("expired session gives recovery guidance without retrying a write", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
  await assert.rejects(brandingRequest("/api/branding", { method: "PUT" }), /Logga in igen i en ny flik/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("role denial is distinguished from an expired session", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 403 }));
  await assert.rejects(brandingRequest("/api/branding"), /administratör/);
});

test("other responses remain available for endpoint-specific error handling", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":"Invalid logo"}', { status: 400 }));
  const response = await brandingRequest("/api/branding/logo");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid logo" });
});