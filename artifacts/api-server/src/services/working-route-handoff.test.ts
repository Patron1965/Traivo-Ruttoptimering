import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, organizationsTable, vehiclesTable, driversTable, routesTable, routeDispatchSnapshotsTable } from "@workspace/db";
import { invalidatedRoutePlanningState } from "./stop-service";
import { invalidatedRouteHandoff, workingRouteHandoff } from "./route-acknowledgement-service";
import { outgoingRoute } from "./outgoing-route-service";

test("working changes retain version zero and acceptance; cancellation clears and edits never revive it", async () => {
  const organizationId = randomUUID(), vehicleId = randomUUID(), driverId = randomUUID(), routeId = randomUUID();
  try {
    await db.insert(organizationsTable).values({ id: organizationId, name: "Isolated handoff regression", email: `${organizationId}@fixture.invalid` });
    await db.insert(vehiclesTable).values({ id: vehicleId, organizationId, name: "Test", licensePlate: "HANDOFF-TEST" });
    await db.insert(driversTable).values({ id: driverId, organizationId, name: "Test", vehicleId });
    const acceptedAt = new Date("2026-11-04T10:00:00Z");
    const [original] = await db.insert(routesTable).values({
      id: routeId, organizationId, vehicleId, name: "Test working edit", date: acceptedAt,
      status: "in_progress", planRevision: 0, dispatchSnapshotVersion: 0,
      handoffVersion: 0, handoffStatus: "accepted", handoffDriverId: driverId,
      sentAt: acceptedAt, acceptedAt, totalStops: 25,
    }).returning();
    await db.insert(routeDispatchSnapshotsTable).values({
      routeId, organizationId, planRevision: 0, driverId, capturedAt: acceptedAt,
      route: { ...original, __snapshotSchema: 2 }, stops: [],
    });
    const [working] = await db.update(routesTable).set(invalidatedRoutePlanningState(26))
      .where(eq(routesTable.id, routeId)).returning();
    assert.equal(working.planRevision, 1);
    assert.equal(working.totalStops, 26);
    assert.equal(working.handoffVersion, 0);
    assert.equal(working.handoffStatus, "accepted");
    assert.equal(working.handoffDriverId, driverId);
    assert.equal(working.acceptedAt?.toISOString(), acceptedAt.toISOString());
    const outgoing = await outgoingRoute(working);
    assert.equal(outgoing.planRevision, 0);
    assert.equal(outgoing.handoffStatus, "accepted");
    assert.equal(outgoing.totalStops, 25);
    const [cancelled] = await db.update(routesTable).set({ status: "cancelled", ...invalidatedRouteHandoff() })
      .where(eq(routesTable.id, routeId)).returning();
    assert.equal(cancelled.handoffVersion, null);
    const [notRevived] = await db.update(routesTable).set(workingRouteHandoff())
      .where(eq(routesTable.id, routeId)).returning();
    assert.equal(notRevived.handoffVersion, null);
    assert.equal(notRevived.handoffStatus, "pending");
  } finally {
    await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
