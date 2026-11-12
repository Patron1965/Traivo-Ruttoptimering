import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGeoapifyMatrix, fetchGeoapifyRoute } from "./geoapify-road";
import { clearOsrmCache, getCachedOsrmDistance, precomputeDistanceMatrix, getDistanceMatrixCacheCoverage, getOsrmDistance } from "./osrm";
import { RoadDataUnavailableError } from "./road-data-policy";
import { operationalProviderConfigured } from "./operational-provider-config";
import { directionalRoad } from "./customer-live-tracking";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import geometryRouter from "../routes/osrm";

const a = { lat: 59.3293, lon: 18.0686 }, b = { lat: 59.341, lon: 18.051 };

async function mocked(
  fetcher: typeof fetch, work: () => Promise<void>,
) {
  const fetchBefore = globalThis.fetch;
  const modeBefore = process.env.OPERATIONAL_ROAD_PROVIDER;
  const keyBefore = process.env.GEOAPIFY_API_KEY;
  process.env.OPERATIONAL_ROAD_PROVIDER = "geoapify";
  process.env.GEOAPIFY_API_KEY = "synthetic-test-credential";
  globalThis.fetch = fetcher;
  clearOsrmCache();
  try { await work(); }
  finally {
    globalThis.fetch = fetchBefore;
    if (modeBefore === undefined) delete process.env.OPERATIONAL_ROAD_PROVIDER;
    else process.env.OPERATIONAL_ROAD_PROVIDER = modeBefore;
    if (keyBefore === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = keyBefore;
    clearOsrmCache();
  }
}

test("Geoapify matrices preserve directed distances, indices and metric units", async () => {
  await mocked((async (input, init) => {
    assert.equal(new URL(String(input)).hostname, "api.geoapify.com");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.sources[0].location, [a.lon, a.lat]);
    assert.equal(body.mode, "drive");
    assert.equal(body.units, "metric");
    return Response.json({ sources_to_targets: [
      [{ source_index: 0, target_index: 1, distance: 1200, time: 180 }, { source_index: 0, target_index: 0, distance: 0, time: 0 }],
      [{ source_index: 1, target_index: 0, distance: 4500, time: 600 }, { source_index: 1, target_index: 1, distance: 0, time: 0 }],
    ] });
  }) as typeof fetch, async () => {
    assert.equal(await precomputeDistanceMatrix([a, b]), true);
    assert.deepEqual(getCachedOsrmDistance(a.lat, a.lon, b.lat, b.lon), { distanceKm: 1.2, durationMin: 3 });
    assert.deepEqual(getCachedOsrmDistance(b.lat, b.lon, a.lat, a.lon), { distanceKm: 4.5, durationMin: 10 });
  });
});

test("Geoapify partitions matrices at 1000 values and reuses complete blocks", async () => {
  let calls = 0;
  const points = Array.from({ length: 228 }, (_, i) => ({ lat: 59 + i / 1000, lon: 18 }));
  await mocked((async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.ok(body.sources.length * body.targets.length <= 1000);
    return Response.json({ sources_to_targets: body.sources.map((_: unknown, s: number) =>
      body.targets.map((_: unknown, t: number) => ({ source_index: s, target_index: t, distance: 1000, time: 120 }))) });
  }) as typeof fetch, async () => {
    assert.equal(await precomputeDistanceMatrix(points), true);
    assert.equal(calls, 64, "228 locations need eight source by eight target blocks");
    assert.equal(getDistanceMatrixCacheCoverage(points).complete, true);
    assert.equal(await precomputeDistanceMatrix(points), true);
    assert.equal(calls, 64);
    process.env.OPERATIONAL_ROAD_PROVIDER = "osrm";
    assert.equal(getCachedOsrmDistance(points[0].lat, points[0].lon, points[1].lat, points[1].lon), undefined);
  });
});

test("missing or negative Geoapify cells never complete a road matrix", async () => {
  await mocked((async () => Response.json({ sources_to_targets: [
    [{ source_index: 0, target_index: 1, distance: -1, time: 60 }],
    [null],
  ] })) as typeof fetch, async () => {
    assert.equal(await precomputeDistanceMatrix([a, b]), false);
    assert.equal(getCachedOsrmDistance(a.lat, a.lon, b.lat, b.lon), undefined);
  });
});

test("malformed indices and provider errors are explicit and never expose credentials", async () => {
  await mocked((async () => Response.json({ sources_to_targets: [[{
    source_index: 99, target_index: 0, distance: 1, time: 1,
  }]] })) as typeof fetch, async () => {
    await assert.rejects(fetchGeoapifyMatrix([a], [b]), RoadDataUnavailableError);
    globalThis.fetch = (async () => { throw new Error("https://provider.invalid/?apiKey=synthetic-test-credential"); }) as typeof fetch;
    await assert.rejects(fetchGeoapifyRoute([a, b]), (error: unknown) => {
      assert.ok(error instanceof RoadDataUnavailableError);
      assert.ok(!error.message.includes("synthetic-test-credential"));
      return true;
    });
    delete process.env.GEOAPIFY_API_KEY;
    assert.equal(operationalProviderConfigured(), false);
    await assert.rejects(fetchGeoapifyMatrix([a], [b]), RoadDataUnavailableError);
  });
});

test("Geoapify geometry, pair distances and tracking use seconds without reverse caching", async () => {
  let calls = 0;
  await mocked((async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(url.searchParams.get("waypoints"), `${a.lat},${a.lon}|${b.lat},${b.lon}`);
    return Response.json({ features: [{
      properties: { distance: 1200, time: 180 },
      geometry: { type: "MultiLineString", coordinates: [[[a.lon, a.lat], [b.lon, b.lat]]] },
    }] });
  }) as typeof fetch, async () => {
    const route = await fetchGeoapifyRoute([a, b]);
    assert.equal(route.code, "Ok");
    assert.ok(route.routes[0].geometry.length > 0);
    assert.deepEqual(await getOsrmDistance(a.lat, a.lon, b.lat, b.lon), { distanceKm: 1.2, durationMin: 3 });
    assert.equal(getCachedOsrmDistance(b.lat, b.lon, a.lat, a.lon), undefined);
    assert.equal(await directionalRoad({ latitude: a.lat, longitude: a.lon }, { latitude: b.lat, longitude: b.lon },
      new AbortController().signal), 180);
    assert.equal(calls, 3);
  });
});

test("geometry HTTP boundary authenticates callers, validates input and hides credentials", async () => {
  const organizationId = randomUUID();
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Synthetic Geoapify acceptance", email: "geoapify@example.test",
  });
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers.authorization === "Bearer synthetic") req.user = {
      id: randomUUID(), name: "Synthetic dispatcher", email: "dispatcher@example.test",
      organizationId, role: "dispatcher", driverProfileId: null,
    };
    next();
  });
  app.use(geometryRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/osrm/route`;
  const localFetch = globalThis.fetch;
  let providerCalls = 0;
  try {
    await mocked((async () => {
      providerCalls++;
      return Response.json({ features: [{
        properties: { distance: 1200, time: 180 },
        geometry: { type: "MultiLineString", coordinates: [[[a.lon, a.lat], [b.lon, b.lat]]] },
      }] });
    }) as typeof fetch, async () => {
      assert.equal((await localFetch(url + "?coords=18,59;18.1,59.1")).status, 401);
      assert.equal((await localFetch(url + "?coords=invalid", {
        headers: { Authorization: "Bearer synthetic" },
      })).status, 400);
      assert.equal(providerCalls, 0);
      const response = await localFetch(url + `?coords=${a.lon},${a.lat};${b.lon},${b.lat}`, {
        headers: { Authorization: "Bearer synthetic" },
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes("synthetic-test-credential"));
      const body = JSON.parse(text);
      assert.equal(body.code, "Ok");
      assert.equal(body.routes[0].duration, 180);
      assert.equal(providerCalls, 1);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
