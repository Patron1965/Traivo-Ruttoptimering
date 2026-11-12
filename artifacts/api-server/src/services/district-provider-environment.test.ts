import assert from "node:assert/strict";
import { test } from "node:test";
import { selectDistrictProviderEnvironment } from "./district-provider-environment";
import { configuredDistrictOsrmProvider } from "./district-solver";

const token = "a".repeat(64);
const development = {
  NODE_ENV: "development",
  DISTRICT_OSRM_BASE_URL: "https://district.example.invalid/",
  DISTRICT_OSRM_AUTH_TOKEN: token,
  OSRM_BASE_URL: "https://ordinary.example.invalid",
  OSRM_AUTH_TOKEN: "legacy-test-token",
};

const production = {
  NODE_ENV: "production",
  DISTRICT_PRODUCTION_OSRM_ENABLED: "true",
  DISTRICT_PRODUCTION_OSRM_BASE_URL: "https://national.example.invalid/datasets/frozen-version/",
  DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN: "b".repeat(64),
  OSRM_BASE_URL: development.OSRM_BASE_URL,
  OSRM_AUTH_TOKEN: development.OSRM_AUTH_TOKEN,
};

test("production district activation is authenticated, separate and leaves ordinary routing untouched", () => {
  const input = Object.freeze({ ...production, DISTRICT_OSRM_BASE_URL: development.DISTRICT_OSRM_BASE_URL });
  assert.deepEqual(selectDistrictProviderEnvironment(input), {
    baseUrl: "https://national.example.invalid/datasets/frozen-version",
    authTokenEnv: "DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN",
    token: production.DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN,
    requiresAuth: true,
  });
  assert.equal(input.OSRM_BASE_URL, development.OSRM_BASE_URL);
  assert.equal(input.OSRM_AUTH_TOKEN, development.OSRM_AUTH_TOKEN);
});

test("staged production URL and token cannot activate without explicit true in production", () => {
  for (const DISTRICT_PRODUCTION_OSRM_ENABLED of [undefined, "false"]) {
    assert.equal(selectDistrictProviderEnvironment({ ...production, DISTRICT_PRODUCTION_OSRM_ENABLED })?.baseUrl,
      development.OSRM_BASE_URL);
  }
  for (const NODE_ENV of ["development", "test", undefined]) {
    assert.equal(selectDistrictProviderEnvironment({ ...production, NODE_ENV })?.baseUrl,
      development.OSRM_BASE_URL);
  }
  assert.equal(selectDistrictProviderEnvironment({
    NODE_ENV: "production",
    DISTRICT_PRODUCTION_OSRM_BASE_URL: production.DISTRICT_PRODUCTION_OSRM_BASE_URL,
    DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN: production.DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN,
  }), undefined);
});

test("invalid production activation fails closed without leaking URLs or credentials", () => {
  for (const DISTRICT_PRODUCTION_OSRM_ENABLED of ["", "1", "TRUE", "true "]) {
    assert.throws(() => selectDistrictProviderEnvironment({ ...production, DISTRICT_PRODUCTION_OSRM_ENABLED }),
      /aktiveringsval/);
  }
  for (const DISTRICT_PRODUCTION_OSRM_BASE_URL of [
    undefined, "", "invalid", "http://national.example.invalid",
    "https://user:password@national.example.invalid", "https://router.project-osrm.org",
    "https://national.example.invalid?token=secret", "https://national.example.invalid#secret",
  ]) {
    assert.throws(() => selectDistrictProviderEnvironment({ ...production, DISTRICT_PRODUCTION_OSRM_BASE_URL }),
      (error: unknown) => error instanceof Error && !/password|secret|national\.example/.test(error.message));
  }
  for (const DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN of [undefined, "", "short", token + "\n"]) {
    assert.throws(() => selectDistrictProviderEnvironment({ ...production, DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN }),
      (error: unknown) => error instanceof Error && /åtkomstnyckel/.test(error.message) &&
        !error.message.includes(token));
  }
});

test("production Table and geometry send the dedicated token only in headers, not URLs", async () => {
  const previous = new Map(Object.keys(production).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests: { url: string; authorization: string | null; redirect?: string }[] = [];
  try {
    Object.assign(process.env, production);
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), authorization: new Headers(options?.headers).get("Authorization"),
        redirect: options?.redirect });
      return new Response(JSON.stringify({
        code: "Ok", distances: [[0]], durations: [[0]],
        sources: [{ location: [18.0686, 59.3293] }], destinations: [{ location: [18.0686, 59.3293] }],
        routes: [{ geometry: { coordinates: [[18.0686, 59.3293]] } }],
        waypoints: [{ location: [18.0686, 59.3293] }],
      }), { headers: { "Content-Type": "application/json" } });
    };
    const points = [{ latitude: 59.3293, longitude: 18.0686 }];
    const provider = configuredDistrictOsrmProvider();
    await provider.table(points, points, new AbortController().signal);
    await provider.route(points, new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.url.startsWith("https://national.example.invalid/datasets/frozen-version/")));
    assert.ok(requests.every(r => r.authorization === `Bearer ${production.DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN}`));
    assert.ok(requests.every(r => r.redirect === "error" && !r.url.includes(production.DISTRICT_PRODUCTION_OSRM_AUTH_TOKEN)));
    assert.equal(process.env.OSRM_BASE_URL, development.OSRM_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("native loopback override is development-only and leaves ordinary routing unchanged", () => {
  const ordinary="https://ordinary.example.invalid";
  const input=Object.freeze({NODE_ENV:"development",OSRM_BASE_URL:ordinary,
    DISTRICT_LOCAL_OSRM_BASE_URL:"http://127.0.0.1:5001"});
  assert.equal(selectDistrictProviderEnvironment(input)?.baseUrl,"http://127.0.0.1:5001");
  assert.equal(selectDistrictProviderEnvironment(input)?.requiresAuth,false);
  assert.equal(input.OSRM_BASE_URL,ordinary);
  for(const NODE_ENV of ["test","production",undefined]) {
    assert.equal(selectDistrictProviderEnvironment({...input,NODE_ENV})?.baseUrl,ordinary);
    assert.equal(selectDistrictProviderEnvironment({NODE_ENV,DISTRICT_LOCAL_OSRM_BASE_URL:input.DISTRICT_LOCAL_OSRM_BASE_URL}),undefined);
  }
  assert.equal(selectDistrictProviderEnvironment({...development,
    DISTRICT_LOCAL_OSRM_BASE_URL:input.DISTRICT_LOCAL_OSRM_BASE_URL})?.baseUrl,development.DISTRICT_OSRM_BASE_URL.replace(/\/$/,""));
});

test("native override cannot open the development pilot to external or credential-bearing HTTP", () => {
  for(const baseUrl of ["http://0.0.0.0:5001","http://localhost:5001","http://routing.invalid:5001",
    "http://127.0.0.1:5002","https://127.0.0.1:5001","http://user:password@127.0.0.1:5001",
    "http://127.0.0.1:5001/path","http://127.0.0.1:5001?token=x","http://127.0.0.1:5001#x","bad"]) {
    assert.throws(()=>selectDistrictProviderEnvironment({NODE_ENV:"development",
      DISTRICT_LOCAL_OSRM_BASE_URL:baseUrl}),/lokala utvecklingsserver/);
  }
});

test("district override does not modify ordinary routing environment", () => {
  const input = Object.freeze({ ...development });
  const selected = selectDistrictProviderEnvironment(input);
  assert.equal(selected?.baseUrl, "https://district.example.invalid");
  assert.equal(selected?.authTokenEnv, "DISTRICT_OSRM_AUTH_TOKEN");
  assert.equal(selected?.token, token);
  assert.equal(selected?.requiresAuth, true);
  assert.equal(input.OSRM_BASE_URL, "https://ordinary.example.invalid");
  assert.equal(input.OSRM_AUTH_TOKEN, "legacy-test-token");
});

test("production, test and unspecified modes ignore development override", () => {
  for (const NODE_ENV of ["production", "test", undefined]) {
    const selected = selectDistrictProviderEnvironment({ ...development, NODE_ENV });
    assert.equal(selected?.baseUrl, development.OSRM_BASE_URL);
    assert.equal(selected?.authTokenEnv, "OSRM_AUTH_TOKEN");
    assert.equal(selected?.token, "legacy-test-token");
    assert.equal(selected?.requiresAuth, false);
  }
  assert.equal(selectDistrictProviderEnvironment({
    NODE_ENV: "production", DISTRICT_OSRM_BASE_URL: development.DISTRICT_OSRM_BASE_URL,
    DISTRICT_OSRM_AUTH_TOKEN: token,
  }), undefined);
});

test("unconfigured district development keeps legacy behavior", () => {
  assert.equal(selectDistrictProviderEnvironment({ NODE_ENV: "development" }), undefined);
  assert.deepEqual(selectDistrictProviderEnvironment({
    NODE_ENV: "development", OSRM_BASE_URL: development.OSRM_BASE_URL,
  }), {
    baseUrl: development.OSRM_BASE_URL, authTokenEnv: "OSRM_AUTH_TOKEN",
    token: undefined, requiresAuth: false,
  });
});

test("explicit invalid development overrides fail closed without legacy fallback or secret disclosure", () => {
  for (const DISTRICT_OSRM_AUTH_TOKEN of [undefined, "", "short", token + "\n"]) {
    assert.throws(
      () => selectDistrictProviderEnvironment({ ...development, DISTRICT_OSRM_AUTH_TOKEN }),
      (error: unknown) => error instanceof Error &&
        /åtkomstnyckel/.test(error.message) && !error.message.includes(token),
    );
  }
  for (const DISTRICT_OSRM_BASE_URL of [
    "", "http://district.example.invalid", "https://user:password@district.example.invalid",
    "https://district.example.invalid/?token=secret", "https://district.example.invalid/#secret",
    "https://router.project-osrm.org",
  ]) {
    assert.throws(() => selectDistrictProviderEnvironment({
      ...development, DISTRICT_OSRM_BASE_URL,
    }));
  }
});

test("configured district provider uses authenticated override for Table and road geometry", async () => {
  const keys = Object.keys(development);
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const requests: { url: string; authorization: string | null }[] = [];
  try {
    Object.assign(process.env, development);
    globalThis.fetch = async (url, options) => {
      requests.push({
        url: String(url), authorization: new Headers(options?.headers).get("Authorization"),
      });
      return new Response(JSON.stringify({
        code: "Ok", distances: [[0]], durations: [[0]],
        sources:[{location:[11.97,57.7]}],destinations:[{location:[11.97,57.7]}],
        routes: [{ geometry: { coordinates: [[11.97, 57.7]] } }],
        waypoints: [{ location: [11.97, 57.7] }],
      }), { headers: { "Content-Type": "application/json" } });
    };
    const points = [{ latitude: 57.7, longitude: 11.97 }];
    const provider = configuredDistrictOsrmProvider();
    await provider.table(points, points, new AbortController().signal);
    await provider.route(points, new AbortController().signal);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.url.startsWith("https://district.example.invalid/")));
    assert.ok(requests.every(r => r.authorization === `Bearer ${token}`));
    assert.ok(requests.every(r => !r.url.includes(token)));
    assert.equal(process.env.OSRM_BASE_URL, development.OSRM_BASE_URL);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});