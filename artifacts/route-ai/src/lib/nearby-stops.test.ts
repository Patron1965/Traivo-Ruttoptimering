import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledRow, ScheduledStop } from "./scheduling";
import { nearbyStopsForSelection, nearbyStopsWithin50m } from "./nearby-stops.ts";

function stop(stopId: string, latitude: number, longitude = 0): ScheduledStop {
  return {
    stopId, latitude, longitude, address: `${stopId} street`,
    sequenceOrder: 1, weightKg: 0, volumeM3: 0, serviceDurationMin: 0, status: "planned",
  };
}
const entry = (item: ScheduledStop, planId: string | null = "plan-a") => ({ stop: item, planId });
const atMeters = (meters: number) => meters / 6_371_000 * 180 / Math.PI;

test("50m straight-line boundary is inclusive, just beyond is excluded", () => {
  const selected = entry(stop("selected", 0));
  assert.deepEqual(nearbyStopsWithin50m(selected, [
    entry(stop("edge", atMeters(50))),
    entry(stop("outside", atMeters(50.01))),
  ]).map(({ stop }) => stop.stopId), ["edge"]);
});

test("zero coordinates are valid; missing and invalid coordinates are not", () => {
  const selected = entry(stop("selected", 0));
  assert.deepEqual(nearbyStopsWithin50m(selected, [
    entry(stop("zero", 0, 0)),
    entry(stop("missing", undefined as unknown as number)),
    entry(stop("nan", Number.NaN)),
    entry(stop("infinite", Number.POSITIVE_INFINITY)),
    entry(stop("latitude", 91)),
    entry(stop("longitude", 0, -181)),
  ]).map(({ stop }) => stop.stopId), ["zero"]);
  assert.deepEqual(nearbyStopsWithin50m(entry(stop("invalid-selected", Number.NaN)), [entry(stop("zero", 0))]), []);
});

test("same-location different stops are included, self excluded, closest and ID tie sorted", () => {
  const selected = entry(stop("selected", 0));
  assert.deepEqual(nearbyStopsWithin50m(selected, [
    selected, entry(stop("far", atMeters(25))), entry(stop("z", 0)), entry(stop("a", 0)),
  ]).map(({ stop }) => stop.stopId), ["a", "z", "far"]);
});

test("only routes in selected open plan participate, including other routes in that plan", () => {
  const selected = stop("selected", 0);
  const shared = stop("shared", 0);
  const foreign = stop("foreign", 0);
  const rows = [
    { routeId: "route-a", stops: [selected] },
    { routeId: "route-b", stops: [shared] },
    { routeId: "route-c", stops: [foreign] },
  ] as ScheduledRow[];
  const routes = [
    { id: "route-a", planId: "plan-a" },
    { id: "route-b", planId: "plan-a" },
    { id: "route-c", planId: "plan-b" },
  ];
  assert.deepEqual(nearbyStopsForSelection(selected, rows, routes).map(({ stop }) => stop.stopId), ["shared"]);
  assert.deepEqual(nearbyStopsForSelection(selected, rows, routes.filter((route) => route.id !== "route-a")), []);
  assert.deepEqual(nearbyStopsForSelection(stop("unassigned", 0), rows, routes), []);
  assert.deepEqual(nearbyStopsWithin50m(entry(selected), [entry(shared, "plan-b")]), []);
});