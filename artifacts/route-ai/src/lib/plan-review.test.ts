import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlanResumeStep, resolvePlanReviewDepot } from "./plan-review.ts";
import { buildHydratedImportRoutes } from "./import-resume.ts";

test("plan review uses the immutable route depot when driver coordinates are absent", () => {
  const result = resolvePlanReviewDepot(
    [{
      vehicleId: "vehicle-1",
      depotSnapshot: {
        start: { latitude: 57.7089, longitude: 11.9746 },
      },
    }],
    [{
      id: "driver-1",
      vehicleId: "vehicle-1",
      isActive: true,
      startLatitude: null,
      startLongitude: null,
    }],
    new Set(["vehicle-1"]),
  );

  assert.deepEqual(result, {
    depotLatitude: 57.7089,
    depotLongitude: 11.9746,
    fallbackDriverId: "driver-1",
  });
});

test("plan review has no invented fallback when neither source has coordinates", () => {
  assert.equal(resolvePlanReviewDepot(
    [{ vehicleId: "vehicle-1", depotSnapshot: null }],
    [{ id: "driver-1", vehicleId: "vehicle-1", isActive: true }],
    new Set(["vehicle-1"]),
  ), null);
});

test("a resource-only route can be reviewed without an organization depot", () => {
  assert.deepEqual(resolvePlanReviewDepot(
    [{ vehicleId: "vehicle-1", depotSnapshot: null }],
    [{ id: "driver-1", vehicleId: "vehicle-1", isActive: true,
      startLatitude: 59.33, startLongitude: 18.06 }],
    new Set(["vehicle-1"]),
  ), { depotLatitude: 59.33, depotLongitude: 18.06, fallbackDriverId: "driver-1" });
});

test("plan review ignores inactive or unrelated driver depot candidates", () => {
  const routes = [{ vehicleId: "vehicle-1", depotSnapshot: null }];
  const drivers = [
    {
      id: "inactive-assigned",
      vehicleId: "vehicle-1",
      isActive: false,
      startLatitude: 57.7,
      startLongitude: 11.9,
    },
    {
      id: "unrelated-active",
      vehicleId: "vehicle-2",
      isActive: true,
      startLatitude: 57.8,
      startLongitude: 12,
    },
  ];

  assert.equal(resolvePlanReviewDepot(routes, drivers, new Set(["vehicle-1"])), null);
  assert.equal(resolvePlanReviewDepot(routes, drivers, new Set(["vehicle-2"])), null);
});

test("review resume always chooses review and never opens a blank dispatch step", () => {
  assert.equal(resolvePlanResumeStep(true, 2, true), 6);
  assert.equal(resolvePlanResumeStep(true, 0, true), 6);
  assert.equal(resolvePlanResumeStep(false, 0, true), 6);
  assert.equal(resolvePlanResumeStep(false, 2, true), 7);
});

test("route hydration uses fresh route payloads rather than persisted assigned routes", () => {
  const result = buildHydratedImportRoutes(
    {
      planId: "plan-1",
      protected: true,
      routes: [{
        routeId: "route-1",
        planId: "plan-1",
        planRevision: 3,
        status: "optimized",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        approval: { approved: true, approvedAt: null, approvedByUserId: null },
      }],
    },
    [{
      summary: {
        routeId: "route-1",
        planId: "plan-1",
        planRevision: 3,
        status: "optimized",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        approval: { approved: true, approvedAt: null, approvedByUserId: null },
      },
      route: {
        name: "Fresh route",
        status: "optimized",
        handoffStatus: "sent",
        totalStops: 4,
      },
    }],
  );
  assert.equal(result[0]?.name, "Fresh route");
  assert.equal(result[0]?.handoffStatus, "sent");
  assert.equal(result[0]?.stopCount, 4);
});

test("route hydration rejects an incomplete authoritative response", () => {
  assert.throws(
    () => buildHydratedImportRoutes({
      planId: "plan-1",
      protected: true,
      routes: [{
        routeId: "route-1",
        planId: "plan-1",
        planRevision: 1,
        status: "optimized",
        vehicleId: "vehicle-1",
        driverId: "driver-1",
        approval: { approved: false, approvedAt: null, approvedByUserId: null },
      }],
    }, []),
    /IMPORT_ROUTE_HYDRATION_INCOMPLETE/,
  );
});