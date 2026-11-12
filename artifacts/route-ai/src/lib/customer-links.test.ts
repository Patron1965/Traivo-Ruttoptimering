import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { destinationCoordinates, publicTrackingPolicy, shareableUrl, requestCustomerLink, CustomerLinkError, type CustomerLink, type PublicDelivery } from "./customer-links.ts";

const active: CustomerLink = { status: "active", url: "https://go.traivo.se/track/secret", expiresAt: "2099-01-01T00:00:00Z", configurationReady: true };
test("destination accepts only finite geographic coordinates including zero", () => {
  assert.deepEqual(destinationCoordinates(0, 0), [0, 0]);
  assert.deepEqual(destinationCoordinates(59.33, 18.06), [59.33, 18.06]);
  for (const [lat, lng] of [[null, 18], [59, null], [NaN, 0], [0, Infinity], [91, 18], [59, -181]]) {
    assert.equal(destinationCoordinates(lat, lng), null);
  }
});
test("only unexpired active canonical HTTPS links can be shared", () => {
  assert.equal(shareableUrl(active), active.url);
  for (const status of ["none", "expired", "revoked", "unavailable"] as const) assert.equal(shareableUrl({ ...active, status }), null);
  for (const expiresAt of [null, "invalid", "2000-01-01T00:00:00Z"]) assert.equal(shareableUrl({ ...active, expiresAt }), null);
  for (const url of ["javascript:alert(1)", "/track/token", "http://localhost/track/token", "https://user:pass@example.com/"]) assert.equal(shareableUrl({ ...active, url }), null);
});
test("management uses authenticated uncached endpoint and action-only body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/base/api/stops/a%2Fb/customer-link");
    assert.equal(init?.credentials, "include");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.referrerPolicy, "no-referrer");
    assert.equal(init?.body, JSON.stringify({ action: "replace" }));
    return new Response(JSON.stringify(active));
  };
  try { assert.deepEqual(await requestCustomerLink("/base", "a/b", "replace"), active); }
  finally { globalThis.fetch = original; }
});
test("errors retain status and code without reflecting server text or tokens", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "secret", code: "FORBIDDEN" }), { status: 403 });
  try {
    await assert.rejects(requestCustomerLink("", "a"), (error: CustomerLinkError) => error.status === 403 && error.code === "FORBIDDEN" && !error.message.includes("secret"));
  } finally { globalThis.fetch = original; }
});
test("public document and page enforce privacy boundaries", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /name="referrer" content="strict-origin"/);
  assert.match(html, /noindex, nofollow, noarchive/);
  const page = readFileSync(new URL("../pages/TrackingPage.tsx", import.meta.url), "utf8");
  assert.match(page, /credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer"/);
  assert.match(page, /controller.abort\(\)/);
  assert.match(page, /version === requestVersion/);
  assert.match(page, /timeZone: "Europe\/Stockholm"/);
  assert.match(page, /destinationCoordinates\(data.latitude, data.longitude\)/);
  assert.match(page, /https:\/\/\{s\}\.tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(page, /<TileLayer[^\n]*referrerPolicy="strict-origin"/);
  assert.match(page, /openstreetmap\.org\/copyright/);
  assert.doesNotMatch(page, /cartocdn\.com|carto\.com/);
  assert.doesNotMatch(page, /ProofDisplay|trackingCode|estimatedArrival|vehicleName|stopsProgress|computeThemeVariables|localStorage/);
});
const now = Date.parse("2026-01-12T10:00:00Z");
const iso = (offset: number) => new Date(now + offset).toISOString();
const liveDelivery: PublicDelivery = {
  status: "on_the_way", address: "Destination", latitude: 59, longitude: 18,
  timeWindowStart: null, timeWindowEnd: null, brand: null,
  tracking: { state: "live", position: { latitude: 59.1, longitude: 18.1 }, lastUpdatedAt: iso(-30_000), freshUntil: iso(90_000), reason: null },
  arrival: { plannedAt: iso(600_000), estimatedAt: iso(300_000), source: "road", calculatedAt: iso(-10_000), reason: null },
};
test("live tracking permits only real fresh coordinates and a road estimate", () => {
  const policy = publicTrackingPolicy(liveDelivery, now);
  assert.deepEqual(policy.position, [59.1, 18.1]);
  assert.equal(policy.estimatedAt, iso(300_000));
  assert.equal(policy.deadline, now + 90_000);
});
test("deadline expires independently of requests, capped at 120 seconds", () => {
  for (const freshUntil of [iso(90_000), iso(900_000)]) {
    const data = { ...liveDelivery, tracking: { ...liveDelivery.tracking!, freshUntil } };
    assert.equal(publicTrackingPolicy(data, now + 89_999).state, "live");
    const expired = publicTrackingPolicy(data, now + 90_000);
    assert.equal(expired.state, "stale");
    assert.equal(expired.position, null);
    assert.equal(expired.estimatedAt, null);
  }
  const shortened = { ...liveDelivery, tracking: { ...liveDelivery.tracking!, freshUntil: iso(1_000) } };
  assert.equal(publicTrackingPolicy(shortened, now + 1_000).position, null);
  assert.equal(publicTrackingPolicy(shortened, now + 1_000).estimatedAt, null);
});
test("road calculation has its own deadline without hiding a still-fresh position", () => {
  const data = { ...liveDelivery, arrival: { ...liveDelivery.arrival!, calculatedAt: iso(-119_000) } };
  assert.equal(publicTrackingPolicy(data, now).deadline, now + 1_000);
  const expired = publicTrackingPolicy(data, now + 1_000);
  assert.equal(expired.estimatedAt, null);
  assert.notEqual(expired.position, null);
  assert.equal(expired.deadline, now + 90_000);
});
test("stale, missing, waiting, inactive, finished, offline and future states fail closed", () => {
  for (const state of ["stale", "waiting", "inactive", "completed", "unavailable", "future_state"]) {
    const data = { ...liveDelivery, tracking: { ...liveDelivery.tracking!, state } } as PublicDelivery;
    assert.equal(publicTrackingPolicy(data, now).position, null);
    assert.equal(publicTrackingPolicy(data, now).estimatedAt, null);
  }
  for (const reason of ["not_next", "execution_inactive", "gps_missing", "gps_stale", "plan_changed", "service_pause"] as const) {
    assert.equal(publicTrackingPolicy({ ...liveDelivery, tracking: { ...liveDelivery.tracking!, reason } }, now).position, null);
  }
  for (const status of ["delivered", "failed"] as const) assert.equal(publicTrackingPolicy({ ...liveDelivery, status }, now).estimatedAt, null);
  assert.equal(publicTrackingPolicy(liveDelivery, now, false).position, null);
  assert.equal(publicTrackingPolicy(liveDelivery, now, false).estimatedAt, null);
  assert.equal(publicTrackingPolicy(null, now).position, null);
  assert.equal(publicTrackingPolicy({ ...liveDelivery, tracking: undefined, arrival: undefined }, now).estimatedAt, null);
});
test("invalid coordinates, missing dates and future position timestamps cannot show vehicle or ETA", () => {
  for (const patch of [
    { position: null }, { position: { latitude: 91, longitude: 0 } },
    { position: { latitude: NaN, longitude: Infinity } },
    { lastUpdatedAt: iso(1) }, { lastUpdatedAt: "invalid" }, { freshUntil: null }, { freshUntil: iso(-1) },
  ]) {
    const policy = publicTrackingPolicy({ ...liveDelivery, tracking: { ...liveDelivery.tracking!, ...patch } }, now);
    assert.equal(policy.position, null);
    assert.equal(policy.estimatedAt, null);
  }
});
test("no fabricated ETA: absent, invalid, future-calculated, stale or non-road estimates stay hidden", () => {
  for (const patch of [
    { estimatedAt: null }, { estimatedAt: "invalid" }, { estimatedAt: iso(-1) },
    { source: null }, { calculatedAt: null }, { calculatedAt: iso(1) },
    { calculatedAt: iso(-120_000) }, { reason: "road_unavailable" as const },
  ]) {
    const policy = publicTrackingPolicy({ ...liveDelivery, arrival: { ...liveDelivery.arrival!, ...patch } }, now);
    assert.notEqual(policy.position, null);
    assert.equal(policy.estimatedAt, null);
  }
});
test("public UI keeps deadline, offline clearing, bounds and translated guidance", () => {
  const page = readFileSync(new URL("../pages/TrackingPage.tsx", import.meta.url), "utf8");
  assert.match(page, /tracking.deadline - Date.now\(\)/);
  assert.match(page, /visibilitychange/);
  assert.match(page, /setOnline\(false\); setData\(null\)/);
  assert.match(page, /map.fitBounds/);
  assert.match(page, /tracking.position && <Marker/);
  for (const locale of ["sv", "en"]) {
    const strings = JSON.parse(readFileSync(new URL(`../i18n/locales/${locale}.json`, import.meta.url), "utf8")).customerLinks;
    for (const key of ["tracking_live", "tracking_stale", "tracking_missing", "tracking_waiting", "tracking_not_next", "tracking_inactive", "tracking_completed", "tracking_offline", "tracking_unavailable", "plannedArrival", "roadArrival", "roadDisclaimer", "positionUpdated"]) assert.equal(typeof strings[key], "string");
  }
});