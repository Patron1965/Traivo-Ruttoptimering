import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import {
  db, organizationsTable, usersTable, routesTable, stopsTable, vehiclesTable, driversTable,
  auditLogTable, executionEventsTable, routeDispatchSnapshotsTable,
  routeAcknowledgementsTable, routeExecutionsTable,
  vehiclePositionsTable,
} from "@workspace/db";
import router from "./routes/routes";
import stopsRouter from "./routes/stops";
import executionRouter from "./routes/route-execution";
import trackingRouter from "./routes/tracking";
import outgoingRouter from "./routes/route-outgoing";
import { outgoingDriverReads } from "./middleware/outgoing-driver-reads";
import { recordExecutionEvent } from "./services/execution-event-service";
import { captureRouteDispatchSnapshot } from "./services/route-dispatch-snapshot-service";
import { hasBlockingPlanningConflicts, planningConflictSeverity } from "./services/planning-conflict-policy";

const org = randomUUID();
const foreignOrg = randomUUID();
const userId = randomUUID();
const vehicleId = randomUUID();
const otherVehicleId = randomUUID();
const driverId = randomUUID();
const routeId = randomUUID();
const otherRouteId = randomUUID();
const stopId = randomUUID();
const instant = "2026-10-19T08:00:00.000Z";
const timeline = [{
  type: "service" as const, stopId, startAt: instant,
  endAt: "2026-10-19T08:05:00.000Z", durationMin: 5,
}];
let server: Server;
let base: string;

before(async () => {
  await db.insert(organizationsTable).values([org, foreignOrg].map((id) => ({
    id, name: "Synthetic planner locks", email: `${id}@planner-locks.test`,
  })));
  await db.insert(usersTable).values({
    id: userId, organizationId: org, name: "Synthetic planner", email: `${userId}@planner-locks.test`, role: "dispatcher",
  });
  await db.insert(vehiclesTable).values([vehicleId, otherVehicleId].map((id) => ({
    id, organizationId: org, name: "Synthetic lock vehicle", licensePlate: id,
  })));
  await db.insert(driversTable).values({ id: driverId, organizationId: org, name: "Synthetic lock driver", vehicleId });
  await db.insert(routesTable).values([
    { id: routeId, organizationId: org, vehicleId, name: "Synthetic lock route", date: new Date(instant),
      status: "optimized", totalStops: 1, workdayTimeline: timeline,
      plannerItinerary: [{ stopId, sequenceOrder: 1, estimatedArrival: instant, distanceFromPreviousKm: 0 }] },
    { id: otherRouteId, organizationId: org, vehicleId: otherVehicleId, name: "Other synthetic route", date: new Date(instant) },
  ]);
  await db.insert(stopsTable).values({
    id: stopId, organizationId: org, routeId, address: "Synthetic stop", latitude: 59.3, longitude: 18.1,
    sequenceOrder: 1,
  });
  // Isolated request harness; production role and tenant middleware still run.
  // Session authentication itself is covered by existing request regressions.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: userId, organizationId: req.header("x-test-foreign") ? foreignOrg : org,
      role: req.header("x-test-role") === "admin" ? "admin" : req.header("x-test-role") === "viewer" ? "viewer" : req.header("x-test-role") === "driver" ? "driver" : "dispatcher",
      name: "Synthetic planner", email: `${userId}@planner-locks.test`,
      driverProfileId: req.header("x-test-role") === "driver" ? req.header("x-test-driver-id") ?? driverId : null,
    };
    next();
  });
  app.use("/api", outgoingDriverReads, trackingRouter, outgoingRouter, router, stopsRouter, executionRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.update(routesTable).set({ optimizationFrozen: false, frozenDriverId: null }).where(eq(routesTable.organizationId, org));
  await db.update(stopsTable).set({ lockedVehicleId: null, lockedDriverId: null, lockedServiceStartAt: null }).where(eq(stopsTable.organizationId, org));
  await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, org));
  await db.delete(executionEventsTable).where(eq(executionEventsTable.organizationId, org));
  await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.organizationId, org));
  await db.delete(routeAcknowledgementsTable).where(eq(routeAcknowledgementsTable.organizationId, org));
  await db.delete(vehiclePositionsTable).where(eq(vehiclePositionsTable.organizationId, org));
  await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, org));
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, org));
  await db.delete(routesTable).where(eq(routesTable.organizationId, org));
  await db.delete(driversTable).where(eq(driversTable.organizationId, org));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, org));
  await db.delete(usersTable).where(eq(usersTable.organizationId, org));
  await db.delete(routesTable).where(eq(routesTable.organizationId, foreignOrg));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [org, foreignOrg]));
});

async function lock(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base}/routes/${routeId}/planning-locks`, {
    method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
async function currentRoute() {
  const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
  return route!;
}
const rejectsLock = (promise: PromiseLike<unknown>) => assert.rejects(Promise.resolve(promise), (error: unknown) =>
  error instanceof Error && (
    error.message.includes("PLANNING_LOCK_CONFLICT")
    || (error.cause instanceof Error && error.cause.message.includes("PLANNING_LOCK_CONFLICT"))
  ));

test("persistent route locks enforce tenant, role, CAS, alternate writes and execution compatibility", async () => {
  assert.equal((await lock({ planRevision: 0, frozen: true }, { "x-test-role": "viewer" })).status, 403);
  assert.equal((await lock({ planRevision: 0, frozen: true }, { "x-test-foreign": "yes" })).status, 404);
  assert.equal((await lock({ planRevision: 100, frozen: true })).status, 409);
  assert.equal((await lock({ planRevision: 0, stopId, serviceStartAt: "2026-10-19T10:00:00" })).status, 400);
  assert.equal((await lock({ planRevision: 0, stopId, serviceStartAt: "2026-10-19T10:00:01+02:00" })).status, 409);
  const response = await lock({
    planRevision: 0, stopId, resourcePair: { vehicleId, driverId }, serviceStartAt: "2026-10-19T10:00:00+02:00",
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await currentRoute()).planRevision, 1);
  const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  assert.equal(stop!.lockedServiceStartAt?.toISOString(), instant);
  await rejectsLock(db.update(stopsTable).set({ routeId: otherRouteId }).where(eq(stopsTable.id, stopId)));
  await rejectsLock(db.update(routesTable).set({ vehicleId: otherVehicleId }).where(eq(routesTable.id, routeId)));
  await rejectsLock(db.update(routesTable).set({ workdayTimeline: [] }).where(eq(routesTable.id, routeId)));
  await rejectsLock(db.update(driversTable).set({ vehicleId: otherVehicleId }).where(eq(driversTable.id, driverId)));
  assert.equal((await lock({ planRevision: 1, frozen: true })).status, 200);
  await rejectsLock(db.update(stopsTable).set({ sequenceOrder: 2 }).where(eq(stopsTable.id, stopId)));
  await rejectsLock(db.insert(stopsTable).values({
    organizationId: org, routeId, address: "Forbidden synthetic insertion", latitude: 59, longitude: 18,
  }));
  await rejectsLock(db.update(routesTable).set({ plannerItinerary: [] }).where(eq(routesTable.id, routeId)));
  await db.update(routesTable).set({
    status: "in_progress", lockedFirstStopId: stopId,
    handoffStatus: "accepted", handoffVersion: 2, handoffDriverId: driverId,
  }).where(eq(routesTable.id, routeId));
  await db.transaction(async (tx) => {
    const route = await currentRoute();
    const stops = await tx.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
    await captureRouteDispatchSnapshot(tx, route, stops, driverId, new Date(instant));
  });
  await recordExecutionEvent({
    organizationId: org, actorUserId: userId, driverProfileId: driverId, role: "driver", stopId,
    input: { clientEventId: randomUUID(), type: "completed", planVersion: 2, occurredAt: new Date().toISOString() },
  });
  const [completed] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  assert.equal(completed!.status, "completed");
  assert.equal(completed!.lockedServiceStartAt, null);
  assert.equal(completed!.lockedVehicleId, null);
  assert.equal((await currentRoute()).lockedFirstStopId, null);
  assert.equal((await currentRoute()).optimizationFrozen, true);
  assert.equal((await lock({ planRevision: 2, frozen: false })).status, 200);
  assert.equal((await lock({ planRevision: 3, stopId, resourcePair: null })).status, 409, "terminal history cannot acquire/change locks");
});

test("snapshot evidence is authentic, immutable, isolated and never fabricated for legacy reads", async () => {
  const legacy = await fetch(`${base}/routes/${otherRouteId}/dispatch-snapshot`);
  assert.equal(legacy.status, 409);
  const route = await currentRoute();
  await db.update(routesTable).set({ handoffVersion: route.planRevision }).where(eq(routesTable.id, routeId));
  const stops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
  await db.transaction(async (tx) => captureRouteDispatchSnapshot(tx, route, stops, driverId, new Date(instant)));
  const response = await fetch(`${base}/routes/${routeId}/dispatch-snapshot`);
  assert.equal(response.status, 200);
  const snapshot = await response.json() as { planRevision: number; stops: { address: string }[] };
  assert.equal(snapshot.planRevision, route.planRevision);
  assert.equal(snapshot.stops[0]!.address, "Synthetic stop");
  assert.equal((await fetch(`${base}/routes/${routeId}/dispatch-snapshot`, { headers: { "x-test-role": "viewer" } })).status, 403);
  assert.equal((await fetch(`${base}/routes/${routeId}/dispatch-snapshot`, { headers: { "x-test-foreign": "yes" } })).status, 404);
  await rejectsLock(db.update(routeDispatchSnapshotsTable).set({ stops: [] }).where(eq(routeDispatchSnapshotsTable.routeId, routeId)));
});

test("shared severity policy defaults unknown and safety constraints to hard", () => {
  for (const code of ["NO_VEHICLE", "TIME_WINDOW", "RANGE", "SKILL", "PLANNING_LOCK", "UNKNOWN"]) {
    assert.equal(planningConflictSeverity(code), "hard");
    assert.equal(hasBlockingPlanningConflicts([code], true), true);
  }
  assert.equal(hasBlockingPlanningConflicts(["WORKING_HOURS"], false), true);
  assert.equal(hasBlockingPlanningConflicts(["WORKING_HOURS"], true), false);
  assert.equal(hasBlockingPlanningConflicts(["WORKING_HOURS"], true, true), true);
  assert.equal(hasBlockingPlanningConflicts(["CAPACITY"], false), true);
  assert.equal(hasBlockingPlanningConflicts(["CAPACITY"], true), false);
});

test("saved working proposal is independent of driver reads/execution until real redispatch and fresh acceptance", async () => {
  const id = randomUUID(), first = randomUUID(), late = randomUUID();
  await db.insert(routesTable).values({
    id, organizationId: org, vehicleId, name: "Approved outgoing name", date: new Date(instant),
    status: "optimized", totalStops: 1,
    plannerItinerary: [{ stopId: first, sequenceOrder: 1, estimatedArrival: instant, distanceFromPreviousKm: 0 }],
  });
  await db.insert(stopsTable).values([
    { id: first, organizationId: org, routeId: id, address: "Approved outgoing address", latitude: 59.3, longitude: 18.1, sequenceOrder: 1 },
    { id: late, organizationId: org, address: "Unapproved late order", latitude: 59.3, longitude: 18.1 },
  ]);
  const request = (path: string, method = "GET", body?: unknown, driver = false, foreign = false) => fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", ...(driver ? { "x-test-role": "driver" } : {}), ...(foreign ? { "x-test-foreign": "yes" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let response = await request(`/routes/${id}/dispatch`, "POST", { driverId, planRevision: 0 });
  assert.equal(response.status, 200, await response.text());
  for (const status of ["received", "opened", "accepted"]) {
    response = await request(`/routes/${id}/handoff`, "POST", { version: 0, status }, true);
    assert.equal(response.status, 200, await response.text());
  }
  response = await request(`/routes/${id}`, "PUT", { name: "Unapproved working name", planRevision: 0 });
  assert.equal(response.status, 200, await response.text());
  response = await request("/stops/dispatch-move", "POST", {
    stopIds: [late], routeId: id, targetIndex: 1, force: false,
    routeRevisions: [{ routeId: id, planRevision: 1 }],
  });
  assert.equal(response.status, 200, await response.text());
  const [working] = await db.select().from(routesTable).where(eq(routesTable.id, id));
  assert.equal(working!.planRevision, 2);
  assert.equal(working!.handoffVersion, 0);
  assert.equal(working!.handoffStatus, "accepted");
  assert.equal(((await (await request(`/routes/${id}`)).json()) as any).name, "Unapproved working name");
  const beforeDriver = await (await request(`/routes/${id}`, "GET", undefined, true)).json() as any;
  assert.equal(beforeDriver.name, "Approved outgoing name");
  assert.equal(beforeDriver.planRevision, 0);
  const beforeStops = await (await request(`/routes/${id}/stops`, "GET", undefined, true)).json() as any[];
  assert.deepEqual(beforeStops.map((stop: { id: string }) => stop.id), [first]);
  assert.equal((await request(`/stops/${late}`, "GET", undefined, true)).status, 409);
  assert.equal((await request(`/routes/${id}`, "GET", undefined, true, true)).status, 403);
  const oldCompletion = { clientEventId: randomUUID(), type: "completed", planVersion: 0, occurredAt: new Date().toISOString() };
  response = await request(`/stops/${first}/execution-events`, "POST", oldCompletion, true);
  assert.equal(response.status, 201, await response.text());
  const [fact] = await db.select().from(executionEventsTable).where(eq(executionEventsTable.clientEventId, oldCompletion.clientEventId));
  assert.equal(fact!.routeId, id); assert.equal(fact!.planVersion, 0);
  response = await request(`/routes/${id}/dispatch`, "POST", { driverId, planRevision: 1 });
  assert.equal(response.status, 409);
  const unchanged = await (await request(`/routes/${id}`, "GET", undefined, true)).json() as any;
  assert.equal(unchanged.planRevision, 0); assert.equal(unchanged.handoffStatus, "accepted");
  // Existing legacy manual-review fixture; protected approval is exercised by
  // route-plan-approval.request.test.ts, not substituted by this timestamp.
  await db.update(routesTable).set({
    manualReviewedAt: new Date(),
    plannerItinerary: [
      { stopId: first, sequenceOrder: 1, estimatedArrival: instant, distanceFromPreviousKm: 0 },
      { stopId: late, sequenceOrder: 2, estimatedArrival: "2026-10-12T08:10:00.000Z", distanceFromPreviousKm: 0 },
    ],
  }).where(eq(routesTable.id, id));
  response = await request(`/routes/${id}/dispatch`, "POST", { driverId, planRevision: 2 });
  assert.equal(response.status, 200, await response.text());
  const sent = await (await request(`/routes/${id}`, "GET", undefined, true)).json() as any;
  assert.equal(sent.name, "Unapproved working name"); assert.equal(sent.planRevision, 2);
  assert.equal(sent.handoffStatus, "sent");
  response = await request(`/stops/${late}/execution-events`, "POST", {
    clientEventId: randomUUID(), type: "completed", planVersion: 2, occurredAt: new Date().toISOString(),
  }, true);
  assert.equal(response.status, 409, "fresh acceptance is mandatory");
  for (const status of ["received", "opened", "accepted"]) {
    response = await request(`/routes/${id}/handoff`, "POST", { version: 2, status }, true);
    assert.equal(response.status, 200, await response.text());
  }
  response = await request(`/stops/${late}/execution-events`, "POST", {
    clientEventId: randomUUID(), type: "completed", planVersion: 0, occurredAt: new Date().toISOString(),
  }, true);
  assert.equal(response.status, 409, "old execution version is rejected atomically");
  const [stillPending] = await db.select().from(stopsTable).where(eq(stopsTable.id, late));
  assert.equal(stillPending!.status, "pending");
  response = await request(`/stops/${late}/execution-events`, "POST", {
    clientEventId: randomUUID(), type: "completed", planVersion: 2, occurredAt: new Date().toISOString(),
  }, true);
  assert.equal(response.status, 201, await response.text());
  const [finished] = await db.select().from(stopsTable).where(eq(stopsTable.id, late));
  assert.equal(finished!.status, "completed", "accepted redispatch executes the new version");
  const [original] = await db.select().from(stopsTable).where(eq(stopsTable.id, first));
  assert.equal(original!.status, "completed", "redispatch preserves already completed history");
});

test("planner outgoing-view requests isolate scope and project approved resources with live facts", async (t) => {
  const realFetch = globalThis.fetch;
  const localOrigin = new URL(base).origin;
  let externalAttempts = 0;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== localOrigin) {
      externalAttempts++;
      throw new Error(`External fetch forbidden by outgoing-view request test: ${url.origin}`);
    }
    return realFetch(input, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const approvedVehicle = randomUUID(), proposedVehicle = randomUUID(), approvedDriver = randomUUID();
  const first = randomUUID(), second = randomUUID(), pending = randomUUID(), legacy = randomUUID(), foreign = randomUUID();
  const actualStop = randomUUID();
  await db.insert(vehiclesTable).values([
    { id: approvedVehicle, organizationId: org, name: "Approved first vehicle", licensePlate: "SNAPSHOT-FIRST", routeColor: "#111111" },
    { id: proposedVehicle, organizationId: org, name: "Unsent proposed vehicle", licensePlate: "PROPOSAL-ONLY", routeColor: "#999999" },
  ]);
  await db.insert(driversTable).values({
    id: approvedDriver, organizationId: org, vehicleId: approvedVehicle, name: "Approved first driver",
  });
  await db.insert(routesTable).values([
    { id: first, organizationId: org, vehicleId: approvedVehicle, name: "Approved first route", date: new Date(instant),
      handoffStatus: "accepted", handoffVersion: 0, handoffDriverId: approvedDriver, status: "in_progress", totalStops: 1 },
    { id: second, organizationId: org, vehicleId: approvedVehicle, name: "Approved second route", date: new Date(instant),
      handoffStatus: "sent", handoffVersion: 0, handoffDriverId: approvedDriver, status: "in_progress" },
    { id: pending, organizationId: org, name: "Unsent work", date: new Date(instant) },
    { id: legacy, organizationId: org, vehicleId: approvedVehicle, name: "Legacy evidence absent", date: new Date(instant),
      handoffStatus: "sent", handoffVersion: 0, handoffDriverId: approvedDriver, status: "in_progress" },
    { id: foreign, organizationId: foreignOrg, name: "SECOND-ORG-PRIVATE", date: new Date(instant) },
  ]);
  await db.insert(stopsTable).values({
    id: actualStop, organizationId: org, routeId: first, address: "Approved address",
    latitude: 59.3, longitude: 18.1, sequenceOrder: 1,
  });
  const capture = async (id: string) => db.transaction(async (tx) => {
    const [route] = await tx.select().from(routesTable).where(eq(routesTable.id, id));
    const stops = await tx.select().from(stopsTable).where(eq(stopsTable.routeId, id));
    await captureRouteDispatchSnapshot(tx, route!, stops, approvedDriver, new Date(instant));
  });
  await capture(first);
  await db.update(vehiclesTable).set({ name: "Approved second vehicle", licensePlate: "SNAPSHOT-SECOND", routeColor: "#222222" })
    .where(eq(vehiclesTable.id, approvedVehicle));
  await db.update(driversTable).set({ name: "Approved second driver" }).where(eq(driversTable.id, approvedDriver));
  await capture(second);
  const query = (ids: string[], headers: Record<string, string> = {}) =>
    fetch(`${base}/routes/outgoing-view?${new URLSearchParams({ routeIds: ids.join(",") })}`, {
      headers: { "x-test-role": "admin", ...headers },
    });

  await t.test("viewer/driver denied and both organizations cannot read each other's evidence", async () => {
    assert.equal((await query([first], { "x-test-role": "viewer" })).status, 403);
    assert.equal((await query([first], { "x-test-role": "driver" })).status, 403);
    for (const [ids, headers] of [
      [[first], { "x-test-foreign": "yes" }], [[foreign], {}],
      [[first, foreign], { "x-test-foreign": "yes" }], [[first, foreign], {}],
    ] as [string[], Record<string, string>][]) {
      const response = await query(ids, headers);
      assert.equal(response.status, 404);
      const body = await response.text();
      assert.ok(!body.includes("Approved first") && !body.includes("SECOND-ORG-PRIVATE") && !body.includes('"routes":'));
    }
    const ownForeign = await query([foreign], { "x-test-foreign": "yes" });
    assert.equal(ownForeign.status, 200);
    assert.deepEqual(await ownForeign.json(), { routes: [], stops: [], omittedRouteIds: [foreign], perRouteResources: {} });
  });
  await t.test("scope is bounded and unsent routes omitted without fabricated evidence", async () => {
    assert.equal((await query([])).status, 400);
    assert.equal((await query(Array.from({ length: 101 }, () => randomUUID()))).status, 400);
    const response = await query([first, pending]);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    const body = await response.json() as any;
    assert.deepEqual(body.routes.map((route: any) => route.id), [first]);
    assert.deepEqual(body.stops.map((stop: any) => stop.id), [actualStop]);
    assert.deepEqual(body.omittedRouteIds, [pending]);
    assert.deepEqual(Object.keys(body.perRouteResources), [first]);
    assert.equal((await db.select().from(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.routeId, pending))).length, 0);
  });
  await t.test("one missing snapshot fails the whole valid/unsent/legacy batch without writes", async () => {
    const response = await query([first, pending, legacy]);
    assert.equal(response.status, 409);
    const body = await response.json() as any;
    assert.equal(body.code, "OUTGOING_REVIEW_REQUIRED");
    assert.equal(body.routeId, legacy);
    assert.ok(!("routes" in body) && !("stops" in body) && !("perRouteResources" in body));
    assert.equal((await db.select().from(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.routeId, legacy))).length, 0);
    const [row] = await db.select().from(routesTable).where(eq(routesTable.id, legacy));
    assert.equal(row!.dispatchSnapshotVersion, null);
  });
  const start = await fetch(`${base}/routes/${first}/execution/start`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-role": "driver", "x-test-driver-id": approvedDriver },
    body: JSON.stringify({ clientEventId: randomUUID() }),
  });
  assert.equal(start.status, 201, await start.text());
  await db.update(routesTable).set({
    name: "UNSENT WORKING ROUTE", vehicleId: proposedVehicle, planRevision: 1, status: "optimized",
  }).where(eq(routesTable.id, first));
  await db.update(stopsTable).set({ address: "UNSENT WORKING ADDRESS" }).where(eq(stopsTable.id, actualStop));
  await db.update(vehiclesTable).set({ name: "CURRENT NOT APPROVED", licensePlate: "CURRENT-ONLY", routeColor: "#333333", isActive: false })
    .where(eq(vehiclesTable.id, approvedVehicle));
  await db.update(driversTable).set({ name: "CURRENT DRIVER NOT APPROVED", vehicleId: proposedVehicle })
    .where(eq(driversTable.id, approvedDriver));
  await t.test("edited pair/current metadata never replace either route's independently approved resources", async () => {
    const response = await query([first, second]);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.routes[0].name, "Approved first route");
    assert.equal(body.routes[0].vehicleId, approvedVehicle);
    assert.equal(body.routes[0].planRevision, 0);
    assert.equal(body.routes[0].status, "in_progress");
    assert.equal(body.stops[0].address, "Approved address");
    assert.equal(body.perRouteResources[first].vehicle.name, "Approved first vehicle");
    assert.equal(body.perRouteResources[first].vehicle.routeColor, "#111111");
    assert.equal(body.perRouteResources[first].vehicle.licensePlate, "SNAPSHOT-FIRST");
    assert.equal(body.perRouteResources[first].vehicle.isActive, true, "dispatch-time resource evidence, not current profile status");
    assert.equal(body.perRouteResources[first].driver.name, "Approved first driver");
    assert.equal(body.perRouteResources[first].driver.vehicleId, approvedVehicle);
    assert.equal(body.perRouteResources[second].vehicle.id, approvedVehicle);
    assert.equal(body.perRouteResources[second].vehicle.name, "Approved second vehicle");
    assert.equal(body.perRouteResources[second].vehicle.routeColor, "#222222");
    assert.equal(body.perRouteResources[second].driver.name, "Approved second driver");
    assert.equal(body.perRouteResources[first].outgoingVersion, 0);
    assert.ok(!JSON.stringify(body).includes("CURRENT NOT APPROVED") && !JSON.stringify(body).includes("UNSENT WORKING"));
  });
  await recordExecutionEvent({
    organizationId: org, actorUserId: userId, driverProfileId: approvedDriver, role: "driver", stopId: actualStop,
    input: { clientEventId: randomUUID(), type: "completed", planVersion: 0, occurredAt: new Date().toISOString() },
  });
  await t.test("terminal facts remain live while approved planning and the edited proposal stay independent", async () => {
    const beforeEnd = await query([first]);
    assert.equal(beforeEnd.status, 200);
    assert.equal((await beforeEnd.json() as any).routes[0].status, "in_progress");
    const end = await fetch(`${base}/routes/${first}/execution/end`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-role": "driver", "x-test-driver-id": approvedDriver },
      body: JSON.stringify({ clientEventId: randomUUID() }),
    });
    assert.equal(end.status, 201, await end.text());
    const response = await query([first]);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.routes[0].status, "completed", "actual ended execution, not working optimized status");
    assert.equal(body.stops[0].status, "completed");
    assert.ok(body.stops[0].terminalAt);
    assert.equal(body.stops[0].address, "Approved address");
    assert.equal(body.perRouteResources[first].driver.name, "Approved first driver");
    const [working] = await db.select().from(routesTable).where(eq(routesTable.id, first));
    assert.equal(working!.name, "UNSENT WORKING ROUTE");
    assert.equal(working!.vehicleId, proposedVehicle);
    assert.equal(working!.planRevision, 1);
    assert.equal(working!.status, "optimized", "execution must not overwrite independent working status");
    const [actual] = await db.select().from(stopsTable).where(eq(stopsTable.id, actualStop));
    assert.equal(actual!.address, "UNSENT WORKING ADDRESS");
    assert.equal(actual!.status, "completed");
    assert.equal(externalAttempts, 0);
  });
});

test("VehiclePosition keeps the actual old GPS measurement time instead of now or a fabricated fix", async () => {
  const before = await (await fetch(`${base}/vehicles/positions`)).json() as Array<{ measuredAt: string | null; isRealGps: boolean }>;
  assert.deepEqual(before, [], "No outgoing execution position is fabricated without telemetry");
  const measuredAt = new Date(Date.now() - 45 * 60_000);
  await db.insert(vehiclePositionsTable).values({
    organizationId: org, vehicleId, routeId,
    latitude: 59.31, longitude: 18.12, recordedAt: measuredAt,
  });
  const response = await fetch(`${base}/vehicles/positions`, { headers: { "x-test-role": "driver" } });
  assert.equal(response.status, 200);
  const positions = await response.json() as Array<{ vehicleId: string; measuredAt: string | null; isRealGps: boolean; latitude: number }>;
  assert.ok(positions.length > 0);
  for (const position of positions) {
    assert.equal(position.vehicleId, vehicleId);
    assert.equal(position.measuredAt, measuredAt.toISOString());
    assert.equal(position.isRealGps, true);
    assert.equal(position.latitude, 59.31);
  }
});
