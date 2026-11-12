import assert from "node:assert/strict";
import { test } from "node:test";
import { withRequiredRoadData, RoadDataUnavailableError } from "./road-data-policy";
import { cachedDistance, cachedDuration, getDistanceCache } from "./alns/distance-cache";
import { clearOsrmCache, precomputeDistanceMatrix } from "./osrm";
import { getEnvCtx, setEnvCtx, withOptimizationEnvironment } from "./alns/types";

test("operational reads reject a polluted analytical cache, but allow a zero-length leg", () => {
  clearOsrmCache(); getDistanceCache().clear();
  assert.ok(cachedDistance(59.3, 18, 59.4, 18.1) > 0);
  withRequiredRoadData(() => {
    assert.throws(() => cachedDistance(59.3, 18, 59.4, 18.1), RoadDataUnavailableError);
    assert.throws(() => cachedDuration(59.3, 18, 59.4, 18.1), RoadDataUnavailableError);
    assert.equal(cachedDistance(59.3, 18, 59.3, 18), 0);
    assert.equal(cachedDuration(59.3, 18, 59.3, 18), 0);
  });
});

test("verified directional road data is used after a straight-line cache entry", async () => {
  const fetchBefore = globalThis.fetch;
  clearOsrmCache(); getDistanceCache().clear();
  cachedDistance(59.3, 18, 59.4, 18.1);
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "Ok", distances: [[0, 1200], [4500, 0]], durations: [[0, 180], [600, 0]],
  }))) as typeof fetch;
  try {
    await precomputeDistanceMatrix([{ lat: 59.3, lon: 18 }, { lat: 59.4, lon: 18.1 }]);
    withRequiredRoadData(() => {
      assert.equal(cachedDistance(59.3, 18, 59.4, 18.1), 1.2);
      assert.equal(cachedDuration(59.4, 18.1, 59.3, 18), 10);
    });
  } finally { globalThis.fetch = fetchBefore; clearOsrmCache(); getDistanceCache().clear(); }
});

test("road policy and weather remain isolated across concurrent asynchronous work", async () => {
  clearOsrmCache();
  await Promise.all([
    withOptimizationEnvironment({ weatherImpact: 1.9, evRangeMultiplier: 0.5 }, async () => {
      await Promise.resolve();
      setEnvCtx({ weatherImpact: 2, evRangeMultiplier: 0.4 });
      await Promise.resolve();
      assert.equal(getEnvCtx().weatherImpact, 2);
      withRequiredRoadData(() => assert.throws(() => cachedDistance(59.3, 18, 59.4, 18.1), RoadDataUnavailableError));
    }),
    withOptimizationEnvironment({ weatherImpact: 1, evRangeMultiplier: 1 }, async () => {
      await Promise.resolve();
      assert.equal(getEnvCtx().weatherImpact, 1);
      assert.ok(cachedDistance(59.3, 18, 59.4, 18.1) > 0);
    }),
  ]);
});
