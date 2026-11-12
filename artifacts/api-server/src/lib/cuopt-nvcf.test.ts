import { test } from "node:test";
import assert from "node:assert/strict";
import { cuoptConfiguration, testCuoptConnection } from "./cuopt-nvcf";

const id = "11111111-1111-4111-8111-111111111111";
const version = "22222222-2222-4222-8222-222222222222";
const config = { NVIDIA_CUOPT_API_KEY: "private-test-token", CUOPT_FUNCTION_ID: id, CUOPT_FUNCTION_VERSION_ID: version };
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("presence status never attempts a network call or reveals credentials", () => {
  const status = cuoptConfiguration(config);
  assert.equal(status.state, "not_checked");
  assert.equal(status.keyPresent, true);
  assert.equal(JSON.stringify(status).includes(config.NVIDIA_CUOPT_API_KEY), false);
  assert.equal(cuoptConfiguration({}).state, "missing_config");
  assert.equal(cuoptConfiguration({ ...config, CUOPT_FUNCTION_ID: "../../x" }).state, "invalid_config");
});

test("metadata probe uses only fixed GET endpoint and bearer header, no solve", async () => {
  let requests = 0;
  const mock = (async (url: string | URL | Request, init?: RequestInit) => {
    requests++;
    assert.equal(url, `https://api.nvcf.nvidia.com/v2/nvcf/functions/${id}/versions/${version}?includeSecrets=false`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${config.NVIDIA_CUOPT_API_KEY}`);
    assert.ok(init?.signal);
    return reply({ function: { id, versionId: version, status: "ACTIVE", name: "not necessarily cuOpt" } });
  }) as typeof fetch;
  const result = await testCuoptConnection(config, mock);
  assert.equal(result.state, "metadata_active");
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(result).includes("private-test-token"), false);
});

test("version omitted requires a matching active version in list response", async () => {
  const noVersion = { ...config, CUOPT_FUNCTION_VERSION_ID: undefined };
  const mock = (async (url: string | URL | Request) => {
    assert.equal(url, `https://api.nvcf.nvidia.com/v2/nvcf/functions/${id}/versions`);
    return reply({ functions: [{ id, versionId: version, status: "INACTIVE" }, { id, versionId: version, status: "ACTIVE" }] });
  }) as typeof fetch;
  assert.equal((await testCuoptConnection(noVersion, mock)).state, "metadata_active");
  assert.equal((await testCuoptConnection(noVersion, (async () => reply({ functions: [] })) as typeof fetch)).state, "metadata_inactive");
});

test("rejects mismatched and malformed metadata, inaccessible and inactive versions", async () => {
  for (const [body, state] of [
    [{ function: { id: version, versionId: version, status: "ACTIVE" } }, "invalid_response"],
    [{ function: { id, versionId: version, status: "INACTIVE" } }, "metadata_inactive"],
    [{ function: { id, versionId: id, status: "ACTIVE" } }, "invalid_response"],
    [{ function: { id, versionId: version } }, "invalid_response"],
    [{ error: "private-test-token" }, "invalid_response"],
  ] as const) {
    assert.equal((await testCuoptConnection(config, (async () => reply(body)) as typeof fetch)).state, state);
  }
  for (const [code, state] of [[401, "auth_failed"], [403, "auth_failed"], [404, "not_found"], [503, "unavailable"]] as const) {
    assert.equal((await testCuoptConnection(config, (async () => reply({ secret: "private-test-token" }, code)) as typeof fetch)).state, state);
  }
});

test("does not leak upstream errors; malformed config does not issue requests", async () => {
  const mock = (async () => { throw new Error("private-test-token upstream body"); }) as typeof fetch;
  const result = await testCuoptConnection(config, mock);
  assert.equal(result.state, "unavailable");
  assert.equal(JSON.stringify(result).includes("private-test-token"), false);
  assert.equal((await testCuoptConnection({ ...config, CUOPT_FUNCTION_VERSION_ID: "https://evil.example/" }, mock)).state, "invalid_config");
  assert.equal((await testCuoptConnection(config, (async () => { throw new DOMException("Timed out", "TimeoutError"); }) as typeof fetch)).state, "timeout");
  assert.equal((await testCuoptConnection(config, (async () => new Response("not json")) as typeof fetch)).state, "invalid_response");
});