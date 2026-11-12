import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearWeatherCache,
  getWeatherForLocation,
} from "./weather-service";

test("optimization weather fallback uses the requested conservative EV range floor", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("weather unavailable");
  }) as typeof fetch;

  try {
    clearWeatherCache();
    const weather = await getWeatherForLocation(
      59.3293,
      18.0686,
      undefined,
      {
        timeoutMs: 10,
        fallbackEvRangeMultiplier: 0.55,
      },
    );

    assert.equal(weather.evRangeMultiplier, 0.55);
    assert.equal(weather.drivingImpact, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearWeatherCache();
  }
});