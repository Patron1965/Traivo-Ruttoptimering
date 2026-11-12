import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, organizationsTable, usersTable, driversTable, vehiclesTable, routesTable,
  stopsTable, executionEventsTable, routeDispatchSnapshotsTable, sessionsTable, deliveryProofsTable } from "@workspace/db";
import { createSession } from "./lib/session";
import { captureSyntheticDispatch } from "./testing/capture-synthetic-dispatch";
import { outgoingRoute, outgoingStops } from "./services/outgoing-route-service";
import { projectDriverArrivals } from "./services/driver-arrival";

const organizationId = randomUUID(), driverId = randomUUID(), vehicleId = randomUUID(), userId = randomUUID();
const otherUserId = randomUUID(), otherDriverId = randomUUID();
let server: Server, base: string, token: string, otherToken: string;
before(async () => {
  await db.insert(organizationsTable).values({ id: organizationId, name: "Selection isolated tests", email: `${organizationId}@example.test` });
  await db.insert(vehiclesTable).values({ id: vehicleId, organizationId, name: "Selection vehicle", licensePlate: randomUUID() });
  await db.insert(driversTable).values([
    { id: driverId, organizationId, vehicleId, name: "Selection driver" },
    { id: otherDriverId, organizationId, name: "Other driver" },
  ]);
  await db.insert(usersTable).values([
    { id: userId, organizationId, name: "Selection user", email: `${userId}@example.test`, role: "driver", driverProfileId: driverId },
    { id: otherUserId, organizationId, name: "Other user", email: `${otherUserId}@example.test`, role: "driver", driverProfileId: otherDriverId },
  ]);
  token = (await createSession({ userId, organizationId, userAgent: "selection-test" })).token;
  otherToken = (await createSession({ userId: otherUserId, organizationId, userAgent: "selection-test" })).token;
  const { default: app } = await import("./app");
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server?.closeAllConnections();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  await db.delete(executionEventsTable).where(eq(executionEventsTable.organizationId, organizationId));
  await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, organizationId));
  await db.update(stopsTable).set({ lockedServiceStartAt: null }).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(sessionsTable).where(eq(sessionsTable.organizationId, organizationId));
  await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});
async function fixture(locked = false) {
  const id = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(routesTable).values({ id, organizationId, vehicleId, name: "Selection route", date: new Date(),
    status: "in_progress", planRevision: 1, handoffVersion: 1, handoffDriverId: driverId,
    handoffStatus: "accepted", lockedFirstStopId: locked ? ids[0] : null, totalStops: 3 });
  await db.insert(stopsTable).values(ids.map((stopId, index) => ({ id: stopId, organizationId, routeId: id,
    address: `Selection stop ${index}`, sequenceOrder: index + 1, latitude: 59.3 + index / 100, longitude: 18.1,
    status: "pending" as const })));
  await captureSyntheticDispatch(organizationId, [id]);
  return { id, ids };
}
async function route(id: string) {
  const [row] = await db.select().from(routesTable).where(eq(routesTable.id, id));
  return outgoingRoute(row);
}
async function select(stopId: string, revision: string, planVersion = 1, auth = token, eventId = randomUUID()) {
  return fetch(`${base}/api/stops/${stopId}/execution-events`, { method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", Connection: "close" },
    body: JSON.stringify({ clientEventId: eventId, type: "select_next", planVersion,
      expectedSelectionRevision: revision, occurredAt: new Date().toISOString() }) });
}
test("explicit selection changes operational order, preserves snapshot, retries and completes safely", async () => {
  const { id, ids } = await fixture();
  const before = await route(id);
  const snapshots = await db.select().from(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.routeId, id));
  const eventId = randomUUID();
  const response = await select(ids[2], before.executionProjection!.selectionRevision!, 1, token, eventId);
  assert.equal(response.status, 201, await response.clone().text());
  const updated = await route(id);
  assert.equal(updated.executionProjection!.activeStopId, ids[2]);
  assert.deepEqual((await outgoingStops(updated)).map(stop => stop.id), [ids[2], ids[0], ids[1]]);
  assert.equal(updated.handoffStatus, "accepted");
  assert.equal(updated.planRevision, 1);
  assert.equal(updated.executionProjection!.expectedFinishAt, null);
  assert.deepEqual(await db.select().from(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.routeId, id)), snapshots);
  assert.equal((await select(ids[2], before.executionProjection!.selectionRevision!, 1, token, eventId)).status, 200);
  await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, ids[2]));
  const completed = await route(id);
  assert.equal(completed.executionProjection!.activeStopId, null);
  assert.equal((await outgoingStops(completed)).find(stop => stop.status === "pending")!.id, ids[0]);
  assert.equal((await select(ids[2], completed.executionProjection!.selectionRevision!)).status, 409);
});
test("first-stop pin blocks bypass and is fulfilled by terminal status", async () => {
  const { id, ids } = await fixture(true);
  let current = await route(id);
  const blocked = await select(ids[1], current.executionProjection!.selectionRevision!);
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /förstastopp/);
  await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, ids[0]));
  current = await route(id);
  assert.equal((await select(ids[2], current.executionProjection!.selectionRevision!)).status, 201);
});
test("concurrent choices have one winner and another driver cannot choose", async () => {
  const { id, ids } = await fixture();
  const revision = (await route(id)).executionProjection!.selectionRevision!;
  assert.notEqual((await select(ids[2], revision, 1, otherToken)).status, 201);
  const results = await Promise.all([select(ids[1], revision), select(ids[2], revision)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const events = await db.select().from(executionEventsTable).where(eq(executionEventsTable.routeId, id));
  assert.equal(events.length, 1);
});
test("working edits preserve accepted execution, redispatch rejects old requests and clears choice", async () => {
  const { id, ids } = await fixture();
  const revision = (await route(id)).executionProjection!.selectionRevision!;
  await db.update(routesTable).set({ planRevision: 2, executionProjection: null }).where(eq(routesTable.id, id));
  assert.equal((await select(ids[2], revision)).status, 201);
  await db.update(routesTable).set({ handoffVersion: 2, handoffStatus: "sent" }).where(eq(routesTable.id, id));
  await captureSyntheticDispatch(organizationId, [id]);
  assert.ok([403, 409].includes((await select(ids[1], revision)).status));
  const current = await route(id);
  assert.equal(current.executionProjection!.activeStopId, null);
  assert.ok([403, 409].includes((await select(ids[1], current.executionProjection!.selectionRevision!, 2)).status));
});
test("in-progress work, pickup evidence and locked time block unsafe switches", async () => {
  let { id, ids } = await fixture();
  await db.update(stopsTable).set({ status: "in_progress" }).where(eq(stopsTable.id, ids[0]));
  assert.equal((await select(ids[2], (await route(id)).executionProjection!.selectionRevision!)).status, 409);
  ({ id, ids } = await fixture());
  await db.update(stopsTable).set({ jobType: "pickup_delivery" }).where(eq(stopsTable.id, ids[0]));
  await db.update(routesTable).set({ planRevision: 2, handoffVersion: 2 }).where(eq(routesTable.id, id));
  await captureSyntheticDispatch(organizationId, [id]);
  await db.insert(deliveryProofsTable).values({ stopId: ids[0], proofType: "photo", proofStage: "pickup" });
  const blocked = await select(ids[2], (await route(id)).executionProjection!.selectionRevision!, 2);
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /hämtning/);
  await db.delete(deliveryProofsTable).where(eq(deliveryProofsTable.stopId, ids[0]));
  const lockedAt = new Date();
  await db.transaction(async tx => {
    await tx.update(routesTable).set({ workdayTimeline: [{
      type: "service", stopId: ids[1], startAt: lockedAt.toISOString(),
      endAt: new Date(lockedAt.getTime() + 600000).toISOString(), durationMin: 10,
    }] }).where(eq(routesTable.id, id));
    await tx.update(stopsTable).set({ lockedServiceStartAt: lockedAt }).where(eq(stopsTable.id, ids[1]));
  });
  await db.update(routesTable).set({ planRevision: 3, handoffVersion: 3 }).where(eq(routesTable.id, id));
  await captureSyntheticDispatch(organizationId, [id]);
  assert.equal((await select(ids[2], (await route(id)).executionProjection!.selectionRevision!, 3)).status, 409);
});
test("new order must not shift old planned ETAs onto remaining customers", () => {
  const planned = new Date().toISOString();
  const result = projectDriverArrivals({
    plannerItinerary: [{ stopId: "a", sequenceOrder: 1, estimatedArrival: planned } as any,
      { stopId: "b", sequenceOrder: 2, estimatedArrival: planned } as any],
    executionProjection: { selectionChangedAt: planned } as any,
  }, [{ id: "b", status: "pending" }, { id: "a", status: "pending" }], {
    plannedAt: planned, estimatedAt: planned, calculatedAt: planned, positionAt: planned, source: "road",
  });
  assert.equal(result.b.estimatedAt, planned);
  assert.equal(result.a.estimatedAt, null);
});

test("import-like delivery with pickup address blocks selection before pickup and switching after pickup proof", async () => {
  const { id, ids } = await fixture();
  // Imports may retain a pickup address without changing the default job type.
  await db.update(stopsTable).set({ pickupAddress: "Import pickup address" }).where(eq(stopsTable.id, ids[1]));
  await db.update(routesTable).set({ planRevision: 2, handoffVersion: 2 }).where(eq(routesTable.id, id));
  await captureSyntheticDispatch(organizationId, [id]);
  let current = await route(id);
  const imported = (await outgoingStops(current)).find(stop => stop.id === ids[1])!;
  assert.equal(imported.jobType, "delivery");
  assert.equal(imported.status, "pending");
  const beforePickup = await select(ids[1], current.executionProjection!.selectionRevision!, 2);
  assert.equal(beforePickup.status, 409);
  assert.match(await beforePickup.text(), /hämtning före leverans/);

  await db.insert(deliveryProofsTable).values({ stopId: ids[1], proofType: "photo", proofStage: "pickup" });
  try {
    current = await route(id);
    const afterPickup = await select(ids[2], current.executionProjection!.selectionRevision!, 2);
    assert.equal(afterPickup.status, 409);
    assert.match(await afterPickup.text(), /Slutför leveransen/);
    assert.equal((await route(id)).executionProjection!.activeStopId, null);
    assert.equal((await db.select().from(executionEventsTable).where(eq(executionEventsTable.routeId, id))).length, 0);
  } finally {
    await db.delete(deliveryProofsTable).where(eq(deliveryProofsTable.stopId, ids[1]));
  }
});
