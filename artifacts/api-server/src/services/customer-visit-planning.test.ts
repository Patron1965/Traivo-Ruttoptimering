import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db, organizationsTable, customersTable, customerSitesTable, stopsTable,
  routesTable, planningDraftsTable, customerVisitIdempotencyTable,
  vehiclesTable, driversTable, routeDispatchSnapshotsTable,
  planningRuntimeStateTable,
} from "@workspace/db";
import { CreateCustomerSiteBody, UpdateCustomerSiteBody, ListCustomersResponse, PlanCustomerVisitsResponse } from "@workspace/api-zod";
import {
  CustomerRegisterError, listCustomers, updateSite, planCustomerVisitsWithMeta,
  type CustomerVisitPlanRequest,
} from "./customer-register-service";
import { decodeRuntimeState } from "./planning-runtime-store";

const date = "2026-04-06";
const anchor = new Date(`${date}T00:00:00.000Z`);
async function fixture() {
  const organizationId = randomUUID();
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Synthetic visit tests", email: `${organizationId}@example.test`,
  });
  const [customer] = await db.insert(customersTable).values({
    organizationId, name: "Synthetic customer",
    unavailablePeriods: [{ weekday: 1, start: "12:00", end: "13:00" }],
  }).returning();
  const baseSite = {
    organizationId, customerId: customer.id, name: "Synthetic site",
    addressInput: "Synthetic address", address: "Verified synthetic address",
    latitude: 59.3, longitude: 18.0, verificationStatus: "exact" as const,
    verificationMetadata: {
      provider: "nominatim" as const, source: "cache" as const,
      displayName: "Verified synthetic address", query: "Synthetic address",
    },
    contactName: "Synthetic contact", contactEmail: "contact@example.test",
    contactPhone: "000", windowStart: "09:00", windowEnd: "11:00",
    serviceDurationMin: 17, instructions: "Synthetic instructions",
  };
  const [normal, high] = await db.insert(customerSitesTable).values([
    baseSite, { ...baseSite, name: "High priority", isPrioritized: true },
  ]).returning();
  const request = (extra: Partial<CustomerVisitPlanRequest> = {}): CustomerVisitPlanRequest => ({
    organizationId, siteIds: [high.id], date, idempotencyKey: randomUUID(), ...extra,
  });
  return {
    organizationId, customer, normal, high, request,
    async cleanup() {
      await db.delete(customerVisitIdempotencyTable).where(eq(customerVisitIdempotencyTable.organizationId, organizationId));
      await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
      await db.update(routesTable).set({ optimizationFrozen: false }).where(eq(routesTable.organizationId, organizationId));
      await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
      await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
      await db.delete(customerSitesTable).where(eq(customerSitesTable.organizationId, organizationId));
      await db.delete(customersTable).where(eq(customersTable.organizationId, organizationId));
      await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
      await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    },
  };
}
const errorCode = (code: string) => (error: unknown) =>
  error instanceof CustomerRegisterError && error.code === code;

test("site priority roundtrip preserves omitted edits and visits snapshot all reusable facts", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Provider calls forbidden"); });
  const f = await fixture();
  try {
    assert.equal(f.normal.isPrioritized, false);
    assert.equal(CreateCustomerSiteBody.parse({ name: "Site", address: "Address" }).isPrioritized, undefined);
    const edit = {
      name: f.high.name, address: f.high.addressInput, expectedRevision: 0,
      contactName: f.high.contactName, contactEmail: f.high.contactEmail, contactPhone: f.high.contactPhone,
      serviceDurationMin: 17, instructions: f.high.instructions,
      windowStart: f.high.windowStart, windowEnd: f.high.windowEnd,
    };
    const updated = await updateSite(f.organizationId, f.customer.id, f.high.id, UpdateCustomerSiteBody.parse(edit));
    assert.equal(updated!.sites.find((site) => site.id === f.high.id)!.isPrioritized, true);
    const listed = ListCustomersResponse.parse(await listCustomers(f.organizationId));
    assert.equal(listed[0].sites.find((site) => site.id === f.high.id)!.isPrioritized, true);
    const first = await planCustomerVisitsWithMeta(f.request({ siteIds: [f.normal.id, f.high.id] }));
    assert.ok(first.result.draftId);
    PlanCustomerVisitsResponse.parse(first.result);
    const stops = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, f.organizationId));
    for (const stop of stops) {
      assert.equal(stop.priority, stop.customerSiteId === f.high.id ? 1 : 0);
      assert.equal(stop.routeId, null);
      assert.equal(stop.sequenceOrder, null);
      assert.equal(stop.planningDate!.toISOString(), anchor.toISOString());
      assert.equal(stop.customerName, f.customer.name);
      assert.equal(stop.address, f.high.address);
      assert.equal(stop.latitude, f.high.latitude);
      assert.equal(stop.serviceDurationMin, 17);
      assert.equal(stop.notes, f.high.instructions);
      assert.equal(stop.contactName, f.high.contactName);
      assert.equal(stop.contactEmail, f.high.contactEmail);
      assert.equal(stop.contactPhone, f.high.contactPhone);
      assert.equal(stop.timeWindowStart!.toISOString(), "2026-04-06T07:00:00.000Z");
      assert.equal(stop.timeWindowEnd!.toISOString(), "2026-04-06T09:00:00.000Z");
      assert.equal(stop.unavailablePeriods!.length, 1);
      assert.deepEqual(stop.unavailablePeriods, [{
        start: "2026-04-06T10:00:00.000Z", end: "2026-04-06T11:00:00.000Z",
      }]);
    }
    await updateSite(f.organizationId, f.customer.id, f.high.id, {
      ...edit, expectedRevision: 1, isPrioritized: false,
    });
    const [snapshot] = await db.select().from(stopsTable).where(and(
      eq(stopsTable.organizationId, f.organizationId), eq(stopsTable.customerSiteId, f.high.id),
    ));
    assert.equal(snapshot.priority, 1);
    const current = await listCustomers(f.organizationId);
    assert.equal(current[0].sites.find((site) => site.id === f.high.id)!.isPrioritized, false);
  } finally { await f.cleanup(); }
});

test("import draft preserves imported membership, duplicate opt-in and exact response-loss replay", async () => {
  const f = await fixture();
  try {
    const [imported] = await db.insert(stopsTable).values({
      organizationId: f.organizationId, address: "Synthetic imported stop", latitude: 59, longitude: 18,
      planningDate: anchor,
    }).returning();
    const [draft] = await db.insert(planningDraftsTable).values({
      organizationId: f.organizationId, name: "Synthetic imported draft", startAt: anchor,
      state: { source: "csv", importedStopIds: [imported.id] },
      importedResult: { receivedRowCount: 1, savedRowCount: 1, imported: 1,
        stopIds: [imported.id], rowResults: [{ sourceRowNumber: 1, status: "saved", stopId: imported.id }] },
    }).returning();
    const request = f.request({ draftId: draft.id, draftRevision: 0 });
    const first = await planCustomerVisitsWithMeta(request);
    const retry = await planCustomerVisitsWithMeta(request);
    assert.deepEqual(retry, { result: first.result, replayed: true });
    await assert.rejects(planCustomerVisitsWithMeta({ ...request, allowDuplicateVisits: true }), errorCode("IDEMPOTENCY_KEY_REUSED"));
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ draftId: draft.id, draftRevision: 0 })), errorCode("DRAFT_REVISION_CONFLICT"));
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ draftId: draft.id, draftRevision: 1 })), (error: unknown) => {
      assert.ok(errorCode("DUPLICATE_CUSTOMER_VISITS")(error));
      assert.deepEqual((error as CustomerRegisterError).details!.siteIds, [f.high.id]);
      return true;
    });
    await planCustomerVisitsWithMeta(f.request({ draftId: draft.id, draftRevision: 1, allowDuplicateVisits: true }));
    const [saved] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draft.id));
    assert.equal(saved.state.source, "csv");
    assert.deepEqual(saved.importedResult, draft.importedResult);
    assert.ok((saved.state.selectedStopIds as string[]).includes(imported.id));
    assert.equal(saved.revision, 2);
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ draftId: draft.id, draftRevision: 2, date: "2026-04-07" })), errorCode("DRAFT_DATE_CONFLICT"));
  } finally { await f.cleanup(); }
});

test("operational membership shares guarded revisions, leaves frozen/outgoing routes intact and scopes duplicates", async () => {
  const f = await fixture();
  const foreign = await fixture();
  try {
    const planId = randomUUID();
    const [vehicle] = await db.insert(vehiclesTable).values({
      organizationId: f.organizationId, name: "Synthetic vehicle", licensePlate: "SYNTHETIC",
    }).returning();
    const [driver] = await db.insert(driversTable).values({
      organizationId: f.organizationId, name: "Synthetic driver", vehicleId: vehicle.id,
    }).returning();
    const summary = {
      complete: true, objective: "balanced" as const, travelReservePercent: 0, stopReserveMin: 0,
      mandatoryUnplannedStopIds: [], selectedPairValues: [], usedPairValues: [],
      unusedPairValues: [], unplanned: [],
    };
    const [working, frozen, completed] = await db.insert(routesTable).values([
      { organizationId: f.organizationId, planId, date: anchor, name: "Working", status: "optimized" as const, planningSummary: summary },
      { organizationId: f.organizationId, planId, date: anchor, name: "Frozen", status: "in_progress" as const,
        vehicleId: vehicle.id, frozenDriverId: driver.id,
        optimizationFrozen: true, handoffStatus: "sent" as const, handoffVersion: 7 },
      { organizationId: f.organizationId, planId, date: anchor, name: "Done", status: "completed" as const },
    ]).returning();
    const [outgoing] = await db.insert(routeDispatchSnapshotsTable).values({
      routeId: frozen.id, organizationId: f.organizationId, planRevision: 7,
      driverId: driver.id, capturedAt: anchor, route: { id: frozen.id }, stops: [],
    }).returning();
    // Neither a visit in another same-day plan nor a same-plan visit on a
    // different date may be mistaken for membership in this target day.
    await db.insert(stopsTable).values([
      { organizationId: f.organizationId, customerId: f.customer.id, customerSiteId: f.high.id,
        address: "Synthetic other plan", latitude: 59.3, longitude: 18,
        planningPlanId: randomUUID(), planningDate: anchor },
      { organizationId: f.organizationId, customerId: f.customer.id, customerSiteId: f.high.id,
        address: "Synthetic other date", latitude: 59.3, longitude: 18,
        planningPlanId: planId, planningDate: new Date("2026-04-07T00:00:00.000Z") },
    ]);
    const revisions = [working, frozen, completed].map((route) => ({ routeId: route.id, planRevision: route.planRevision }));
    const request = f.request({ planId, routes: revisions });
    const first = await planCustomerVisitsWithMeta(request);
    assert.equal(first.result.planId, planId);
    assert.equal(first.result.draftId, undefined);
    assert.deepEqual(await planCustomerVisitsWithMeta(request), { result: first.result, replayed: true });
    let events: Array<typeof planningRuntimeStateTable.$inferSelect> = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      events = await db.select().from(planningRuntimeStateTable).where(and(
        eq(planningRuntimeStateTable.organizationId, f.organizationId),
        eq(planningRuntimeStateTable.kind, "realtime-event"),
      ));
      if (events.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const relayed = events.map((event) => decodeRuntimeState<{
      organizationId: string; type: string; payload: Record<string, unknown>;
    }>(event.payload));
    assert.equal(relayed.length, 2, "new visits broadcast once; replay does not broadcast");
    assert.deepEqual(relayed.map((event) => event.type).sort(), ["data:route:updated", "data:stop:created"]);
    assert.ok(relayed.every((event) => event.organizationId === f.organizationId));
    assert.equal(relayed.find((event) => event.type === "data:route:updated")!.payload.id, working.id);
    const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, first.result.stopIds[0]));
    assert.equal(stop.planningPlanId, planId);
    assert.equal(stop.planningDate!.toISOString(), anchor.toISOString());
    assert.equal(stop.routeId, null);
    const after = await db.select().from(routesTable).where(eq(routesTable.planId, planId));
    assert.deepEqual(after.find((route) => route.id === frozen.id), frozen);
    assert.deepEqual(after.find((route) => route.id === completed.id), completed);
    const changed = after.find((route) => route.id === working.id)!;
    assert.equal(changed.planRevision, 1);
    assert.equal(changed.planningSummary!.complete, false);
    assert.deepEqual(changed.planningSummary!.mandatoryUnplannedStopIds, first.result.stopIds);
    assert.deepEqual(changed.plannerItinerary, working.plannerItinerary);
    assert.equal(changed.handoffVersion, working.handoffVersion);
    const [outgoingAfter] = await db.select().from(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.routeId, frozen.id));
    assert.deepEqual(outgoingAfter, outgoing);
    const current = after.map((route) => ({ routeId: route.id, planRevision: route.planRevision }));
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ planId, routes: revisions })), errorCode("PLAN_REVISION_CONFLICT"));
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ planId, routes: current, date: "2026-04-07" })), errorCode("PLAN_DATE_CONFLICT"));
    await assert.rejects(planCustomerVisitsWithMeta(foreign.request({ planId, routes: current })), errorCode("PLAN_REVISION_CONFLICT"));
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ planId, routes: current, siteIds: [foreign.high.id] })), errorCode("INVALID_SITE_SELECTION"));
    await assert.rejects(planCustomerVisitsWithMeta(f.request({ planId, routes: current })), errorCode("DUPLICATE_CUSTOMER_VISITS"));
    assert.equal((await db.select().from(planningRuntimeStateTable).where(and(
      eq(planningRuntimeStateTable.organizationId, f.organizationId),
      eq(planningRuntimeStateTable.kind, "realtime-event"),
    ))).length, 2, "rolled back additions never broadcast");
    await planCustomerVisitsWithMeta(f.request({ planId, routes: current, allowDuplicateVisits: true }));
    // A separate draft/date is not a duplicate merely because the site has an operational visit.
    await planCustomerVisitsWithMeta(f.request({ date: "2026-04-07" }));
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, f.organizationId))).length, 5);
  } finally { await f.cleanup(); await foreign.cleanup(); }
});

test("different concurrent idempotency keys cannot bypass target duplicate guards", async () => {
  const f = await fixture();
  try {
    const [draft] = await db.insert(planningDraftsTable).values({
      organizationId: f.organizationId, name: "Concurrent synthetic draft", startAt: anchor,
    }).returning();
    const outcomes = await Promise.allSettled([
      planCustomerVisitsWithMeta(f.request({ draftId: draft.id, draftRevision: 0 })),
      planCustomerVisitsWithMeta(f.request({ draftId: draft.id, draftRevision: 0 })),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    assert.ok(errorCode("DRAFT_REVISION_CONFLICT")(rejected.reason));
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, f.organizationId))).length, 1);
  } finally { await f.cleanup(); }
});

test("same-key concurrent new-draft requests create exactly one snapshot and preserve resource-selection state", async () => {
  const f = await fixture();
  try {
    const request = f.request({ planName: "Synthetic named draft" });
    const outcomes = await Promise.all([
      planCustomerVisitsWithMeta(request), planCustomerVisitsWithMeta(request),
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.replayed).sort(), [false, true]);
    assert.deepEqual(outcomes[0].result, outcomes[1].result);
    const drafts = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.organizationId, f.organizationId));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].name, "Synthetic named draft");
    assert.equal(drafts[0].state.step, 5);
    assert.equal(drafts[0].state.source, "manual");
    assert.deepEqual(drafts[0].state.selectedStopIds, outcomes[0].result.stopIds);
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, f.organizationId))).length, 1);
  } finally { await f.cleanup(); }
});
