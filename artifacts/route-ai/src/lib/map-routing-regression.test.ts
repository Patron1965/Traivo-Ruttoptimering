import assert from "node:assert/strict";
import test from "node:test";
import { mapRouteEndpoints } from "./map-route-endpoints";
import { fetchRouteGeometry } from "./osrm";

test("maps consume only explicit endpoints and preserve missing positions", () => {
  assert.deepEqual(mapRouteEndpoints({
    mapEndpoints: {
      start: { latitude: 59.36306, longitude: 18.12989 },
      end: { latitude: 59.350903, longitude: 18.153103 },
    },
  }), { start: [59.36306, 18.12989], end: [59.350903, 18.153103] });
  assert.deepEqual(mapRouteEndpoints({}), { start: null, end: null });
  const depotSnapshot = {
    start: { latitude: 59, longitude: 18 },
    end: { latitude: 60, longitude: 19 },
  } as NonNullable<Parameters<typeof mapRouteEndpoints>[0]["depotSnapshot"]>;
  assert.deepEqual(mapRouteEndpoints({ depotSnapshot }), { start: [59, 18], end: [60, 19] });
  assert.deepEqual(mapRouteEndpoints({ depotSnapshot, mapEndpoints: { start: null, end: null } }),
    { start: null, end: null });
  assert.deepEqual(mapRouteEndpoints({ mapEndpoints: {
    start: { latitude: 100, longitude: 18 }, end: null,
  } }), { start: null, end: null });
});

test("112 waypoints preserve every leg across overlapping chunks; failures are not cached", async () => {
  const original = globalThis.fetch;
  const calls: string[][] = [];
  let fail = true;
  globalThis.fetch = async (input) => {
    const coordinates = new URL(String(input), "https://example.test").searchParams.get("coords")!.split(";");
    calls.push(coordinates);
    if (fail && calls.length === 2) return new Response("", { status: 503 });
    return Response.json({ code: "Ok", routes: [{ geometry: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }] });
  };
  try {
    const points: [number, number][] = Array.from({ length: 112 }, (_, i) => [59.35 + i / 10000, 18.15]);
    assert.equal((await fetchRouteGeometry(points)).isFallback, true);
    assert.equal(calls[0].length, 100);
    assert.equal(calls[1].length, 13);
    assert.equal(calls[0].at(-1), calls[1][0]);
    assert.deepEqual([...calls[0], ...calls[1].slice(1)], points.map(([lat, lon]) => `${lon},${lat}`));
    fail = false;
    assert.equal((await fetchRouteGeometry(points)).isFallback, false);
    assert.equal(calls.length, 4);
    await fetchRouteGeometry(points);
    assert.equal(calls.length, 4);
  } finally { globalThis.fetch = original; }
});
