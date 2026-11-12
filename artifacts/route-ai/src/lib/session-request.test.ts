import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession } from "./session-request.ts";

test("session read distinguishes valid, unauthorized and server failure", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  fetchMock.mock.mockImplementation(async () => Response.json({ user: { id: "test" } }));
  assert.deepEqual(await readSession("/api/auth/me"), { user: { id: "test" } });
  for (const status of [401, 403]) {
    fetchMock.mock.mockImplementation(async () => new Response(null, { status }));
    assert.equal(await readSession("/api/auth/me"), null);
  }
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(readSession("/api/auth/me"), /unavailable/);
});

test("hung session fetch is aborted", async (t) => {
  t.mock.method(globalThis, "fetch", (_url: string, options: RequestInit) =>
    new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
  await assert.rejects(readSession("/api/auth/me", 10), /aborted/);
});

test("timeout also covers a stalled response body", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
    }),
  }));
  await assert.rejects(readSession("/api/auth/me", 10), /body aborted/);
});
