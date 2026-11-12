import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db, organizationsTable, vehiclesTable, driversTable, routesTable, stopsTable,
  planningRuntimeStateTable, planningDraftsTable,
} from "@workspace/db";
import { PreviewRouteAppendImportBody, ApplyRouteAppendImportBody } from "@workspace/api-zod";
import {
  appendImportDuplicates, assertAppendRouteEligible, previewRouteAppendImport, applyRouteAppendImport,
  setAppendImportGeocodeForTest, setRouteScopedReoptimizationAfterLockHookForTest,
  DEFAULT_PLANNING_INPUTS,
  setAppendImportBeforeCommitForTest,
  previewWholePlanReoptimization, applyWholePlanReoptimization,
} from "./import-route-workflow";
import { clearOsrmCache } from "./osrm";
import { getPlanningDraft, updatePlanningDraft } from "./planning-draft-service";
import { loadRuntimeState } from "./planning-runtime-store";

test("append contract conserves row metadata and requires reviewed proposal plus duplicate decision", () => {
  const parsed = PreviewRouteAppendImportBody.parse({
    planRevision: 2, expectedRowCount: 1, stops: [{ address: "Synthetic", sourceRowNumber: 17, customFields: { original: "kept" }, jobType: "pickup_delivery", pickupAddress: "Pickup" }],
  });
  assert.equal(parsed.stops[0].sourceRowNumber, 17);
  assert.equal(parsed.stops[0].customFields?.original, "kept");
  assert.equal(ApplyRouteAppendImportBody.safeParse({ planRevision: 2, proposalId: randomUUID(), digest: "a".repeat(64) }).success, false);
});

test("duplicate review identifies both old stops and source rows without filtering", () => {
  const rows = [{ address: "  Same STREET ", sourceRowNumber: 9 }, { address: "same street", sourceRowNumber: 12 }, { address: "other", externalRef: "REF", sourceRowNumber: 20 }];
  assert.deepEqual(appendImportDuplicates(rows, [{ id: "old", address: "distinct", externalRef: "ref" }]), [
    { sourceRowNumber: 9, matchingStopIds: [], matchingSourceRowNumbers: [12] },
    { sourceRowNumber: 12, matchingStopIds: [], matchingSourceRowNumbers: [9] },
    { sourceRowNumber: 20, matchingStopIds: ["old"], matchingSourceRowNumbers: [] },
  ]);
  assert.equal(rows.length, 3);
});

test("append rejects live, terminal, dispatched, accepted and frozen routes", () => {
  const base = { status: "optimized", handoffStatus: "pending", optimizationFrozen: false, sentAt: null, acceptedAt: null } as typeof routesTable.$inferSelect;
  assert.doesNotThrow(() => assertAppendRouteEligible(base, []));
  for (const patch of [{ status: "in_progress" }, { status: "completed" }, { status: "cancelled" }, { handoffStatus: "accepted" }, { handoffStatus: "sent" }, { optimizationFrozen: true }, { acceptedAt: new Date() }]) {
    assert.throws(() => assertAppendRouteEligible({ ...base, ...patch } as typeof base, []));
  }
  assert.throws(() => assertAppendRouteEligible(base, [{ status: "in_progress" } as typeof stopsTable.$inferSelect]));
});

test("synthetic append preview/apply is atomic, tenant bound, exact, and preserves existing rows and import history", async () => {
  const organizationId = randomUUID(), vehicleId = randomUUID(), driverId = randomUUID();
  const routeId = randomUUID(), planId = randomUUID(), draftId = randomUUID(), oldId = randomUUID();
  const fetchBefore = globalThis.fetch;
  let geocodeCalls = 0;
  // All fixture points are identical. No external road/geocode service is
  // needed; any accidental network request makes this test fail.
  globalThis.fetch = async () => { throw new Error("Network forbidden in append-import test"); };
  setAppendImportGeocodeForTest(async address => {
    geocodeCalls++;
    return address === "invalid" ? null : { latitude: 59.3, longitude: 18, displayName: address, source: "nominatim", provider: "nominatim" };
  });
  clearOsrmCache();
  const depot = { start: { address: "Synthetic depot", latitude: 59.3, longitude: 18, verifiedAt: new Date().toISOString(), verification: { provider: "test" } }, end: { address: "Synthetic depot", latitude: 59.3, longitude: 18, verifiedAt: new Date().toISOString(), verification: { provider: "test" } } };
  const history = { receivedRowCount: 1, savedRowCount: 1, imported: 1, stopIds: [oldId], rowResults: [{ sourceRowNumber: 3, status: "saved" as const, stopId: oldId }] };
  const initialState = { planningInputs: { ...DEFAULT_PLANNING_INPUTS, travelReservePercent: 0, stopReserveMin: 0 } };
  try {
    await db.insert(organizationsTable).values({ id: organizationId, name: "Synthetic append test", email: `${organizationId}@example.test` });
    await db.insert(vehiclesTable).values({ id: vehicleId, organizationId, name: "Synthetic", licensePlate: organizationId.slice(0, 8), capacityKg: 100, capacityVolume: 10, vehicleType: "fossil" });
    await db.insert(driversTable).values({ id: driverId, organizationId, vehicleId, name: "Synthetic", workStartTime: "07:00:00", workEndTime: "18:00:00", startLatitude: 59.3, startLongitude: 18, endLatitude: 59.3, endLongitude: 18 });
    await db.insert(planningDraftsTable).values({ id: draftId, organizationId, name: "Synthetic", startAt: new Date("2026-08-26T05:00:00Z"), planId, importedResult: history, state: initialState });
    await db.insert(routesTable).values({ id: routeId, organizationId, planId, draftId, vehicleId, name: "Synthetic", date: new Date("2026-08-26T05:00:00Z"), status: "optimized", planRevision: 2, totalStops: 1, depotSnapshot: depot, lockedFirstStopId: oldId,
      optimizationResourceSnapshot: { driver: { id: driverId } },
      optimizationPlanningSnapshot: { ...DEFAULT_PLANNING_INPUTS, travelReservePercent: 0, stopReserveMin: 0 },
    });
    await db.insert(stopsTable).values({ id: oldId, organizationId, routeId, planningPlanId: planId, address: "Synthetic old", latitude: 59.3, longitude: 18, serviceDurationMin: 11, sequenceOrder: 1, notes: "preserve", customFields: { source: "original" }, sourceRowNumber: 3 });
    const [original] = await db.select().from(stopsTable).where(eq(stopsTable.id, oldId));
    const input = { planRevision: 2, expectedRowCount: 1, stops: [{ address: "Synthetic old", latitude: 0, longitude: 0, serviceDurationMin: 7, sourceRowNumber: 8, customFields: { extra: "retained" }, jobType: "pickup_delivery", pickupAddress: "Synthetic pickup" }] };
    await assert.rejects(previewRouteAppendImport(organizationId, routeId, { ...input, expectedRowCount: 2 }));
    assert.equal(geocodeCalls, 0);
    await assert.rejects(previewRouteAppendImport(organizationId, routeId, { ...input, stops: [{ address: "invalid" }] }));
    await assert.rejects(previewRouteAppendImport(organizationId, routeId, { ...input, stops: [{ address: "Synthetic heavy", weightKg: 101 }] }));
    await assert.rejects(previewRouteAppendImport(organizationId, routeId, { ...input, stops: [{ address: "Synthetic overtime", serviceDurationMin: 10000 }] }));
    const preview = await previewRouteAppendImport(organizationId, routeId, input);
    const durable = await loadRuntimeState<{ preview: { route: { date: Date }; stops: Array<{ createdAt: Date }> } }>(
      organizationId, "route-append-import", preview.proposalId,
    );
    assert.ok(durable?.value.preview.route.date instanceof Date);
    assert.ok(durable.value.preview.stops.every(stop => stop.createdAt instanceof Date));
    assert.equal(preview.consequences.optimizedStopIds[0], oldId);
    assert.equal(preview.counts.total, 2);
    assert.equal(preview.duplicates.length, 1);
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId))).length, 1);
    const apply = { planRevision: 2, proposalId: preview.proposalId, digest: preview.digest, acknowledgeDuplicates: true };
    await assert.rejects(applyRouteAppendImport(randomUUID(), routeId, apply));
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, { ...apply, acknowledgeDuplicates: false }));
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, { ...apply, digest: "0".repeat(64) }));
    setRouteScopedReoptimizationAfterLockHookForTest(async () => { throw new Error("Injected failure before writes"); });
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, apply), /Injected/);
    setRouteScopedReoptimizationAfterLockHookForTest(undefined);
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId))).length, 1);
    setAppendImportBeforeCommitForTest(async () => { throw new Error("Injected failure after all writes"); });
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, apply), /after all writes/);
    setAppendImportBeforeCommitForTest(undefined);
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId))).length, 1);
    assert.equal((await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0].planRevision, 2);
    assert.deepEqual((await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId)))[0].state, initialState);
    const result = await applyRouteAppendImport(organizationId, routeId, apply);
    assert.deepEqual(result.optimizedStopIds, preview.consequences.optimizedStopIds);
    assert.equal(result.planRevision, 3);
    assert.deepEqual(result.counts, { expected: 1, received: 1, saved: 1 });
    const saved = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    const old = saved.find(stop => stop.id === oldId)!;
    assert.deepEqual({ ...old, sequenceOrder: original.sequenceOrder }, original);
    const added = saved.find(stop => stop.id !== oldId)!;
    assert.equal(added.routeId, routeId);
    assert.equal(added.planningPlanId, planId);
    assert.ok(Math.abs(added.latitude - 59.3) < 0.00001);
    assert.equal(added.serviceDurationMin, 7);
    assert.equal(added.pickupAddress, "Synthetic pickup");
    assert.equal(added.customFields?.extra, "retained");
    const [draft] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId));
    assert.deepEqual(draft.importedResult, history);
    assert.deepEqual(draft.state.appendedStopIds, result.importedStopIds);
    const resumed = await getPlanningDraft(organizationId, draftId);
    assert.deepEqual(resumed?.state.appendedStopIds, result.importedStopIds);
    assert.deepEqual(resumed?.importedResult, history);
    const refreshed = await updatePlanningDraft({
      organizationId, id: draftId, revision: resumed!.revision,
      state: { ...resumed!.state, appendedStopIds: ["forged-id"] },
    });
    assert.deepEqual(refreshed.state.appendedStopIds, result.importedStopIds);
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, apply));
    // Resource-only changes do not increment route revisions, but must still
    // reject the reviewed proposal without inserting any new rows.
    const next = await previewRouteAppendImport(organizationId, routeId, { ...input, planRevision: 3 });
    await db.update(vehiclesTable).set({ capacityKg: 99 }).where(eq(vehiclesTable.id, vehicleId));
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, { planRevision: 3, proposalId: next.proposalId, digest: next.digest, acknowledgeDuplicates: true }));
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId))).length, 2);
    await db.update(planningRuntimeStateTable).set({ expiresAt: new Date(0) }).where(eq(planningRuntimeStateTable.organizationId, organizationId));
    await assert.rejects(applyRouteAppendImport(organizationId, routeId, { planRevision: 3, proposalId: next.proposalId, digest: next.digest, acknowledgeDuplicates: true }), /saknas/);
    // Subsequent whole-plan planning loads authoritative planningPlanId
    // membership, not the immutable original importedResult.stopIds.
    await db.update(vehiclesTable).set({ capacityKg: 100 }).where(eq(vehiclesTable.id, vehicleId));
    await db.update(routesTable).set({ lockedFirstStopId: null }).where(eq(routesTable.id, routeId));
    const wholeInput = {
      draftId, draftRevision: refreshed.revision,
      routes: [{ routeId, driverId, planRevision: 3 }],
      pairs: [{ vehicleId, driverId }], depotLatitude: 59.3, depotLongitude: 18,
    };
    const wholePreview = await previewWholePlanReoptimization(organizationId, planId, wholeInput);
    assert.deepEqual(new Set(wholePreview.routes.flatMap(route => route.optimizedStopIds)), new Set([oldId, ...result.importedStopIds]));
    await applyWholePlanReoptimization(organizationId, planId, { ...wholeInput, proposalHash: wholePreview.proposalHash });
    const replannedStops = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    assert.deepEqual(new Set(replannedStops.map(stop => stop.id)), new Set([oldId, ...result.importedStopIds]));
    assert.ok(replannedStops.every(stop => stop.planningPlanId === planId && stop.routeId === routeId));
    assert.equal(replannedStops.find(stop => stop.id === oldId)?.serviceDurationMin, 11);
    assert.equal(replannedStops.find(stop => stop.id === added.id)?.serviceDurationMin, 7);
    const finalDraft = await getPlanningDraft(organizationId, draftId);
    assert.deepEqual(finalDraft?.importedResult, history);
    assert.deepEqual(finalDraft?.state.appendedStopIds, result.importedStopIds);
  } finally {
    setAppendImportBeforeCommitForTest(undefined);
    setRouteScopedReoptimizationAfterLockHookForTest(undefined);
    setAppendImportGeocodeForTest(undefined);
    globalThis.fetch = fetchBefore;
    clearOsrmCache();
    await db.delete(planningRuntimeStateTable).where(eq(planningRuntimeStateTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
