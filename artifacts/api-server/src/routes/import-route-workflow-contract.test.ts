import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AdjustAssignedRoutesBody,
  AdjustAssignedRoutesResponse,
  CreateImportRoutePlanBody,
  MoveDispatchStopsBody,
  PreviewRouteReoptimizationBody,
  ApplyRouteReoptimizationBody,
  PreviewRouteReoptimizationResponse,
  PreviewImportRoutePlanReoptimizationBody,
  ApplyImportRoutePlanReoptimizationBody,
  PreviewImportRoutePlanReoptimizationResponse,
} from "@workspace/api-zod";

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}`;

test("route adjustment does not require proposal-assignment diagnostics", () => {
  const parsed = AdjustAssignedRoutesBody.safeParse({
    planId: id(1),
    routes: [{
      routeId: id(2),
      driverId: id(3),
      planRevision: 1,
      stopIds: [id(4)],
    }],
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  });

  assert.equal(parsed.success, true);
});

test("route adjustment response retains the recalculated workday", () => {
  const parsed = AdjustAssignedRoutesResponse.safeParse({
    routes: [{
      routeId: id(2),
      planId: id(1),
      name: "Rutt 1",
      vehicleId: id(5),
      driverId: id(3),
      stopCount: 1,
      totalDistanceKm: 10,
      totalDurationMin: 30,
      planRevision: 2,
      status: "optimized",
      depotSnapshot: null,
      workdayTimeline: [{
        type: "return",
        startAt: new Date("2026-09-02T12:00:00.000Z"),
        endAt: new Date("2026-09-02T12:30:00.000Z"),
        durationMin: 30,
        distanceKm: 18,
      }],
      workdaySummary: {
        shiftMin: 480,
        nonReturnDrivingMin: 90,
        serviceMin: 120,
        waitingMin: 15,
        breakMin: 30,
        returnMin: 30,
        totalMin: 285,
        marginMin: 195,
        overtimeMin: 0,
        shiftEndAt: new Date("2026-09-02T14:00:00.000Z"),
      },
    }],
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.routes[0].workdaySummary?.returnMin, 30);
  assert.equal(parsed.data.routes[0].workdayTimeline?.[0].type, "return");
});

test("combined route-plan contract accepts real vehicle-driver pairs without proposal tokens", () => {
  const parsed = CreateImportRoutePlanBody.safeParse({
    stopIds: [id(4)],
    pairs: [{ vehicleId: id(5), driverId: id(3) }],
    date: new Date("2026-09-02T06:00:00.000Z"),
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.vehicleDistributionMode, "balance");
});

test("affected-route reoptimization persists authoritative depot workday evidence", () => {
  const source = readFileSync(new URL("./optimize.ts", import.meta.url), "utf8");
  assert.match(source, /existingRoute\.depotSnapshot \?\? currentDepotSnapshot/);
  assert.match(source, /evaluateRouteWorkday\([\s\S]*existingRoute\.date/);
  assert.match(source, /depotSnapshot: update\.depotSnapshot/);
  assert.match(source, /workdayTimeline: update\.workdayTimeline/);
  assert.match(source, /workdaySummary: update\.workdaySummary/);
});

test("group move contract accepts compare-and-swap revisions for all affected routes", () => {
  const parsed = MoveDispatchStopsBody.safeParse({
    stopIds: [id(4)],
    routeId: id(2),
    targetIndex: 0,
    routeRevisions: [
      { routeId: id(2), planRevision: 7 },
      { routeId: id(6), planRevision: 3 },
    ],
  });
  assert.equal(parsed.success, true);
});

test("route-scoped preview/apply contracts carry the exact pending proposal and revision", () => {
  const previewInput = {
    planRevision: 4,
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  };
  assert.equal(PreviewRouteReoptimizationBody.safeParse(previewInput).success, true);
  assert.equal(ApplyRouteReoptimizationBody.safeParse({
    ...previewInput,
    optimizedStopIds: [id(4), id(5)],
  }).success, true);
  assert.equal(PreviewRouteReoptimizationResponse.safeParse({
    routeId: id(2),
    planRevision: 4,
    vehicleId: id(3),
    lockedStopIds: [id(6)],
    pendingStopIds: [id(4), id(5)],
    optimizedStopIds: [id(5), id(4)],
    plannerItinerary: [],
    totalStops: 3,
    totalDistanceKm: 12.5,
    totalDurationMin: 45,
    co2EmissionsKg: 2.1,
    depotSnapshot: null,
    workdayTimeline: [],
    workdaySummary: {
      shiftMin: 540,
      nonReturnDrivingMin: 25,
      serviceMin: 10,
      waitingMin: 0,
      breakMin: 0,
      returnMin: 10,
      totalMin: 45,
      marginMin: 495,
      overtimeMin: 0,
      shiftEndAt: new Date("2026-08-26T14:00:00.000Z"),
    },
  }).success, true);
});

test("whole-plan preview/apply contracts carry named-plan, resource, and proposal revisions", () => {
  const preview = {
    draftId: id(10),
    draftRevision: 4,
    routes: [{ routeId: id(2), driverId: id(3), planRevision: 7 }],
    pairs: [{ vehicleId: id(5), driverId: id(3) }],
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  };
  assert.equal(PreviewImportRoutePlanReoptimizationBody.safeParse(preview).success, true);
  assert.equal(
    ApplyImportRoutePlanReoptimizationBody.safeParse({
      ...preview,
      proposalHash: "a".repeat(64),
    }).success,
    true,
  );
  assert.equal(
    PreviewImportRoutePlanReoptimizationResponse.safeParse({
      planId: id(1),
      draftId: id(10),
      draftRevision: 5,
      proposalHash: "a".repeat(64),
      lockedStopCount: 0,
      movedStopCount: 2,
      routes: [{
        routeId: id(2),
        vehicleId: id(5),
        driverId: id(3),
        planRevision: 7,
        nextPlanRevision: 8,
        status: "optimized",
        lockedStopIds: [],
        pendingStopIds: [id(4), id(5)],
        optimizedStopIds: [id(5), id(4)],
        movedStopCount: 2,
        before: { stopCount: 2, distanceKm: 12, durationMin: 40 },
        after: { stopCount: 2, distanceKm: 10, durationMin: 35 },
      }],
    }).success,
    true,
  );
});
