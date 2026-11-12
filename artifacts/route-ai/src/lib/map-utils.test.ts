import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortStopsBySequence, isValidCoordinate, getValidCoordinates, getRouteColor, TRAIVO_ROUTE_COLORS, STATUS_COLORS } from "./map-utils";

describe("map-utils", () => {
  it("sorts stops by sequenceOrder null-safely", () => {
    const stops = [
      { id: "1", sequenceOrder: 3 },
      { id: "2", sequenceOrder: 1 },
      { id: "3", sequenceOrder: null },
      { id: "4", sequenceOrder: 2 },
    ];

    const sorted = sortStopsBySequence(stops);
    assert.deepEqual(sorted.map(s => s.id), ["2", "4", "1", "3"]);
  });

  it("validates coordinates correctly", () => {
    assert.equal(isValidCoordinate(59.3293, 18.0686), true);
    assert.equal(isValidCoordinate(0, 0), false);
    assert.equal(isValidCoordinate(null, 18.0686), false);
    assert.equal(isValidCoordinate(59.3293, undefined), false);
    assert.equal(isValidCoordinate(Infinity, 18.0686), false);
    assert.equal(isValidCoordinate(0.00001, 18.0686), false);
    assert.equal(isValidCoordinate(91, 18.0686), false);
    assert.equal(isValidCoordinate(59.3293, 181), false);
  });

  it("extracts valid coordinates from stops in correct order", () => {
    const stops = [
      { id: "1", sequenceOrder: 2, latitude: 59.3293, longitude: 18.0686 },
      { id: "2", sequenceOrder: 1, latitude: 59.3300, longitude: 18.0700 },
      { id: "3", sequenceOrder: 3, latitude: 0, longitude: 0 },
      { id: "4", sequenceOrder: null, latitude: 59.3200, longitude: 18.0600 },
    ];

    const coords = getValidCoordinates(stops);
    assert.deepEqual(coords, [
      [59.3300, 18.0700],
      [59.3293, 18.0686],
      [59.3200, 18.0600],
    ]);
  });

  it("resolves route colors correctly", () => {
    assert.equal(getRouteColor("completed", 0), STATUS_COLORS.completed);
    assert.equal(getRouteColor("delayed", 5), STATUS_COLORS.delayed);
    assert.equal(getRouteColor("optimized", 0), TRAIVO_ROUTE_COLORS[0]);
    assert.equal(getRouteColor("planned", 1), TRAIVO_ROUTE_COLORS[1]);
    assert.equal(getRouteColor("optimized", TRAIVO_ROUTE_COLORS.length + 2), TRAIVO_ROUTE_COLORS[2]);
    assert.equal(getRouteColor(null, 3), TRAIVO_ROUTE_COLORS[3]);
    assert.equal(getRouteColor("in_progress", 4, true), TRAIVO_ROUTE_COLORS[4]);
  });
});
