import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStopRegisterRequest,
  duplicateVisitSiteIds,
  filterRegister,
  groupCheckState,
  isStaleTargetError,
  reconcileRegisterSelection,
  stopRegisterFingerprint,
  toggleSites,
  type RegisterGroup,
  type StopRegisterTarget,
} from "./stop-register.ts";

const groups: RegisterGroup[] = [
  { id: "g1", name: "Måndagsturen", sites: [
    { id: "s1", name: "Bageriet", address: "Storgatan 1" },
    { id: "s2", name: "Kiosken", address: "Lillgatan 4", archivedAt: "2026-01-01" },
    { id: "s3", name: "Skolan", address: "Skolvägen 9", isPrioritized: true },
  ] },
  { id: "g2", name: "Arkiv", archivedAt: "2026-01-01", sites: [{ id: "s4", name: "X", address: "Y" }] },
];
const draft: StopRegisterTarget = { kind: "draft", draftId: "d1", name: "Utkast", date: "2026-05-04" };
const plan: StopRegisterTarget = { kind: "plan", planId: "p1", name: "Plan", date: "2026-05-04", routes: [{ routeId: "r1", planRevision: 3 }] };

test("filter matches group or site and hides archived", () => {
  assert.deepEqual(filterRegister(groups, "").map((g) => g.sites.map((s) => s.id)), [["s1", "s3"]]);
  assert.deepEqual(filterRegister(groups, "skolv")[0].sites.map((s) => s.id), ["s3"]);
  assert.equal(filterRegister(groups, "måndag")[0].sites.length, 2);
});

test("group selection is tri-state and toggles whole group", () => {
  const sites = filterRegister(groups, "")[0].sites;
  let selected = toggleSites(new Set(), ["s1"], true);
  assert.equal(groupCheckState(sites, selected), "indeterminate");
  selected = toggleSites(selected, sites.map((s) => s.id), true);
  assert.equal(groupCheckState(sites, selected), true);
  assert.equal(groupCheckState(sites, toggleSites(selected, ["s1", "s3"], false)), false);
  assert.deepEqual([...reconcileRegisterSelection(groups, new Set(["s1", "s2", "s4"]))], ["s1"]);
});

test("requests carry exactly one target", () => {
  const d = buildStopRegisterRequest({ target: draft, siteIds: ["s3", "s1"], idempotencyKey: "k", draftRevision: 7, allowDuplicateVisits: false });
  assert.deepEqual(d, { siteIds: ["s1", "s3"], date: "2026-05-04", idempotencyKey: "k", draftId: "d1", draftRevision: 7 });
  const p = buildStopRegisterRequest({ target: plan, siteIds: ["s1"], idempotencyKey: "k", allowDuplicateVisits: true });
  assert.equal(p.draftId, undefined);
  assert.equal(p.planId, "p1");
  assert.equal(p.allowDuplicateVisits, true);
  assert.deepEqual(p.routes, [{ routeId: "r1", planRevision: 3 }]);
  assert.throws(() => buildStopRegisterRequest({ target: draft, siteIds: ["s1"], idempotencyKey: "k", allowDuplicateVisits: false }));
});

test("fingerprint is order independent and changes with consent", () => {
  assert.equal(stopRegisterFingerprint(draft, ["a", "b"], false), stopRegisterFingerprint(draft, ["b", "a"], false));
  assert.notEqual(stopRegisterFingerprint(draft, ["a"], false), stopRegisterFingerprint(draft, ["a"], true));
});

test("duplicate and stale errors are classified, not confused", () => {
  const dup = { status: 409, data: { code: "DUPLICATE_CUSTOMER_VISITS", details: { siteIds: ["s1"] } } };
  assert.deepEqual(duplicateVisitSiteIds(dup), ["s1"]);
  assert.equal(isStaleTargetError(dup), false);
  assert.equal(isStaleTargetError({ status: 409, data: { code: "DRAFT_REVISION_CONFLICT" } }), true);
  assert.equal(isStaleTargetError({ status: 500 }), false);
});

import { createStopRegisterSubmission, stopRegisterTargetIdentity } from "./stop-register.ts";

test("ambiguous network failure retries the exact same request without re-preparing", async () => {
  const sent: unknown[] = [];
  let prepares = 0;
  let calls = 0;
  const submission = createStopRegisterSubmission({
    prepare: async () => ({ draftRevision: 10 + prepares++ }),
    mutate: async (request) => {
      sent.push(JSON.parse(JSON.stringify(request)));
      if (calls++ === 0) throw new TypeError("Failed to fetch");
      return { stopIds: ["n1"], count: 1, draftId: "d1" };
    },
    hydrate: async () => {},
    newKey: (() => { let i = 0; return () => `key-${i++}`; })(),
  });
  assert.equal((await submission.submit(draft, ["s1"], false)).kind, "retryable");
  assert.equal((await submission.submit(draft, ["s1"], false)).kind, "success");
  assert.equal(prepares, 1);
  assert.deepEqual(sent[0], sent[1]);
});

test("plan retries keep frozen route revisions", async () => {
  const sent: Array<{ routes?: unknown }> = [];
  let calls = 0;
  const submission = createStopRegisterSubmission({
    mutate: async (request) => { sent.push(request); if (calls++ === 0) throw { status: 503 }; return { stopIds: [], count: 0, planId: "p1" }; },
    hydrate: () => {},
    newKey: () => crypto.randomUUID(),
  });
  await submission.submit(plan, ["s1"], false);
  await submission.submit(plan, ["s1"], false);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(sent[1].routes, [{ routeId: "r1", planRevision: 3 }]);
});

test("committed success with failed hydration never mutates again", async () => {
  let mutations = 0;
  let hydrations = 0;
  const submission = createStopRegisterSubmission({
    mutate: async () => { mutations++; return { stopIds: ["n1"], count: 1, draftId: "d1" }; },
    hydrate: async (result) => { hydrations++; if (hydrations === 1) throw new Error("read failed"); assert.deepEqual(result.stopIds, ["n1"]); },
    prepare: async () => ({ draftRevision: 1 }),
    newKey: () => "k",
  });
  const first = await submission.submit(draft, ["s1"], false);
  assert.equal(first.kind, "hydration_failed");
  assert.equal((await submission.retryHydration())?.kind, "success");
  assert.equal((await submission.submit(draft, ["s1"], false)).kind, "success");
  assert.equal(mutations, 1);
});

test("stale and duplicate drop the attempt; consent creates a new request", async () => {
  const keys: string[] = [];
  let n = 0;
  const responses: unknown[] = [
    { status: 409, data: { code: "DUPLICATE_CUSTOMER_VISITS", details: { siteIds: ["s1"] } } },
  ];
  const submission = createStopRegisterSubmission({
    mutate: async (request) => { keys.push(request.idempotencyKey); const r = responses.shift(); if (r) throw r; return { stopIds: [], count: 1, draftId: "d1" }; },
    hydrate: () => {},
    prepare: async () => ({ draftRevision: 2 }),
    newKey: () => `k${n++}`,
  });
  assert.equal((await submission.submit(draft, ["s1"], false)).kind, "duplicate");
  assert.equal((await submission.submit(draft, ["s1"], true)).kind, "success");
  assert.notEqual(keys[0], keys[1]);
  assert.notEqual(stopRegisterTargetIdentity(plan), stopRegisterTargetIdentity({ ...plan, routes: [{ routeId: "r1", planRevision: 4 }] }));
});

test("after ambiguous failure, polled revision bump still replays the original request", async () => {
  const sent: unknown[] = [];
  let calls = 0;
  const submission = createStopRegisterSubmission({
    mutate: async (request) => {
      sent.push(JSON.parse(JSON.stringify(request)));
      if (calls++ === 0) throw new TypeError("Failed to fetch"); // server actually committed
      return { stopIds: ["n1"], count: 1, planId: "p1" }; // idempotent replay returns stored result
    },
    hydrate: () => {},
    newKey: (() => { let i = 0; return () => `k${i++}`; })(),
  });
  assert.equal((await submission.submit(plan, ["s1"], false)).kind, "retryable");
  assert.equal(submission.unresolved, true);
  const polled: StopRegisterTarget = { ...plan, routes: [{ routeId: "r1", planRevision: 4 }] };
  // Selection/consent changes are ignored while unresolved: same exact request.
  assert.equal((await submission.submit(polled, ["s1", "s9"], true)).kind, "success");
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual((sent[1] as { routes: unknown }).routes, [{ routeId: "r1", planRevision: 3 }]);
  assert.equal(submission.unresolved, false);
});

test("unresolved attempt refuses a different target or day", async () => {
  const submission = createStopRegisterSubmission({
    mutate: async () => { throw { status: 503 }; },
    hydrate: () => {},
    newKey: () => "k",
  });
  await submission.submit(plan, ["s1"], false);
  assert.equal((await submission.submit({ ...plan, date: "2026-05-05" }, ["s1"], false)).kind, "scope_mismatch");
  assert.equal((await submission.submit({ ...plan, planId: "p2" }, ["s1"], false)).kind, "scope_mismatch");
});
