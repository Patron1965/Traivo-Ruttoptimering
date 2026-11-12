import assert from "node:assert/strict";
import test from "node:test";
import { routeMapGeometryKey } from "./route-map-selection.ts";

test("geometry keys include route identity and waypoints", () => {
  const waypoints: [number, number][] = [[59.3, 18.0], [59.4, 18.1]];

  assert.notEqual(
    routeMapGeometryKey("route-a", waypoints),
    routeMapGeometryKey("route-b", waypoints),
  );
  assert.notEqual(
    routeMapGeometryKey("route-a", waypoints),
    routeMapGeometryKey("route-a", [...waypoints, [59.5, 18.2]]),
  );
});

test("geometry keys remain tied to the selected run", () => {
  const waypoints: [number, number][] = [[59.3, 18.0], [59.4, 18.1]];

  assert.equal(routeMapGeometryKey("route-a", waypoints).startsWith("route-a:"), true);
  assert.equal(routeMapGeometryKey("route-b", waypoints).startsWith("route-b:"), true);
});