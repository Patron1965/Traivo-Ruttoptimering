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
  notificationsTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import optimizeRouter from "./optimize";

function appFor(organizationId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Reoptimization lifecycle-lock test",
      email: "reoptimization-lock@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(optimizeRouter);
  return app;
}

async function post(
  app: Express,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("legacy reoptimization rejects a mixed route without moving its lifecycle anchor", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const routeId = randomUUID();
  const lockedStopId = randomUUID();
  const pendingStopId = randomUUID();
  const originalItinerary = [
    {
      stopId: lockedStopId,
      sequenceOrder: 1,
      estimatedArrival: "2026-09-07T08:00:00.000Z",
      distanceFromPreviousKm: 1,
    },
    {
      stopId: pendingStopId,
      sequenceOrder: 2,
      estimatedArrival: "2026-09-07T08:15:00.000Z",
      distanceFromPreviousKm: 2,
    },
  ];

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Reoptimization lifecycle-lock test",
    email: `${organizationId}@example.test`,
  });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Lifecycle-lock vehicle",
      licensePlate: `RL-${vehicleId.slice(0, 8)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
    });
    await db.insert(routesTable).values({
      id: routeId,
      organizationId,
      vehicleId,
      name: "Mixed lifecycle route",
      date: new Date("2026-09-07T00:00:00.000Z"),
      status: "optimized",
      totalStops: 2,
      planRevision: 4,
      plannerItinerary: originalItinerary,
    });
    await db.insert(stopsTable).values([
      {
        id: lockedStopId,
        organizationId,
        routeId,
        address: "Active lifecycle anchor",
        latitude: 59.3293,
        longitude: 18.0686,
        status: "in_progress",
        sequenceOrder: 1,
        serviceDurationMin: 15,
      },
      {
        id: pendingStopId,
        organizationId,
        routeId,
        address: "Pending route work",
        latitude: 59.3393,
        longitude: 18.0786,
        status: "pending",
        sequenceOrder: 2,
        serviceDurationMin: 15,
      },
    ]);

    const response = await post(appFor(organizationId), "/optimize/reoptimize", {
      organizationId,
      routeIds: [routeId],
      routeRevisions: [{ routeId, planRevision: 4 }],
      reason: "endpoint lifecycle-lock regression",
    });
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /locked stops/i);

    const savedStops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, routeId))
      .orderBy(asc(stopsTable.sequenceOrder));
    assert.deepEqual(
      savedStops.map((stop) => ({
        id: stop.id,
        status: stop.status,
        routeId: stop.routeId,
        sequenceOrder: stop.sequenceOrder,
      })),
      [
        {
          id: lockedStopId,
          status: "in_progress",
          routeId,
          sequenceOrder: 1,
        },
        {
          id: pendingStopId,
          status: "pending",
          routeId,
          sequenceOrder: 2,
        },
      ],
    );
    assert.equal(new Set(savedStops.map((stop) => stop.sequenceOrder)).size, 2);

    const [savedRoute] = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(savedRoute.planRevision, 4);
    assert.deepEqual(savedRoute.plannerItinerary, originalItinerary);
  } finally {
    await db.delete(notificationsTable).where(eq(notificationsTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("generic reoptimization rejects affected routes with different effective optimizer configurations", async () => {
  const organizationId = randomUUID();
  const routeIds = [randomUUID(), randomUUID()];
  const weights = (geographic: boolean) => geographic
    ? {
        distanceWeight: 0.25,
        co2Weight: 0.1,
        etaPrecisionWeight: 0.1,
        driverHappinessWeight: 0.05,
        geographicCohesionWeight: 0.5,
      }
    : {
        distanceWeight: 0.45,
        co2Weight: 0.25,
        etaPrecisionWeight: 0.15,
        driverHappinessWeight: 0.15,
        geographicCohesionWeight: 0,
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
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Mixed optimizer configuration",
    email: `${organizationId}@example.test`,
  });
  try {
    await db.insert(routesTable).values(routeIds.map((id, index) => ({
      id,
      organizationId,
      name: `Mixed config route ${index}`,
      date: new Date("2026-09-07T00:00:00.000Z"),
      status: "optimized" as const,
      planRevision: 4,
      optimizationPlanningSnapshot: planningSnapshot,
      planningSummary: {
        complete: true,
        objective: (index === 0 ? "geographic" : "balanced") as "geographic" | "balanced",
        travelReservePercent: 0,
        stopReserveMin: 0,
        mandatoryUnplannedStopIds: [],
        selectedPairValues: [],
        usedPairValues: [],
        unusedPairValues: [],
        unplanned: [],
        optimizationEvidence: {
          source: "planningInputs" as const,
          requestedObjective: index === 0 ? "geographic" as const : "balanced" as const,
          effectiveObjective: index === 0 ? "geographic" as const : "balanced" as const,
          requestedWeights: weights(index === 0),
          effectiveWeights: weights(index === 0),
          vehicleDistributionMode: "balance" as const,
          vehicleSelectionMode: "use_all_selected_pairs" as const,
        },
      },
    })));

    const response = await post(appFor(organizationId), "/optimize/reoptimize", {
      organizationId,
      routeIds,
      routeRevisions: routeIds.map((routeId) => ({ routeId, planRevision: 4 })),
      reason: "mixed optimizer configuration regression",
    });
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /different effective optimization configurations/i);

    const savedRoutes = await db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId));
    assert.deepEqual(savedRoutes.map((route) => route.planRevision), [4, 4]);
  } finally {
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});


test("generic reoptimization rejects mixed protected and legacy selections atomically", async () => {
  const organizationId = randomUUID();
  const legacyVehicleId = randomUUID();
  const protectedVehicleId = randomUUID();
  const legacyRouteId = randomUUID();
  const protectedRouteId = randomUUID();
  const legacyStopId = randomUUID();
  const protectedStopId = randomUUID();
  const protectedDraftId = randomUUID();

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Protected generic reoptimization guard",
    email: `${organizationId}@generic-guard.test`,
  });
  try {
    await db.insert(vehiclesTable).values([
      {
        id: legacyVehicleId,
        organizationId,
        name: "Legacy guard vehicle",
        licensePlate: `LG-${legacyVehicleId.slice(0, 8)}`,
        capacityKg: 1_000,
        capacityVolume: 10,
      },
      {
        id: protectedVehicleId,
        organizationId,
        name: "Protected guard vehicle",
        licensePlate: `PG-${protectedVehicleId.slice(0, 8)}`,
        capacityKg: 1_000,
        capacityVolume: 10,
      },
    ]);
    await db.insert(routesTable).values([
      {
        id: legacyRouteId,
        organizationId,
        vehicleId: legacyVehicleId,
        name: "Legacy route",
        date: new Date("2026-09-08T00:00:00.000Z"),
        status: "optimized",
        totalStops: 1,
        planRevision: 3,
      },
      {
        id: protectedRouteId,
        organizationId,
        vehicleId: protectedVehicleId,
        draftId: protectedDraftId,
        name: "Protected route",
        date: new Date("2026-09-08T00:00:00.000Z"),
        status: "optimized",
        totalStops: 1,
        planRevision: 7,
      },
    ]);
    await db.insert(stopsTable).values([
      {
        id: legacyStopId,
        organizationId,
        routeId: legacyRouteId,
        address: "Legacy guard stop",
        latitude: 59.3293,
        longitude: 18.0686,
        status: "pending",
        sequenceOrder: 1,
        serviceDurationMin: 5,
      },
      {
        id: protectedStopId,
        organizationId,
        routeId: protectedRouteId,
        address: "Protected guard stop",
        latitude: 59.3393,
        longitude: 18.0786,
        status: "pending",
        sequenceOrder: 1,
        serviceDurationMin: 5,
      },
    ]);

    const beforeRoutes = await db.select().from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    const beforeStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));
    const response = await post(appFor(organizationId), "/optimize/reoptimize", {
      organizationId,
      routeIds: [legacyRouteId, protectedRouteId],
      routeRevisions: [
        { routeId: legacyRouteId, planRevision: 3 },
        { routeId: protectedRouteId, planRevision: 7 },
      ],
      reason: "mixed protected route guard regression",
    });
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /protected import routes.*protected import route reoptimization/i);

    const afterRoutes = await db.select().from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    const afterStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));
    assert.deepEqual(afterRoutes, beforeRoutes);
    assert.deepEqual(afterStops, beforeStops);
  } finally {
    await db.delete(notificationsTable).where(eq(notificationsTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("HTTP reoptimization preserves route planning reserves and refreshes unplanned evidence atomically", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const routeId = randomUUID();
  const plannedStopId = randomUUID();
  const heavyStopId = randomUUID();
  const date = new Date("2026-09-09T00:00:00.000Z");
  const planningSnapshot = {
    version: 1 as const,
    objective: "balanced" as const,
    travelReservePercent: 20,
    stopReserveMin: 20,
    stopPriorities: { [plannedStopId]: 0 as const, [heavyStopId]: 2 as const },
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const,
  };

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "HTTP reoptimization planning evidence test",
    email: `${organizationId}@planning-evidence.test`,
  });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Planning evidence vehicle",
      licensePlate: `PE-${vehicleId.slice(0, 8)}`,
      capacityKg: 10,
      capacityVolume: 10,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Planning evidence driver",
      workStartTime: "07:00:00",
      workEndTime: "16:00:00",
      isActive: true,
    });
    await db.insert(routesTable).values({
      id: routeId,
      organizationId,
      vehicleId,
      name: "Planning evidence route",
      date,
      status: "optimized",
      totalStops: 2,
      planRevision: 4,
      optimizationPlanningSnapshot: planningSnapshot,
      planningSummary: {
        complete: false,
        objective: "balanced",
        travelReservePercent: 0,
        stopReserveMin: 0,
        mandatoryUnplannedStopIds: [plannedStopId],
        selectedPairValues: [],
        usedPairValues: [],
        unusedPairValues: [],
        unplanned: [{
          stopId: plannedStopId,
          priority: 2,
          reason: "Stale planning evidence",
        }],
      },
    });
    await db.insert(stopsTable).values([
      {
        id: plannedStopId,
        organizationId,
        routeId,
        address: "Planning evidence planned stop",
        latitude: 59.3493,
        longitude: 18.0886,
        status: "pending",
        sequenceOrder: 1,
        serviceDurationMin: 5,
        weightKg: 1,
        unplannedReason: "Stale stop reason",
      },
      {
        id: heavyStopId,
        organizationId,
        routeId,
        address: "Planning evidence capacity stop",
        latitude: 59.3593,
        longitude: 18.0986,
        status: "pending",
        sequenceOrder: 2,
        serviceDurationMin: 5,
        weightKg: 100,
      },
    ]);

    const first = await post(appFor(organizationId), "/optimize/reoptimize", {
      organizationId,
      routeIds: [routeId],
      routeRevisions: [{ routeId, planRevision: 4 }],
      reason: "planning evidence capacity regression",
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));

    const [firstRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const firstStops = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    assert.equal(firstRoute.planningSummary?.travelReservePercent, 20);
    assert.equal(firstRoute.planningSummary?.stopReserveMin, 20);
    assert.ok((firstRoute.workdaySummary?.travelReserveMin ?? 0) > 0, JSON.stringify(firstRoute.workdaySummary));
    assert.ok((firstRoute.workdaySummary?.stopReserveMin ?? 0) > 0, JSON.stringify(firstRoute.workdaySummary));
    assert.ok(firstRoute.planningSummary?.unplanned.some((item) => item.stopId === heavyStopId));
    assert.equal(firstRoute.planningSummary?.optimizationEvidence?.source, "legacy");
    assert.deepEqual(firstRoute.planningSummary?.optimizationEvidence?.effectiveWeights, {
      distanceWeight: 0.45,
      co2Weight: 0.25,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    });
    assert.equal(firstRoute.planningSummary?.optimizationEvidence?.vehicleDistributionMode, "minimize");
    assert.equal(firstStops.find((stop) => stop.id === heavyStopId)?.routeId, null);
    assert.match(
      firstStops.find((stop) => stop.id === heavyStopId)?.unplannedReason ?? "",
      /kapacitet|planeringsvillkor/i,
    );
    assert.equal(firstStops.find((stop) => stop.id === plannedStopId)?.unplannedReason, null);

    await db.update(stopsTable)
      .set({ weightKg: 1 })
      .where(eq(stopsTable.id, heavyStopId));
    const second = await post(appFor(organizationId), "/optimize/reoptimize", {
      organizationId,
      routeIds: [routeId],
      routeRevisions: [{ routeId, planRevision: firstRoute.planRevision }],
      reason: "planning evidence recovery regression",
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));

    const [secondRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const secondStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));
    assert.deepEqual(secondRoute.planningSummary?.unplanned, []);
    assert.equal(secondRoute.planningSummary?.complete, true);
    assert.equal(secondRoute.planningSummary?.optimizationEvidence?.source, "legacy");
    assert.deepEqual(secondRoute.planningSummary?.optimizationEvidence?.effectiveWeights, {
      distanceWeight: 0.45,
      co2Weight: 0.25,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    });
    assert.equal(
      secondStops.find((stop) => stop.id === heavyStopId)?.unplannedReason,
      null,
      JSON.stringify({ body: second.body, summary: secondRoute.planningSummary }),
    );
    assert.equal(secondStops.find((stop) => stop.id === heavyStopId)?.routeId, routeId);
  } finally {
    await db.delete(notificationsTable).where(eq(notificationsTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("ordinary HTTP optimization returns concrete capacity, time-window, and working-time reasons", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const feasibleStopId = randomUUID();
  const capacityStopId = randomUUID();
  const timeWindowStopId = randomUUID();
  const workingTimeStopId = randomUUID();
  const stopIds = [feasibleStopId, capacityStopId, timeWindowStopId, workingTimeStopId];
  const date = new Date("2026-09-10T00:00:00.000Z");
  const planningInputs = {
    version: 1 as const,
    objective: "balanced" as const,
    travelReservePercent: 20,
    stopReserveMin: 20,
    stopPriorities: {
      [feasibleStopId]: 0 as const,
      [capacityStopId]: 1 as const,
      [timeWindowStopId]: 1 as const,
      [workingTimeStopId]: 2 as const,
    },
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const,
  };

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Ordinary optimization diagnostics test",
    email: `${organizationId}@ordinary-diagnostics.test`,
  });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Ordinary diagnostics vehicle",
      licensePlate: `OD-${vehicleId.slice(0, 8)}`,
      capacityKg: 10,
      capacityVolume: 10,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Ordinary diagnostics driver",
      workStartTime: "07:00:00",
      workEndTime: "08:00:00",
      isActive: true,
    });
    await db.insert(stopsTable).values([
      {
        id: feasibleStopId,
        organizationId,
        address: "Ordinary diagnostics feasible stop",
        latitude: 59.3493,
        longitude: 18.0886,
        status: "pending",
        serviceDurationMin: 5,
        weightKg: 1,
      },
      {
        id: capacityStopId,
        organizationId,
        address: "Ordinary diagnostics capacity stop",
        latitude: 59.3593,
        longitude: 18.0986,
        status: "pending",
        serviceDurationMin: 5,
        weightKg: 100,
      },
      {
        id: timeWindowStopId,
        organizationId,
        address: "Ordinary diagnostics time-window stop",
        latitude: 59.3693,
        longitude: 18.1086,
        status: "pending",
        serviceDurationMin: 5,
        weightKg: 1,
        timeWindowEnd: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        id: workingTimeStopId,
        organizationId,
        address: "Ordinary diagnostics working-time stop",
        latitude: 59.3793,
        longitude: 18.1186,
        status: "pending",
        serviceDurationMin: 1_000,
        weightKg: 1,
      },
    ]);

    const response = await post(appFor(organizationId), "/optimize", {
      organizationId,
      vehicleIds: [vehicleId],
      stopIds,
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      date: date.toISOString(),
      timeBudgetMs: 1_000,
      planningInputs,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const reasonByStopId = new Map<string, {
      stopId: string;
      reasonCodes: string[];
      details: string[];
    }>(
      response.body.unassignedReasons.map((reason: {
        stopId: string;
        reasonCodes: string[];
        details: string[];
      }) => [reason.stopId, reason]),
    );
    assert.equal(reasonByStopId.get(capacityStopId)?.reasonCodes[0], "CAPACITY_EXCEEDED");
    assert.equal(reasonByStopId.get(timeWindowStopId)?.reasonCodes[0], "TIME_WINDOW_UNREACHABLE");
    assert.equal(
      reasonByStopId.get(workingTimeStopId)?.reasonCodes[0],
      "WORKING_TIME_OR_TIME_WINDOW_EXCEEDED",
    );
    for (const stopId of [capacityStopId, timeWindowStopId, workingTimeStopId]) {
      assert.ok(reasonByStopId.get(stopId)?.details[0]);
    }

    const [savedRoute] = await db.select().from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    assert.ok(savedRoute);
    assert.deepEqual(savedRoute.optimizationPlanningSnapshot, planningInputs);
    assert.equal(savedRoute.planningSummary?.travelReservePercent, 20);
    assert.equal(savedRoute.planningSummary?.stopReserveMin, 20);
    assert.deepEqual(
      new Set(savedRoute.planningSummary?.unplanned.map((item) => item.stopId)),
      new Set([capacityStopId, timeWindowStopId, workingTimeStopId]),
    );

    const savedStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));
    for (const stopId of [capacityStopId, timeWindowStopId, workingTimeStopId]) {
      assert.ok(savedStops.find((stop) => stop.id === stopId)?.unplannedReason);
    }
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});