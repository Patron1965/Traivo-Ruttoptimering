import test from "node:test";
import assert from "node:assert/strict";
import type { ImportRoutePlanApprovalResult, Route } from "@workspace/api-client-react";
import {
  getImportApprovalActionState,
  mapImportApprovalRoutes,
  type ExactApprovalMatcher,
} from "./import-plan-approval.ts";

const exactApproval: ExactApprovalMatcher = (result, expected) => {
  if (!result.protected || result.routes.length !== expected.length) return false;
  const expectedById = new Map(expected.map((route) => [route.routeId, route]));
  return result.routes.every((route) => {
    const expectedRoute = expectedById.get(route.routeId);
    return Boolean(
      expectedRoute
      && route.planRevision === expectedRoute.planRevision
      && route.driverId === expectedRoute.driverId
      && route.approval.approved,
    );
  });
};

function liveRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "route-1",
    planId: "plan-1",
    organizationId: "org-1",
    vehicleId: "vehicle-1",
    name: "Stockholm centrum",
    status: "optimized",
    manualReviewRequired: false,
    manualReviewedAt: null,
    planRevision: 3,
    handoffStatus: "pending",
    date: "2026-01-01T00:00:00.000Z",
    totalStops: 4,
    totalDistanceKm: 12,
    totalDurationMin: 30,
    geographicOverlapExplanation: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function approval(
  overrides: Partial<ImportRoutePlanApprovalResult> = {},
): ImportRoutePlanApprovalResult {
  return {
    planId: "plan-1",
    protected: true,
    routes: [{
      routeId: "route-1",
      planId: "plan-1",
      draftId: "draft-1",
      planRevision: 3,
      status: "optimized",
      vehicleId: "vehicle-1",
      driverId: "driver-1",
      approval: {
        approved: false,
        approvedAt: null,
        approvedByUserId: null,
      },
    }],
    ...overrides,
  };
}

test("maps only an exact approved live route set and uses approval driver", () => {
  const result = mapImportApprovalRoutes(
    "plan-1",
    [liveRoute()],
    approval({
      routes: [{
        ...approval().routes[0],
        approval: { approved: true, approvedAt: "2026-01-01T01:00:00.000Z", approvedByUserId: "user-1" },
      }],
    }),
    exactApproval,
  );

  assert.equal(result.state, "exact");
  assert.equal(result.assignedRoutes[0]?.driverId, "driver-1");
  assert.equal(result.assignedRoutes[0]?.name, "Stockholm centrum");
});

test("blocks a stale approval when the live plan revision changes", () => {
  const result = mapImportApprovalRoutes(
    "plan-1",
    [liveRoute({ planRevision: 4 })],
    approval({
      routes: [{
        ...approval().routes[0],
        approval: { approved: true, approvedAt: "2026-01-01T01:00:00.000Z", approvedByUserId: "user-1" },
      }],
    }),
    exactApproval,
  );

  assert.equal(result.state, "stale");
  assert.equal(result.exact, false);
  assert.equal(result.assignedRoutes.length, 0);
});

test("does not invent a driver when the approval response has no recipient", () => {
  const result = mapImportApprovalRoutes(
    "plan-1",
    [liveRoute()],
    approval({
      routes: [{ ...approval().routes[0], driverId: null }],
    }),
    exactApproval,
  );

  assert.equal(result.state, "missingDriver");
  assert.equal(result.assignedRoutes.length, 0);
});

test("read-only users can inspect approval state but never receive a mutation action", () => {
  assert.equal(getImportApprovalActionState("exact", false), "readOnly");
  assert.equal(getImportApprovalActionState("awaitingApproval", false), "readOnly");
  assert.equal(getImportApprovalActionState("exact", true), "exact");
  assert.equal(getImportApprovalActionState("awaitingApproval", true), "awaitingApproval");
  assert.equal(getImportApprovalActionState("stale", true), "blocked");
});

test("conserves the current non-cancelled route set and ignores cancelled routes", () => {
  const result = mapImportApprovalRoutes(
    "plan-1",
    [
      liveRoute(),
      liveRoute({
        id: "route-cancelled",
        status: "cancelled",
        vehicleId: "vehicle-2",
      }),
    ],
    approval({
      routes: [{
        ...approval().routes[0],
        approval: { approved: true, approvedAt: "2026-01-01T01:00:00.000Z", approvedByUserId: "user-1" },
      }],
    }),
    exactApproval,
  );

  assert.equal(result.state, "exact");
  assert.deepEqual(result.allPlanRoutes.map((route) => route.id), ["route-1"]);
  assert.deepEqual(result.assignedRoutes.map((route) => route.routeId), ["route-1"]);
});

test("corrects recipient data only from the current protected approval response", () => {
  const result = mapImportApprovalRoutes(
    "plan-1",
    [liveRoute()],
    approval({
      routes: [{
        ...approval().routes[0],
        driverId: "driver-corrected",
        approval: { approved: false, approvedAt: null, approvedByUserId: null },
      }],
    }),
    exactApproval,
  );

  assert.equal(result.state, "awaitingApproval");
  assert.equal(result.expectedRoutes[0]?.driverId, "driver-corrected");
  assert.equal(result.assignedRoutes.length, 0);
});

test("a published working revision can be explicitly reviewed without treating it as already sent", () => {
  const result = mapImportApprovalRoutes("plan-1", [liveRoute({
    status: "in_progress", handoffStatus: "accepted", handoffVersion: 2, handoffDriverId: "driver-1", dispatchSnapshotVersion: 2,
  })], approval(), exactApproval);
  assert.equal(result.state, "awaitingApproval");
  assert.equal(result.canApprove, true);
  assert.equal(result.assignedRoutes.length, 0);
});

test("legacy active routes without outgoing version evidence do not gain approval controls", () => {
  const result = mapImportApprovalRoutes("plan-1", [liveRoute({
    status: "in_progress", handoffVersion: null, handoffDriverId: null,
  })], approval(), exactApproval);
  assert.equal(result.canApprove, false);
  const missingSnapshot = mapImportApprovalRoutes("plan-1", [liveRoute({
    status: "in_progress", handoffVersion: 2, handoffDriverId: "driver-1", dispatchSnapshotVersion: null,
  })], approval(), exactApproval);
  assert.equal(missingSnapshot.canApprove, false);
});
