import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test, before, after } from "node:test";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, organizationsTable, vehiclesTable, driversTable, stopsTable, routesTable,
  auditLogTable, usersTable, routeExecutionsTable, routeDispatchSnapshotsTable,
} from "@workspace/db";
import router from "./planner-corrections";
import importRouter from "./import-route-workflow";
import stopsRouter from "./stops";
import { updateStop, moveStopsForDispatch, persistDispatchRouteWorkday, setDispatchMutationBeforeLockHookForTest } from "../services/stop-service";
import { setRoutePlanningLocks } from "../services/planning-lock-service";
import { captureRouteDispatchSnapshot } from "../services/route-dispatch-snapshot-service";
import { plannerFactsDigest } from "../services/planner-stop-facts";
import { loadRuntimeState } from "../services/planning-runtime-store";
import { dispatchTargetOptimizationSettings } from "../services/dispatch-target-optimizer";
import { planningWeights } from "../services/import-route-workflow";
import { prohibitExternalTestConnections } from "../lib/tenant-test-network";
import { materialResourceSnapshotHash } from "../services/route-plan-approval-service";

const organizationId = randomUUID(), foreignOrg = randomUUID(), actor = randomUUID(), planId = randomUUID();
const vehicleId = randomUUID(), driverId = randomUUID(), sourceId = randomUUID(), targetId = randomUUID();
const stopId = randomUUID(), addressStopId = randomUUID();
let base = "";
let server: ReturnType<ReturnType<typeof express>["listen"]>;
let role: "dispatcher" | "viewer" = "dispatcher";
let org = organizationId;
const originalFetch = globalThis.fetch;
let externalFetchAttempts = 0;
let restoreNetwork: (() => void) | undefined;
async function post(path: string, body: unknown) {
  const response = await fetch(`${base}/planner-corrections/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}
async function stop(id = stopId) {
  return (await db.select().from(stopsTable).where(eq(stopsTable.id, id)))[0]!;
}

before(async () => {
  restoreNetwork = prohibitExternalTestConnections();
  globalThis.fetch = (...args: Parameters<typeof fetch>) => {
    const request = args[0];
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    if (url.hostname !== "127.0.0.1") {
      externalFetchAttempts++;
      throw new Error("External network forbidden in planner correction tests");
    }
    return originalFetch(...args);
  };
  await db.insert(organizationsTable).values([
    { id: organizationId, name: "Synthetic planner corrections", email: `${organizationId}@example.test`,
      depotStartLatitude: 59.3, depotStartLongitude: 18.1, depotEndLatitude: 59.3, depotEndLongitude: 18.1 },
    { id: foreignOrg, name: "Foreign synthetic planner", email: `${foreignOrg}@example.test` },
  ]);
  await db.insert(vehiclesTable).values({ id: vehicleId, organizationId, name: "Existing pair vehicle",
    licensePlate: `P-${vehicleId.slice(0, 8)}`, capacityKg: 1000, capacityVolume: 10 });
  await db.insert(driversTable).values({ id: driverId, organizationId, name: "Existing pair driver", vehicleId,
    workStartTime: "07:00", workEndTime: "18:00" });
  await db.insert(routesTable).values([sourceId, targetId].map((id) => ({
    id, organizationId, planId, vehicleId, name: id === sourceId ? "Source route" : "Target route",
    date: new Date("2026-08-26T00:00:00Z"), status: "optimized" as const,
  })));
  await db.insert(stopsTable).values([
    { id: stopId, organizationId, routeId: sourceId, planningPlanId: planId, sequenceOrder: 1,
      address: "Synthetic source 1", latitude: 59.3, longitude: 18.1, status: "pending" },
    { id: addressStopId, organizationId, address: "Original imported address", latitude: 59.3, longitude: 18.1,
      sourceRowNumber: 7, customFields: { reference: "Synthetic source evidence" }, status: "pending" },
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: actor, organizationId: org, role, name: "Synthetic dispatcher", email: "planner@example.test", driverProfileId: null };
    next();
  });
  app.use(router);
  app.use(importRouter);
  app.use(stopsRouter);
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.organizationId, organizationId));
  await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, organizationId));
  await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
  await db.update(routesTable).set({ optimizationFrozen: false, frozenDriverId: null })
    .where(eq(routesTable.organizationId, organizationId));
  await db.update(stopsTable).set({ lockedVehicleId: null, lockedDriverId: null, lockedServiceStartAt: null })
    .where(eq(stopsTable.organizationId, organizationId));
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [organizationId, foreignOrg]));
  assert.equal(externalFetchAttempts, 0, "Planner tests must never call an external provider");
  restoreNetwork?.();
});

test("real pair preview is non-mutating; resource-facts change invalidates confirm, fresh confirm moves", async () => {
  const before = await stop();
  const result = await post("recommendations", { stopId, routeIds: [sourceId, targetId] });
  assert.equal(result.status, 200);
  assert.equal(result.body.recommendations.length, 1);
  const proposal = result.body.recommendations[0];
  assert.equal(proposal.driverId, driverId);
  assert.equal(proposal.vehicleId, vehicleId);
  assert.equal(proposal.consequences.status, "unknown");
  assert.equal(proposal.consequences.routes[0].before.driveMin, null);
  assert.deepEqual(await stop(), before);
  await db.update(driversTable).set({ tempo: "slow" }).where(eq(driversTable.id, driverId));
  const stale = await post("confirm", { token: proposal.token, confirmed: true });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stop(), before);
  const fresh = await post("recommendations", { stopId, routeIds: [sourceId, targetId] });
  const confirmed = await post("confirm", { token: fresh.body.recommendations[0].token, confirmed: true });
  assert.equal(confirmed.status, 200);
  assert.equal((await stop()).routeId, targetId);
  assert.equal((await post("confirm", { token: fresh.body.recommendations[0].token, confirmed: true })).status, 409);
});

test("manual address preview needs explicit confirmation, rejects stale and preserves original audit", async () => {
  const input = { stopId: addressStopId, address: "Corrected synthetic address",
    position: { latitude: 59.31, longitude: 18.11, confirmed: true } };
  assert.equal((await post("address/preview", { ...input, position: { ...input.position, confirmed: false } })).status, 400);
  const before = await stop(addressStopId);
  const preview = await post("address/preview", input);
  assert.equal(preview.status, 200);
  assert.deepEqual(await stop(addressStopId), before);
  await db.update(stopsTable).set({ notes: "Concurrent edit" }).where(eq(stopsTable.id, addressStopId));
  assert.equal((await post("confirm", { token: preview.body.token, confirmed: true })).status, 409);
  assert.equal((await stop(addressStopId)).address, before.address);
  const fresh = await post("address/preview", input);
  assert.equal((await post("confirm", { token: fresh.body.token, confirmed: true })).status, 200);
  const saved = await stop(addressStopId);
  assert.equal(saved.address, input.address);
  assert.equal(saved.sourceRowNumber, 7);
  assert.equal(saved.customFields?._traivoNavigationVerified, undefined);
  const audit = await db.select().from(auditLogTable).where(and(
    eq(auditLogTable.organizationId, organizationId), eq(auditLogTable.resourceId, addressStopId),
    eq(auditLogTable.action, "stop.address_corrected"),
  ));
  assert.equal(audit.length, 1);
  assert.equal((audit[0]!.diff as any).original.address, before.address);
});

test("API rejects foreign organization, forged token, viewer writes and server-owned fields", async () => {
  org = foreignOrg;
  try { assert.equal((await post("recommendations", { stopId, routeIds: [targetId] })).status, 404); }
  finally { org = organizationId; }
  role = "viewer";
  try { assert.equal((await post("recommendations", { stopId, routeIds: [targetId] })).status, 403); }
  finally { role = "dispatcher"; }
  assert.equal((await post("confirm", { token: "forged", confirmed: true })).status, 409);
  assert.equal((await post("recommendations", { stopId, routeIds: [targetId], organizationId: foreignOrg })).status, 400);
});

test("raw driver status uses outgoing membership/version after working membership changed", async () => {
  const routeId = randomUUID(), runtimeStopId = randomUUID(), userId = randomUUID();
  await db.insert(usersTable).values({ id: userId, organizationId, name: "Synthetic driver",
    email: `${userId}@example.test`, role: "driver", driverProfileId: driverId });
  const [route] = await db.insert(routesTable).values({
    id: routeId, organizationId, vehicleId, name: "Outgoing route", date: new Date("2026-08-26T00:00:00Z"),
    status: "in_progress", planRevision: 1, handoffVersion: 1, dispatchSnapshotVersion: 1,
    handoffStatus: "accepted", handoffDriverId: driverId,
  }).returning();
  const [runtimeStop] = await db.insert(stopsTable).values({
    id: runtimeStopId, organizationId, routeId, address: "Outgoing stop", latitude: 59.3, longitude: 18.1,
    status: "pending", sequenceOrder: 1,
  }).returning();
  await db.transaction((tx) => captureRouteDispatchSnapshot(tx, route!, [runtimeStop!], driverId, new Date()));
  await db.insert(routeExecutionsTable).values({ organizationId, routeId, driverId, planVersion: 1,
    status: "active", startedAt: new Date(), startClientEventId: randomUUID(), startedByUserId: userId });
  await db.update(stopsTable).set({ routeId: null, sequenceOrder: null }).where(eq(stopsTable.id, runtimeStopId));
  await db.update(routesTable).set({ planRevision: 2 }).where(eq(routesTable.id, routeId));
  const updated = await updateStop(runtimeStopId, organizationId, { status: "in_progress" }, {}, driverId, null, { expectedOutgoingVersion: 1 });
  assert.equal(updated?.status, "in_progress");
  assert.equal(updated?.routeId, null);
  await assert.rejects(() => updateStop(runtimeStopId, organizationId, { executionComment: "Stale" }, {}, driverId, null,
    { expectedOutgoingVersion: 2 }));
  assert.equal((await stop(runtimeStopId)).executionComment, null);
  await db.update(routesTable).set({ status: "cancelled" }).where(eq(routesTable.id, routeId));
  await assert.rejects(() => updateStop(runtimeStopId, organizationId, { executionComment: "Cancelled" }, {}, driverId));
});

test("fact digest includes nested dates and is stable across key ordering", () => {
  assert.equal(plannerFactsDigest({ b: 2, a: new Date(1) }), plannerFactsDigest({ a: new Date(1), b: 2 }));
  assert.notEqual(plannerFactsDigest({ a: new Date(1) }), plannerFactsDigest({ a: new Date(2) }));
});

test("optimized bulk move requires review and atomically applies the shared exact recipient proposal", async () => {
  const source = randomUUID(), target = randomUUID(), moving = randomUUID(), remaining = randomUUID();
  const testPlan = randomUUID();
  const point = { address: "Synthetic colocated depot", latitude: 59.3, longitude: 18.1,
    verifiedAt: "2026-08-26T00:00:00Z", verification: { source: "synthetic-test" } };
  await db.insert(routesTable).values([source, target].map(id => ({
    id, organizationId, planId: testPlan, vehicleId, name: "Synthetic optimized move",
    date: new Date("2026-08-26T00:00:00Z"), status: "optimized" as const,
    depotSnapshot: { start: point, end: point },
    optimizationPlanningSnapshot: { version: 1 as const, objective: "geographic" as const,
      travelReservePercent: 0, stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [],
      depotOverride: null, vehicleSelectionMode: "use_all_selected_pairs" as const, maxDriverOvertimeMin: 0 },
  })));
  await db.insert(stopsTable).values([
    { id: moving, routeId: source, serviceDurationMin: 3 },
    { id: remaining, routeId: target, serviceDurationMin: 7 },
  ].map(item => ({ ...item, organizationId, planningPlanId: testPlan, sequenceOrder: 1,
    address: "Synthetic stop", latitude: point.latitude, longitude: point.longitude, status: "pending" as const })));
  const input = { stopIds: [moving], routeId: target, targetIndex: 1, optimizeTargetRoute: true,
    routeRevisions: [{ routeId: source, planRevision: 0 }, { routeId: target, planRevision: 0 }] };
  assert.equal((await moveStopsForDispatch(organizationId, input)).kind, "ineligible");
  assert.equal((await moveStopsForDispatch(organizationId, { ...input, routeId: null }, { previewOnly: true })).kind, "ineligible");
  // A generous organization must not relax this route's explicit zero.
  // Normal previews retain the strict shift; overtime needs explicit consent.
  await db.update(organizationsTable).set({ maxDriverOvertimeMin: 60, allowLateStopsMin: 45 })
    .where(eq(organizationsTable.id, organizationId));
  await db.update(driversTable).set({ workEndTime: "07:05" }).where(eq(driversTable.id, driverId));
  await assert.rejects(() => moveStopsForDispatch(organizationId, input, { previewOnly: true }));
  const infeasibleResponse = await fetch(`${base}/stops/dispatch-move/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(infeasibleResponse.status, 409);
  assert.equal((await infeasibleResponse.json() as { code: string }).code, "DISPATCH_TARGET_INFEASIBLE");
  assert.equal((await stop(moving)).routeId, source);
  const overtimePreview = await moveStopsForDispatch(organizationId, { ...input, force: true }, { previewOnly: true });
  assert.equal(overtimePreview.kind, "preview");
  if (overtimePreview.kind !== "preview") throw new Error("Expected overtime preview");
  assert.ok(overtimePreview.conflicts.length > 0, "actual shift overrun remains visible");
  assert.equal((await stop(moving)).routeId, source, "consent to preview never commits");
  await db.update(stopsTable).set({ weightKg: 2000 }).where(eq(stopsTable.id, moving));
  await assert.rejects(() => moveStopsForDispatch(organizationId, { ...input, force: true }, { previewOnly: true }),
    (error: any) => error.code === "DISPATCH_TARGET_INFEASIBLE");
  await db.update(stopsTable).set({ weightKg: 0 }).where(eq(stopsTable.id, moving));
  await db.update(driversTable).set({ workEndTime: "18:00" }).where(eq(driversTable.id, driverId));
  const [savedTarget] = await db.select().from(routesTable).where(eq(routesTable.id, target));
  await db.update(routesTable).set({ depotSnapshot: null }).where(eq(routesTable.id, target));
  for (const endpoint of ["/stops/dispatch-move/preview", "/stops/dispatch-move"]) {
    const unavailableResponse = await fetch(`${base}${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, expectedPreviewDigest: "0".repeat(64) }),
    });
    assert.equal(unavailableResponse.status, 503);
    assert.equal((await unavailableResponse.json() as { code: string }).code, "DISPATCH_TARGET_UNAVAILABLE");
  }
  await db.update(routesTable).set({ depotSnapshot: savedTarget!.depotSnapshot }).where(eq(routesTable.id, target));
  let lockPasses = 0;
  setDispatchMutationBeforeLockHookForTest(async () => {
    if (++lockPasses !== 2) return;
    // Search must have released the first transaction, including its route
    // advisory lock, before the validation pass starts.
    await db.transaction(async tx => {
      const released = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${"dispatch-route:" + target})) AS acquired`);
      assert.equal(released.rows[0]?.acquired, true);
      await tx.update(vehiclesTable).set({ capacityKg: 999 }).where(eq(vehiclesTable.id, vehicleId));
    });
  });
  try {
    await assert.rejects(() => moveStopsForDispatch(organizationId, input, { previewOnly: true }));
    assert.equal(lockPasses, 2);
    assert.equal((await stop(moving)).routeId, source);
  } finally {
    setDispatchMutationBeforeLockHookForTest(undefined);
    await db.update(vehiclesTable).set({ capacityKg: 1000 }).where(eq(vehiclesTable.id, vehicleId));
  }
  const preview = await moveStopsForDispatch(organizationId, input, { previewOnly: true });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw new Error("Expected optimized preview");
  assert.equal(preview.canMove, true);
  assert.equal((await stop(moving)).routeId, source);
  const proposal = await loadRuntimeState<{ stopIds: string[] }>(organizationId, "dispatch-target-optimization", preview.previewDigest);
  assert.ok(proposal);
  assert.equal(await loadRuntimeState(foreignOrg, "dispatch-target-optimization", preview.previewDigest), null);
  await db.update(vehiclesTable).set({ capacityKg: 999 }).where(eq(vehiclesTable.id, vehicleId));
  await assert.rejects(() => moveStopsForDispatch(organizationId, { ...input, expectedPreviewDigest: preview.previewDigest }));
  assert.equal((await stop(moving)).routeId, source);
  await db.update(vehiclesTable).set({ capacityKg: 1000 }).where(eq(vehiclesTable.id, vehicleId));
  await assert.rejects(() => moveStopsForDispatch(organizationId, { ...input,
    targetIndex: 0, expectedPreviewDigest: preview.previewDigest }));
  await assert.rejects(() => moveStopsForDispatch(organizationId, { ...input, expectedPreviewDigest: "0".repeat(64) }));
  assert.equal((await stop(moving)).routeId, source);
  const saved = await moveStopsForDispatch(organizationId, { ...input, expectedPreviewDigest: preview.previewDigest });
  assert.equal(saved.kind, "moved");
  const ordered = await db.select().from(stopsTable).where(eq(stopsTable.routeId, target)).orderBy(stopsTable.sequenceOrder);
  assert.deepEqual(ordered.map(item => item.id), proposal.value.stopIds);
  assert.deepEqual(ordered.map(item => item.serviceDurationMin).sort(), [3, 7]);
  const [recalculated] = await db.select().from(routesTable).where(eq(routesTable.id, target));
  const [currentVehicle] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
  const [currentDriver] = await db.select().from(driversTable).where(eq(driversTable.id, driverId));
  assert.equal(recalculated!.optimizationResourceSnapshotHash,
    materialResourceSnapshotHash(currentVehicle!, currentDriver!, ordered, []),
    "Manual moves must save approval evidence for the persisted stop order");
  await assert.rejects(() => moveStopsForDispatch(organizationId, { ...input, expectedPreviewDigest: preview.previewDigest }));
  await db.update(organizationsTable).set({ maxDriverOvertimeMin: 0, allowLateStopsMin: 0 })
    .where(eq(organizationsTable.id, organizationId));
});

test("optimized bulk settings preserve strict zero, objective, reserves and priorities", () => {
  const snapshot = { version: 1 as const, objective: "shortest" as const,
    travelReservePercent: 17, stopReserveMin: 4, stopPriorities: { selected: 2 as const },
    excludedPairValues: [], depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const, maxDriverOvertimeMin: 0, allowLateStopsMin: 0 };
  const settings = dispatchTargetOptimizationSettings(
    { maxDriverOvertimeMin: 60, allowLateStopsMin: 45 }, snapshot, 2,
  );
  assert.deepEqual(settings.policy, { maxDriverOvertimeMin: 0, allowLateStopsMin: 0 });
  assert.equal(settings.config.weights.distanceWeight, planningWeights(settings.planning).distanceWeight);
  assert.equal(settings.config.weights.distanceWeight, 0.8);
  assert.equal(settings.config.weights.geographicCohesionWeight, 0);
  assert.equal(settings.planning.travelReservePercent, 17);
  assert.equal(settings.planning.stopReserveMin, 4);
  assert.equal(settings.planning.stopPriorities.selected, 2);
  const geographic = dispatchTargetOptimizationSettings(
    { maxDriverOvertimeMin: 60, allowLateStopsMin: 45 }, { ...snapshot, objective: "geographic" }, 2,
  );
  assert.equal(geographic.config.weights.geographicCohesionWeight, 0.5);
});

test("canonical bound preview exposes verified zero-distance before/after clocks and exact-input CAS", async () => {
  const source = randomUUID(), target = randomUUID(), moving = randomUUID(), remaining = randomUUID();
  const testPlan = randomUUID();
  const point = { address: "Synthetic colocated depot", latitude: 59.3, longitude: 18.1,
    verifiedAt: "2026-08-26T00:00:00Z", verification: { source: "synthetic-test" } };
  await db.insert(routesTable).values([source, target].map((id) => ({
    id, organizationId, planId: testPlan, vehicleId, name: id === source ? "Clock source" : "Clock target",
    date: new Date("2026-08-26T00:00:00Z"), status: "optimized" as const,
    depotSnapshot: { start: point, end: point },
    optimizationPlanningSnapshot: { version: 1 as const, objective: "geographic" as const,
      travelReservePercent: 0, stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [],
      depotOverride: null, vehicleSelectionMode: "use_all_selected_pairs" as const, maxDriverOvertimeMin: 0 },
  })));
  await db.insert(stopsTable).values([
    { id: moving, routeId: source }, { id: remaining, routeId: target },
  ].map((item) => ({ ...item, organizationId, planningPlanId: testPlan, sequenceOrder: 1,
    address: "Synthetic colocated stop", latitude: point.latitude, longitude: point.longitude,
    serviceDurationMin: 5, status: "pending" as const })));
  const input = { stopIds: [moving], routeId: target, targetIndex: 1,
    routeRevisions: [{ routeId: source, planRevision: 0 }, { routeId: target, planRevision: 0 }] };
  const preview = await moveStopsForDispatch(organizationId, input, { previewOnly: true });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw new Error("Expected preview");
  assert.equal(preview.consequences.status, "verified");
  const sourceClock = preview.consequences.routes.find((route) => route.routeId === source)!;
  const targetClock = preview.consequences.routes.find((route) => route.routeId === target)!;
  assert.equal(sourceClock.before.driveMin, 0);
  assert.equal(sourceClock.before.workMin, 5);
  assert.equal(sourceClock.after.workMin, 0);
  assert.equal(targetClock.before.workMin, 5);
  assert.equal(targetClock.after.workMin, 10);
  assert.equal(targetClock.after.stopCount, 2);
  assert.equal(targetClock.after.windowViolations, 0);
  assert.ok(targetClock.after.endAt);
  await assert.rejects(() => moveStopsForDispatch(organizationId, {
    ...input, targetIndex: 0, expectedPreviewDigest: preview.previewDigest,
  }));
  assert.equal((await stop(moving)).routeId, source);
  const saved = await moveStopsForDispatch(organizationId, { ...input, expectedPreviewDigest: preview.previewDigest });
  assert.equal(saved.kind, "moved");
  assert.equal((await stop(moving)).routeId, target);
  const revisions = await db.select().from(routesTable).where(inArray(routesTable.id, [source, target]));
  const targetRevision = revisions.find((route) => route.id === target)!.planRevision;
  const unassign = { stopIds: [moving], routeId: null, targetIndex: 0,
    routeRevisions: [{ routeId: target, planRevision: targetRevision }] };
  const unassignment = await moveStopsForDispatch(organizationId, unassign, { previewOnly: true });
  assert.equal(unassignment.kind, "preview");
  if (unassignment.kind !== "preview") throw new Error("Expected unassignment preview");
  assert.equal(unassignment.targetRouteId, null);
  assert.equal(unassignment.targetStopCount, 0);
  assert.deepEqual(unassignment.consequences.unplanned, { before: 0, after: 1 });
  assert.equal(unassignment.consequences.routes[0]!.before.stopCount, 2);
  assert.equal(unassignment.consequences.routes[0]!.after.stopCount, 1);
  assert.equal((await stop(moving)).routeId, target);
  assert.equal((await moveStopsForDispatch(organizationId, {
    ...unassign, expectedPreviewDigest: unassignment.previewDigest,
  })).kind, "moved");
  assert.equal((await stop(moving)).routeId, null);
});

test("explicit soft override requires its own bound force preview and persists only on confirm", async () => {
  const routeId = randomUUID(), moving = randomUUID();
  await db.insert(routesTable).values({ id: routeId, organizationId, vehicleId, name: "Soft capacity route",
    date: new Date("2026-08-26T00:00:00Z") });
  await db.insert(stopsTable).values({ id: moving, organizationId, address: "Synthetic heavy order",
    latitude: 59.3, longitude: 18.1, weightKg: 2000, status: "pending" });
  const input = { stopIds: [moving], routeId, targetIndex: 0, routeRevisions: [{ routeId, planRevision: 0 }] };
  const ordinary = await moveStopsForDispatch(organizationId, input, { previewOnly: true });
  const accepted = await moveStopsForDispatch(organizationId, { ...input, force: true }, { previewOnly: true });
  assert.equal(ordinary.kind, "preview");
  assert.equal(accepted.kind, "preview");
  if (ordinary.kind !== "preview" || accepted.kind !== "preview") throw new Error("Expected previews");
  assert.equal(ordinary.canMove, false);
  assert.equal(accepted.canMove, true);
  assert.deepEqual(accepted.conflicts, ordinary.conflicts);
  assert.ok(accepted.conflicts.includes("CAPACITY"));
  assert.notEqual(ordinary.previewDigest, accepted.previewDigest);
  assert.equal((await stop(moving)).assignmentOverrideAt, null);
  await assert.rejects(() => moveStopsForDispatch(organizationId, {
    ...input, force: true, expectedPreviewDigest: ordinary.previewDigest,
  }));
  assert.equal((await stop(moving)).routeId, null);
  assert.equal((await moveStopsForDispatch(organizationId, {
    ...input, force: true, expectedPreviewDigest: accepted.previewDigest,
  })).kind, "moved");
  const saved = await stop(moving);
  assert.ok(saved.assignmentOverrideAt);
  assert.ok(saved.assignmentOverrideReasonCodes?.includes("CAPACITY"));
});

test("manual insertion and resource replacement honor arbitrary service-start locks by waiting; stale resource confirmation rejects", async () => {
  const routeId = randomUUID(), lockedId = randomUUID(), incomingId = randomUUID(), newVehicle = randomUUID(), newDriver = randomUUID();
  const testPlan = randomUUID();
  const point = { address: "Colocated depot", latitude: 59.3, longitude: 18.1,
    verifiedAt: "2026-08-26T00:00:00Z", verification: { source: "synthetic-test" } };
  const planning = { version: 1 as const, objective: "geographic" as const, travelReservePercent: 0,
    stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [], depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const, maxDriverOvertimeMin: 0 };
  await db.insert(routesTable).values({ id: routeId, organizationId, planId: testPlan, vehicleId, name: "Service-lock route",
    date: new Date("2026-08-26T00:00:00Z"), status: "optimized", depotSnapshot: { start: point, end: point },
    optimizationPlanningSnapshot: planning });
  await db.insert(stopsTable).values([
    { id: lockedId, routeId, sequenceOrder: 1 }, { id: incomingId, routeId: null, sequenceOrder: null },
  ].map(item => ({ ...item, organizationId, planningPlanId: testPlan, address: "Colocated synthetic service",
    latitude: point.latitude, longitude: point.longitude, serviceDurationMin: 5, status: "pending" as const })));
  const original = (await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0]!;
  await db.transaction(tx => persistDispatchRouteWorkday(tx, organizationId, original, null));
  const lockAt = "2026-08-26T07:30:00.000Z";
  const acquired = await setRoutePlanningLocks(organizationId, routeId, {
    planRevision: 1, stopId: lockedId, serviceStartAt: new Date(lockAt),
  }, { userId: actor });
  assert.ok(acquired);
  const move = { stopIds: [incomingId], routeId, targetIndex: 0,
    routeRevisions: [{ routeId, planRevision: acquired.planRevision }] };
  const preview = await moveStopsForDispatch(organizationId, move, { previewOnly: true });
  assert.equal(preview.kind, "preview");
  if (preview.kind !== "preview") throw new Error("Expected preview");
  assert.equal(preview.canMove, true);
  assert.equal((await moveStopsForDispatch(organizationId, { ...move, expectedPreviewDigest: preview.previewDigest })).kind, "moved");
  const inserted = (await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0]!;
  assert.equal(inserted.workdayTimeline?.find(e => e.type === "service" && e.stopId === lockedId)?.startAt, lockAt);
  assert.ok(inserted.workdayTimeline?.some(e => e.type === "waiting" && e.durationMin > 0));
  const frozenId = randomUUID(), frozenStop = randomUUID();
  await db.insert(routesTable).values({ id: frozenId, organizationId, planId: randomUUID(), vehicleId, name: "Frozen sibling",
    date: original.date, status: "optimized", depotSnapshot: original.depotSnapshot, optimizationPlanningSnapshot: planning,
    geographicOverlapExplanation: { status: "unknown", message: "Preserve frozen evidence", analyzedPairCount: 0,
      scope: { vehicleIds: [vehicleId], stopIds: [frozenStop] } } });
  await db.insert(stopsTable).values({ id: frozenStop, organizationId, routeId: frozenId,
    address: "Frozen colocated service", latitude: point.latitude, longitude: point.longitude,
    sequenceOrder: 1, serviceDurationMin: 5, status: "pending" });
  const unfrozen = (await db.select().from(routesTable).where(eq(routesTable.id, frozenId)))[0]!;
  await db.transaction(tx => persistDispatchRouteWorkday(tx, organizationId, unfrozen, null));
  await setRoutePlanningLocks(organizationId, frozenId, { planRevision: 1, frozen: true }, { userId: actor });
  await db.update(routesTable).set({
    geographicOverlapExplanation: { status: "unknown", message: "Preserve frozen evidence", analyzedPairCount: 0,
      scope: { vehicleIds: [vehicleId], stopIds: [frozenStop] } },
  }).where(eq(routesTable.id, frozenId));
  const frozenBefore = (await db.select().from(routesTable).where(eq(routesTable.id, frozenId)))[0]!;
  const frozenInput = { stopIds: [frozenStop], routeId: frozenId, targetIndex: 0,
    routeRevisions: [{ routeId: frozenId, planRevision: frozenBefore.planRevision }] };
  const frozenPreview = await moveStopsForDispatch(organizationId, frozenInput, { previewOnly: true });
  assert.equal(frozenPreview.kind, "preview");
  if (frozenPreview.kind !== "preview") throw new Error("Expected frozen reevaluation");
  assert.equal((await moveStopsForDispatch(organizationId, {
    ...frozenInput, expectedPreviewDigest: frozenPreview.previewDigest,
  })).kind, "moved");
  assert.deepEqual((await db.select().from(routesTable).where(eq(routesTable.id, frozenId)))[0], frozenBefore);
  await db.insert(vehiclesTable).values({ id: newVehicle, organizationId, name: "Real replacement vehicle",
    licensePlate: `R-${newVehicle.slice(0, 8)}`, capacityKg: 1000, capacityVolume: 10 });
  await db.insert(driversTable).values({ id: newDriver, organizationId, vehicleId: newVehicle,
    name: "Real replacement driver", workStartTime: "08:00", workEndTime: "18:00" });
  const resources = { routeId, vehicleId: newVehicle, driverId: newDriver, planRevision: inserted.planRevision };
  const resourcePreview = await post("route-resources/preview", resources);
  assert.equal(resourcePreview.status, 200, JSON.stringify(resourcePreview.body));
  assert.equal(resourcePreview.body.canChange, true);
  assert.equal((await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0]!.vehicleId, vehicleId);
  await db.update(driversTable).set({ tempo: "fast" }).where(eq(driversTable.id, newDriver));
  assert.equal((await post("route-resources/confirm", { ...resources, expectedPreviewDigest: resourcePreview.body.previewDigest })).status, 409);
  const refreshed = await post("route-resources/preview", resources);
  const saved = await post("route-resources/confirm", { ...resources, expectedPreviewDigest: refreshed.body.previewDigest });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.route.vehicleId, newVehicle);
  assert.equal(saved.body.route.workdayTimeline.find((e: any) => e.type === "service" && e.stopId === lockedId).startAt, lockAt);
  assert.ok(saved.body.route.workdayTimeline.some((e: any) => e.type === "waiting" && e.durationMin > 0));
  assert.deepEqual((await db.select().from(routesTable).where(eq(routesTable.id, frozenId)))[0], frozenBefore);
  const beforeLockedMove = await stop(lockedId);
  const otherRoute = randomUUID();
  await db.insert(routesTable).values({ id: otherRoute, organizationId, planId: testPlan, vehicleId, name: "Same-plan route",
    date: original.date, depotSnapshot: original.depotSnapshot, optimizationPlanningSnapshot: planning });
  await assert.rejects(() => moveStopsForDispatch(organizationId, { stopIds: [lockedId], routeId: otherRoute, targetIndex: 0,
    routeRevisions: [{ routeId, planRevision: saved.body.route.planRevision }, { routeId: otherRoute, planRevision: 0 }] }, { previewOnly: true }));
  assert.deepEqual(await stop(lockedId), beforeLockedMove);
  await setRoutePlanningLocks(organizationId, routeId, {
    planRevision: saved.body.route.planRevision, stopId: lockedId,
    resourcePair: { vehicleId: newVehicle, driverId: newDriver },
  }, { userId: actor });
  const resourceLockedRoute = (await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0]!;
  assert.equal((await post("route-resources/preview", {
    routeId, vehicleId, driverId, planRevision: resourceLockedRoute.planRevision, force: true,
  })).status, 409);
  assert.equal((await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0]!.vehicleId, newVehicle);
});

test("complete combined adjustment previews without saving, binds all revisions/facts and preserves frozen sibling", async () => {
  const testPlan = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()];
  const vehicleIds = ids.map(() => randomUUID()), driverIds = ids.map(() => randomUUID());
  const stopIds = Array.from({ length: 4 }, () => randomUUID());
  const point = { address: "Combined zero-distance depot", latitude: 59.3, longitude: 18.1,
    verifiedAt: "2026-08-26T00:00:00Z", verification: { source: "synthetic-test" } };
  const planning = { version: 1 as const, objective: "geographic" as const, travelReservePercent: 0,
    stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [], depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const };
  await db.insert(vehiclesTable).values(vehicleIds.map(id => ({ id, organizationId, name: "Combined vehicle",
    licensePlate: `C-${id.slice(0, 8)}`, capacityKg: 1000, capacityVolume: 10 })));
  await db.insert(driversTable).values(driverIds.map((id, index) => ({ id, organizationId, vehicleId: vehicleIds[index],
    name: "Combined driver", workStartTime: "07:00", workEndTime: "18:00" })));
  await db.insert(routesTable).values(ids.map((id, index) => ({ id, organizationId, planId: testPlan,
    vehicleId: vehicleIds[index], name: `Combined route ${index + 1}`, date: new Date("2026-08-26T00:00:00Z"),
    status: "optimized" as const, depotSnapshot: { start: point, end: point }, optimizationPlanningSnapshot: planning })));
  await db.insert(stopsTable).values(stopIds.map((id, index) => ({ id, organizationId, planningPlanId: testPlan,
    routeId: ids[index < 2 ? 0 : index - 1], sequenceOrder: index < 2 ? index + 1 : 1,
    address: "Combined colocated service", latitude: point.latitude, longitude: point.longitude,
    serviceDurationMin: 5, status: "pending" as const })));
  for (const id of ids) {
    const route = (await db.select().from(routesTable).where(eq(routesTable.id, id)))[0]!;
    await db.transaction(tx => persistDispatchRouteWorkday(tx, organizationId, route, null));
  }
  await setRoutePlanningLocks(organizationId, ids[2], { planRevision: 1, frozen: true }, { userId: actor });
  const routeRows = () => db.select().from(routesTable).where(and(eq(routesTable.organizationId, organizationId),
    eq(routesTable.planId, testPlan))).orderBy(routesTable.id);
  const stopRows = () => db.select().from(stopsTable).where(and(eq(stopsTable.organizationId, organizationId),
    eq(stopsTable.planningPlanId, testPlan))).orderBy(stopsTable.id);
  const beforeRoutes = await routeRows(), beforeStops = await stopRows();
  const input = { planId: testPlan, depotLatitude: point.latitude, depotLongitude: point.longitude,
    routes: ids.map((routeId, index) => ({ routeId, driverId: driverIds[index],
      planRevision: beforeRoutes.find(row => row.id === routeId)!.planRevision,
      stopIds: index === 0 ? [stopIds[1]] : index === 1 ? [stopIds[2], stopIds[0]] : [stopIds[3]] })) };
  async function request(path: string, body: unknown) {
    const response = await fetch(`${base}/import/route-adjustments${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  const preview = await request("/preview", input);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.canApply, true);
  assert.equal(preview.body.consequences.status, "verified");
  assert.equal(preview.body.consequences.routes.find((route: any) => route.routeId === ids[1]).after.stopCount, 2);
  assert.deepEqual(await routeRows(), beforeRoutes);
  assert.deepEqual(await stopRows(), beforeStops);
  const changed = structuredClone(input);
  changed.routes[1].stopIds.reverse();
  assert.equal((await request("", { ...changed, expectedPreviewDigest: preview.body.previewDigest })).status, 409);
  await db.update(driversTable).set({ tempo: "slow" }).where(eq(driversTable.id, driverIds[0]));
  assert.equal((await request("", { ...input, expectedPreviewDigest: preview.body.previewDigest })).status, 409);
  assert.deepEqual(await routeRows(), beforeRoutes);
  assert.deepEqual(await stopRows(), beforeStops);
  const frozenChange = structuredClone(input);
  [frozenChange.routes[0].stopIds[0], frozenChange.routes[2].stopIds[0]]
    = [frozenChange.routes[2].stopIds[0], frozenChange.routes[0].stopIds[0]];
  assert.equal((await request("/preview", frozenChange)).status, 409);
  const fresh = await request("/preview", input);
  assert.equal(fresh.status, 200);
  const saved = await request("", { ...input, expectedPreviewDigest: fresh.body.previewDigest });
  assert.equal(saved.status, 200);
  assert.deepEqual((await stopRows()).filter(row => row.routeId === ids[1])
    .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0)).map(row => row.id), [stopIds[2], stopIds[0]]);
  assert.deepEqual((await routeRows()).find(row => row.id === ids[2]), beforeRoutes.find(row => row.id === ids[2]));
  assert.equal((await request("", { ...input, expectedPreviewDigest: fresh.body.previewDigest })).status, 409);
});
