import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  executionEventsTable,
  organizationsTable,
  routesTable,
  stopsTable,
  usersTable,
} from "@workspace/db";
import {
  recordExecutionEvent,
  type ExecutionEventInput,
} from "./services/execution-event-service";
import { transitionGeofenceStopStatus } from "./ws";

const organizationId = randomUUID();
const actorUserId = randomUUID();
const executionRouteId = randomUUID();
const executionStopId = randomUUID();
const geofenceRouteId = randomUUID();
const geofenceStopId = randomUUID();

const routeDate = new Date("2026-09-16T00:00:00.000Z");

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Execution first-stop lock tests",
    email: `${organizationId}@execution-first-stop-lock.test`,
  });
  await db.insert(usersTable).values({
    id: actorUserId,
    organizationId,
    name: "Execution first-stop lock actor",
    email: `${actorUserId}@execution-first-stop-lock.test`,
    role: "dispatcher",
  });
  await db.insert(routesTable).values([
    {
      id: executionRouteId,
      organizationId,
      name: "Execution event lock route",
      date: routeDate,
      status: "in_progress",
      planRevision: 12,
      lockedFirstStopId: executionStopId,
      totalStops: 1,
    },
    {
      id: geofenceRouteId,
      organizationId,
      name: "Geofence lock route",
      date: routeDate,
      status: "in_progress",
      planRevision: 22,
      handoffStatus: "accepted",
      handoffVersion: 22,
      lockedFirstStopId: geofenceStopId,
      totalStops: 1,
    },
  ]);
  await db.insert(stopsTable).values([
    {
      id: executionStopId,
      organizationId,
      routeId: executionRouteId,
      address: "Execution event lock stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      sequenceOrder: 1,
    },
    {
      id: geofenceStopId,
      organizationId,
      routeId: geofenceRouteId,
      address: "Geofence lock stop",
      latitude: 59.3393,
      longitude: 18.0786,
      status: "in_progress",
      sequenceOrder: 1,
    },
  ]);
});

after(async () => {
  await db.delete(executionEventsTable).where(eq(executionEventsTable.organizationId, organizationId));
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

test("direct execution event completion clears its pinned first stop without plan mutation", async () => {
  const input: ExecutionEventInput = {
    clientEventId: randomUUID(),
    type: "completed",
    planVersion: 12,
    occurredAt: new Date().toISOString(),
  };
  await recordExecutionEvent({
    organizationId,
    actorUserId,
    driverProfileId: null,
    role: "dispatcher",
    stopId: executionStopId,
    input,
  });

  const [[route], [stop]] = await Promise.all([
    db.select({
      lockedFirstStopId: routesTable.lockedFirstStopId,
      planRevision: routesTable.planRevision,
      handoffStatus: routesTable.handoffStatus,
    }).from(routesTable).where(and(
      eq(routesTable.id, executionRouteId),
      eq(routesTable.organizationId, organizationId),
    )),
    db.select({ status: stopsTable.status }).from(stopsTable).where(
      eq(stopsTable.id, executionStopId),
    ),
  ]);
  assert.equal(stop?.status, "completed");
  assert.equal(route?.lockedFirstStopId, null);
  assert.equal(route?.planRevision, 12);
  assert.equal(route?.handoffStatus, "pending");
});

test("geofence terminal transition clears its pin and leaves accepted plan unchanged", async () => {
  const transitioned = await transitionGeofenceStopStatus({
    organizationId,
    routeId: geofenceRouteId,
    planVersion: 22,
    stopId: geofenceStopId,
    expectedStatus: "in_progress",
    nextStatus: "completed",
  });
  assert.equal(transitioned?.status, "completed");

  const [route] = await db.select({
    lockedFirstStopId: routesTable.lockedFirstStopId,
    planRevision: routesTable.planRevision,
    handoffStatus: routesTable.handoffStatus,
    handoffVersion: routesTable.handoffVersion,
  }).from(routesTable).where(and(
    eq(routesTable.id, geofenceRouteId),
    eq(routesTable.organizationId, organizationId),
  ));
  assert.equal(route?.lockedFirstStopId, null);
  assert.equal(route?.planRevision, 22);
  assert.equal(route?.handoffStatus, "accepted");
  assert.equal(route?.handoffVersion, 22);
});