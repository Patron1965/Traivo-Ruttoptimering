import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { test } from "node:test";
import {
  db,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routePlanApprovalsTable,
  routeExecutionsTable,
  routeHistoryTable,
  routesTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import type { AuthUser, UserRole } from "../middleware/auth";
import { startRouteExecution } from "../services/route-execution-service";
import routesRouter from "./routes";
import stopsRouter from "./stops";
import trackingRouter from "./tracking";
import { prepareOperationalRoadData } from "../middleware/operational-road-data";
import { withRequiredRoadData } from "../services/road-data-policy";

type RunningApp = {
  url: string;
  close: () => Promise<void>;
};

type RouteFixture = {
  id: string;
  stopId: string;
  planId: string;
};

type RouteOptions = {
  status?: "draft" | "optimized" | "in_progress" | "completed" | "cancelled";
  stopStatus?: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  planId?: string;
  draftId?: string;
  planningDate?: Date | null;
};

const testUser = (organizationId: string, role: UserRole): AuthUser => ({
  id: randomUUID(),
  name: `${role} route deletion test`,
  email: `${randomUUID()}@route-deletion.test`,
  role,
  organizationId,
  driverProfileId: null,
});

async function runningApp(
  organizationId: string,
  role?: UserRole,
  includeRoadPreparation = false,
): Promise<RunningApp> {
  const app: Express = express();
  app.use(express.json());
  if (role) {
    app.use((req, _res, next) => {
      req.user = testUser(organizationId, role);
      next();
    });
  }
  if (includeRoadPreparation) {
    app.use("/api", (_req, _res, next) => withRequiredRoadData(next), prepareOperationalRoadData);
  }
  app.use("/api", routesRouter, stopsRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(
  baseUrl: string,
  path: string,
  method: "POST" | "DELETE" | "PUT",
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function runningDriverStopsApp(
  organizationId: string,
  driverUserId: string,
  driverProfileId: string,
): Promise<RunningApp> {
  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: driverUserId,
      name: "Driver stop update test",
      email: `${driverUserId}@route-deletion.test`,
      role: "driver",
      organizationId,
      driverProfileId,
    };
    next();
  });
  app.use("/api", stopsRouter);
  app.use("/api", trackingRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function createOrganization(id = randomUUID()): Promise<string> {
  await db.insert(organizationsTable).values({
    id,
    name: `Route deletion ${id}`,
    email: `${id}@route-deletion.test`,
  });
  return id;
}

async function createRoute(
  organizationId: string,
  options: RouteOptions = {},
): Promise<RouteFixture> {
  const id = randomUUID();
  const stopId = randomUUID();
  const planId = options.planId ?? randomUUID();
  await db.insert(routesTable).values({
    id,
    planId,
    draftId: options.draftId ?? null,
    organizationId,
    name: `Delete test route ${id}`,
    date: new Date("2027-02-01T08:00:00.000Z"),
    status: options.status ?? "draft",
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    routeId: id,
    address: `Order ${stopId}`,
    latitude: 59.3293,
    longitude: 18.0686,
    status: options.stopStatus ?? "pending",
    sequenceOrder: 1,
    externalRef: `ORDER-${stopId}`,
    trackingCode: `TRACK-${stopId}`,
    planningPlanId: options.status === "draft" && !options.draftId ? null : planId,
    planningDate: options.planningDate === undefined
      ? new Date("2027-02-01T00:00:00.000Z")
      : options.planningDate,
  });
  return { id, stopId, planId };
}

async function cleanup(organizationIds: string[], routeIds: string[]): Promise<void> {
  if (routeIds.length > 0) {
    await db.delete(routeHistoryTable).where(inArray(routeHistoryTable.routeId, routeIds));
  }
  await db.delete(routePlanApprovalsTable).where(inArray(
    routePlanApprovalsTable.organizationId,
    organizationIds,
  ));
  await db.delete(planningDraftsTable).where(inArray(
    planningDraftsTable.organizationId,
    organizationIds,
  ));
  await db.delete(stopsTable).where(inArray(stopsTable.organizationId, organizationIds));
  await db.delete(routesTable).where(inArray(routesTable.organizationId, organizationIds));
  await db.delete(driversTable).where(inArray(driversTable.organizationId, organizationIds));
  await db.delete(vehiclesTable).where(inArray(vehiclesTable.organizationId, organizationIds));
  await db.delete(usersTable).where(inArray(usersTable.organizationId, organizationIds));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
}

test("route deletion RBAC denies anonymous/viewer/driver and permits dispatcher/admin", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  const servers: RunningApp[] = [];
  try {
    let route = await createRoute(organizationId);
    routeIds.push(route.id);
    for (const role of [undefined, "viewer", "driver", "dispatcher", "admin"] as const) {
      const server = await runningApp(organizationId, role);
      servers.push(server);
      const result = await request(server.url, `/api/routes/${route.id}`, "DELETE", {
        confirmLiveRouteRemoval: false,
      });
      if (role === "dispatcher" || role === "admin") {
        assert.equal(result.status, 204, JSON.stringify(result.body));
        // Recreate the route so both allowed roles exercise the actual service.
        if (role === "dispatcher") {
          route = await createRoute(organizationId);
          routeIds.push(route.id);
        }
      } else {
        assert.equal(result.status, role === undefined ? 401 : 403);
      }
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await cleanup([organizationId], routeIds);
  }
});

test("bulk route cleanup and planned-stop archiving do not require a road provider", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  const server = await runningApp(organizationId, "dispatcher", true);
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = (async (input, init) => {
    if (!String(input).startsWith(`${server.url}/`)) {
      providerRequests++;
      throw new Error("No external service is available in this cleanup test");
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    const removed = await createRoute(organizationId, { status: "optimized" });
    const archived = await createRoute(organizationId, { status: "optimized" });
    routeIds.push(removed.id, archived.id);
    // Distinct depot/stop points would trigger a matrix request without the
    // cleanup exclusions. No provider is needed for either transaction.
    await db.update(organizationsTable).set({
      depotStartLatitude: 59.4, depotStartLongitude: 18.1,
      depotEndLatitude: 59.4, depotEndLongitude: 18.1,
    }).where(eq(organizationsTable.id, organizationId));
    const deletion = await request(server.url, "/api/routes/bulk-delete", "POST", {
      routeIds: [removed.id], confirmLiveRouteRemoval: false,
    });
    assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
    assert.equal(deletion.body.deletedCount, 1);
    const [released] = await db.select().from(stopsTable).where(eq(stopsTable.id, removed.stopId));
    assert.equal(released.routeId, null);
    assert.equal(released.status, "pending");
    const archive = await request(server.url, "/api/stops/bulk-archive", "POST", {
      stopIds: [archived.stopId], confirmActiveRoutes: true,
    });
    assert.equal(archive.status, 200, JSON.stringify(archive.body));
    assert.equal(archive.body.archivedCount, 1);
    const [retained] = await db.select().from(stopsTable).where(eq(stopsTable.id, archived.stopId));
    assert.ok(retained.archivedAt);
    assert.equal(retained.id, archived.stopId);
    assert.equal(providerRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    await cleanup([organizationId], routeIds);
  }
});

test("single and bulk deletion preserve pending orders while detaching planning fields", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "dispatcher");
    const single = await createRoute(organizationId, { status: "optimized" });
    routeIds.push(single.id);
    const singleResult = await request(server.url, `/api/routes/${single.id}`, "DELETE", {
      confirmLiveRouteRemoval: false,
    });
    assert.equal(singleResult.status, 204);
    const [detachedSingle] = await db.select().from(stopsTable).where(eq(stopsTable.id, single.stopId));
    assert.equal(detachedSingle?.routeId, null);
    assert.equal(detachedSingle?.sequenceOrder, null);
    assert.equal(detachedSingle?.planningPlanId, null);
    assert.equal(detachedSingle?.planningDate, null);
    assert.match(detachedSingle?.externalRef ?? "", /^ORDER-/);
    assert.match(detachedSingle?.trackingCode ?? "", /^TRACK-/);

    const first = await createRoute(organizationId, { status: "optimized" });
    const second = await createRoute(organizationId, { status: "optimized" });
    routeIds.push(first.id, second.id);
    const bulk = await request(server.url, "/api/routes/bulk-delete", "POST", {
      routeIds: [first.id, second.id],
      confirmLiveRouteRemoval: false,
    });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.deepEqual(new Set(bulk.body.deletedRouteIds), new Set([first.id, second.id]));
    assert.equal(bulk.body.deletedCount, 2);
    const detachedBulk = await db.select().from(stopsTable).where(inArray(
      stopsTable.id,
      [first.stopId, second.stopId],
    ));
    assert.equal(detachedBulk.length, 2);
    assert.ok(detachedBulk.every((stop) =>
      stop.routeId === null
      && stop.sequenceOrder === null
      && stop.planningPlanId === null
      && stop.planningDate === null
      && stop.externalRef?.startsWith("ORDER-"),
    ));
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], routeIds);
  }
});

test("a live accepted and approved route needs acknowledgement, then archives without losing its evidence", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "dispatcher");
    const live = await createRoute(organizationId, { status: "in_progress" });
    routeIds.push(live.id);
    const vehicleId = randomUUID();
    const driverId = randomUUID();
    const driverUserId = randomUUID();
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Live removal vehicle",
      licensePlate: `LIVE-${vehicleId.slice(0, 8)}`,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      name: "Live removal driver",
      vehicleId,
    });
    await db.insert(usersTable).values({
      id: driverUserId,
      organizationId,
      name: "Live removal driver user",
      email: `${driverUserId}@route-deletion.test`,
      role: "driver",
    });
    await db.update(routesTable).set({
      vehicleId,
      handoffStatus: "accepted",
      handoffVersion: 0,
      handoffDriverId: driverId,
    }).where(eq(routesTable.id, live.id));
    await db.insert(routeExecutionsTable).values({
      organizationId,
      routeId: live.id,
      driverId,
      planVersion: 0,
      status: "active",
      startedAt: new Date("2027-02-01T08:00:00.000Z"),
      startClientEventId: `start-${live.id}`,
      startedByUserId: driverUserId,
    });
    await db.insert(routePlanApprovalsTable).values({
      organizationId,
      planId: live.planId,
      routeId: live.id,
      planRevision: 0,
      driverId,
      vehicleId,
      approvedByUserId: driverUserId,
    });

    const unacknowledged = await request(server.url, `/api/routes/${live.id}`, "DELETE", {
      confirmLiveRouteRemoval: false,
    });
    assert.equal(unacknowledged.status, 409, JSON.stringify(unacknowledged.body));
    assert.equal(unacknowledged.body.details.conflicts[0].reason, "live_confirmation");

    const removed = await request(server.url, `/api/routes/${live.id}`, "DELETE", {
      confirmLiveRouteRemoval: true,
    });
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    const [archived] = await db.select().from(routesTable).where(eq(routesTable.id, live.id));
    assert.equal(archived?.status, "cancelled");
    assert.equal(archived?.planRevision, 1);
    assert.equal(archived?.handoffStatus, "pending");
    assert.equal(archived?.handoffDriverId, null);
    const retainedApprovals = await db.select().from(routePlanApprovalsTable).where(
      eq(routePlanApprovalsTable.routeId, live.id),
    );
    assert.equal(retainedApprovals.length, 1);
    const [releasedStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, live.stopId));
    assert.equal(releasedStop?.routeId, null);
    assert.equal(releasedStop?.status, "pending");
    const [endedExecution] = await db.select().from(routeExecutionsTable).where(
      eq(routeExecutionsTable.routeId, live.id),
    );
    assert.equal(endedExecution?.status, "ended");
    assert.ok(endedExecution?.endedAt);
    await assert.rejects(
      () => startRouteExecution({
        routeId: live.id,
        clientEventId: `stale-${live.id}`,
        actor: {
          organizationId,
          actorUserId: driverUserId,
          role: "driver",
          driverProfileId: driverId,
        },
      }),
      (error: any) => error?.statusCode === 409,
    );
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], routeIds);
  }
});

test("driver generic stop PUT cannot revive an archived stop or update a same-tenant route owned by another driver", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let dispatcherServer: RunningApp | undefined;
  let driverServer: RunningApp | undefined;
  try {
    const archivedRoute = await createRoute(organizationId, { status: "in_progress" });
    const otherDriverRoute = await createRoute(organizationId, { status: "in_progress" });
    routeIds.push(archivedRoute.id, otherDriverRoute.id);
    const vehicleId = randomUUID();
    const driverId = randomUUID();
    const otherDriverId = randomUUID();
    const driverUserId = randomUUID();
    const otherDriverUserId = randomUUID();
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Driver PUT vehicle",
      licensePlate: `PUT-${vehicleId.slice(0, 8)}`,
    });
    await db.insert(driversTable).values([
      { id: driverId, organizationId, name: "Authorized driver", vehicleId },
      { id: otherDriverId, organizationId, name: "Other driver", vehicleId },
    ]);
    await db.insert(usersTable).values([
      { id: driverUserId, organizationId, name: "Authorized driver", email: `${driverUserId}@route-deletion.test`, role: "driver" },
      { id: otherDriverUserId, organizationId, name: "Other driver", email: `${otherDriverUserId}@route-deletion.test`, role: "driver" },
    ]);
    for (const [route, assignedDriverId, userId] of [
      [archivedRoute, driverId, driverUserId],
      [otherDriverRoute, otherDriverId, otherDriverUserId],
    ] as const) {
      await db.update(routesTable).set({
        vehicleId,
        handoffStatus: "accepted",
        handoffVersion: 0,
        handoffDriverId: assignedDriverId,
      }).where(eq(routesTable.id, route.id));
      await db.insert(routeExecutionsTable).values({
        organizationId,
        routeId: route.id,
        driverId: assignedDriverId,
        planVersion: 0,
        status: "active",
        startedAt: new Date("2027-02-01T08:00:00.000Z"),
        startClientEventId: `start-${route.id}`,
        startedByUserId: userId,
      });
    }

    dispatcherServer = await runningApp(organizationId, "dispatcher");
    driverServer = await runningDriverStopsApp(organizationId, driverUserId, driverId);
    const removed = await request(dispatcherServer.url, `/api/routes/${archivedRoute.id}`, "DELETE", {
      confirmLiveRouteRemoval: true,
    });
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    const staleReplay = await request(driverServer.url, `/api/stops/${archivedRoute.stopId}`, "PUT", {
      status: "in_progress",
    });
    assert.equal(staleReplay.status, 409, JSON.stringify(staleReplay.body));
    const staleTracking = await request(driverServer.url, "/api/tracking/location", "POST", {
      organizationId,
      vehicleId,
      routeId: archivedRoute.id,
      clientSessionId: `start-${archivedRoute.id}`,
      latitude: 59.3293,
      longitude: 18.0686,
      timestamp: Date.now(),
    });
    assert.equal(staleTracking.status, 403, JSON.stringify(staleTracking.body));
    const crossDriverWrite = await request(driverServer.url, `/api/stops/${otherDriverRoute.stopId}`, "PUT", {
      status: "in_progress",
    });
    assert.equal(crossDriverWrite.status, 403, JSON.stringify(crossDriverWrite.body));
  } finally {
    if (driverServer) await driverServer.close();
    if (dispatcherServer) await dispatcherServer.close();
    await cleanup([organizationId], routeIds);
  }
});

test("bulk conflicts for active, terminal, or retained history routes roll back every deletion", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "admin");
    const valid = await createRoute(organizationId, { status: "optimized" });
    const active = await createRoute(organizationId, {
      status: "in_progress",
      stopStatus: "pending",
    });
    const terminal = await createRoute(organizationId, {
      status: "draft",
      stopStatus: "completed",
    });
    const historical = await createRoute(organizationId, {
      status: "draft",
      stopStatus: "pending",
    });
    routeIds.push(valid.id, active.id, terminal.id, historical.id);
    await db.insert(routeHistoryTable).values({
      organizationId,
      routeId: historical.id,
      vehicleName: "Retained vehicle",
      date: new Date("2027-02-01T08:00:00.000Z"),
      totalStops: 1,
    });

    const result = await request(server.url, "/api/routes/bulk-delete", "POST", {
      routeIds,
      confirmLiveRouteRemoval: false,
    });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "ROUTE_DELETE_CONFLICT");
    assert.ok(result.body.details.conflicts.some((item: any) =>
      item.routeId === active.id && item.reason === "live_confirmation"));
    assert.ok(result.body.details.conflicts.some((item: any) =>
      item.routeId === terminal.id && item.reason === "stop_status"));
    const remaining = await db.select({ id: routesTable.id }).from(routesTable).where(
      inArray(routesTable.id, routeIds),
    );
    assert.equal(remaining.length, routeIds.length);
    const [validStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, valid.stopId));
    assert.equal(validStop?.routeId, valid.id);
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], routeIds);
  }
});

test("foreign or missing bulk ids return a generic 404 and roll back own routes", async () => {
  const organizationId = await createOrganization();
  const otherOrganizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "dispatcher");
    const own = await createRoute(organizationId, { status: "optimized" });
    const foreign = await createRoute(otherOrganizationId, { status: "optimized" });
    routeIds.push(own.id, foreign.id);
    for (const missingOrForeign of [foreign.id, randomUUID()]) {
      const result = await request(server.url, "/api/routes/bulk-delete", "POST", {
        routeIds: [own.id, missingOrForeign],
        confirmLiveRouteRemoval: false,
      });
      assert.equal(result.status, 404);
      assert.deepEqual(result.body, { error: "Route not found" });
      const [stillOwn] = await db.select().from(routesTable).where(eq(routesTable.id, own.id));
      assert.equal(stillOwn?.id, own.id);
      const [stillOwnStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, own.stopId));
      assert.equal(stillOwnStop?.routeId, own.id);
    }
  } finally {
    if (server) await server.close();
    await cleanup([organizationId, otherOrganizationId], routeIds);
  }
});

test("bulk deletion validates unique UUIDs and the 500-route limit", async () => {
  const organizationId = await createOrganization();
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "dispatcher");
    const invalidBodies = [
      { routeIds: [], confirmLiveRouteRemoval: false },
      { routeIds: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001",
      ], confirmLiveRouteRemoval: false },
      { routeIds: ["not-a-uuid"], confirmLiveRouteRemoval: false },
      { routeIds: Array.from({ length: 501 }, () => randomUUID()), confirmLiveRouteRemoval: false },
      { routeIds: [randomUUID()] },
    ];
    for (const body of invalidBodies) {
      const result = await request(server.url, "/api/routes/bulk-delete", "POST", body);
      assert.equal(result.status, 400, JSON.stringify(result.body));
    }
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], []);
  }
});

test("deleting a generated route invalidates its draft so the deleted route cannot replay", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "dispatcher");
    const draftId = randomUUID();
    const planId = randomUUID();
    const route = await createRoute(organizationId, {
      status: "optimized",
      draftId,
      planId,
    });
    routeIds.push(route.id);
    await db.insert(planningDraftsTable).values({
      id: draftId,
      organizationId,
      name: "Generated deletion draft",
      startAt: new Date("2027-02-01T08:00:00.000Z"),
      state: { planningInputs: { stopIds: [route.stopId] } },
      revision: 4,
      planId,
      planPayloadHash: "payload-before-delete",
      planResult: { planId, routes: [{ routeId: route.id }] },
    });

    const result = await request(server.url, `/api/routes/${route.id}`, "DELETE", {
      confirmLiveRouteRemoval: false,
    });
    assert.equal(result.status, 204);
    const [draft] = await db.select().from(planningDraftsTable).where(eq(
      planningDraftsTable.id,
      draftId,
    ));
    assert.equal(draft?.planId, null);
    assert.equal(draft?.planPayloadHash, null);
    assert.equal(draft?.planResult, null);
    assert.equal(draft?.revision, 5);
    const [deletedRoute] = await db.select().from(routesTable).where(eq(routesTable.id, route.id));
    assert.equal(deletedRoute, undefined);
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], routeIds);
  }
});

test("partial deletion reconciles a two-route draft plan without replaying the deleted route", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "dispatcher");
    const draftId = randomUUID();
    const planId = randomUUID();
    const first = await createRoute(organizationId, { status: "optimized", draftId, planId });
    const second = await createRoute(organizationId, { status: "optimized", draftId, planId });
    routeIds.push(first.id, second.id);
    const planResult = {
      planId,
      routes: [{ routeId: first.id }, { routeId: second.id }],
      recovery: { stopIds: [first.stopId, second.stopId] },
      planningInputs: {
        stopPriorities: { [first.stopId]: 2, [second.stopId]: 1 },
      },
    };
    await db.insert(planningDraftsTable).values({
      id: draftId,
      organizationId,
      name: "Two route generated plan",
      startAt: new Date("2027-02-01T08:00:00.000Z"),
      state: {
        planningInputs: {
          stopIds: [first.stopId, second.stopId],
          stopPriorities: { [first.stopId]: 2, [second.stopId]: 1 },
        },
        assignedRoutes: [{ routeId: first.id }, { routeId: second.id }],
      },
      revision: 2,
      planId,
      planPayloadHash: "two-route-payload",
      planResult,
    });

    const partial = await request(server.url, `/api/routes/${first.id}`, "DELETE", {
      confirmLiveRouteRemoval: false,
    });
    assert.equal(partial.status, 204, JSON.stringify(partial.body));

    const survivingRoutes = await db.select().from(routesTable).where(inArray(
      routesTable.id,
      [first.id, second.id],
    ));
    assert.deepEqual(survivingRoutes.map((route) => route.id), [second.id]);
    const [releasedStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, first.stopId));
    assert.equal(releasedStop?.routeId, null);
    assert.equal(releasedStop?.planningPlanId, null);
    const [survivingStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, second.stopId));
    assert.equal(survivingStop?.routeId, second.id);
    const [draftAfterPartial] = await db.select().from(planningDraftsTable).where(eq(
      planningDraftsTable.id,
      draftId,
    ));
    assert.equal(draftAfterPartial?.planId, planId);
    assert.equal(draftAfterPartial?.planPayloadHash, "two-route-payload");
    assert.deepEqual(
      (draftAfterPartial?.planResult as any)?.routes.map((route: any) => route.routeId),
      [second.id],
    );
    assert.ok((draftAfterPartial?.planResult as any)?.unassignedStopIds.includes(first.stopId));
    assert.equal(
      (draftAfterPartial?.planResult as any)?.planningInputs.stopPriorities[first.stopId],
      undefined,
    );
    assert.equal(draftAfterPartial?.revision, 3);
    assert.deepEqual((draftAfterPartial?.state as any)?.assignedRoutes, [{ routeId: second.id }]);
    assert.equal(
      (draftAfterPartial?.state as any)?.planningInputs.stopPriorities[first.stopId],
      undefined,
    );
    assert.equal(
      (draftAfterPartial?.state as any)?.planningMetadata?.routeDeletionTombstones?.[0]?.routeIds[0],
      first.id,
    );
    // Keeping planId/payloadHash frozen prevents a new unrelated plan from
    // being created under this draft; replay can only hydrate the survivor.

    const allRoutes = await request(server.url, `/api/routes/${second.id}`, "DELETE", {
      confirmLiveRouteRemoval: false,
    });
    assert.equal(allRoutes.status, 204, JSON.stringify(allRoutes.body));
    const [invalidatedDraft] = await db.select().from(planningDraftsTable).where(eq(
      planningDraftsTable.id,
      draftId,
    ));
    assert.equal(invalidatedDraft?.planId, null);
    assert.equal(invalidatedDraft?.planPayloadHash, null);
    assert.equal(invalidatedDraft?.planResult, null);
    assert.equal(invalidatedDraft?.revision, 4);
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], routeIds);
  }
});

test("approved routes are archived so approval evidence is retained", async () => {
  const organizationId = await createOrganization();
  const routeIds: string[] = [];
  let server: RunningApp | undefined;
  try {
    server = await runningApp(organizationId, "admin");
    const approved = await createRoute(organizationId, { status: "optimized" });
    const other = await createRoute(organizationId, { status: "optimized" });
    routeIds.push(approved.id, other.id);
    const vehicleId = randomUUID();
    const driverId = randomUUID();
    const approverId = randomUUID();
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Approval test vehicle",
      licensePlate: `APP-${vehicleId.slice(0, 8)}`,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      name: "Approval test driver",
      vehicleId,
    });
    await db.insert(usersTable).values({
      id: approverId,
      organizationId,
      name: "Approval test admin",
      email: `${approverId}@route-deletion.test`,
      role: "admin",
    });
    await db.insert(routePlanApprovalsTable).values({
      organizationId,
      planId: approved.planId,
      routeId: approved.id,
      planRevision: 0,
      driverId,
      vehicleId,
      approvedByUserId: approverId,
    });

    await db.update(routesTable).set({
      handoffStatus: "accepted",
      handoffVersion: 0,
      handoffDriverId: driverId,
      vehicleId,
    }).where(eq(routesTable.id, approved.id));
    const result = await request(server.url, "/api/routes/bulk-delete", "POST", {
      routeIds,
      confirmLiveRouteRemoval: false,
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.archivedRouteIds, [approved.id]);
    assert.deepEqual(result.body.deletedRouteIds, [other.id]);
    const retainedRoutes = await db.select({ id: routesTable.id }).from(routesTable).where(
      inArray(routesTable.id, routeIds),
    );
    assert.deepEqual(retainedRoutes.map((route) => route.id), [approved.id]);
    const [archivedRoute] = await db.select().from(routesTable).where(eq(routesTable.id, approved.id));
    assert.equal(archivedRoute?.status, "cancelled");
    const retainedApprovals = await db.select().from(routePlanApprovalsTable).where(
      eq(routePlanApprovalsTable.routeId, approved.id),
    );
    assert.equal(retainedApprovals.length, 1);

    const partialDraftId = randomUUID();
    const partialPlanId = randomUUID();
    const partialDeleted = await createRoute(organizationId, {
      status: "optimized",
      draftId: partialDraftId,
      planId: partialPlanId,
    });
    const partialSurvivor = await createRoute(organizationId, {
      status: "optimized",
      draftId: partialDraftId,
      planId: partialPlanId,
    });
    routeIds.push(partialDeleted.id, partialSurvivor.id);
    await db.insert(planningDraftsTable).values({
      id: partialDraftId,
      organizationId,
      name: "Approved membership draft",
      startAt: new Date("2027-02-01T08:00:00.000Z"),
      state: {},
      planId: partialPlanId,
      planPayloadHash: "approved-membership-payload",
      planResult: { planId: partialPlanId, routes: [{ routeId: partialDeleted.id }, { routeId: partialSurvivor.id }] },
    });
    await db.insert(routePlanApprovalsTable).values({
      organizationId,
      planId: partialPlanId,
      routeId: partialSurvivor.id,
      planRevision: 0,
      driverId,
      vehicleId,
      approvedByUserId: approverId,
    });
    const approvedMembership = await request(server.url, "/api/routes/bulk-delete", "POST", {
      routeIds: [partialDeleted.id],
      confirmLiveRouteRemoval: false,
    });
    assert.equal(approvedMembership.status, 409, JSON.stringify(approvedMembership.body));
    assert.ok(approvedMembership.body.details.conflicts.some((item: any) =>
      item.routeId === partialDeleted.id && item.reason === "approved_membership"));
    const partialRemaining = await db.select({ id: routesTable.id }).from(routesTable).where(
      inArray(routesTable.id, [partialDeleted.id, partialSurvivor.id]),
    );
    assert.equal(partialRemaining.length, 2);
  } finally {
    if (server) await server.close();
    await cleanup([organizationId], routeIds);
  }
});