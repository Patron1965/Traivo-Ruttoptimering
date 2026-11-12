import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { inArray } from "drizzle-orm";
import {
  db,
  deliveryNotificationsTable,
  geofenceEventsTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import {
  deleteStop,
  deleteRetentionEligibleStops,
  deleteStops,
  getStopRetentionCutoff,
  getTerminalTimestampForStopStatus,
  isRetentionEligibleStopStatus,
  isStopPastRetention,
  StopBulkDeleteNotFoundError,
  StopBulkDeleteConflictError,
} from "./stop-service";

test("only terminal stop statuses are eligible for automatic retention cleanup", () => {
  assert.equal(isRetentionEligibleStopStatus("completed"), true);
  assert.equal(isRetentionEligibleStopStatus("failed"), true);
  assert.equal(isRetentionEligibleStopStatus("skipped"), true);
  assert.equal(isRetentionEligibleStopStatus("pending"), false);
  assert.equal(isRetentionEligibleStopStatus("in_progress"), false);
});

test("retention cutoff is calculated from the selected number of days", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  assert.equal(
    getStopRetentionCutoff(30, now).toISOString(),
    "2026-07-25T12:00:00.000Z",
  );
});

test("retention uses the terminal timestamp instead of the stop creation date", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  assert.equal(
    isStopPastRetention(
      "completed",
      new Date("2026-08-24T11:00:00.000Z"),
      30,
      now,
    ),
    false,
  );
  assert.equal(
    isStopPastRetention(
      "completed",
      new Date("2026-07-24T12:00:00.000Z"),
      30,
      now,
    ),
    true,
  );
  assert.equal(
    isStopPastRetention(
      "pending",
      new Date("2026-07-01T12:00:00.000Z"),
      30,
      now,
    ),
    false,
  );
  assert.equal(isStopPastRetention("completed", null, 30, now), false);
});

test("all status paths use the same terminal timestamp policy", () => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  assert.equal(
    getTerminalTimestampForStopStatus("completed", now)?.toISOString(),
    now.toISOString(),
  );
  assert.equal(
    getTerminalTimestampForStopStatus("failed", now)?.toISOString(),
    now.toISOString(),
  );
  assert.equal(
    getTerminalTimestampForStopStatus("skipped", now)?.toISOString(),
    now.toISOString(),
  );
  assert.equal(getTerminalTimestampForStopStatus("in_progress", now), null);
  assert.equal(getTerminalTimestampForStopStatus("pending", now), null);
});

type StopDeletionFixture = {
  organizationId: string;
  foreignOrganizationId: string;
  vehicleIds: string[];
  routeIds: string[];
  stopIds: {
    single: string;
    bulk: string[];
    foreign: string;
  };
};

async function createStopDeletionFixture(): Promise<StopDeletionFixture> {
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const vehicleIds = [randomUUID(), randomUUID()];
  const routeIds = [randomUUID(), randomUUID()];
  const stopIds = {
    single: randomUUID(),
    bulk: [randomUUID(), randomUUID()],
    foreign: randomUUID(),
  };

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Stop deletion test organization",
      email: `${organizationId}@example.test`,
    },
    {
      id: foreignOrganizationId,
      name: "Foreign stop deletion test organization",
      email: `${foreignOrganizationId}@example.test`,
    },
  ]);
  await db.insert(vehiclesTable).values([
    {
      id: vehicleIds[0],
      organizationId,
      name: "Test vehicle",
      licensePlate: `${vehicleIds[0].slice(0, 8)}`,
    },
    {
      id: vehicleIds[1],
      organizationId: foreignOrganizationId,
      name: "Foreign test vehicle",
      licensePlate: `${vehicleIds[1].slice(0, 8)}`,
    },
  ]);
  await db.insert(routesTable).values([
    {
      id: routeIds[0],
      organizationId,
      vehicleId: vehicleIds[0],
      name: "Test route",
      date: new Date(),
    },
    {
      id: routeIds[1],
      organizationId: foreignOrganizationId,
      vehicleId: vehicleIds[1],
      name: "Foreign test route",
      date: new Date(),
    },
  ]);
  await db.insert(stopsTable).values([
    {
      id: stopIds.single,
      organizationId,
      routeId: routeIds[0],
      address: "Single deletion test stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
    },
    ...stopIds.bulk.map((id, index) => ({
      id,
      organizationId,
      routeId: routeIds[0],
      address: `Bulk deletion test stop ${index + 1}`,
      latitude: 59.33 + index / 1000,
      longitude: 18.07 + index / 1000,
      status: "pending" as const,
    })),
    {
      id: stopIds.foreign,
      organizationId: foreignOrganizationId,
      routeId: routeIds[1],
      address: "Foreign organization test stop",
      latitude: 59.332,
      longitude: 18.072,
      status: "pending",
    },
  ]);

  const stopRows = [
    {
      stopId: stopIds.single,
      organizationId,
      routeId: routeIds[0],
      vehicleId: vehicleIds[0],
      address: "Single deletion test stop",
    },
    ...stopIds.bulk.map((stopId, index) => ({
      stopId,
      organizationId,
      routeId: routeIds[0],
      vehicleId: vehicleIds[0],
      address: `Bulk deletion test stop ${index + 1}`,
    })),
    {
      stopId: stopIds.foreign,
      organizationId: foreignOrganizationId,
      routeId: routeIds[1],
      vehicleId: vehicleIds[1],
      address: "Foreign organization test stop",
    },
  ];
  await db.insert(geofenceEventsTable).values(
    stopRows.map((row) => ({
      organizationId: row.organizationId,
      vehicleId: row.vehicleId,
      stopId: row.stopId,
      routeId: row.routeId,
      eventType: "entered" as const,
      vehicleName: "Test vehicle",
      stopAddress: row.address,
    })),
  );
  await db.insert(deliveryNotificationsTable).values(
    stopRows.map((row) => ({
      stopId: row.stopId,
      routeId: row.routeId,
      type: "delivered" as const,
      channel: "system",
      message: "Test delivery notification",
    })),
  );

  return {
    organizationId,
    foreignOrganizationId,
    vehicleIds,
    routeIds,
    stopIds,
  };
}

async function countStopDependencies(stopIds: string[]) {
  const [geofenceEvents, deliveryNotifications] = await Promise.all([
    db
      .select({ id: geofenceEventsTable.id })
      .from(geofenceEventsTable)
      .where(inArray(geofenceEventsTable.stopId, stopIds)),
    db
      .select({ id: deliveryNotificationsTable.id })
      .from(deliveryNotificationsTable)
      .where(inArray(deliveryNotificationsTable.stopId, stopIds)),
  ]);
  return {
    geofenceEvents: geofenceEvents.length,
    deliveryNotifications: deliveryNotifications.length,
  };
}

async function removeStopDeletionFixture(
  fixture: StopDeletionFixture,
): Promise<void> {
  const allStopIds = [
    fixture.stopIds.single,
    ...fixture.stopIds.bulk,
    fixture.stopIds.foreign,
  ];
  await db
    .delete(deliveryNotificationsTable)
    .where(inArray(deliveryNotificationsTable.stopId, allStopIds));
  await db
    .delete(geofenceEventsTable)
    .where(inArray(geofenceEventsTable.stopId, allStopIds));
  await db.delete(stopsTable).where(inArray(stopsTable.id, allStopIds));
  await db.delete(routesTable).where(inArray(routesTable.id, fixture.routeIds));
  await db
    .delete(vehiclesTable)
    .where(inArray(vehiclesTable.id, fixture.vehicleIds));
  await db
    .delete(organizationsTable)
    .where(
      inArray(organizationsTable.id, [
        fixture.organizationId,
        fixture.foreignOrganizationId,
      ]),
    );
}

test("single and bulk stop deletion removes geofence events and delivery notifications", async () => {
  const fixture = await createStopDeletionFixture();
  const allStopIds = [
    fixture.stopIds.single,
    ...fixture.stopIds.bulk,
    fixture.stopIds.foreign,
  ];

  try {
    const deletedSingle = await deleteStop(
      fixture.stopIds.single,
      fixture.organizationId,
    );
    assert.equal(deletedSingle?.id, fixture.stopIds.single);
    assert.deepEqual(await countStopDependencies([fixture.stopIds.single]), {
      geofenceEvents: 0,
      deliveryNotifications: 0,
    });

    const deletedBulk = await deleteStops(
      fixture.stopIds.bulk,
      fixture.organizationId,
    );
    assert.deepEqual(
      deletedBulk.map((stop) => stop.id).sort(),
      [...fixture.stopIds.bulk].sort(),
    );
    assert.deepEqual(await countStopDependencies(fixture.stopIds.bulk), {
      geofenceEvents: 0,
      deliveryNotifications: 0,
    });

    const remainingStops = await db
      .select({ id: stopsTable.id })
      .from(stopsTable)
      .where(inArray(stopsTable.id, allStopIds));
    assert.deepEqual(
      remainingStops.map((stop) => stop.id),
      [fixture.stopIds.foreign],
    );

    const affectedRouteIds = Array.from(new Set([
      ...(deletedSingle?.routeId ? [deletedSingle.routeId] : []),
      ...deletedBulk.flatMap((stop) => stop.routeId ? [stop.routeId] : []),
    ]));
    const emptiedRoutes = await db
      .select({ status: routesTable.status, totalStops: routesTable.totalStops })
      .from(routesTable)
      .where(inArray(routesTable.id, affectedRouteIds));
    assert.equal(emptiedRoutes.length, affectedRouteIds.length);
    assert.ok(emptiedRoutes.every((route) =>
      route.status === "cancelled" && route.totalStops === 0));
  } finally {
    await removeStopDeletionFixture(fixture);
  }
});

test("mixed pending and completed deletion reports status policy and preserves the entire batch", async () => {
  const fixture = await createStopDeletionFixture();
  const ids = [fixture.stopIds.single, ...fixture.stopIds.bulk];
  try {
    await db.update(stopsTable).set({ status: "completed" })
      .where(inArray(stopsTable.id, [fixture.stopIds.single]));
    const dependencies = await countStopDependencies(ids);
    await assert.rejects(
      () => deleteStops(ids, fixture.organizationId),
      (error: unknown) => error instanceof StopBulkDeleteConflictError
        && error.message === "Only pending stops can be deleted. No stops were deleted.",
    );
    assert.equal((await db.select().from(stopsTable).where(inArray(stopsTable.id, ids))).length, ids.length);
    assert.deepEqual(await countStopDependencies(ids), dependencies);
  } finally {
    await removeStopDeletionFixture(fixture);
  }
});

test("pending deletion that shifts a completed stop reports the sequence policy without deleting", async () => {
  const fixture = await createStopDeletionFixture();
  const ids = [fixture.stopIds.single, ...fixture.stopIds.bulk];
  try {
    await db.update(stopsTable).set({ status: "completed", sequenceOrder: 2 })
      .where(inArray(stopsTable.id, [fixture.stopIds.single]));
    const before = await db.select().from(stopsTable).where(inArray(stopsTable.id, ids)).orderBy(stopsTable.id);
    const dependencies = await countStopDependencies(ids);
    await assert.rejects(
      () => deleteStops(fixture.stopIds.bulk, fixture.organizationId),
      (error: unknown) => error instanceof StopBulkDeleteConflictError
        && error.message === "Deletion would reorder active or terminal stops. No stops were deleted.",
    );
    assert.deepEqual(await db.select().from(stopsTable).where(inArray(stopsTable.id, ids)).orderBy(stopsTable.id), before);
    assert.deepEqual(await countStopDependencies(ids), dependencies);
  } finally {
    await removeStopDeletionFixture(fixture);
  }
});

test("retention deletion rechecks terminal eligibility and removes dependencies atomically", async () => {
  const fixture = await createStopDeletionFixture();
  const ownStopIds = [fixture.stopIds.single, ...fixture.stopIds.bulk];
  const terminalAt = new Date("2026-06-01T00:00:00.000Z");
  const cutoff = new Date("2026-07-01T00:00:00.000Z");

  try {
    await db.update(stopsTable).set({
      status: "completed",
      terminalAt,
    }).where(inArray(stopsTable.id, ownStopIds));

    await assert.rejects(
      () => deleteStops(ownStopIds, fixture.organizationId),
      (error: unknown) => error instanceof StopBulkDeleteConflictError
        && error.message === "Only pending stops can be deleted. No stops were deleted.",
    );

    const deleted = await deleteRetentionEligibleStops(
      ownStopIds,
      fixture.organizationId,
      cutoff,
    );
    assert.deepEqual(
      deleted.map((stop) => stop.id).sort(),
      [...ownStopIds].sort(),
    );
    assert.deepEqual(await countStopDependencies(ownStopIds), {
      geofenceEvents: 0,
      deliveryNotifications: 0,
    });
    const [route] = await db
      .select({ status: routesTable.status, totalStops: routesTable.totalStops })
      .from(routesTable)
      .where(inArray(routesTable.id, [fixture.routeIds[0]]));
    assert.equal(route.status, "cancelled");
    assert.equal(route.totalStops, 0);
  } finally {
    await removeStopDeletionFixture(fixture);
  }
});

test("mixed-organization bulk deletion rolls back stop and dependency deletions", async () => {
  const fixture = await createStopDeletionFixture();
  const requestedStopIds = [fixture.stopIds.bulk[0], fixture.stopIds.foreign];

  try {
    await assert.rejects(
      () => deleteStops(requestedStopIds, fixture.organizationId),
      (error: unknown) => error instanceof StopBulkDeleteNotFoundError,
    );

    const remainingStops = await db
      .select({ id: stopsTable.id, organizationId: stopsTable.organizationId })
      .from(stopsTable)
      .where(inArray(stopsTable.id, requestedStopIds));
    assert.deepEqual(
      remainingStops.map((stop) => [stop.id, stop.organizationId]).sort(),
      [
        [fixture.stopIds.bulk[0], fixture.organizationId],
        [fixture.stopIds.foreign, fixture.foreignOrganizationId],
      ].sort(),
    );
    assert.deepEqual(await countStopDependencies(requestedStopIds), {
      geofenceEvents: requestedStopIds.length,
      deliveryNotifications: requestedStopIds.length,
    });
  } finally {
    await removeStopDeletionFixture(fixture);
  }
});