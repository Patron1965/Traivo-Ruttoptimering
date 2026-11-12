import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routePlanApprovalsTable,
  routesTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import importRouteWorkflowRouter from "./import-route-workflow";
import routesRouter from "./routes";

const depotSnapshot = {
  start: {
    address: "Synthetic verified Stockholm depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
  end: {
    address: "Synthetic verified Stockholm depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
};
const planningSnapshot = {
  version: 1 as const,
  objective: "balanced" as const,
  travelReservePercent: 0,
  stopReserveMin: 0,
  stopPriorities: {},
  excludedPairValues: [],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs" as const,
};

function appFor(organizationId: string, userId = randomUUID()): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      name: "Resource replan test",
      email: "resource-replan@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(importRouteWorkflowRouter);
  app.use(routesRouter);
  return app;
}

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

async function get(app: Express, path: string) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() as any };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

test("resource replan preserves exact stops and distributes them across added resources", async () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const draftId = randomUUID();
  const planId = randomUUID();
  const oldRouteId = randomUUID();
  const oldVehicleId = randomUUID();
  const newVehicleId = randomUUID();
  const oldDriverId = randomUUID();
  const newDriverId = randomUUID();
  const stopIds = [randomUUID(), randomUUID()];
  const depotLatitude = 59.3293;
  const depotLongitude = 18.0686;
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Resource replan",
    email: `${organizationId}@example.test`,
  });
  try {
    await db.insert(usersTable).values({
      id: userId,
      organizationId,
      name: "Resource replan test",
      email: `${userId}@example.test`,
      role: "dispatcher",
    });
    await db.insert(planningDraftsTable).values({
      id: draftId,
      organizationId,
      name: "Protected resource replan",
      startAt: new Date("2026-10-12T08:00:00.000Z"),
      state: { source: "resource-replan-test" },
    });
    await db.insert(vehiclesTable).values([
      {
        id: oldVehicleId, organizationId, name: "Old vehicle",
        licensePlate: `OLD-${oldVehicleId.slice(0, 6)}`,
        capacityKg: 10_000, capacityVolume: 100, isActive: true,
      },
      {
        id: newVehicleId, organizationId, name: "New vehicle",
        licensePlate: `NEW-${newVehicleId.slice(0, 6)}`,
        capacityKg: 10_000, capacityVolume: 100, isActive: true,
      },
    ]);
    await db.insert(driversTable).values([
      {
        id: oldDriverId, organizationId, vehicleId: oldVehicleId,
        name: "Old driver", startLatitude: depotLatitude,
        startLongitude: depotLongitude, isActive: true,
      },
      {
        id: newDriverId, organizationId, vehicleId: newVehicleId,
        name: "New driver", startLatitude: depotLatitude,
        startLongitude: depotLongitude, isActive: true,
      },
    ]);
    await db.insert(routesTable).values({
      id: oldRouteId, planId, draftId, organizationId, vehicleId: oldVehicleId,
      name: "Old route", date: new Date("2026-10-12T08:00:00.000Z"),
      status: "optimized", planRevision: 3, totalStops: stopIds.length,
      depotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
      handoffStatus: "accepted", handoffVersion: 3,
      handoffDriverId: oldDriverId, acceptedAt: new Date(),
    });
    await db.insert(stopsTable).values(stopIds.map((id, index) => ({
      id, organizationId, routeId: oldRouteId, sequenceOrder: index + 1,
      address: `Resource stop ${index + 1}`,
      latitude: depotLatitude + 0.002 + index * 0.001,
      longitude: depotLongitude + 0.002 + index * 0.001,
      serviceDurationMin: 5, weightKg: 10, volumeM3: 0.1,
      status: "pending" as const,
    })));

    const response = await post(
      appFor(organizationId, userId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      {
        serviceDurationMin: 5,
        serviceTimeStrategy: "preserve_individual",
        routes: [{ routeId: oldRouteId, driverId: oldDriverId, planRevision: 3 }],
        pairs: [
          { vehicleId: oldVehicleId, driverId: oldDriverId },
          { vehicleId: newVehicleId, driverId: newDriverId },
        ],
        depotLatitude,
        depotLongitude,
      },
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.routes.length, 2);
    assert.deepEqual(
      new Set(response.body.routes.map((route: any) => route.vehicleId)),
      new Set([oldVehicleId, newVehicleId]),
    );
    const newRouteResponse = response.body.routes.find(
      (route: any) => route.vehicleId === newVehicleId,
    );
    assert.ok(newRouteResponse);
    assert.notEqual(newRouteResponse.routeId, oldRouteId);
    assert.equal(newRouteResponse.driverId, newDriverId);

    const savedStops = await db.select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
    }).from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))
      .orderBy(asc(stopsTable.id));
    assert.deepEqual(savedStops.map((stop) => stop.id), [...stopIds].sort());
    assert.equal(new Set(savedStops.map((stop) => stop.id)).size, stopIds.length);
    assert.deepEqual(
      new Set(savedStops.map((stop) => stop.routeId)),
      new Set(response.body.routes.map((route: any) => route.routeId)),
    );
    const [oldRoute] = await db.select().from(routesTable).where(eq(routesTable.id, oldRouteId));
    assert.equal(oldRoute.draftId, draftId);
    assert.equal(oldRoute.status, "optimized");
    assert.equal(oldRoute.totalStops, 1);
    assert.equal(oldRoute.handoffStatus, "pending");
    assert.equal(oldRoute.handoffDriverId, null);
    assert.ok(oldRoute.optimizationResourceSnapshotHash);
    assert.ok(oldRoute.optimizationResourceSnapshot);
    const [newRoute] = await db.select().from(routesTable)
      .where(eq(routesTable.id, newRouteResponse.routeId));
    assert.equal(newRoute.draftId, draftId);
    assert.equal(newRoute.handoffStatus, "pending");
    assert.equal(newRoute.totalStops, 1);
    assert.ok(newRoute.optimizationResourceSnapshotHash);
    assert.ok(newRoute.optimizationResourceSnapshot);

    const removeOldResource = await post(
      appFor(organizationId, userId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      {
        serviceDurationMin: 5,
        serviceTimeStrategy: "preserve_individual",
        routes: response.body.routes.map((route: any) => ({
          routeId: route.routeId,
          driverId: route.driverId,
          planRevision: route.planRevision,
        })),
        pairs: [{ vehicleId: newVehicleId, driverId: newDriverId }],
        depotLatitude,
        depotLongitude,
      },
    );
    assert.equal(removeOldResource.status, 200);
    assert.equal(removeOldResource.body.routes.length, 1);
    assert.equal(removeOldResource.body.routes[0].routeId, newRouteResponse.routeId);
    assert.equal(removeOldResource.body.routes[0].stopCount, stopIds.length);

    const approvalState = await get(
      appFor(organizationId, userId),
      `/import/route-plans/${planId}/approval`,
    );
    assert.equal(approvalState.status, 200, JSON.stringify(approvalState.body));
    assert.deepEqual(
      approvalState.body.routes.map((route: any) => route.routeId),
      [newRouteResponse.routeId],
    );
    assert.equal(
      approvalState.body.routes.some((route: any) => route.routeId === oldRouteId),
      false,
    );
    const historicalIncluded = await post(
      appFor(organizationId, userId),
      `/import/route-plans/${planId}/approve`,
      {
        routes: [
          {
            routeId: oldRouteId,
            planRevision: 3,
            driverId: oldDriverId,
          },
          {
            routeId: newRouteResponse.routeId,
            planRevision: removeOldResource.body.routes[0].planRevision,
            driverId: newDriverId,
          },
        ],
      },
    );
    assert.equal(historicalIncluded.status, 409);
    assert.equal(historicalIncluded.body.code, "ROUTE_NOT_IN_PLAN");
    const approved = await post(
      appFor(organizationId, userId),
      `/import/route-plans/${planId}/approve`,
      {
        routes: [{
          routeId: newRouteResponse.routeId,
          planRevision: removeOldResource.body.routes[0].planRevision,
          driverId: newDriverId,
        }],
      },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(
      approved.body.routes.map((route: any) => route.routeId),
      [newRouteResponse.routeId],
    );
    const dispatched = await post(
      appFor(organizationId, userId),
      `/routes/${newRouteResponse.routeId}/dispatch`,
      { driverId: newDriverId },
    );
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
    const activeApprovalState = await get(
      appFor(organizationId, userId),
      `/import/route-plans/${planId}/approval`,
    );
    assert.equal(activeApprovalState.status, 200);
    assert.equal(activeApprovalState.body.routes.length, 1);
    assert.equal(activeApprovalState.body.routes[0].routeId, newRouteResponse.routeId);
    assert.equal(activeApprovalState.body.routes[0].status, "in_progress");
    assert.equal(activeApprovalState.body.routes[0].approval.approved, true);

    const [cancelledOldRoute] = await db.select().from(routesTable)
      .where(eq(routesTable.id, oldRouteId));
    assert.equal(cancelledOldRoute.status, "cancelled");
    assert.equal(cancelledOldRoute.totalStops, 0);
    assert.deepEqual(cancelledOldRoute.plannerItinerary, []);
    const reassignedStops = await db.select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
    }).from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    assert.equal(new Set(reassignedStops.map((stop) => stop.id)).size, stopIds.length);
    assert.ok(reassignedStops.every(
      (stop) => stop.routeId === newRouteResponse.routeId,
    ));
    const [newRouteAfterReplacement] = await db.select({ draftId: routesTable.draftId })
      .from(routesTable)
      .where(eq(routesTable.id, newRouteResponse.routeId));
    assert.equal(newRouteAfterReplacement.draftId, draftId);
  } finally {
    await db.delete(routePlanApprovalsTable)
      .where(eq(routePlanApprovalsTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("resource replan rejects duplicate resources and stale snapshots without writes", async () => {
  const organizationId = randomUUID();
  const planId = randomUUID();
  const routeId = randomUUID();
  const vehicleId = randomUUID();
  const otherVehicleId = randomUUID();
  const driverId = randomUUID();
  const otherDriverId = randomUUID();
  const stopId = randomUUID();
  const depotLatitude = 59.3293;
  const depotLongitude = 18.0686;
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Resource conflicts",
    email: `${organizationId}@example.test`,
  });
  try {
    await db.insert(vehiclesTable).values([
      {
        id: vehicleId, organizationId, name: "Vehicle",
        licensePlate: `DUP-${vehicleId.slice(0, 6)}`,
        capacityKg: 10_000, capacityVolume: 100, isActive: true,
      },
      {
        id: otherVehicleId, organizationId, name: "Other vehicle",
        licensePlate: `OTH-${otherVehicleId.slice(0, 6)}`,
        capacityKg: 10_000, capacityVolume: 100, isActive: true,
      },
    ]);
    await db.insert(driversTable).values([
      {
        id: driverId, organizationId, vehicleId, name: "Driver",
        startLatitude: depotLatitude, startLongitude: depotLongitude, isActive: true,
      },
      {
        id: otherDriverId, organizationId, vehicleId: otherVehicleId,
        name: "Other driver",
        startLatitude: depotLatitude, startLongitude: depotLongitude, isActive: true,
      },
    ]);
    await db.insert(routesTable).values({
      id: routeId, planId, organizationId, vehicleId, name: "Route",
      date: new Date("2026-10-12T08:00:00.000Z"), status: "optimized",
      planRevision: 2, totalStops: 1,
      depotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
    });
    await db.insert(stopsTable).values({
      id: stopId, organizationId, routeId, sequenceOrder: 1, address: "Stop",
      latitude: depotLatitude + 0.002, longitude: depotLongitude + 0.002,
      serviceDurationMin: 5, weightKg: 10, volumeM3: 0.1, status: "pending",
    });
    const base = {
      serviceDurationMin: 5,
      serviceTimeStrategy: "preserve_individual",
      routes: [{ routeId, driverId, planRevision: 2 }],
      depotLatitude,
      depotLongitude,
    };
    const duplicate = await post(
      appFor(organizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      {
        ...base,
        pairs: [
          { vehicleId, driverId },
          { vehicleId, driverId: otherDriverId },
        ],
      },
    );
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.body));
    const tooManyResources = await post(
      appFor(organizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      {
        ...base,
        pairs: [
          { vehicleId, driverId },
          { vehicleId: otherVehicleId, driverId: otherDriverId },
        ],
      },
    );
    assert.equal(tooManyResources.status, 400);
    const stale = await post(
      appFor(organizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      { ...base, routes: [{ routeId, driverId, planRevision: 1 }] },
    );
    assert.equal(stale.status, 409);
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.equal(route.status, "optimized");
    assert.equal(route.planRevision, 2);
    assert.equal(route.totalStops, 1);
    assert.equal(stop.routeId, routeId);
    assert.equal(stop.sequenceOrder, 1);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});