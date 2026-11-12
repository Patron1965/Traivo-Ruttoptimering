import test from "node:test";
import assert from "node:assert/strict";
import { projectDriverArrivals } from "./driver-arrival";

test("ETA shifts remaining road plan without editing order, windows, or history", () => {
  const route = { plannerItinerary: [
    { stopId: "done", estimatedArrival: "2026-10-14T06:30:00Z", isChargingStop: false },
    { stopId: "next", estimatedArrival: "2026-10-14T06:40:00Z", isChargingStop: false },
    { stopId: "later", estimatedArrival: "2026-10-14T07:00:00Z", isChargingStop: false },
  ] } as Parameters<typeof projectDriverArrivals>[0];
  const stops: Parameters<typeof projectDriverArrivals>[1] = [{ id: "done", status: "completed" }, { id: "next", status: "pending" }, { id: "later", status: "pending" }];
  const snapshot = JSON.stringify({ route, stops });
  const projection = projectDriverArrivals(route, stops, {
    plannedAt: "2026-10-14T06:40:00Z", estimatedAt: "2026-10-14T06:50:00Z",
    calculatedAt: "2026-10-14T06:35:00Z", positionAt: "2026-10-14T06:34:00Z", source: "road",
  });
  assert.equal(projection.next.source, "road");
  assert.equal(projection.later.estimatedAt, "2026-10-14T07:10:00.000Z");
  assert.equal(projection.later.source, "plan_shift");
  assert.equal(projection.done.estimatedAt, null);
  assert.equal(JSON.stringify({ route, stops }), snapshot);
});
test("missing road evidence retains planned time without invented ETA", () => {
  const route = { plannerItinerary: [] };
  const output = projectDriverArrivals(route, [{ id: "next", status: "pending" }], {
    plannedAt: null, estimatedAt: null, positionAt: null, calculatedAt: null, source: null,
  });
  assert.equal(output.next.estimatedAt, null);
  assert.equal(output.next.source, null);
});
