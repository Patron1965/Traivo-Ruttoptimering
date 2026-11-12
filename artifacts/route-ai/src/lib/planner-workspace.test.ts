import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveHandoffEvidence, deriveRevisionEvidence, deriveReviewScopeNotice, deriveWorkflowMoments, deriveWorkspaceScope, formatDateRange,
} from "./planner-workspace.ts";

const route = (o: Record<string, unknown> = {}) => ({
  id: "r1", planId: "p1", name: "Rutt 1", status: "optimized", date: "2025-03-04",
  vehicleId: "v1", driverId: "d1", planRevision: 3, ...o,
});
const byId = (ms: ReturnType<typeof deriveWorkflowMoments>, id: string) => ms.find((m) => m.id === id)!;

test("no scope asks for a plan instead of a cross-project date range", () => {
  const s = deriveWorkspaceScope({ routes: [], scheduledStopCount: 0, unassignedCount: 0 });
  assert.equal(s.dateLabel, "Välj plan och dag");
  assert.equal(s.dateDetail, null);
  assert.equal(deriveWorkspaceScope({ planId: "p1", day: "2025-03-06", routes: [route({ date: "2025-03-06" })], scheduledStopCount: 1, unassignedCount: 0 }).dateLabel, "2025-03-06");
});

test("revision is unanimous, mixed or unknown, never a max", () => {
  assert.deepEqual(deriveRevisionEvidence([route(), route({ id: "r2" })]), { kind: "unanimous", value: 3 });
  assert.deepEqual(deriveRevisionEvidence([route(), route({ id: "r2", planRevision: 5 })]), { kind: "mixed", values: [3, 5] });
  assert.deepEqual(deriveRevisionEvidence([route({ planRevision: null })]), { kind: "unknown" });
});

test("handoff compared per route, not across maxima", () => {
  const e = deriveHandoffEvidence([
    route({ handoffStatus: "sent", handoffVersion: 3 }),
    route({ id: "r2", planRevision: 5, handoffStatus: "sent", handoffVersion: 3 }),
    route({ id: "r3", handoffStatus: "accepted" }),
    route({ id: "r4", handoffStatus: "pending", handoffVersion: 3 }),
  ]);
  assert.deepEqual(e, { current: 1, stale: 1, unverified: 1, none: 1 });
});

test("underlag presence is active, not done", () => {
  assert.equal(byId(deriveWorkflowMoments({ scopeKind: "plan", routes: [route()], scheduledStopCount: 2, unassignedCount: 0 }), "underlag").state, "active");
});

test("resources use current driverId only", () => {
  const missing = deriveWorkflowMoments({ scopeKind: "plan", routes: [route({ driverId: null, handoffDriverId: "d9" })], scheduledStopCount: 1, unassignedCount: 0 });
  assert.equal(byId(missing, "resurser").state, "attention");
  const r = route(); delete (r as Record<string, unknown>).driverId;
  assert.equal(byId(deriveWorkflowMoments({ scopeKind: "plan", routes: [r], scheduledStopCount: 1, unassignedCount: 0 }), "resurser").state, "unknown");
});

test("unknown unassigned data blocks proposal and send completion", () => {
  const ms = deriveWorkflowMoments({ scopeKind: "plan", routes: [route({ handoffStatus: "accepted", handoffVersion: 3 })], scheduledStopCount: null, unassignedCount: null });
  assert.equal(byId(ms, "underlag").state, "unknown");
  assert.equal(byId(ms, "planforslag").state, "unknown");
  assert.notEqual(byId(ms, "godkann").state, "done");
});

test("calculated routes are not done; manual flag raises attention", () => {
  const ok = deriveWorkflowMoments({ scopeKind: "plan", routes: [route()], scheduledStopCount: 1, unassignedCount: 0 });
  assert.equal(byId(ok, "planforslag").state, "active");
  assert.equal(byId(ok, "granskning").state, "active");
  const flagged = deriveWorkflowMoments({ scopeKind: "plan", routes: [route({ manualReviewRequired: true })], scheduledStopCount: 1, unassignedCount: 0 });
  assert.equal(byId(flagged, "planforslag").state, "attention");
  assert.equal(byId(flagged, "granskning").state, "attention");
});

test("granskning done only with exact current protected approval", () => {
  const approval = { protected: true, routes: [{ routeId: "r1", planRevision: 3, approval: { approved: true } }] };
  assert.equal(byId(deriveWorkflowMoments({ scopeKind: "plan", routes: [route()], scheduledStopCount: 1, unassignedCount: 0, approval }), "granskning").state, "done");
  const old = { protected: true, routes: [{ routeId: "r1", planRevision: 2, approval: { approved: true } }] };
  assert.equal(byId(deriveWorkflowMoments({ scopeKind: "plan", routes: [route()], scheduledStopCount: 1, unassignedCount: 0, approval: old }), "granskning").state, "active");
  assert.equal(byId(deriveWorkflowMoments({ scopeKind: "global", routes: [route()], scheduledStopCount: 1, unassignedCount: 0, approval }), "granskning").state, "active");
});

test("protected approval supersedes a legacy review flag only for its exact revision", () => {
  const input = { scopeKind: "plan" as const, routes: [route({ manualReviewRequired: true })], scheduledStopCount: 3, unassignedCount: 0,
    approval: { protected: true, routes: [{ routeId: "r1", planRevision: 3, approval: { approved: true } }] } };
  const moments = deriveWorkflowMoments(input);
  assert.equal(byId(moments, "granskning").state, "done");
  assert.equal(byId(moments, "planforslag").state, "done");
  for (const changed of [
    { ...input, routes: [route({ manualReviewRequired: true, planRevision: 4 })] },
    { ...input, approvalError: true },
    { ...input, approvalLoading: true },
    { ...input, scopeKind: "global" as const },
  ]) {
    assert.equal(byId(deriveWorkflowMoments(changed), "granskning").state, "attention");
  }
});

test("send done only with verified current receipts; stale and global unknowns honest", () => {
  const sent = deriveWorkflowMoments({ scopeKind: "global", routes: [route({ handoffStatus: "accepted", handoffVersion: 3 })], scheduledStopCount: 1, unassignedCount: 0 });
  assert.equal(byId(sent, "godkann").state, "done");
  const stale = deriveWorkflowMoments({ scopeKind: "plan", routes: [route({ handoffStatus: "sent", handoffVersion: 2 })], scheduledStopCount: 1, unassignedCount: 0 });
  assert.equal(byId(stale, "godkann").state, "attention");
  const none = deriveWorkflowMoments({ scopeKind: "global", routes: [route()], scheduledStopCount: 1, unassignedCount: 0 });
  assert.equal(byId(none, "godkann").state, "unknown");
  const loading = deriveWorkflowMoments({ scopeKind: "plan", routes: [route()], scheduledStopCount: 1, unassignedCount: 0, approvalLoading: true });
  assert.equal(byId(loading, "godkann").state, "unknown");
});

test("date range dedupes", () => {
  assert.equal(formatDateRange(["2025-01-02", "2025-01-02", null]), "2025-01-02");
  assert.equal(formatDateRange([]), null);
});

test("review notice groups only visible unreviewed flags by exact plan and keeps unlinked routes explicit", () => {
  const notice = deriveReviewScopeNotice("global", [
    route({ manualReviewRequired: true }),
    route({ id: "r2", manualReviewRequired: true }),
    route({ id: "r3", planId: "p &/2", manualReviewRequired: true }),
    route({ id: "r4", planId: null, manualReviewRequired: true }),
    route({ id: "r5", manualReviewRequired: true, manualReviewedAt: "2026-10-30" }),
    route({ id: "r6" }),
  ])!;
  assert.equal(notice.routeCount, 4);
  assert.deepEqual(notice.plans.map(p => [p.planId, p.routeCount]), [["p1", 2], ["p &/2", 1]]);
  const target = new URL(notice.plans[1].href, "https://example.test");
  assert.equal(target.pathname, "/dispatch");
  assert.deepEqual([...target.searchParams], [["view", "traffic"], ["planId", "p &/2"]]);
  assert.equal(notice.unlinkedRoutes[0].id, "r4");
  assert.equal(deriveReviewScopeNotice("plan", [route({ manualReviewRequired: true })]), null);
  assert.equal(deriveReviewScopeNotice("global", [route()]), null);
  assert.equal(deriveReviewScopeNotice("route", [route({ manualReviewRequired: true })])?.routeCount, 1);
});

test("global flags remain warnings even for completed routes; running routes stay running", () => {
  for (const status of ["in_progress", "completed"]) {
    const moments = deriveWorkflowMoments({
      scopeKind: "global", routes: [route({ status, manualReviewRequired: true })],
      scheduledStopCount: 3, unassignedCount: 2,
      approval: { protected: true, routes: [{ routeId: "r1", planRevision: 3, approval: { approved: true } }] },
    });
    assert.equal(byId(moments, "planforslag").state, "attention");
    assert.match(byId(moments, "planforslag").evidence, /2 ej tilldelade/);
    assert.equal(byId(moments, "granskning").state, "attention");
    assert.match(byId(moments, "granskning").evidence, /godkännande ej verifierat här/);
    assert.equal(byId(moments, "utforande").state, status === "completed" ? "done" : "active");
  }
});
