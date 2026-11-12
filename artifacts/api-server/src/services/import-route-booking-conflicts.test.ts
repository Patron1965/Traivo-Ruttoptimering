import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { test } from "node:test";
import {
  db,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth";
import importRouteWorkflowRouter from "../routes/import-route-workflow";
import {
  createImportRoutePlan,
  setImportPlanBeforeOptimizeHookForTest,
  setImportPlanBeforePersistHookForTest,
} from "./import-route-workflow";

const date = new Date("2026-09-17T08:00:00.000Z");

function appFor(organizationId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Booking conflict test",
      email: "booking-conflict@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(importRouteWorkflowRouter);
  return app;
}

async function post(app: Express, body: unknown) {
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/import/route-plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

async function insertOrganization(id = randomUUID()): Promise<string> {
  await db.insert(organizationsTable).values({
    id,
    name: `Booking conflict ${id}`,
    email: `${id}@example.test`,
  });
  return id;
}

async function insertResource(organizationId: string, name: string) {
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name,
    licensePlate: `BC-${vehicleId.slice(0, 8)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: `${name} driver`,
    startLatitude: 59.3293,
    startLongitude: 18.0686,
    isActive: true,
  });
  return { vehicleId, driverId };
}

async function insertStop(
  organizationId: string,
  routeId: string | null = null,
  id = randomUUID(),
) {
  await db.insert(stopsTable).values({
    id,
    organizationId,
    routeId,
    address: `Booking stop ${id}`,
    latitude: 59.33,
    longitude: 18.07,
    sequenceOrder: routeId ? 1 : null,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
    status: "pending",
  });
  return id;
}

async function cleanup(organizationIds: string[]) {
  for (const organizationId of organizationIds) {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
}

function planInput(stopId: string, vehicleId: string, driverId: string) {
  return {
    stopIds: [stopId],
    pairs: [{ vehicleId, driverId }],
    date,
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  };
}

test("early booking conflict is coded, detailed, and leaves optimizer and writes untouched", async () => {
  const organizationId = await insertOrganization();
  const resource = await insertResource(organizationId, "Own booking vehicle");
  const stopId = await insertStop(organizationId);
  const routeId = randomUUID();
  const planId = randomUUID();
  const draftId = randomUUID();
  await db.insert(planningDraftsTable).values({
    id: draftId,
    organizationId,
    name: "Existing booking draft",
    startAt: date,
    state: {},
  });
  await db.insert(routesTable).values({
    id: routeId,
    planId,
    draftId,
    organizationId,
    vehicleId: resource.vehicleId,
    name: "Existing booking route",
    date,
    status: "optimized",
    totalStops: 1,
  });
  const occupiedStopId = await insertStop(organizationId, routeId);
  let optimizerCalls = 0;
  setImportPlanBeforeOptimizeHookForTest(async () => {
    optimizerCalls++;
  });
  try {
    const response = await post(appFor(organizationId), {
      ...planInput(stopId, resource.vehicleId, resource.driverId),
      date: date.toISOString(),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_ALREADY_PLANNED");
    assert.deepEqual(response.body.details, {
      conflicts: [{
        vehicleId: resource.vehicleId,
        vehicleName: "Own booking vehicle",
        routeId,
        planId,
        draftId,
        draftName: "Existing booking draft",
        date: date.toISOString(),
      }],
    });
    assert.equal(optimizerCalls, 0);
    await db.update(routesTable).set({ status: "in_progress" }).where(eq(routesTable.id, routeId));
    const activeResponse = await post(appFor(organizationId), {
      ...planInput(stopId, resource.vehicleId, resource.driverId),
      date: date.toISOString(),
    });
    assert.equal(activeResponse.status, 409);
    assert.equal(activeResponse.body.code, "VEHICLE_ALREADY_PLANNED");
    assert.equal(optimizerCalls, 0);
    // Exercise the actual API/database predicate, not only the date helper.
    // These instants are Swedish midnight, although their UTC date is yesterday.
    for (const [planningDate, occupiedDate] of [
      ["2026-09-17T00:00:00Z", "2026-09-16T22:00:00Z"],
      ["2026-12-17T00:00:00Z", "2026-12-16T23:00:00Z"],
      ["2026-03-29T00:00:00Z", "2026-03-28T23:00:00Z"],
      ["2026-10-25T00:00:00Z", "2026-10-24T22:00:00Z"],
    ]) {
      await db.update(routesTable).set({ date: new Date(occupiedDate) })
        .where(eq(routesTable.id, routeId));
      const midnightResponse = await post(appFor(organizationId), {
        ...planInput(stopId, resource.vehicleId, resource.driverId),
        date: planningDate,
      });
      assert.equal(midnightResponse.status, 409, `booking at ${occupiedDate}`);
      assert.equal(midnightResponse.body.code, "VEHICLE_ALREADY_PLANNED");
      assert.equal(optimizerCalls, 0);
    }
    const [pendingStop] = await db.select({
      routeId: stopsTable.routeId,
      planningPlanId: stopsTable.planningPlanId,
      trackingCode: stopsTable.trackingCode,
    }).from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.deepEqual(pendingStop, {
      routeId: null,
      planningPlanId: null,
      trackingCode: null,
    });
    assert.ok(occupiedStopId);
    const savedRoutes = await db.select({ id: routesTable.id })
      .from(routesTable).where(eq(routesTable.organizationId, organizationId));
    assert.deepEqual(savedRoutes.map((route) => route.id), [routeId]);
  } finally {
    setImportPlanBeforeOptimizeHookForTest(undefined);
    await cleanup([organizationId]);
  }
});

test("foreign-organization booking does not block the selected resource", async () => {
  const organizationId = await insertOrganization();
  const foreignOrganizationId = await insertOrganization();
  const resource = await insertResource(organizationId, "Tenant vehicle");
  const stopId = await insertStop(organizationId);
  const foreignRouteId = randomUUID();
  await db.insert(routesTable).values({
    id: foreignRouteId,
    planId: randomUUID(),
    organizationId: foreignOrganizationId,
    vehicleId: resource.vehicleId,
    name: "Foreign booking route",
    date,
    status: "optimized",
    totalStops: 1,
  });
  await insertStop(foreignOrganizationId, foreignRouteId);
  try {
    const result = await createImportRoutePlan(
      organizationId,
      planInput(stopId, resource.vehicleId, resource.driverId),
    );
    assert.ok(result.planId);
    assert.equal(
      (await db.select().from(routesTable).where(eq(routesTable.id, foreignRouteId))).length,
      1,
    );
  } finally {
    // The deliberately malformed cross-tenant route references the own
    // vehicle, so remove the foreign tenant's route before its vehicle.
    await cleanup([foreignOrganizationId]);
    await cleanup([organizationId]);
  }
});

test("completed, cancelled and empty same-day routes do not block planning or change completed history", async () => {
  const organizationId = await insertOrganization();
  const resource = await insertResource(organizationId, "Reusable vehicle");
  const stopId = await insertStop(organizationId);
  const cancelledRouteId = randomUUID();
  const emptyRouteId = randomUUID();
  const completedRouteId = randomUUID();
  await db.insert(routesTable).values([
    {
      id: completedRouteId,
      planId: randomUUID(),
      organizationId,
      vehicleId: resource.vehicleId,
      name: "Completed route",
      date,
      status: "completed",
      totalStops: 1,
    },
    {
      id: cancelledRouteId,
      planId: randomUUID(),
      organizationId,
      vehicleId: resource.vehicleId,
      name: "Cancelled route",
      date,
      status: "cancelled",
      totalStops: 1,
    },
    {
      id: emptyRouteId,
      planId: randomUUID(),
      organizationId,
      vehicleId: resource.vehicleId,
      name: "Empty orphan route",
      date,
      status: "optimized",
      totalStops: 0,
    },
  ]);
  const cancelledStopId = await insertStop(organizationId, cancelledRouteId);
  const completedStopId = await insertStop(organizationId, completedRouteId);
  await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, completedStopId));
  const completedRouteBefore = await db.select().from(routesTable).where(eq(routesTable.id, completedRouteId));
  const completedStopBefore = await db.select().from(stopsTable).where(eq(stopsTable.id, completedStopId));
  try {
    const result = await createImportRoutePlan(
      organizationId,
      planInput(stopId, resource.vehicleId, resource.driverId),
    );
    assert.ok(result.planId);
    const [emptyRoute] = await db.select({ status: routesTable.status })
      .from(routesTable).where(eq(routesTable.id, emptyRouteId));
    assert.equal(emptyRoute.status, "cancelled");
    assert.deepEqual(await db.select().from(routesTable).where(eq(routesTable.id, completedRouteId)), completedRouteBefore);
    assert.deepEqual(await db.select().from(stopsTable).where(eq(stopsTable.id, completedStopId)), completedStopBefore);
    assert.ok(cancelledStopId);
  } finally {
    await cleanup([organizationId]);
  }
});

test("late booking conflict rolls back the transaction with the same contract", async () => {
  const organizationId = await insertOrganization();
  const resource = await insertResource(organizationId, "Racing vehicle");
  const stopId = await insertStop(organizationId);
  const lateRouteId = randomUUID();
  const latePlanId = randomUUID();
  const lateStopId = randomUUID();
  setImportPlanBeforePersistHookForTest(async () => {
    await db.insert(routesTable).values({
      id: lateRouteId,
      planId: latePlanId,
      organizationId,
      vehicleId: resource.vehicleId,
      name: "Late booking route",
      date,
      status: "optimized",
      totalStops: 1,
    });
    await insertStop(organizationId, lateRouteId, lateStopId);
  });
  try {
    await assert.rejects(
      () => createImportRoutePlan(
        organizationId,
        planInput(stopId, resource.vehicleId, resource.driverId),
      ),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal((error as { code?: string }).code, "VEHICLE_ALREADY_PLANNED");
        assert.deepEqual(
          (error as { details?: unknown }).details,
          {
            conflicts: [{
              vehicleId: resource.vehicleId,
              vehicleName: "Racing vehicle",
              routeId: lateRouteId,
              planId: latePlanId,
              draftId: null,
              draftName: null,
              date: date.toISOString(),
            }],
          },
        );
        return true;
      },
    );
    const [pendingStop] = await db.select({
      routeId: stopsTable.routeId,
      planningPlanId: stopsTable.planningPlanId,
      trackingCode: stopsTable.trackingCode,
    }).from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.deepEqual(pendingStop, {
      routeId: null,
      planningPlanId: null,
      trackingCode: null,
    });
    assert.equal(
      (await db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId))).length,
      1,
    );
  } finally {
    setImportPlanBeforePersistHookForTest(undefined);
    await cleanup([organizationId]);
  }
});