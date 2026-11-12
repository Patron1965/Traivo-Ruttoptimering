import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { db } from "@workspace/db";
import {
  DEFAULT_ORGANIZATION_SERVICE_POLICY as defaults,
  loadOrganizationServicePolicy,
  currentOrganizationServicePolicy,
  assertOrganizationServiceEnabled,
  assertOrganizationDistrictAllowed,
  withOrganizationServicePolicy,
  type OrganizationServicePolicy,
} from "./organization-service-policy";
import { runWithUsageContext, getUsageContext } from "./usage-context";
import { operationalProviderKind, operationalProviderCacheKey } from "./operational-provider-config";
import { getCachedOsrmDistance, getOsrmDistance, precomputeDistanceMatrix } from "./osrm";
import { fetchGeoapifyRoute } from "./geoapify-road";
import { geocodeDetailed, reverseGeocode } from "./geocoding";
import { sendSms, configuredProvider } from "./sms";
import { sendEmail } from "./email";
import { enrichInsightsWithAI } from "./insights";
import { resolveBoundRoutingProvider } from "./routing-provider-config";
import { roadArrival } from "./customer-live-tracking";

const orgA = "c0110000-0000-4000-8000-000000000001";
const orgB = "c0110000-0000-4000-8000-000000000002";
const disabled = (error: unknown) => error instanceof Error &&
  "code" in error && error.code === "ORGANIZATION_SERVICE_DISABLED";
const unavailable = (error: unknown) => error instanceof Error &&
  "code" in error && error.code === "ORGANIZATION_SERVICE_POLICY_UNAVAILABLE";

function scoped<T>(organizationId: string, policy: Partial<OrganizationServicePolicy>, fn: () => T): T {
  return runWithUsageContext({ organizationId, servicePolicy: { ...defaults, ...policy } }, fn);
}
function policyRows(rows: unknown[]) {
  return mock.method(db, "select", () => ({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  }) as unknown as ReturnType<typeof db.select>);
}
let networkCalls = 0;
beforeEach(() => {
  networkCalls = 0;
  // Never allow these tests to reach any real external integration.
  mock.method(globalThis, "fetch", async () => {
    networkCalls++;
    throw new Error("External traffic is prohibited in policy tests");
  });
  mock.method(db, "insert", () => ({
    values: () => ({ onConflictDoNothing: async () => undefined }),
  }) as unknown as ReturnType<typeof db.insert>);
});
afterEach(() => mock.restoreAll());

test("missing policy rows preserve other services but require district opt-in", async () => {
  const reads = policyRows([]);
  const policy = await loadOrganizationServicePolicy(orgA);
  assert.deepEqual(policy, defaults);
  assert.equal(policy.districtEnabled, false);
  assert.equal(policy.emailEnabled && policy.aiEnabled && policy.cuoptEnabled, true);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(reads.mock.callCount(), 1);
  assert.equal(networkCalls, 0);
});

test("lookup failures and malformed persisted policies fail closed, never inherit", async () => {
  const reads = mock.method(db, "select", () => { throw new Error("database unavailable"); });
  await assert.rejects(loadOrganizationServicePolicy(orgA), unavailable);
  reads.mock.restore();
  policyRows([{ policy: { roadProvider: "inherit" } }]);
  await assert.rejects(loadOrganizationServicePolicy(orgA), unavailable);
  assert.equal(networkCalls, 0);
});

test("parallel request snapshots preserve tenant/provider isolation without environment changes", async () => {
  const before = { ...process.env };
  const [a, b] = await Promise.all([
    scoped(orgA, { roadProvider: "geoapify" }, async () => {
      await Promise.resolve();
      return [operationalProviderKind(), operationalProviderCacheKey()];
    }),
    scoped(orgB, { roadProvider: "osrm" }, async () => {
      await Promise.resolve();
      return [operationalProviderKind(), operationalProviderCacheKey()];
    }),
  ]);
  assert.equal(a[0], "geoapify");
  assert.equal(b[0], "osrm");
  assert.notEqual(a[1], b[1]);
  assert.notEqual(scoped(orgA, { roadProvider: "osrm" }, operationalProviderCacheKey), b[1]);
  assert.deepEqual({ ...process.env }, before);
});

test("known-tenant usage-only async callers hydrate; sync consumers fail explicitly until hydrated", async () => {
  policyRows([{ policy: { ...defaults, geocodingProvider: "disabled" } }]);
  await runWithUsageContext({ organizationId: orgA }, async () => {
    assert.throws(currentOrganizationServicePolicy, unavailable);
    await assert.rejects(geocodeDetailed("Policygatan 12, Stockholm"), disabled);
    assert.equal(currentOrganizationServicePolicy().geocodingProvider, "disabled");
  });
  assert.equal(networkCalls, 0);
});

test("road disable blocks synchronous cache access, routes, matrices and direct Geoapify", async () => {
  await scoped(orgA, { roadProvider: "disabled" }, async () => {
    assert.throws(() => getCachedOsrmDistance(59.3, 18, 59.4, 18.1));
    await assert.rejects(getOsrmDistance(59.3, 18, 59.4, 18.1));
    await assert.rejects(precomputeDistanceMatrix([{ lat: 59.3, lon: 18 }, { lat: 59.4, lon: 18.1 }]));
    await assert.rejects(fetchGeoapifyRoute([{ lat: 59.3, lon: 18 }, { lat: 59.4, lon: 18.1 }]), disabled);
  });
  assert.equal(networkCalls, 0);
});

test("explicit OSRM policy cannot call the Geoapify transport", async () => {
  await scoped(orgA, { roadProvider: "osrm" }, async () => {
    await assert.rejects(fetchGeoapifyRoute([{ lat: 59.3, lon: 18 }, { lat: 59.4, lon: 18.1 }]), disabled);
  });
  assert.equal(networkCalls, 0);
});

test("geocoding disable denies forward and reverse lookup before any provider/cache access", async () => {
  await scoped(orgA, { geocodingProvider: "disabled" }, async () => {
    await assert.rejects(geocodeDetailed("Policygatan 14, Stockholm"), disabled);
    await assert.rejects(reverseGeocode(59.3, 18), disabled);
  });
  assert.equal(networkCalls, 0);
});

test("Google-only geocoding never falls back to Nominatim, including reverse lookup", async () => {
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    urls.push(String(url));
    assert.match(String(url), /^https:\/\/maps\.googleapis\.com\//);
    return new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }));
  });
  await scoped(orgA, { geocodingProvider: "google" }, async () => {
    const result = await geocodeDetailed("Policygatan 16, Stockholm");
    assert.equal(result.result, null);
    await assert.rejects(reverseGeocode(59.3, 18), disabled);
  });
  // With no configured Google key there may be zero calls, still no fallback.
  assert.ok(urls.every(url => url.includes("maps.googleapis.com")));
});

test("Nominatim-only geocoding cannot consult Google even when no result is found", async () => {
  const urls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    urls.push(String(url));
    assert.ok(!String(url).includes("googleapis"));
    return new Response("[]");
  });
  const result = await scoped(orgB, { geocodingProvider: "nominatim" }, () =>
    geocodeDetailed("Policygatan 18, Stockholm"));
  assert.equal(result.result, null);
  assert.ok(urls.length > 0);
});

test("a warm geocoding cache is isolated by tenant and cannot bypass a newly disabled policy", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    calls++;
    assert.ok(!String(url).includes("googleapis"));
    return new Response(JSON.stringify([{
      place_id: 987654, lat: "59.3", lon: "18.0", display_name: "Policygatan 24, Stockholm",
      addresstype: "house", address: { road: "Policygatan", house_number: "24", city: "Stockholm" },
    }]));
  });
  const address = "Policygatan 24, Stockholm";
  const first = await scoped(orgA, { geocodingProvider: "nominatim" }, () => geocodeDetailed(address));
  assert.equal(first.status, "matched");
  const warmCalls = calls;
  const cached = await scoped(orgA, { geocodingProvider: "nominatim" }, () => geocodeDetailed(address));
  assert.equal(cached.result?.source, "cache");
  assert.equal(calls, warmCalls);
  await scoped(orgA, { geocodingProvider: "disabled" }, () =>
    assert.rejects(geocodeDetailed(address), disabled));
  assert.equal(calls, warmCalls);
  await scoped(orgB, { geocodingProvider: "nominatim" }, () => geocodeDetailed(address));
  assert.ok(calls > warmCalls, "another tenant cannot reuse the cached provider result");
});

test("public-tracking ETA uses the persisted stop tenant and rechecks policy before warm-cache reuse", async () => {
  const rows: { policy: OrganizationServicePolicy }[] = [{ policy: { ...defaults, roadProvider: "osrm" } }];
  policyRows(rows);
  const snapshot = {
    key: "policy-public-tracking-cache",
    arrival: { plannedAt: null, estimatedAt: null, source: null, calculatedAt: null, reason: "not_live" },
    tracking: { state: "live", position: { latitude: 59.3, longitude: 18 }, lastUpdatedAt: "2026-01-01T12:00:00.000Z" },
    destination: { latitude: 59.4, longitude: 18.1 },
  } as unknown as Parameters<typeof roadArrival>[0];
  const stop = { organizationId: orgA } as Parameters<typeof roadArrival>[1];
  let adapterCalls = 0;
  const adapter = async () => { adapterCalls++; return 120; };
  const first = await scoped(orgB, { roadProvider: "disabled" }, () => roadArrival(snapshot, stop, adapter));
  assert.equal(first.source, "road");
  await roadArrival(snapshot, stop, adapter);
  assert.equal(adapterCalls, 1);
  await roadArrival(snapshot, { ...stop, organizationId: orgB }, adapter);
  assert.equal(adapterCalls, 2);
  rows[0] = { policy: { ...defaults, roadProvider: "disabled" } };
  await assert.rejects(roadArrival(snapshot, stop, adapter));
  assert.equal(adapterCalls, 2, "disabled tracking must not consult the adapter or warm cache");
  assert.equal(networkCalls, 0);
});

test("AI policy is enforced before empty-insight or provider-error fallbacks", async () => {
  await scoped(orgA, { aiEnabled: false }, async () => {
    await assert.rejects(assertOrganizationServiceEnabled("aiEnabled"), disabled);
    await assert.rejects(enrichInsightsWithAI([]), disabled);
  });
  assert.equal(networkCalls, 0);
});

test("outbound SMS and notification email use the explicit authoritative tenant, not ambient tenant", async () => {
  const reads = policyRows([{ policy: { ...defaults, smsProvider: "disabled", emailEnabled: false } }]);
  await scoped(orgB, {}, async () => {
    await assert.rejects(sendSms("+46700000000", "Not sent", orgA), disabled);
    await assert.rejects(sendEmail({ to: "no-send@example.invalid", toName: "Not sent", subject: "Not sent", html: "Not sent" }, orgA), disabled);
  });
  assert.equal(reads.mock.callCount(), 2);
  assert.equal(networkCalls, 0);
});

test("a fresh send reads current policy rather than reusing the old request snapshot", async () => {
  policyRows([{ policy: { ...defaults, smsProvider: "disabled" } }]);
  await scoped(orgA, { smsProvider: "twilio" }, async () => {
    await assert.rejects(sendSms("+46700000000", "Not sent"), disabled);
  });
  assert.equal(networkCalls, 0);
  assert.equal(scoped(orgA, { smsProvider: "disabled" }, configuredProvider), null);
});

test("background explicit-tenant scopes replace unrelated contexts while retaining same-tenant job identity", async () => {
  policyRows([{ policy: { ...defaults, roadProvider: "osrm" } }]);
  await runWithUsageContext({ organizationId: orgA, jobId: "job-a", servicePolicy: defaults }, async () => {
    await withOrganizationServicePolicy(orgA, () => assert.equal(getUsageContext()?.jobId, "job-a"));
    await withOrganizationServicePolicy(orgB, () => {
      assert.equal(getUsageContext()?.organizationId, orgB);
      assert.equal(getUsageContext()?.jobId, undefined);
    });
    assert.equal(getUsageContext()?.organizationId, orgA);
  });
});

test("district resolution denies disabled districts; operational road selection is independent", async () => {
  const reads = policyRows([{ policy: { ...defaults, districtEnabled: false } }]);
  await assert.rejects(resolveBoundRoutingProvider(orgA, { serverId: "shared", configurationVersion: "not-used" }), disabled);
  reads.mock.restore();
  const second = policyRows([{ policy: { ...defaults, districtEnabled: true, roadProvider: "geoapify" } }]);
  await assert.doesNotReject(assertOrganizationDistrictAllowed(orgA));
  second.mock.restore();
  policyRows([{ policy: { ...defaults, districtEnabled: true, roadProvider: "disabled" } }]);
  await assert.doesNotReject(assertOrganizationDistrictAllowed(orgA));
  assert.equal(networkCalls, 0);
});
