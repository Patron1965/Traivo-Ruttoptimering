import assert from "node:assert/strict";
import test from "node:test";
import { resolveReoptimizationDepot } from "./route-reoptimization-depot";

const driver = { startLatitude: 59, startLongitude: 18, endLatitude: 60, endLongitude: 19 };
test("resource-only routes retain distinct start and end locations", () => {
  assert.deepEqual(resolveReoptimizationDepot(null, driver), {
    start: { latitude: 59, longitude: 18 }, end: { latitude: 60, longitude: 19 },
  });
});
test("saved depot takes precedence over current driver locations", () => {
  const depot = { start: { latitude: 57, longitude: 12 }, end: { latitude: 58, longitude: 13 } };
  assert.deepEqual(resolveReoptimizationDepot(depot, driver), depot);
});
test("missing or invalid endpoints cannot become invented return trips", () => {
  assert.equal(resolveReoptimizationDepot(null, { ...driver, endLatitude: null }), null);
  assert.equal(resolveReoptimizationDepot(null, { ...driver, startLatitude: NaN }), null);
  assert.equal(resolveReoptimizationDepot(null, { ...driver, endLongitude: 181 }), null);
});
