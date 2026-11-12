import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearOsrmCache,
  getDistanceMatrixCacheCoverage,
  precomputeDistanceMatrix,
} from "./osrm";
import { cachedDistance, cachedDuration, getDistanceCache } from "./alns/distance-cache";

test("optimizer cache preserves directional road distances and durations regardless of lookup order", async () => {
  const coordinates = [
    { lat: 59.3293, lon: 18.0686 },
    { lat: 59.3410, lon: 18.0510 },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "Ok",
    distances: [[0, 1_000], [3_000, 0]],
    durations: [[0, 120], [420, 0]],
  }), { status: 200 })) as typeof fetch;
  try {
    clearOsrmCache();
    assert.equal(await precomputeDistanceMatrix(coordinates), true);
    const [a, b] = coordinates;
    for (const reverseFirst of [false, true]) {
      getDistanceCache().clear();
      const [from, to] = reverseFirst ? [b, a] : [a, b];
      assert.equal(cachedDistance(from.lat, from.lon, to.lat, to.lon), reverseFirst ? 3 : 1);
      assert.equal(cachedDuration(to.lat, to.lon, from.lat, from.lon), reverseFirst ? 2 : 7);
      assert.equal(cachedDistance(to.lat, to.lon, from.lat, from.lon), reverseFirst ? 1 : 3);
      assert.equal(cachedDuration(from.lat, from.lon, to.lat, to.lon), reverseFirst ? 7 : 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
    getDistanceCache().clear();
    clearOsrmCache();
  }
});

test("a complete cached distance matrix skips the next OSRM request", async () => {
  const coordinates = [
    { lat: 59.3293, lon: 18.0686 },
    { lat: 59.3410, lon: 18.0510 },
    { lat: 59.3120, lon: 18.0910 },
  ];
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount++;
    return new Response(JSON.stringify({
      code: "Ok",
      distances: [
        [0, 1_000, 2_000],
        [1_100, 0, 1_200],
        [2_100, 1_300, 0],
      ],
      durations: [
        [0, 120, 240],
        [130, 0, 140],
        [250, 150, 0],
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    clearOsrmCache();
    assert.equal(await precomputeDistanceMatrix(coordinates), true);
    assert.equal(requestCount, 1);
    assert.deepEqual(getDistanceMatrixCacheCoverage(coordinates), {
      complete: true,
      cachedPairs: 6,
      totalPairs: 6,
    });

    assert.equal(await precomputeDistanceMatrix(coordinates), true);
    assert.equal(requestCount, 1, "the cached matrix should avoid another network request");
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});

test("concurrent callers share one matrix warm-up", async () => {
  const coordinates = [
    { lat: 59.3293, lon: 18.0686 },
    { lat: 59.3410, lon: 18.0510 },
    { lat: 59.3120, lon: 18.0910 },
  ];
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  let releaseRequest: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => { releaseRequest = resolve; });

  globalThis.fetch = (async () => {
    requestCount++;
    await requestStarted;
    return new Response(JSON.stringify({
      code: "Ok",
      distances: [[0, 1_000, 2_000], [1_100, 0, 1_200], [2_100, 1_300, 0]],
      durations: [[0, 120, 240], [130, 0, 140], [250, 150, 0]],
    }), { status: 200 });
  }) as typeof fetch;

  try {
    clearOsrmCache();
    const first = precomputeDistanceMatrix(coordinates);
    const second = precomputeDistanceMatrix([...coordinates].reverse());
    assert.equal(requestCount, 1, "the second caller should join the in-flight matrix request");
    releaseRequest!();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});

test("large matrices cache every directional pair within OSRM's coordinate limit", async () => {
  const coordinates = Array.from({ length: 101 }, (_, index) => ({
    lat: 59.2 + index * 0.001,
    lon: 18.0 + index * 0.001,
  }));
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = (async (input) => {
    requestCount++;
    const coordinateText = new URL(String(input)).pathname.split("/").pop() ?? "";
    const count = coordinateText.split(";").filter(Boolean).length;
    assert.ok(count <= 100, "each OSRM table request must stay within its coordinate limit");
    return new Response(JSON.stringify({
      code: "Ok",
      distances: Array.from({ length: count }, (_, row) =>
        Array.from({ length: count }, (_, column) => row === column ? 0 : 1_000)),
      durations: Array.from({ length: count }, (_, row) =>
        Array.from({ length: count }, (_, column) => row === column ? 0 : 120)),
    }), { status: 200 });
  }) as typeof fetch;

  try {
    clearOsrmCache();
    assert.equal(await precomputeDistanceMatrix(coordinates), true);
    assert.equal(requestCount, 6, "three 50-or-fewer point blocks need three internal and three cross-block requests");
    assert.deepEqual(getDistanceMatrixCacheCoverage(coordinates), {
      complete: true,
      cachedPairs: 10_100,
      totalPairs: 10_100,
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});

test("a matrix above the former LRU limit remains completely cached", async () => {
  const coordinates = Array.from({ length: 225 }, (_, index) => ({
    lat: 58.8 + index * 0.0005,
    lon: 17.8 + index * 0.0005,
  }));
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input) => {
    const coordinateText = new URL(String(input)).pathname.split("/").pop() ?? "";
    const count = coordinateText.split(";").filter(Boolean).length;
    return new Response(JSON.stringify({
      code: "Ok",
      distances: Array.from({ length: count }, (_, row) =>
        Array.from({ length: count }, (_, column) => row === column ? 0 : 1_000)),
      durations: Array.from({ length: count }, (_, row) =>
        Array.from({ length: count }, (_, column) => row === column ? 0 : 120)),
    }), { status: 200 });
  }) as typeof fetch;

  try {
    clearOsrmCache();
    assert.equal(await precomputeDistanceMatrix(coordinates), true);
    assert.deepEqual(getDistanceMatrixCacheCoverage(coordinates), {
      complete: true,
      cachedPairs: 50_400,
      totalPairs: 50_400,
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache();
  }
});