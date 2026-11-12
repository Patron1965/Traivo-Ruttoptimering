import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  driversTable,
  geofenceEventsTable,
  notificationsTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
  vehiclePositionsTable,
  routeDispatchSnapshotsTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import { setRealPosition } from "../services/real-positions";
import trackingRouter from "./tracking";

function appFor(user: AuthUser): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(trackingRouter);
  return app;
}

async function trackingRequest(user: AuthUser, path: string) {
  const server = appFor(user).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer test-${user.id}` },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function getPositions(user: AuthUser) {
  const response = await trackingRequest(user, "/vehicles/positions");
  if (response.status !== 200) {
    assert.fail(`Unexpected status ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<Array<{
      routeId: string;
      vehicleId: string;
      latitude: number;
      longitude: number;
      speedKmh: number;
      distanceTravelledKm: number;
      isRealGps: boolean;
      nextStopAddress: string | null;
    }>>;
}

test("vehicle positions is a read-only, tenant- and driver-scoped view", async () => {
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const vehicleId = randomUUID();
  const siblingVehicleId = randomUUID();
  const foreignVehicleId = randomUUID();
  const driverProfileId = randomUUID();
  const siblingDriverProfileId = randomUUID();
  const routeId = randomUUID();
  const siblingRouteId = randomUUID();
  const foreignRouteId = randomUUID();
  const stopId = randomUUID();
  const siblingStopId = randomUUID();
  const foreignStopId = randomUUID();
  const adminUserId = randomUUID();
  const driverUserId = randomUUID();
  const foreignAdminUserId = randomUUID();
  const viewerUserId = randomUUID();
  const routeIds = [routeId, siblingRouteId, foreignRouteId];
  const stopIds = [stopId, siblingStopId, foreignStopId];
  const organizationIds = [organizationId, foreignOrganizationId];

  const admin: AuthUser = {
    id: adminUserId,
    name: "Tracking admin",
    email: `${adminUserId}@tracking.test`,
    role: "admin",
    organizationId,
    driverProfileId: null,
  };
  const driver: AuthUser = {
    id: driverUserId,
    name: "Tracking driver",
    email: `${driverUserId}@tracking.test`,
    role: "driver",
    organizationId,
    driverProfileId,
  };
  const foreignAdmin: AuthUser = {
    id: foreignAdminUserId,
    name: "Foreign tracking admin",
    email: `${foreignAdminUserId}@tracking.test`,
    role: "admin",
    organizationId: foreignOrganizationId,
    driverProfileId: null,
  };
  const viewer: AuthUser = {
    id: viewerUserId,
    name: "Tracking viewer",
    email: `${viewerUserId}@tracking.test`,
    role: "viewer",
    organizationId,
    driverProfileId: null,
  };

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: `Tracking read-only ${organizationId}`,
      email: `${organizationId}@tracking.test`,
    },
    {
      id: foreignOrganizationId,
      name: `Tracking foreign ${foreignOrganizationId}`,
      email: `${foreignOrganizationId}@tracking.test`,
    },
  ]);

  try {
    await db.insert(vehiclesTable).values([
      {
        id: vehicleId,
        organizationId,
        name: "Tracking vehicle",
        licensePlate: `TR-${vehicleId.slice(0, 8)}`,
      },
      {
        id: siblingVehicleId,
        organizationId,
        name: "Tracking sibling vehicle",
        licensePlate: `TR-${siblingVehicleId.slice(0, 8)}`,
      },
      {
        id: foreignVehicleId,
        organizationId: foreignOrganizationId,
        name: "Tracking foreign vehicle",
        licensePlate: `TR-${foreignVehicleId.slice(0, 8)}`,
      },
    ]);
    await db.insert(driversTable).values([
      {
        id: driverProfileId,
        organizationId,
        vehicleId,
        name: "Tracking driver",
      },
      {
        id: siblingDriverProfileId,
        organizationId,
        vehicleId: siblingVehicleId,
        name: "Tracking sibling driver",
      },
    ]);
    await db.insert(routesTable).values([
      {
        id: routeId,
        organizationId,
        vehicleId,
        name: "Protected optimized route",
        status: "optimized",
        planRevision: 4,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: driverProfileId,
        date: new Date(),
      },
      {
        id: siblingRouteId,
        organizationId,
        vehicleId: siblingVehicleId,
        name: "Sibling optimized route",
        status: "optimized",
        planRevision: 2,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: siblingDriverProfileId,
        date: new Date(),
      },
      {
        id: foreignRouteId,
        organizationId: foreignOrganizationId,
        vehicleId: foreignVehicleId,
        name: "Foreign optimized route",
        status: "optimized",
        planRevision: 1,
        handoffStatus: "pending",
        handoffVersion: null,
        date: new Date(),
      },
    ]);
    await db.insert(stopsTable).values([
      {
        id: stopId,
        organizationId,
        routeId,
        sequenceOrder: 1,
        address: "Protected tracking stop",
        latitude: 59.3293,
        longitude: 18.0686,
        status: "pending",
      },
      {
        id: siblingStopId,
        organizationId,
        routeId: siblingRouteId,
        sequenceOrder: 1,
        address: "Sibling tracking stop",
        latitude: 59.5,
        longitude: 18.3,
        status: "pending",
      },
      {
        id: foreignStopId,
        organizationId: foreignOrganizationId,
        routeId: foreignRouteId,
        sequenceOrder: 1,
        address: "Foreign tracking stop",
        latitude: 59.7,
        longitude: 18.5,
        status: "pending",
      },
    ]);

    // This is an actual execution telemetry sample at the protected stop. The
    // old GET implementation treated it as a geofence transition even though
    // the optimized plan was still unaccepted.
    setRealPosition(vehicleId, {
      latitude: 59.3293,
      longitude: 18.0686,
      heading: 0,
      speedKmh: 0,
      timestamp: Date.now(),
    });

    const [beforeRoute] = await db
      .select({
        status: routesTable.status,
        handoffStatus: routesTable.handoffStatus,
        handoffVersion: routesTable.handoffVersion,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    const [beforeStop] = await db
      .select({ status: stopsTable.status, terminalAt: stopsTable.terminalAt })
      .from(stopsTable)
      .where(eq(stopsTable.id, stopId));
    const beforeGeofenceCount = (await db
      .select({ id: geofenceEventsTable.id })
      .from(geofenceEventsTable)
      .where(eq(geofenceEventsTable.organizationId, organizationId))).length;
    const beforeNotificationCount = (await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(eq(notificationsTable.organizationId, organizationId))).length;

    const adminPositions = await getPositions(admin);
    assert.deepEqual(
      adminPositions.map((position) => position.routeId).sort(),
      [routeId, siblingRouteId].sort(),
    );
    const actualPosition = adminPositions.find((position) => position.routeId === routeId);
    assert.ok(actualPosition);
    assert.equal(actualPosition.routeId, routeId);
    assert.equal(actualPosition.vehicleId, vehicleId);
    assert.equal(actualPosition.latitude, 59.3293);
    assert.equal(actualPosition.longitude, 18.0686);
    assert.equal(actualPosition.speedKmh, 0);
    assert.equal(actualPosition.distanceTravelledKm, 0);
    assert.equal(actualPosition.isRealGps, true);
    const plannedPosition = adminPositions.find((position) => position.routeId === siblingRouteId);
    assert.ok(plannedPosition);
    assert.equal(plannedPosition.isRealGps, false);
    assert.equal(plannedPosition.speedKmh, 0);
    assert.equal(plannedPosition.distanceTravelledKm, 0);

    const driverPositions = await getPositions(driver);
    assert.deepEqual(driverPositions, []);
    const viewerPositions = await getPositions(viewer);
    assert.equal(viewerPositions.every((position) => position.nextStopAddress === null), true);

    const foreignPositions = await getPositions(foreignAdmin);
    assert.deepEqual(foreignPositions.map((position) => position.routeId), [foreignRouteId]);

    const [afterRoute] = await db
      .select({
        status: routesTable.status,
        handoffStatus: routesTable.handoffStatus,
        handoffVersion: routesTable.handoffVersion,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    const [afterStop] = await db
      .select({ status: stopsTable.status, terminalAt: stopsTable.terminalAt })
      .from(stopsTable)
      .where(eq(stopsTable.id, stopId));
    const afterGeofenceCount = (await db
      .select({ id: geofenceEventsTable.id })
      .from(geofenceEventsTable)
      .where(eq(geofenceEventsTable.organizationId, organizationId))).length;
    const afterNotificationCount = (await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(eq(notificationsTable.organizationId, organizationId))).length;

    assert.deepEqual(afterRoute, beforeRoute);
    assert.deepEqual(afterStop, beforeStop);
    assert.equal(afterGeofenceCount, beforeGeofenceCount);
    assert.equal(afterNotificationCount, beforeNotificationCount);
  } finally {
    await db.delete(notificationsTable).where(inArray(notificationsTable.organizationId, organizationIds));
    await db.delete(geofenceEventsTable).where(inArray(geofenceEventsTable.organizationId, organizationIds));
    await db.delete(stopsTable).where(inArray(stopsTable.id, stopIds));
    await db.delete(routesTable).where(inArray(routesTable.id, routeIds));
    await db.delete(driversTable).where(inArray(driversTable.id, [driverProfileId, siblingDriverProfileId]));
    await db.delete(vehiclesTable).where(inArray(vehiclesTable.id, [vehicleId, siblingVehicleId, foreignVehicleId]));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  }
});

test("driver tracking scope requires exact accepted handoff on a shared vehicle", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverOneId = randomUUID();
  const driverTwoId = randomUUID();
  const vehiclePositionRouteId = randomUUID();
  const otherAcceptedRouteId = randomUUID();
  const selectedOtherDraftRouteId = randomUUID();
  const nullHandoffDraftRouteId = randomUUID();
  const stopIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const routeIds = [
    vehiclePositionRouteId,
    otherAcceptedRouteId,
    selectedOtherDraftRouteId,
    nullHandoffDraftRouteId,
  ];
  const userOne: AuthUser = {
    id: randomUUID(),
    name: "Shared vehicle driver one",
    email: `${randomUUID()}@tracking.test`,
    role: "driver",
    organizationId,
    driverProfileId: driverOneId,
  };
  const userTwo: AuthUser = {
    id: randomUUID(),
    name: "Shared vehicle driver two",
    email: `${randomUUID()}@tracking.test`,
    role: "driver",
    organizationId,
    driverProfileId: driverTwoId,
  };
  const admin: AuthUser = {
    id: randomUUID(),
    name: "Shared vehicle admin",
    email: `${randomUUID()}@tracking.test`,
    role: "admin",
    organizationId,
    driverProfileId: null,
  };

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: `Shared tracking ${organizationId}`,
    email: `${organizationId}@tracking.test`,
  });

  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Shared tracking vehicle",
      licensePlate: `SH-${vehicleId.slice(0, 8)}`,
    });
    await db.insert(driversTable).values([
      {
        id: driverOneId,
        organizationId,
        vehicleId,
        name: "Shared driver one",
      },
      {
        id: driverTwoId,
        organizationId,
        vehicleId,
        name: "Shared driver two",
      },
    ]);
    await db.insert(routesTable).values([
      {
        id: vehiclePositionRouteId,
        organizationId,
        vehicleId,
        name: "Shared accepted route one",
        status: "in_progress",
        planRevision: 10,
        handoffStatus: "accepted",
        handoffVersion: 10,
        handoffDriverId: driverOneId,
        date: new Date(),
      },
      {
        id: otherAcceptedRouteId,
        organizationId,
        vehicleId,
        name: "Shared accepted route two",
        status: "in_progress",
        planRevision: 11,
        handoffStatus: "accepted",
        handoffVersion: 11,
        handoffDriverId: driverTwoId,
        date: new Date(),
      },
      {
        id: selectedOtherDraftRouteId,
        organizationId,
        vehicleId,
        name: "Shared selected-other predispatch",
        status: "optimized",
        planRevision: 12,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: driverTwoId,
        date: new Date(),
      },
      {
        id: nullHandoffDraftRouteId,
        organizationId,
        vehicleId,
        name: "Shared null-handoff predispatch",
        status: "optimized",
        planRevision: 13,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        date: new Date(),
      },
    ]);
    await db.insert(stopsTable).values(routeIds.map((routeId, index) => ({
      id: stopIds[index],
      organizationId,
      routeId,
      sequenceOrder: 1,
      address: `Shared tracking stop ${index + 1}`,
      latitude: 59.4 + index / 100,
      longitude: 18.1 + index / 100,
      status: "pending" as const,
    })));
    await db.insert(geofenceEventsTable).values(routeIds.map((routeId, index) => ({
      organizationId,
      vehicleId,
      stopId: stopIds[index],
      routeId,
      eventType: "entered" as const,
      vehicleName: "Shared tracking vehicle",
      stopAddress: `Shared event address ${index + 1}`,
    })));
    await db.insert(vehiclePositionsTable).values({
      organizationId,
      vehicleId,
      routeId: vehiclePositionRouteId,
      latitude: 59.31,
      longitude: 18.01,
      source: "shared-tracking-test",
    });
    setRealPosition(vehicleId, {
      latitude: 59.31,
      longitude: 18.01,
      heading: 90,
      speedKmh: 25,
      timestamp: Date.now(),
    });

    // Accepted routes require immutable dispatch evidence, not just working rows.
    const fixtureRoutes = await db.select().from(routesTable).where(inArray(routesTable.id, routeIds));
    for (const route of fixtureRoutes) {
      if (route.handoffVersion == null || !route.handoffDriverId) continue;
      await db.update(routesTable).set({ dispatchSnapshotVersion: route.handoffVersion }).where(eq(routesTable.id, route.id));
      const snapshotStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, route.id));
      await db.insert(routeDispatchSnapshotsTable).values({
        routeId: route.id, organizationId, planRevision: route.handoffVersion,
        driverId: route.handoffDriverId, capturedAt: new Date(),
        route: { ...route, dispatchSnapshotVersion: route.handoffVersion, __snapshotSchema: 2 },
        stops: snapshotStops,
      });
    }
    const driverOnePositions = await getPositions(userOne);
    const driverTwoPositions = await getPositions(userTwo);
    assert.deepEqual(driverOnePositions.map((position) => position.routeId), [vehiclePositionRouteId]);
    assert.deepEqual(driverTwoPositions.map((position) => position.routeId), [otherAcceptedRouteId]);
    const driverOneEvents = await trackingRequest(userOne, "/geofence/events");
    assert.equal(driverOneEvents.status, 200);
    const driverOneEventRows = await driverOneEvents.json() as Array<{
      routeId: string;
      stopAddress: string;
    }>;
    assert.deepEqual(driverOneEventRows.map((event) => event.routeId), [vehiclePositionRouteId]);
    assert.equal(driverOneEventRows[0].stopAddress, "Shared event address 1");

    const ownVehicleHistory = await trackingRequest(admin, `/tracking/history/vehicle/${vehicleId}`);
    assert.equal(ownVehicleHistory.status, 200);
    assert.equal((await ownVehicleHistory.json() as unknown[]).length, 1);
    const ownRouteHistory = await trackingRequest(admin, `/tracking/history/route/${vehiclePositionRouteId}`);
    assert.equal(ownRouteHistory.status, 200);
    assert.equal((await ownRouteHistory.json() as unknown[]).length, 1);

    const driverVehicleHistory = await trackingRequest(
      userOne,
      `/tracking/history/vehicle/${vehicleId}`,
    );
    assert.equal(driverVehicleHistory.status, 403);
    const driverOtherRouteHistory = await trackingRequest(
      userOne,
      `/tracking/history/route/${otherAcceptedRouteId}`,
    );
    assert.equal(driverOtherRouteHistory.status, 403);

    // Once both execution routes are back in predispatch state, the driver
    // still cannot fall back to selected-other or null-handoff plan markers.
    await db.update(routesTable).set({
      status: "optimized",
      handoffStatus: "pending",
      handoffVersion: null,
    }).where(inArray(routesTable.id, [vehiclePositionRouteId, otherAcceptedRouteId]));
    const predispatchPositions = await getPositions(userOne);
    assert.deepEqual(predispatchPositions, []);
  } finally {
    await db.delete(vehiclePositionsTable).where(eq(vehiclePositionsTable.vehicleId, vehicleId));
    await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, organizationId));
    await db.delete(geofenceEventsTable).where(eq(geofenceEventsTable.vehicleId, vehicleId));
    await db.delete(stopsTable).where(inArray(stopsTable.id, stopIds));
    await db.delete(routesTable).where(inArray(routesTable.id, routeIds));
    await db.delete(driversTable).where(inArray(driversTable.id, [driverOneId, driverTwoId]));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});