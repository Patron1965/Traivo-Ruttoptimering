import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  routeExecutionsTable,
  routesTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import {
  endRouteExecution,
  getRouteExecution,
  RouteExecutionError,
  startRouteExecution,
} from "./route-execution-service";
import { captureSyntheticDispatch, discardSyntheticDispatch } from "../testing/capture-synthetic-dispatch";

test("route execution stays resumable when ending before all stops are terminal", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const userId = randomUUID();
  const routeId = randomUUID();
  const stopIds = [randomUUID(), randomUUID()];
  const startClientEventId = `lifecycle-start-${randomUUID()}`;
  const actor = {
    organizationId,
    actorUserId: userId,
    role: "driver",
    driverProfileId: driverId,
  };
  const startedAt = new Date("2026-09-07T07:00:00.000Z");

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Route execution lifecycle test",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Lifecycle test vehicle",
    licensePlate: `LX-${vehicleId.slice(0, 8)}`,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Lifecycle test driver",
  });
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Lifecycle test user",
    email: `${userId}@example.test`,
    role: "driver",
    driverProfileId: driverId,
  });
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Lifecycle test route",
    date: startedAt,
    status: "optimized",
    planRevision: 4,
    handoffStatus: "accepted",
    handoffVersion: 4,
    handoffDriverId: driverId,
    totalStops: stopIds.length,
  });
  await db.insert(stopsTable).values(stopIds.map((id, index) => ({
    id,
    organizationId,
    routeId,
    address: `Lifecycle test stop ${index + 1}`,
    latitude: 59.3293 + index * 0.001,
    longitude: 18.0686 + index * 0.001,
    sequenceOrder: index,
    status: "pending" as const,
  })));

  await captureSyntheticDispatch(organizationId, [routeId]);
  try {
    const started = await startRouteExecution({
      routeId,
      clientEventId: startClientEventId,
      startedAt: startedAt.toISOString(),
      actor,
    });
    assert.equal(started.duplicate, false);
    assert.equal(started.execution.status, "active");
    assert.equal(started.route.status, "in_progress");

    const [beforeExecution] = await db
      .select()
      .from(routeExecutionsTable)
      .where(eq(routeExecutionsTable.id, started.execution.id));
    const [beforeRoute] = await db
      .select({
        status: routesTable.status,
        planRevision: routesTable.planRevision,
        handoffStatus: routesTable.handoffStatus,
        handoffVersion: routesTable.handoffVersion,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.ok(beforeExecution);
    assert.ok(beforeRoute);

    const prematureEnd = await assert.rejects(
      () => endRouteExecution({
        routeId,
        clientEventId: `lifecycle-premature-end-${randomUUID()}`,
        endedAt: "2026-09-07T09:00:00.000Z",
        actor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError
        && error.statusCode === 409
        && error.code === "ROUTE_STOPS_REMAIN",
    );
    assert.equal(prematureEnd, undefined);

    const [afterPrematureExecution] = await db
      .select()
      .from(routeExecutionsTable)
      .where(eq(routeExecutionsTable.id, started.execution.id));
    const [afterPrematureRoute] = await db
      .select({
        status: routesTable.status,
        planRevision: routesTable.planRevision,
        handoffStatus: routesTable.handoffStatus,
        handoffVersion: routesTable.handoffVersion,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    const afterPrematureStops = await db
      .select({ id: stopsTable.id, status: stopsTable.status })
      .from(stopsTable)
      .where(eq(stopsTable.routeId, routeId));
    assert.deepEqual(afterPrematureExecution, beforeExecution);
    assert.deepEqual(afterPrematureRoute, beforeRoute);
    assert.deepEqual(
      afterPrematureStops.map((stop) => stop.status),
      ["pending", "pending"],
    );

    await db
      .update(stopsTable)
      .set({ status: "completed" })
      .where(eq(stopsTable.id, stopIds[0]));
    const continued = await startRouteExecution({
      routeId,
      clientEventId: startClientEventId,
      startedAt: startedAt.toISOString(),
      actor,
    });
    assert.equal(continued.duplicate, true);
    assert.equal(continued.execution.status, "active");

    const stillPremature = await assert.rejects(
      () => endRouteExecution({
        routeId,
        clientEventId: `lifecycle-still-premature-${randomUUID()}`,
        endedAt: "2026-09-07T10:00:00.000Z",
        actor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError
        && error.statusCode === 409
        && error.code === "ROUTE_STOPS_REMAIN",
    );
    assert.equal(stillPremature, undefined);

    await db
      .update(stopsTable)
      .set({ status: "completed" })
      .where(eq(stopsTable.id, stopIds[1]));
    const finalEnd = await endRouteExecution({
      routeId,
      clientEventId: `lifecycle-final-end-${randomUUID()}`,
      endedAt: "2026-09-07T11:00:00.000Z",
      actor,
    });
    assert.equal(finalEnd.duplicate, false);
    assert.equal(finalEnd.execution.status, "ended");
    assert.deepEqual(finalEnd.execution.summary, {
      totalStops: 2,
      completedStops: 2,
      failedStops: 0,
      skippedStops: 0,
      pendingStops: 0,
      durationMin: 240,
      distanceKm: null,
    });
    const [completedRoute] = await db
      .select({ status: routesTable.status })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(completedRoute?.status, "completed");
  } finally {
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, routeId));
    await discardSyntheticDispatch(organizationId, [routeId]);
    await db.delete(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.delete(routesTable).where(eq(routesTable.id, routeId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(driversTable).where(eq(driversTable.id, driverId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("legacy ended execution with unfinished stops can resume only on its accepted plan", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const userId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  const startClientEventId = `legacy-start-${randomUUID()}`;
  const legacyEndClientEventId = `legacy-end-${randomUUID()}`;
  const actor = {
    organizationId,
    actorUserId: userId,
    role: "driver",
    driverProfileId: driverId,
  };
  const startedAt = new Date("2026-09-08T07:00:00.000Z");
  const endedAt = new Date("2026-09-08T09:00:00.000Z");

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Legacy execution recovery test",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Legacy test vehicle",
    licensePlate: `LG-${vehicleId.slice(0, 8)}`,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Legacy test driver",
  });
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Legacy test user",
    email: `${userId}@example.test`,
    role: "driver",
    driverProfileId: driverId,
  });
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Legacy test route",
    date: startedAt,
    status: "in_progress",
    planRevision: 2,
    handoffStatus: "accepted",
    handoffVersion: 2,
    handoffDriverId: driverId,
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    routeId,
    address: "Legacy unfinished stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    sequenceOrder: 0,
  });
  await db.insert(routeExecutionsTable).values({
    organizationId,
    routeId,
    driverId,
    planVersion: 2,
    status: "ended",
    startedAt,
    endedAt,
    startClientEventId,
    endClientEventId: legacyEndClientEventId,
    startedByUserId: userId,
    endedByUserId: userId,
    summary: {
      totalStops: 1,
      completedStops: 0,
      failedStops: 0,
      skippedStops: 0,
      pendingStops: 1,
      durationMin: 120,
      distanceKm: null,
    },
  });

  try {
    await captureSyntheticDispatch(organizationId, [routeId]);
    const resumed = await startRouteExecution({
      routeId,
      clientEventId: startClientEventId,
      startedAt: startedAt.toISOString(),
      actor,
    });
    assert.equal(resumed.duplicate, false);
    assert.equal(resumed.execution.status, "active");
    assert.equal(resumed.execution.endedAt, null);
    assert.equal(resumed.execution.endClientEventId, legacyEndClientEventId);

    await assert.rejects(
      () => endRouteExecution({
        routeId,
        clientEventId: legacyEndClientEventId,
        endedAt: "2026-09-08T09:30:00.000Z",
        actor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError && error.statusCode === 409,
    );

    await db
      .update(stopsTable)
      .set({ status: "completed" })
      .where(eq(stopsTable.id, stopId));
    const ended = await endRouteExecution({
      routeId,
      clientEventId: `legacy-final-end-${randomUUID()}`,
      endedAt: "2026-09-08T10:00:00.000Z",
      actor,
    });
    assert.equal(ended.execution.status, "ended");
    assert.equal(ended.execution.summary?.pendingStops, 0);
    const [completedRoute] = await db
      .select({ status: routesTable.status })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(completedRoute?.status, "completed");
  } finally {
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, routeId));
    await discardSyntheticDispatch(organizationId, [routeId]);
    await db.delete(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.delete(routesTable).where(eq(routesTable.id, routeId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(driversTable).where(eq(driversTable.id, driverId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("legacy tracking session can resume and finally end with its original clientSessionId", async () => {
  // The route-level endpoint uses one clientSessionId for both lifecycle
  // edges. This guards the compatibility path where the old ended row has
  // that same value in startClientEventId and endClientEventId.
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const userId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  const clientSessionId = `legacy-session-${randomUUID()}`;
  const actor = {
    organizationId,
    actorUserId: userId,
    role: "driver",
    driverProfileId: driverId,
  };
  const startedAt = new Date("2026-09-09T07:00:00.000Z");
  const endedAt = new Date("2026-09-09T09:00:00.000Z");

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Legacy tracking session test",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Legacy tracking vehicle",
    licensePlate: `LT-${vehicleId.slice(0, 8)}`,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Legacy tracking driver",
  });
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Legacy tracking user",
    email: `${userId}@example.test`,
    role: "driver",
    driverProfileId: driverId,
  });
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Legacy tracking route",
    date: startedAt,
    status: "in_progress",
    planRevision: 5,
    handoffStatus: "accepted",
    handoffVersion: 5,
    handoffDriverId: driverId,
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    routeId,
    address: "Legacy tracking stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    sequenceOrder: 0,
  });
  await db.insert(routeExecutionsTable).values({
    organizationId,
    routeId,
    driverId,
    planVersion: 5,
    status: "ended",
    startedAt,
    endedAt,
    startClientEventId: clientSessionId,
    endClientEventId: clientSessionId,
    startedByUserId: userId,
    endedByUserId: userId,
    summary: {
      totalStops: 1,
      completedStops: 0,
      failedStops: 0,
      skippedStops: 0,
      pendingStops: 1,
      durationMin: 120,
      distanceKm: null,
    },
  });

  try {
    await captureSyntheticDispatch(organizationId, [routeId]);
    const started = await startRouteExecution({
      routeId,
      clientEventId: clientSessionId,
      actor,
    });
    assert.equal(started.duplicate, false);
    assert.equal(started.execution.status, "active");
    assert.equal(started.execution.endClientEventId, null);

    await db
      .update(stopsTable)
      .set({ status: "completed" })
      .where(eq(stopsTable.id, stopId));
    const ended = await endRouteExecution({
      routeId,
      clientEventId: clientSessionId,
      actor,
    });
    assert.equal(ended.duplicate, false);
    assert.equal(ended.execution.status, "ended");
    assert.equal(ended.execution.endClientEventId, clientSessionId);
    assert.equal(ended.execution.summary?.pendingStops, 0);
  } finally {
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, routeId));
    await discardSyntheticDispatch(organizationId, [routeId]);
    await db.delete(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.delete(routesTable).where(eq(routesTable.id, routeId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(driversTable).where(eq(driversTable.id, driverId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("execution recipient mismatches are hidden and cannot start or end the current revision", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const currentDriverId = randomUUID();
  const replacementDriverId = randomUUID();
  const currentUserId = randomUUID();
  const replacementUserId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  const startClientEventId = `mismatch-start-${randomUUID()}`;
  const startedAt = new Date("2026-09-10T07:00:00.000Z");
  const actor = {
    organizationId,
    actorUserId: currentUserId,
    role: "driver",
    driverProfileId: currentDriverId,
  };
  const replacementActor = {
    organizationId,
    actorUserId: replacementUserId,
    role: "driver",
    driverProfileId: replacementDriverId,
  };

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Execution mismatch test",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Execution mismatch vehicle",
    licensePlate: `EM-${vehicleId.slice(0, 8)}`,
  });
  await db.insert(driversTable).values([
    {
      id: currentDriverId,
      organizationId,
      vehicleId,
      name: "Current mismatch driver",
    },
    {
      id: replacementDriverId,
      organizationId,
      vehicleId,
      name: "Replacement mismatch driver",
    },
  ]);
  await db.insert(usersTable).values([
    {
      id: currentUserId,
      organizationId,
      name: "Current mismatch user",
      email: `${currentUserId}@example.test`,
      role: "driver",
      driverProfileId: currentDriverId,
    },
    {
      id: replacementUserId,
      organizationId,
      name: "Replacement mismatch user",
      email: `${replacementUserId}@example.test`,
      role: "driver",
      driverProfileId: replacementDriverId,
    },
  ]);
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Execution mismatch route",
    date: startedAt,
    status: "in_progress",
    planRevision: 6,
    handoffStatus: "accepted",
    handoffVersion: 6,
    handoffDriverId: currentDriverId,
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    routeId,
    address: "Execution mismatch stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    sequenceOrder: 0,
  });
  await db.insert(routeExecutionsTable).values({
    organizationId,
    routeId,
    driverId: currentDriverId,
    planVersion: 6,
    status: "active",
    startedAt,
    startClientEventId,
    startedByUserId: currentUserId,
  });

  try {
    await captureSyntheticDispatch(organizationId, [routeId]);
    assert.equal((await getRouteExecution(routeId, organizationId))?.driverId, currentDriverId);

    await db
      .update(routesTable)
      .set({ handoffDriverId: replacementDriverId })
      .where(eq(routesTable.id, routeId));
    assert.equal(await getRouteExecution(routeId, organizationId), null);

    await assert.rejects(
      () => startRouteExecution({
        routeId,
        clientEventId: startClientEventId,
        actor: replacementActor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError
        && error.statusCode === 409
        && !error.message.includes(currentDriverId)
        && !error.message.includes(replacementDriverId),
    );
    await assert.rejects(
      () => endRouteExecution({
        routeId,
        clientEventId: `mismatch-end-${randomUUID()}`,
        actor: replacementActor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError
        && error.statusCode === 409
        && !error.message.includes(currentDriverId)
        && !error.message.includes(replacementDriverId),
    );
    await assert.rejects(
      () => endRouteExecution({
        routeId,
        clientEventId: `old-driver-end-${randomUUID()}`,
        actor,
      }),
      (error: unknown) => error instanceof RouteExecutionError && error.statusCode === 403,
    );
    const [unchangedActive] = await db
      .select({
        status: routeExecutionsTable.status,
        driverId: routeExecutionsTable.driverId,
        endClientEventId: routeExecutionsTable.endClientEventId,
      })
      .from(routeExecutionsTable)
      .where(eq(routeExecutionsTable.routeId, routeId));
    assert.deepEqual(unchangedActive, {
      status: "active",
      driverId: currentDriverId,
      endClientEventId: null,
    });

    await db
      .update(routesTable)
      .set({ handoffDriverId: currentDriverId })
      .where(eq(routesTable.id, routeId));
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, routeId));
    const corruptStartClientEventId = `corrupt-start-${randomUUID()}`;
    const corruptEndClientEventId = `corrupt-end-${randomUUID()}`;
    await db.insert(routeExecutionsTable).values({
      organizationId,
      routeId,
      driverId: replacementDriverId,
      planVersion: 6,
      status: "ended",
      startedAt,
      endedAt: new Date("2026-09-10T09:00:00.000Z"),
      startClientEventId: corruptStartClientEventId,
      endClientEventId: corruptEndClientEventId,
      startedByUserId: replacementUserId,
      endedByUserId: replacementUserId,
      summary: {
        totalStops: 1,
        completedStops: 0,
        failedStops: 0,
        skippedStops: 0,
        pendingStops: 1,
        durationMin: 120,
        distanceKm: null,
      },
    });
    assert.equal(await getRouteExecution(routeId, organizationId), null);
    await assert.rejects(
      () => startRouteExecution({
        routeId,
        clientEventId: corruptStartClientEventId,
        actor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError
        && error.statusCode === 409
        && !error.message.includes(currentDriverId)
        && !error.message.includes(replacementDriverId),
    );
    await assert.rejects(
      () => endRouteExecution({
        routeId,
        clientEventId: corruptEndClientEventId,
        actor,
      }),
      (error: unknown) =>
        error instanceof RouteExecutionError
        && error.statusCode === 409
        && !error.message.includes(currentDriverId)
        && !error.message.includes(replacementDriverId),
    );
    const [unchangedCorrupt] = await db
      .select({
        status: routeExecutionsTable.status,
        driverId: routeExecutionsTable.driverId,
        endClientEventId: routeExecutionsTable.endClientEventId,
      })
      .from(routeExecutionsTable)
      .where(eq(routeExecutionsTable.routeId, routeId));
    assert.deepEqual(unchangedCorrupt, {
      status: "ended",
      driverId: replacementDriverId,
      endClientEventId: corruptEndClientEventId,
    });
  } finally {
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, routeId));
    await discardSyntheticDispatch(organizationId, [routeId]);
    await db.delete(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.delete(routesTable).where(eq(routesTable.id, routeId));
    await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});