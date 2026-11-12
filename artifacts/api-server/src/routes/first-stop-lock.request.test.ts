import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { after, before, test } from "node:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import routesRouter from "./routes";
import optimizeRouter from "./optimize";
import {
  archiveStops,
  moveStopsForDispatch,
  updateStop,
  type DispatchMoveIneligibleCode,
} from "../services/stop-service";
import {
  adjustAssignedRoutes,
  ImportRouteWorkflowError,
  previewRouteScopedReoptimization,
  reorderAssignedRouteStops,
} from "../services/import-route-workflow";
import * as routeService from "../services/route-service";

const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const planId = randomUUID();
const routeId = randomUUID();
const foreignRouteId = randomUUID();
const vehicleId = randomUUID();
const alternateVehicleId = randomUUID();
const foreignVehicleId = randomUUID();
const driverId = randomUUID();
const firstStopId = randomUUID();
const secondStopId = randomUUID();
const thirdStopId = randomUUID();
const foreignStopId = randomUUID();

const depotSnapshot = {
  start: {
    address: "Lock test depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
  end: {
    address: "Lock test depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
};

const planningSnapshot = {
  version: 1 as const,
  objective: "geographic" as const,
  travelReservePercent: 0,
  stopReserveMin: 0,
  stopPriorities: {},
  excludedPairValues: [],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs" as const,
};

type ApiResult = {
  status: number;
  body: any;
};

function testUser(orgId: string): AuthUser {
  return {
    id: randomUUID(),
    name: "First-stop lock test",
    email: `${randomUUID()}@first-stop-lock.test`,
    role: "dispatcher",
    organizationId: orgId,
    driverProfileId: null,
  };
}

function appFor(orgId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = testUser(orgId);
    next();
  });
  app.use("/api", routesRouter);
  app.use("/api", optimizeRouter);
  return app;
}

async function startApp(orgId: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = appFor(orgId).listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(
  baseUrl: string,
  path: string,
  method: "PUT" | "POST",
  body: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "First-stop lock request tests",
      email: `${organizationId}@first-stop-lock.test`,
    },
    {
      id: foreignOrganizationId,
      name: "Foreign first-stop lock request tests",
      email: `${foreignOrganizationId}@first-stop-lock.test`,
    },
  ]);
  await db.insert(vehiclesTable).values([
    {
      id: vehicleId,
      organizationId,
      name: "Lock vehicle",
      licensePlate: `LOCK-${vehicleId.slice(0, 6)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    },
    {
      id: alternateVehicleId,
      organizationId,
      name: "Alternate lock vehicle",
      licensePlate: `ALT-${alternateVehicleId.slice(0, 6)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    },
    {
      id: foreignVehicleId,
      organizationId: foreignOrganizationId,
      name: "Foreign lock vehicle",
      licensePlate: `FOREIGN-${foreignVehicleId.slice(0, 6)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    },
  ]);
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Lock driver",
    isActive: true,
    workStartTime: "07:00:00",
    workEndTime: "18:00:00",
    startLatitude: 59.3293,
    startLongitude: 18.0686,
  });
  await db.insert(routesTable).values([
    {
      id: routeId,
      planId,
      organizationId,
      vehicleId,
      name: "Lock route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      status: "optimized",
      planRevision: 4,
      totalStops: 3,
      depotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
    },
    {
      id: foreignRouteId,
      planId: randomUUID(),
      organizationId: foreignOrganizationId,
      vehicleId: foreignVehicleId,
      name: "Foreign lock route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      status: "optimized",
      totalStops: 1,
      depotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
    },
  ]);
  await db.insert(stopsTable).values([
    firstStopId,
    secondStopId,
    thirdStopId,
  ].map((id, index) => ({
    id,
    organizationId,
    routeId,
    address: `Lock stop ${index + 1}`,
    latitude: 59.33 + index * 0.005,
    longitude: 18.07 + index * 0.005,
    status: "pending" as const,
    sequenceOrder: index + 1,
    serviceDurationMin: 5,
    planningPlanId: planId,
  })));
  await db.insert(stopsTable).values({
    id: foreignStopId,
    organizationId: foreignOrganizationId,
    routeId: foreignRouteId,
    address: "Foreign lock stop",
    latitude: 59.4,
    longitude: 18.2,
    status: "pending",
    sequenceOrder: 1,
  });
});

after(async () => {
  await db.delete(stopsTable).where(
    inArray(stopsTable.organizationId, [organizationId, foreignOrganizationId]),
  );
  await db.delete(routesTable).where(
    inArray(routesTable.organizationId, [organizationId, foreignOrganizationId]),
  );
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(
    inArray(vehiclesTable.organizationId, [organizationId, foreignOrganizationId]),
  );
  await db.delete(organizationsTable).where(
    inArray(organizationsTable.id, [organizationId, foreignOrganizationId]),
  );
});

test("locks the chosen second stop first, persists the schedule, and rejects stale CAS", async () => {
  const server = await startApp(organizationId);
  try {
    const locked = await request(
      server.url,
      `/api/routes/${routeId}/locked-first-stop`,
      "PUT",
      { stopId: secondStopId, planRevision: 4 },
    );
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.lockedFirstStopId, secondStopId);
    assert.equal(locked.body.planRevision, 5);
    assert.ok(Array.isArray(locked.body.workdayTimeline));
    assert.notEqual(locked.body.totalDistanceKm, null);

    const savedStops = await db
      .select({ id: stopsTable.id, sequenceOrder: stopsTable.sequenceOrder })
      .from(stopsTable)
      .where(eq(stopsTable.routeId, routeId))
      .orderBy(stopsTable.sequenceOrder);
    assert.deepEqual(savedStops.map((stop) => stop.id), [
      secondStopId,
      firstStopId,
      thirdStopId,
    ]);

    const stale = await request(
      server.url,
      `/api/routes/${routeId}/locked-first-stop`,
      "PUT",
      { stopId: firstStopId, planRevision: 4 },
    );
    assert.equal(stale.status, 409);
    assert.match(String(stale.body?.error), /ändrades|ladda|låst/i);
  } finally {
    await server.close();
  }
});

test("rejects foreign route and stop identifiers, direct vehicle/status mutations, and then unlocks", async () => {
  const server = await startApp(organizationId);
  try {
    const foreignRoute = await request(
      server.url,
      `/api/routes/${foreignRouteId}/locked-first-stop`,
      "PUT",
      { stopId: null, planRevision: 0 },
    );
    assert.equal(foreignRoute.status, 404);

    const foreignStop = await request(
      server.url,
      `/api/routes/${routeId}/locked-first-stop`,
      "PUT",
      { stopId: foreignStopId, planRevision: 5 },
    );
    assert.equal(foreignStop.status, 409);
    assert.match(String(foreignStop.body?.error), /samma rutt|väntande/i);

    await assert.rejects(
      routeService.updateRoute(
        routeId,
        organizationId,
        { status: "in_progress" },
        {},
        5,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("låst första kundstopp"),
    );
    await assert.rejects(
      routeService.updateRoute(
        routeId,
        organizationId,
        { vehicleId: alternateVehicleId },
        {},
        5,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("Planning fields"),
    );

    const unlocked = await request(
      server.url,
      `/api/routes/${routeId}/locked-first-stop`,
      "PUT",
      { stopId: null, planRevision: 5 },
    );
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
    assert.equal(unlocked.body.lockedFirstStopId, null);
    assert.equal(unlocked.body.planRevision, 6);
  } finally {
    await server.close();
  }
});

test("rejects an infeasible lock transactionally without changing order or revision", async () => {
  await db.update(stopsTable)
    .set({
      timeWindowStart: new Date("2026-08-25T00:00:00.000Z"),
      timeWindowEnd: new Date("2026-08-25T00:01:00.000Z"),
    })
    .where(eq(stopsTable.id, secondStopId));

  const server = await startApp(organizationId);
  try {
    const rejected = await request(
      server.url,
      `/api/routes/${routeId}/locked-first-stop`,
      "PUT",
      { stopId: secondStopId, planRevision: 6 },
    );
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.match(String(rejected.body?.error), /tid|rutt|stopp|övertid/i);
  } finally {
    await server.close();
  }

  const [route] = await db
    .select({ lockedFirstStopId: routesTable.lockedFirstStopId, planRevision: routesTable.planRevision })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  assert.equal(route.lockedFirstStopId, null);
  assert.equal(route.planRevision, 6);
  const unchanged = await db
    .select({ id: stopsTable.id, sequenceOrder: stopsTable.sequenceOrder })
    .from(stopsTable)
    .where(eq(stopsTable.routeId, routeId))
    .orderBy(stopsTable.sequenceOrder);
  assert.deepEqual(unchanged.map((stop) => stop.id), [
    secondStopId,
    firstStopId,
    thirdStopId,
  ]);
  await db.update(stopsTable).set({
    timeWindowStart: null,
    timeWindowEnd: null,
  }).where(eq(stopsTable.id, secondStopId));
});

test("dispatch move and import adjustment cannot reorder away from a pinned first stop", async () => {
  await db.update(routesTable)
    .set({ lockedFirstStopId: secondStopId })
    .where(eq(routesTable.id, routeId));

  const move = await moveStopsForDispatch(organizationId, {
    stopIds: [thirdStopId],
    routeId,
    targetIndex: 0,
    routeRevisions: [{ routeId, planRevision: 6 }],
  });
  assert.equal(move.kind, "ineligible");
  assert.equal(move.code as DispatchMoveIneligibleCode, "LOCKED_FIRST_STOP_CONFLICT");

  await assert.rejects(
    adjustAssignedRoutes(organizationId, {
      planId,
      depotLatitude: depotSnapshot.start.latitude,
      depotLongitude: depotSnapshot.start.longitude,
      routes: [{
        routeId,
        driverId,
        planRevision: 6,
        stopIds: [firstStopId, thirdStopId, secondStopId],
      }],
    }),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError &&
      error.statusCode === 409 &&
      error.message.includes("låst"),
  );

  const saved = await db
    .select({ id: stopsTable.id, sequenceOrder: stopsTable.sequenceOrder })
    .from(stopsTable)
    .where(eq(stopsTable.routeId, routeId))
    .orderBy(stopsTable.sequenceOrder);
  assert.deepEqual(saved.map((stop) => stop.id), [
    secondStopId,
    firstStopId,
    thirdStopId,
  ]);

  const server = await startApp(organizationId);
  try {
    const continuous = await request(
      server.url,
      "/api/optimize/continuous/start",
      "POST",
      {
        organizationId,
        routeIds: [routeId],
        depotLatitude: depotSnapshot.start.latitude,
        depotLongitude: depotSnapshot.start.longitude,
      },
    );
    assert.equal(continuous.status, 409);
    assert.match(String(continuous.body?.error), /låst första kundstopp/i);
  } finally {
    await server.close();
  }
});

test("archive of a nonlocked customer cannot resurrect it or remove the pin", async () => {
  const archived = await archiveStops(
    [thirdStopId],
    organizationId,
    { userId: randomUUID(), userEmail: "archive-test@example.test" },
  );
  assert.deepEqual(archived.archivedStopIds, [thirdStopId]);
  const [route] = await db
    .select({ lockedFirstStopId: routesTable.lockedFirstStopId })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  assert.equal(route.lockedFirstStopId, secondStopId);
  const [stop] = await db
    .select({ archivedAt: stopsTable.archivedAt, routeId: stopsTable.routeId })
    .from(stopsTable)
    .where(eq(stopsTable.id, thirdStopId));
  assert.ok(stop.archivedAt);
  assert.equal(stop.routeId, routeId);
  const activeStops = await db
    .select({ id: stopsTable.id })
    .from(stopsTable)
    .where(and(eq(stopsTable.routeId, routeId), isNull(stopsTable.archivedAt)))
    .orderBy(stopsTable.sequenceOrder);
  assert.deepEqual(activeStops.map((stop) => stop.id), [secondStopId, firstStopId]);
});

test("dispatch keeps the pin through start, then clears it on first-job completion before reroute", async () => {
  await db.update(routesTable)
    .set({ manualReviewedAt: new Date() })
    .where(eq(routesTable.id, routeId));
  const server = await startApp(organizationId);
  try {
    const dispatched = await request(
      server.url,
      `/api/routes/${routeId}/dispatch`,
      "POST",
      { driverId },
    );
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
  } finally {
    await server.close();
  }
  let [route] = await db
    .select({ lockedFirstStopId: routesTable.lockedFirstStopId, status: routesTable.status, planRevision: routesTable.planRevision })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  assert.equal(route.status, "in_progress");
  assert.equal(route.lockedFirstStopId, secondStopId);

  await updateStop(secondStopId, organizationId, { status: "completed" });
  [route] = await db
    .select({
      lockedFirstStopId: routesTable.lockedFirstStopId,
      status: routesTable.status,
      planRevision: routesTable.planRevision,
    })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  assert.equal(route.lockedFirstStopId, null);
  assert.equal(route.planRevision, 7);

  const rerouted = await reorderAssignedRouteStops(
    organizationId,
    routeId,
    [secondStopId, firstStopId],
    route.planRevision,
  );
  assert.equal(rerouted.error, undefined, JSON.stringify(rerouted));
  const [completed] = await db
    .select({ status: stopsTable.status, sequenceOrder: stopsTable.sequenceOrder })
    .from(stopsTable)
    .where(eq(stopsTable.id, secondStopId));
  assert.equal(completed.status, "completed");
  assert.equal(completed.sequenceOrder, 1);
});

test("route reroute treats a terminal legacy pin as fulfilled and excludes it from pending work", async () => {
  await db.update(routesTable)
    .set({ lockedFirstStopId: secondStopId })
    .where(eq(routesTable.id, routeId));
  const [route] = await db
    .select({ planRevision: routesTable.planRevision })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  const preview = await previewRouteScopedReoptimization(
    organizationId,
    routeId,
    {
      planRevision: route.planRevision,
      depotLatitude: depotSnapshot.start.latitude,
      depotLongitude: depotSnapshot.start.longitude,
    },
  );
  assert.deepEqual(
    preview.pendingStopIds,
    [firstStopId],
  );
  assert.deepEqual(preview.lockedStopIds, [secondStopId]);
  await db.update(routesTable)
    .set({ lockedFirstStopId: null })
    .where(eq(routesTable.id, routeId));
});

test("archiving from an active pinned route cancels and detaches pending work atomically", async () => {
  const dynamicRouteId = randomUUID();
  const dynamicFirstId = randomUUID();
  const dynamicSecondId = randomUUID();
  await db.insert(routesTable).values({
    id: dynamicRouteId,
    planId: randomUUID(),
    organizationId,
    vehicleId,
    name: "Archive cancellation lock route",
    date: new Date("2026-08-26T00:00:00.000Z"),
    status: "optimized",
    planRevision: 1,
    totalStops: 2,
    depotSnapshot,
    optimizationPlanningSnapshot: planningSnapshot,
  });
  await db.insert(stopsTable).values([
    { id: dynamicFirstId, organizationId, routeId: dynamicRouteId, address: "Dynamic first", latitude: 59.33, longitude: 18.07, status: "pending", sequenceOrder: 1 },
    { id: dynamicSecondId, organizationId, routeId: dynamicRouteId, address: "Dynamic second", latitude: 59.34, longitude: 18.08, status: "pending", sequenceOrder: 2 },
  ]);
  await routeService.setLockedFirstStop(dynamicRouteId, organizationId, dynamicFirstId, 1);
  await db.update(routesTable).set({ status: "in_progress" }).where(eq(routesTable.id, dynamicRouteId));
  await archiveStops(
    [dynamicSecondId],
    organizationId,
    { userId: randomUUID(), userEmail: "archive-cancel-test@example.test" },
    true,
  );
  const [cancelled] = await db
    .select({ status: routesTable.status, lockedFirstStopId: routesTable.lockedFirstStopId })
    .from(routesTable)
    .where(eq(routesTable.id, dynamicRouteId));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.lockedFirstStopId, null);
  const [detached] = await db
    .select({ routeId: stopsTable.routeId, status: stopsTable.status })
    .from(stopsTable)
    .where(eq(stopsTable.id, dynamicFirstId));
  assert.equal(detached.routeId, null);
  assert.equal(detached.status, "pending");
});

test("locking an electric route preserves policy and inserts a feasible charger itinerary", async () => {
  const dynamicOrganizationId = randomUUID();
  const dynamicVehicleId = randomUUID();
  const dynamicDriverId = randomUUID();
  const dynamicRouteId = randomUUID();
  const dynamicStopIds = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(organizationsTable).values({
    id: dynamicOrganizationId,
    name: "Electric lock policy test",
    email: `${dynamicOrganizationId}@first-stop-lock.test`,
    maxDriverOvertimeMin: 45,
    allowLateStopsMin: 7,
  });
  await db.insert(vehiclesTable).values({
    id: dynamicVehicleId,
    organizationId: dynamicOrganizationId,
    name: "Electric lock vehicle",
    licensePlate: `EV-${dynamicVehicleId.slice(0, 6)}`,
    vehicleType: "electric",
    rangeKm: 30,
    currentBatteryPercent: 100,
    capacityKg: 1_000,
    capacityVolume: 10,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: dynamicDriverId,
    organizationId: dynamicOrganizationId,
    vehicleId: dynamicVehicleId,
    name: "Electric lock driver",
    isActive: true,
    workStartTime: "07:00:00",
    workEndTime: "18:00:00",
    startLatitude: depotSnapshot.start.latitude,
    startLongitude: depotSnapshot.start.longitude,
  });
  await db.insert(routesTable).values({
    id: dynamicRouteId,
    planId: randomUUID(),
    organizationId: dynamicOrganizationId,
    vehicleId: dynamicVehicleId,
    name: "Electric lock route",
    date: new Date("2026-08-26T00:00:00.000Z"),
    status: "optimized",
    planRevision: 1,
    totalStops: 3,
    depotSnapshot,
    optimizationPlanningSnapshot: planningSnapshot,
  });
  await db.insert(stopsTable).values(dynamicStopIds.map((id, index) => ({
    id,
    organizationId: dynamicOrganizationId,
    routeId: dynamicRouteId,
    address: `Electric lock stop ${index + 1}`,
    latitude: [59.385, 59.405, 59.43][index],
    longitude: [18.02, 17.945, 17.87][index],
    status: "pending" as const,
    sequenceOrder: index + 1,
    serviceDurationMin: 5,
  })));
  const server = await startApp(dynamicOrganizationId);
  try {
    const locked = await request(
      server.url,
      `/api/routes/${dynamicRouteId}/locked-first-stop`,
      "PUT",
      { stopId: dynamicStopIds[1], planRevision: 1 },
    );
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.optimizationPlanningSnapshot.allowLateStopsMin, 7);
    assert.ok(
      (locked.body.plannerItinerary as Array<{ isChargingStop?: boolean }>)
        .some((entry) => entry.isChargingStop === true),
      "locking an EV route should retain or insert a charging station",
    );
    assert.equal(locked.body.workdaySummary.allowedOvertimeMin, 45);
    await db.update(vehiclesTable)
      .set({ rangeKm: 1 })
      .where(eq(vehiclesTable.id, dynamicVehicleId));
    const rejected = await request(
      server.url,
      `/api/routes/${dynamicRouteId}/locked-first-stop`,
      "PUT",
      { stopId: dynamicStopIds[2], planRevision: 2 },
    );
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    const [rolledBackRoute] = await db
      .select({
        lockedFirstStopId: routesTable.lockedFirstStopId,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.id, dynamicRouteId));
    assert.equal(rolledBackRoute.lockedFirstStopId, dynamicStopIds[1]);
    assert.equal(rolledBackRoute.planRevision, 2);
  } finally {
    await server.close();
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, dynamicOrganizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, dynamicOrganizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, dynamicOrganizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, dynamicOrganizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, dynamicOrganizationId));
  }
});