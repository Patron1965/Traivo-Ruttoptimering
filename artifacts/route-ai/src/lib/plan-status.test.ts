import assert from "node:assert/strict";
import test from "node:test";
import { deriveNoServerPlanStatus, derivePlanStatus, getCurrentApprovalResources } from "./plan-status.ts";

function route(overrides: Record<string, unknown> = {}) {
  return {
    id: "route-1",
    status: "optimized",
    planRevision: 1,
    vehicleId: "vehicle-1",
    driverId: "driver-1",
    manualReviewRequired: false,
    manualReviewedAt: null,
    handoffStatus: "pending",
    ...overrides,
  };
}

function protectedApproval(
  routes: Array<{ routeId: string; planRevision: number; approved: boolean }>,
  protectedPlan = true,
) {
  return {
    protected: protectedPlan,
    routes: routes.map((item) => ({
      routeId: item.routeId,
      planRevision: item.planRevision,
      driverId: "driver-1",
      approval: { approved: item.approved },
    })),
  };
}

test("empty plans remain drafts and preserve the unplanned-stop blocker", () => {
  const result = derivePlanStatus({ routes: [], unplannedCount: 3 });

  assert.deepEqual(
    {
      status: result.status,
      stage: result.stage,
      nextAction: result.nextAction,
      routeCount: result.routeCount,
      blockers: result.blockers,
    },
    {
      status: "draft",
      stage: 0,
      nextAction: "build",
      routeCount: 0,
      blockers: [{ type: "unplannedStops", count: 3 }],
    },
  );
});

test("current approval resolves the review flag, but stale approval does not", () => {
  const routes = [route({ manualReviewRequired: true })];
  const approval = protectedApproval([{ routeId: "route-1", planRevision: 1, approved: true }]);
  assert.equal(derivePlanStatus({ routes, approval }).blockers.some(b => b.type === "manualReview"), false);
  assert.equal(derivePlanStatus({
    routes: [route({ manualReviewRequired: true, planRevision: 2 })], approval,
  }).blockers.some(b => b.type === "manualReview"), true);
});

test("a wizard step cannot present a calculated plan before a server plan exists", () => {
  const result = deriveNoServerPlanStatus(228);
  assert.equal(result.status, "draft");
  assert.equal(result.stage, 0);
  assert.equal(result.nextAction, "build");
  assert.deepEqual(result.blockers, [{ type: "unplannedStops", count: 228 }]);
});

test("partial handoff is distinct from fully sent, received and accepted", () => {
  const partiallySent = derivePlanStatus({
    routes: [
      route({ id: "route-1", handoffStatus: "sent" }),
      route({ id: "route-2", handoffStatus: "pending" }),
    ],
  });
  assert.equal(partiallySent.status, "partially_sent");
  assert.equal(partiallySent.sentCount, 1);
  assert.equal(partiallySent.nextAction, "follow_up");

  const partiallyReceived = derivePlanStatus({
    routes: [
      route({ id: "route-1", handoffStatus: "received" }),
      route({ id: "route-2", handoffStatus: "sent" }),
    ],
  });
  assert.equal(partiallyReceived.status, "partially_received");
  assert.equal(partiallyReceived.receivedCount, 1);

  const partiallyAccepted = derivePlanStatus({
    routes: [
      route({ id: "route-1", handoffStatus: "accepted" }),
      route({ id: "route-2", handoffStatus: "received" }),
    ],
  });
  assert.equal(partiallyAccepted.status, "partially_accepted");
  assert.equal(partiallyAccepted.acceptedCount, 1);
});

test("a stale or unprotected approval cannot make a plan appear approved", () => {
  const staleRevision = derivePlanStatus({
    routes: [route({ id: "route-1", planRevision: 2 })],
    approval: protectedApproval([
      { routeId: "route-1", planRevision: 1, approved: true },
    ]),
  });
  assert.notEqual(staleRevision.status, "approved");
  assert.equal(staleRevision.status, "approval_checking");
  assert.equal(staleRevision.nextAction, "follow_up");

  const unprotected = derivePlanStatus({
    routes: [route({ id: "route-1" })],
    approval: protectedApproval([
      { routeId: "route-1", planRevision: 1, approved: true },
    ], false),
  });
  assert.notEqual(unprotected.status, "approved");
  assert.equal(unprotected.approvedCount, 0);
  assert.equal(unprotected.status, "dispatch_ready");
  assert.equal(unprotected.nextAction, "send");

  const checking = derivePlanStatus({
    routes: [route({ id: "route-1" })],
    approvalAvailability: "checking",
  });
  assert.equal(checking.status, "approval_checking");
  assert.equal(checking.nextAction, "follow_up");

  const wrongRouteIdentity = derivePlanStatus({
    routes: [
      route({ id: "route-1", planRevision: 1 }),
      route({ id: "route-2", planRevision: 1 }),
    ],
    approval: protectedApproval([
      { routeId: "route-elsewhere", planRevision: 1, approved: true },
      { routeId: "route-2", planRevision: 1, approved: true },
    ]),
  });
  assert.equal(wrongRouteIdentity.approvedCount, 1);

  const staleHandoff = derivePlanStatus({
    routes: [route({
      planRevision: 2,
      handoffStatus: "sent",
      handoffVersion: 1,
      handoffDriverId: "driver-1",
    })],
  });
  assert.equal(staleHandoff.sentCount, 0);
  assert.notEqual(staleHandoff.status, "sent");
});

test("partial approval remains actionable until every current route is approved", () => {
  const result = derivePlanStatus({
    routes: [
      route({ id: "route-1" }),
      route({ id: "route-2" }),
    ],
    approval: protectedApproval([
      { routeId: "route-1", planRevision: 1, approved: true },
      { routeId: "route-2", planRevision: 1, approved: false },
    ]),
  });

  assert.equal(result.status, "partially_approved");
  assert.equal(result.approvedCount, 1);
  assert.equal(result.nextAction, "approve");
});

test("a protected revision-zero approval is reflected from the current mapping", () => {
  const awaiting = derivePlanStatus({
    routes: [route({ id: "route-1", planRevision: 0 })],
    approval: protectedApproval([
      { routeId: "route-1", planRevision: 0, approved: false },
    ]),
  });
  assert.equal(awaiting.status, "ready_for_approval");
  assert.equal(awaiting.nextAction, "approve");

  const result = derivePlanStatus({
    routes: [route({ id: "route-1", planRevision: 0 })],
    approval: protectedApproval([
      { routeId: "route-1", planRevision: 0, approved: true },
    ]),
  });

  assert.equal(result.status, "approved");
  assert.equal(result.approvedCount, 1);
  assert.equal(result.nextAction, "send");
});

test("manual review remains a real blocker before unprotected dispatch", () => {
  const result = derivePlanStatus({
    routes: [route({ manualReviewRequired: true, manualReviewedAt: null })],
  });

  assert.equal(result.status, "needs_review");
  assert.equal(result.nextAction, "review");
  assert.deepEqual(result.blockers, [{ type: "manualReview" }]);
});

test("resource pairs use only current approval revisions without requiring protection", () => {
  const routes = [route({ id: "route-1", planRevision: 2 })];
  const stale = protectedApproval([
    { routeId: "route-1", planRevision: 1, approved: true },
  ]);
  assert.equal(getCurrentApprovalResources(routes, stale), null);
  const unprotectedCurrent = {
    protected: false,
    routes: protectedApproval([
      { routeId: "route-1", planRevision: 2, approved: false },
    ]).routes,
  };
  assert.deepEqual(getCurrentApprovalResources(routes, unprotectedCurrent), unprotectedCurrent.routes);
  const current = protectedApproval([
    { routeId: "route-1", planRevision: 2, approved: true },
  ]);
  assert.deepEqual(getCurrentApprovalResources(routes, current), current.routes);
});
