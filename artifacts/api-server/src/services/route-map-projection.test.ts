import assert from "node:assert/strict";
import test from "node:test";
import { routeMapEndpoints } from "./route-map-projection";

test("map coordinates prefer immutable depots and fall back independently without claiming verification", () => {
  const route = {
    depotSnapshot: { start: { latitude: 60, longitude: 19 } },
    optimizationResourceSnapshot: { driver: {
      startLatitude: 59, startLongitude: 18, endLatitude: 58, endLongitude: 17,
      email: "private@example.test",
    } },
  };
  assert.deepEqual(routeMapEndpoints(route), {
    start: { latitude: 60, longitude: 19 }, end: { latitude: 58, longitude: 17 },
  });
  assert.deepEqual(routeMapEndpoints({ optimizationResourceSnapshot: route.optimizationResourceSnapshot }), {
    start: { latitude: 59, longitude: 18 }, end: { latitude: 58, longitude: 17 },
  });
});

test("missing, non-finite and out-of-range positions stay null; zero is valid", () => {
  assert.deepEqual(routeMapEndpoints({}), { start: null, end: null });
  for (const latitude of [undefined, null, "59", NaN, Infinity, 91, -91]) {
    assert.deepEqual(routeMapEndpoints({ depotSnapshot: { start: { latitude, longitude: 18 } } }),
      { start: null, end: null });
  }
  for (const longitude of [undefined, null, "18", NaN, Infinity, 181, -181]) {
    assert.deepEqual(routeMapEndpoints({ depotSnapshot: { end: { latitude: 59, longitude } } }),
      { start: null, end: null });
  }
  assert.deepEqual(routeMapEndpoints({ depotSnapshot: { start: { latitude: 0, longitude: 0 } } }),
    { start: { latitude: 0, longitude: 0 }, end: null });
});
