import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import { installSyntheticRoadMatrix } from "../test-utils/road-matrix";
import { clearOsrmCache } from "./osrm";
import { RoadDataUnavailableError } from "./road-data-policy";
const restoreRoadProvider = installSyntheticRoadMatrix();
after(restoreRoadProvider);
test("missing road data rejects a cold-cache manual mutation without changing routes or stops", async () => {
  const beforeRoutes = await db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId));
  const beforeStops = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "Ok", distances: [[0]], durations: [[0]] }))) as typeof fetch;
  clearOsrmCache();
  try {
    await assert.rejects(adjustAssignedRoutes(organizationId, {
      planId, depotLatitude: 59.3293, depotLongitude: 18.0686,
      routes: beforeRoutes.map(route => ({
        routeId: route.id, driverId: driverIds[routeIds.findIndex(id => id === route.id)], planRevision: route.planRevision,
        stopIds: beforeStops.filter(stop => stop.routeId === route.id).sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0)).map(stop => stop.id),
      })),
    }), RoadDataUnavailableError);
    assert.deepEqual(await db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId)), beforeRoutes);
    assert.deepEqual(await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)), beforeStops);
  } finally { globalThis.fetch = previous; clearOsrmCache(); }
});
import {
  db,
  driversTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import {
  adjustAssignedRoutes,
  ImportRouteWorkflowError,
} from "./import-route-workflow";

const organizationId = randomUUID();
const planId = randomUUID();
const routeIds = [randomUUID(), randomUUID()];
const vehicleIds = [randomUUID(), randomUUID()];
const driverIds = [randomUUID(), randomUUID()];
const stopIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const depotSnapshot = {
  start: {
    address: "Verified start depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
  end: {
    address: "Verified end depot",
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

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Route adjustment tests",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values(vehicleIds.map((id, index) => ({
    id,
    organizationId,
    name: `Adjustment vehicle ${index + 1}`,
    licensePlate: `ADJ-${index + 1}-${organizationId.slice(0, 5)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  })));
  await db.insert(driversTable).values(driverIds.map((id, index) => ({
    id,
    organizationId,
    vehicleId: vehicleIds[index],
    name: `Adjustment driver ${index + 1}`,
    isActive: true,
  })));
  await db.insert(routesTable).values(routeIds.map((id, index) => ({
    id,
    planId,
    organizationId,
    vehicleId: vehicleIds[index],
    name: `Adjustment route ${index + 1}`,
    date: new Date("2026-08-26T08:00:00.000Z"),
    status: "optimized" as const,
    planRevision: 2,
    totalStops: 2,
    depotSnapshot,
    optimizationPlanningSnapshot: planningSnapshot,
    optimizationResourceSnapshot: { driver: { id: driverIds[index] } },
  })));
  await db.insert(stopsTable).values(stopIds.map((id, index) => ({
    id,
    organizationId,
    routeId: routeIds[index < 2 ? 0 : 1],
    sequenceOrder: index % 2 + 1,
    address: `Adjustment stop ${index + 1}`,
    latitude: 59.3293 + index * 0.001,
    longitude: 18.0686 + index * 0.001,
    status: "pending" as const,
    serviceDurationMin: 5,
    weightKg: 10,
    volumeM3: 0.1,
  })));
});

after(async () => {
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

test("saves exact route order and increments every route revision", async () => {
  const result = await adjustAssignedRoutes(organizationId, {
    planId,
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
    routes: [
      {
        routeId: routeIds[0],
        driverId: driverIds[0],
        planRevision: 2,
        stopIds: [stopIds[1], stopIds[2]],
        plannerItinerary: [
          {
            stopId: stopIds[1],
            sequenceOrder: 1,
            estimatedArrival: "2026-08-26T08:15:00.000Z",
            distanceFromPreviousKm: 2,
          },
          {
            stopId: "cs-1",
            sequenceOrder: 2,
            estimatedArrival: "2026-08-26T08:30:00.000Z",
            distanceFromPreviousKm: 4,
            isChargingStop: true,
            chargingStationName: "Untrusted client label",
          },
          {
            stopId: stopIds[2],
            sequenceOrder: 3,
            estimatedArrival: "2026-08-26T09:10:00.000Z",
            distanceFromPreviousKm: 3,
          },
        ],
      },
      {
        routeId: routeIds[1],
        driverId: driverIds[1],
        planRevision: 2,
        stopIds: [stopIds[3], stopIds[0]],
      },
    ],
  });

  assert.deepEqual(result.routes.map((route) => route.planRevision), [3, 3]);
  const savedStops = await db
    .select({
      id: stopsTable.id,
      routeId: stopsTable.routeId,
      sequenceOrder: stopsTable.sequenceOrder,
    })
    .from(stopsTable)
    .where(inArray(stopsTable.routeId, routeIds))
    .orderBy(asc(stopsTable.routeId), asc(stopsTable.sequenceOrder));
  const byRoute = new Map(routeIds.map((routeId) => [
    routeId,
    savedStops.filter((stop) => stop.routeId === routeId).map((stop) => stop.id),
  ]));
  assert.deepEqual(byRoute.get(routeIds[0]), [stopIds[1], stopIds[2]]);
  assert.deepEqual(byRoute.get(routeIds[1]), [stopIds[3], stopIds[0]]);
  const [savedRoute] = await db
    .select({ plannerItinerary: routesTable.plannerItinerary })
    .from(routesTable)
    .where(eq(routesTable.id, routeIds[0]));
  assert.deepEqual(savedRoute.plannerItinerary?.map((entry) => ({
    stopId: entry.stopId,
    sequenceOrder: entry.sequenceOrder,
    chargingStationName: entry.chargingStationName,
  })), [
    { stopId: stopIds[1], sequenceOrder: 1, chargingStationName: undefined },
    { stopId: "cs-1", sequenceOrder: 2, chargingStationName: "Ionity Stockholm North" },
    { stopId: stopIds[2], sequenceOrder: 3, chargingStationName: undefined },
  ]);
  const explanationRoutes = await db
    .select({
      vehicleId: routesTable.vehicleId,
      explanation: routesTable.geographicOverlapExplanation,
    })
    .from(routesTable)
    .where(inArray(routesTable.id, routeIds));
  assert.ok(
    explanationRoutes.every(
      (route) =>
        route.explanation?.status === "unknown" &&
        route.explanation.scope.vehicleIds.includes(route.vehicleId!),
    ),
  );
});

test("rejects unknown charging stops without changing the persisted itinerary", async () => {
  const [before] = await db
    .select({ plannerItinerary: routesTable.plannerItinerary })
    .from(routesTable)
    .where(eq(routesTable.id, routeIds[0]));

  await assert.rejects(
    adjustAssignedRoutes(organizationId, {
      planId,
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      routes: [
        {
          routeId: routeIds[0],
          driverId: driverIds[0],
          planRevision: 3,
          stopIds: [stopIds[1], stopIds[2]],
          plannerItinerary: [
            {
              stopId: stopIds[1],
              sequenceOrder: 1,
              estimatedArrival: "2026-08-26T08:15:00.000Z",
              distanceFromPreviousKm: 2,
            },
            {
              stopId: "cs-unknown",
              sequenceOrder: 2,
              estimatedArrival: "2026-08-26T08:30:00.000Z",
              distanceFromPreviousKm: 4,
              isChargingStop: true,
            },
            {
              stopId: stopIds[2],
              sequenceOrder: 3,
              estimatedArrival: "2026-08-26T09:10:00.000Z",
              distanceFromPreviousKm: 3,
            },
          ],
        },
        {
          routeId: routeIds[1],
          driverId: driverIds[1],
          planRevision: 3,
          stopIds: [stopIds[3], stopIds[0]],
        },
      ],
    }),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError &&
      error.message.includes("okänt laddstopp"),
  );

  const [after] = await db
    .select({ plannerItinerary: routesTable.plannerItinerary })
    .from(routesTable)
    .where(eq(routesTable.id, routeIds[0]));
  assert.deepEqual(after.plannerItinerary, before.plannerItinerary);
});

test("rejects a stale revision without partially changing the plan", async () => {
  const beforeStops = await db
    .select({ id: stopsTable.id, routeId: stopsTable.routeId, sequenceOrder: stopsTable.sequenceOrder })
    .from(stopsTable)
    .where(eq(stopsTable.organizationId, organizationId))
    .orderBy(asc(stopsTable.id));

  await assert.rejects(
    adjustAssignedRoutes(organizationId, {
      planId,
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      routes: [
        {
          routeId: routeIds[0],
          driverId: driverIds[0],
          planRevision: 3,
          stopIds: [stopIds[2], stopIds[1]],
        },
        {
          routeId: routeIds[1],
          driverId: driverIds[1],
          planRevision: 2,
          stopIds: [stopIds[0], stopIds[3]],
        },
      ],
    }),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );

  const afterStops = await db
    .select({ id: stopsTable.id, routeId: stopsTable.routeId, sequenceOrder: stopsTable.sequenceOrder })
    .from(stopsTable)
    .where(eq(stopsTable.organizationId, organizationId))
    .orderBy(asc(stopsTable.id));
  assert.deepEqual(afterStops, beforeStops);
});

test("requires the plan id to match the complete submitted route set", async () => {
  await assert.rejects(
    adjustAssignedRoutes(organizationId, {
      planId: randomUUID(),
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      routes: routeIds.map((routeId, index) => ({
        routeId,
        driverId: driverIds[index],
        planRevision: 3,
        stopIds: index === 0 ? [stopIds[1], stopIds[2]] : [stopIds[3], stopIds[0]],
      })),
    }),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );

  const routes = await db
    .select({ id: routesTable.id })
    .from(routesTable)
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planId, planId),
      ),
    );
  assert.equal(routes.length, 2);
});

test("moves deliveries across routes when both stored itineraries are omitted by the client", async () => {
  await db.update(routesTable).set({
    plannerItinerary: [
      {
        stopId: stopIds[3],
        sequenceOrder: 1,
        estimatedArrival: "2026-08-26T08:15:00.000Z",
        distanceFromPreviousKm: 1,
      },
      {
        stopId: stopIds[0],
        sequenceOrder: 2,
        estimatedArrival: "2026-08-26T08:30:00.000Z",
        distanceFromPreviousKm: 1,
      },
    ],
  }).where(eq(routesTable.id, routeIds[1]));

  await adjustAssignedRoutes(organizationId, {
    planId,
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
    routes: [
      {
        routeId: routeIds[0],
        driverId: driverIds[0],
        planRevision: 3,
        stopIds: [stopIds[1], stopIds[2], stopIds[3]],
      },
      {
        routeId: routeIds[1],
        driverId: driverIds[1],
        planRevision: 3,
        stopIds: [stopIds[0]],
      },
    ],
  });

  const routes = await db.select({
    id: routesTable.id,
    plannerItinerary: routesTable.plannerItinerary,
    optimizationResourceSnapshotHash: routesTable.optimizationResourceSnapshotHash,
  }).from(routesTable).where(inArray(routesTable.id, routeIds));
  const itineraryByRoute = new Map(routes.map((route) => [
    route.id,
    route.plannerItinerary?.filter((entry) => !entry.isChargingStop).map((entry) => entry.stopId),
  ]));
  assert.deepEqual(itineraryByRoute.get(routeIds[0]), [stopIds[1], stopIds[2], stopIds[3]]);
  assert.deepEqual(itineraryByRoute.get(routeIds[1]), [stopIds[0]]);
  assert.ok(routes.every((route) => route.optimizationResourceSnapshotHash));
});

test("rejects moving or reopening a lifecycle-locked stop", async () => {
  const currentRoutes = await db
    .select()
    .from(routesTable)
    .where(inArray(routesTable.id, routeIds));
  const currentStops = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.organizationId, organizationId))
    .orderBy(asc(stopsTable.routeId), asc(stopsTable.sequenceOrder));
  const lockedStop = currentStops.find((stop) => stop.routeId === routeIds[0]);
  assert.ok(lockedStop);
  const completedAt = new Date("2026-08-26T10:00:00.000Z");
  await db
    .update(stopsTable)
    .set({ status: "completed", terminalAt: completedAt })
    .where(eq(stopsTable.id, lockedStop.id));

  const routeStops = new Map(routeIds.map((routeId) => [
    routeId,
    currentStops
      .filter((stop) => stop.routeId === routeId)
      .map((stop) => stop.id),
  ]));
  routeStops.set(
    routeIds[0],
    routeStops.get(routeIds[0])!.filter((stopId) => stopId !== lockedStop.id),
  );
  routeStops.set(
    routeIds[1],
    [...routeStops.get(routeIds[1])!, lockedStop.id],
  );

  await assert.rejects(
    adjustAssignedRoutes(organizationId, {
      planId,
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      routes: routeIds.map((routeId, index) => ({
        routeId,
        driverId: driverIds[index],
        planRevision: currentRoutes.find((route) => route.id === routeId)!.planRevision,
        stopIds: routeStops.get(routeId)!,
      })),
    }),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError &&
      error.statusCode === 409 &&
      error.message.includes("låsta"),
  );

  const [savedLockedStop] = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.id, lockedStop.id));
  assert.equal(savedLockedStop.status, "completed");
  assert.equal(savedLockedStop.terminalAt?.getTime(), completedAt.getTime());
  assert.equal(savedLockedStop.routeId, lockedStop.routeId);
  assert.equal(savedLockedStop.sequenceOrder, lockedStop.sequenceOrder);
});