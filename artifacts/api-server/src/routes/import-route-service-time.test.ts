import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  driverCertificationsTable,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser, UserRole } from "../middleware/auth";
import {
  createImportRoutePlan,
  planningSummaryForResponse,
  type PlanningInputsV1,
  reoptimizeImportRoutePlanPlanningInputs,
  reoptimizeImportRoutePlanServiceTime,
  setServiceTimeReoptimizationBeforePersistHookForTest,
  updatePlanSharedInstructions,
} from "../services/import-route-workflow";
import importRouteWorkflowRouter from "./import-route-workflow";

function appFor(organizationId: string, role: UserRole = "dispatcher"): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Service time test",
      email: "service-time@example.test",
      role,
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(importRouteWorkflowRouter);
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
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function get(
  app: Express,
  path: string,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("service-time endpoint keeps tenant, plan, rows, stop IDs, and resources atomic", async () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const planId = randomUUID();
  const routeId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopIds = [randomUUID(), randomUUID()];
  const depotLatitude = 59.3293;
  const depotLongitude = 18.0686;
  const depotSnapshot = {
    start: { address: "Verified start", latitude: depotLatitude, longitude: depotLongitude, verifiedAt: "2026-01-01T00:00:00.000Z", verification: { provider: "test" } },
    end: { address: "Verified end", latitude: depotLatitude, longitude: depotLongitude, verifiedAt: "2026-01-01T00:00:00.000Z", verification: { provider: "test" } },
  };
  const planningInputs = {
    version: 1 as const,
    objective: "geographic" as const,
    travelReservePercent: 0,
    stopReserveMin: 0,
    stopPriorities: {},
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const,
  };

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Service-time endpoint test",
      email: `${organizationId}@example.test`,
    },
    {
      id: otherOrganizationId,
      name: "Other service-time tenant",
      email: `${otherOrganizationId}@example.test`,
    },
  ]);
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Existing service-time vehicle",
      licensePlate: `ST-${vehicleId.slice(0, 8)}`,
      capacityKg: 10_000,
      capacityVolume: 100,
      isActive: true,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Existing service-time driver",
      startLatitude: depotLatitude,
      startLongitude: depotLongitude,
      isActive: true,
    });
    await db.insert(routesTable).values({
      id: routeId,
      planId,
      organizationId,
      vehicleId,
      name: "Existing imported plan",
      date: new Date("2026-10-12T08:00:00.000Z"),
      status: "optimized",
      planRevision: 4,
      totalStops: 2,
      handoffStatus: "accepted",
      handoffVersion: 4,
      handoffDriverId: driverId,
      acceptedAt: new Date(),
      depotSnapshot,
      optimizationPlanningSnapshot: planningInputs,
      planningSummary: {
        complete: true,
        objective: "geographic" as const,
        travelReservePercent: 0,
        stopReserveMin: 0,
        mandatoryUnplannedStopIds: [],
        selectedPairValues: [`${vehicleId}:${driverId}`],
        usedPairValues: [`${vehicleId}:${driverId}`],
        unusedPairValues: [],
        unplanned: [],
      },
      optimizationResourceSnapshot: { driver: { id: driverId } },
    });
    await db.insert(stopsTable).values(stopIds.map((id, index) => ({
      id,
      organizationId,
      routeId,
      sequenceOrder: index + 1,
      address: `Service time stop ${index + 1}`,
      latitude: depotLatitude + 0.002 + index * 0.001,
      longitude: depotLongitude + 0.002 + index * 0.001,
      serviceDurationMin: index === 0 ? 5 : 12,
      weightKg: 10,
      volumeM3: 0.1,
      status: "pending" as const,
    })));

    const requestBody = {
      serviceDurationMin: 8,
      serviceTimeStrategy: "preserve_individual",
      routes: [{ routeId, driverId, planRevision: 4 }],
      depotLatitude,
      depotLongitude,
    };
    const [historicalRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.equal(historicalRoute.planningSummary?.optimizationEvidence, undefined);
    assert.equal(
      (planningSummaryForResponse(historicalRoute.planningSummary) as any)
        ?.optimizationEvidence?.source,
      "unknown",
    );
    const beforeCount = (await db.select({ id: stopsTable.id }).from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))).length;
    const wrongPlan = await post(
      appFor(organizationId),
      `/import/route-plans/${randomUUID()}/reoptimize-service-time`,
      requestBody,
    );
    assert.equal(wrongPlan.status, 409);
    const success = await post(
      appFor(organizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      requestBody,
    );
     assert.equal(success.status, 200);
    assert.equal(success.body.routes[0].routeId, routeId);
    assert.equal(success.body.routes[0].vehicleId, vehicleId);
    assert.equal(success.body.routes[0].driverId, driverId);

    const savedStops = await db.select({
      id: stopsTable.id,
      serviceDurationMin: stopsTable.serviceDurationMin,
    }).from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))
      .orderBy(asc(stopsTable.id));
    assert.equal(
      (await db.select({ id: stopsTable.id }).from(stopsTable)
        .where(eq(stopsTable.organizationId, organizationId))).length,
      beforeCount,
    );
    assert.deepEqual(
      savedStops.map((stop) => stop.id),
      [...stopIds].sort(),
    );
    assert.deepEqual(
      savedStops.map((stop) => stop.serviceDurationMin).sort((a, b) => a - b),
      [8, 12],
    );
    const [savedRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.equal(savedRoute.vehicleId, vehicleId);
    assert.equal(savedRoute.planRevision, 5);
    assert.equal(savedRoute.planningSummary?.optimizationEvidence?.source, "legacy");
    assert.equal(savedRoute.planningSummary?.optimizationEvidence?.requestedObjective, null);
    assert.equal(savedRoute.planningSummary?.optimizationEvidence?.effectiveObjective, null);
    assert.deepEqual(savedRoute.planningSummary?.optimizationEvidence?.effectiveWeights, {
      distanceWeight: 0.45,
      co2Weight: 0.25,
      etaPrecisionWeight: 0.15,
      driverHappinessWeight: 0.15,
      geographicCohesionWeight: 0,
    });
    assert.equal(savedRoute.planningSummary?.optimizationEvidence?.vehicleDistributionMode, "balance");
    assert.equal(savedRoute.handoffStatus, "pending");
    assert.equal(savedRoute.handoffDriverId, null);
    assert.deepEqual(
      savedRoute.plannerItinerary
        ?.filter((entry) => !entry.isChargingStop)
        .map((entry) => entry.stopId)
        .sort(),
      [...stopIds].sort(),
    );
    await db
      .update(stopsTable)
      .set({ status: "in_progress" })
      .where(eq(stopsTable.id, stopIds[0]));
    const lockedBefore = await db
      .select({
        id: stopsTable.id,
        status: stopsTable.status,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
        serviceDurationMin: stopsTable.serviceDurationMin,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))
      .orderBy(asc(stopsTable.id));
    const lockedResponse = await post(
      appFor(organizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      { ...requestBody, routes: [{ routeId, driverId, planRevision: 5 }] },
    );
    assert.equal(lockedResponse.status, 409);
    assert.match(String(lockedResponse.body.error), /pågående eller avslutade stopp/i);
    const lockedAfter = await db
      .select({
        id: stopsTable.id,
        status: stopsTable.status,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
        serviceDurationMin: stopsTable.serviceDurationMin,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))
      .orderBy(asc(stopsTable.id));
    assert.deepEqual(lockedAfter, lockedBefore);

    const persistedBeforeConflicts = {
      stops: savedStops,
      revision: savedRoute.planRevision,
      itinerary: savedRoute.plannerItinerary,
    };
    const stale = await post(
      appFor(organizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      requestBody,
    );
    assert.equal(stale.status, 409);
    const crossTenant = await post(
      appFor(otherOrganizationId),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      { ...requestBody, routes: [{ routeId, driverId, planRevision: 5 }] },
    );
    assert.equal(crossTenant.status, 409);
    const forbidden = await post(
      appFor(organizationId, "viewer"),
      `/import/route-plans/${planId}/reoptimize-service-time`,
      { ...requestBody, routes: [{ routeId, driverId, planRevision: 5 }] },
    );
    assert.equal(forbidden.status, 403);

    const stopsAfterConflicts = await db.select({
      id: stopsTable.id,
      serviceDurationMin: stopsTable.serviceDurationMin,
    }).from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))
      .orderBy(asc(stopsTable.id));
    const [routeAfterConflicts] = await db.select().from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.deepEqual(stopsAfterConflicts, persistedBeforeConflicts.stops);
    assert.equal(routeAfterConflicts.planRevision, persistedBeforeConflicts.revision);
    assert.deepEqual(routeAfterConflicts.plannerItinerary, persistedBeforeConflicts.itinerary);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
  }
});

test("service-time reoptimization rejects concurrent optimization-input changes without partial plan writes", async (t) => {
  for (const concurrentChange of [
    "stop",
    "certification",
    "vehicle-capacity",
    "driver-working-time",
    "draft-revision",
  ] as const) {
    await t.test(concurrentChange, async () => {
      const organizationId = randomUUID();
      const planId = randomUUID();
      const routeId = randomUUID();
      const vehicleId = randomUUID();
      const driverId = randomUUID();
      const stopIds = [randomUUID(), randomUUID()];
      const certificationId = randomUUID();
      const draftId = randomUUID();
      const depotLatitude = 59.3293;
      const depotLongitude = 18.0686;
      const planningInputs = {
        version: 1 as const,
        objective: "balanced" as const,
        travelReservePercent: 0,
        stopReserveMin: 0,
        stopPriorities: {},
        excludedPairValues: [],
        depotOverride: null,
        vehicleSelectionMode: "use_all_selected_pairs" as const,
      };
      const depotSnapshot = {
        start: { address: "Verified start", latitude: depotLatitude, longitude: depotLongitude, verifiedAt: "2026-01-01T00:00:00.000Z", verification: { provider: "test" } },
        end: { address: "Verified end", latitude: depotLatitude, longitude: depotLongitude, verifiedAt: "2026-01-01T00:00:00.000Z", verification: { provider: "test" } },
      };
      let releaseOptimization!: () => void;
      let signalOptimizationPaused!: () => void;
      const optimizationPaused = new Promise<void>((resolve) => {
        signalOptimizationPaused = resolve;
      });
      const optimizationRelease = new Promise<void>((resolve) => {
        releaseOptimization = resolve;
      });

      await db.insert(organizationsTable).values({
        id: organizationId,
        name: `Concurrent ${concurrentChange} test`,
        email: `${organizationId}@example.test`,
      });
      try {
        await db.insert(vehiclesTable).values({
          id: vehicleId,
          organizationId,
          name: "Concurrent test vehicle",
          licensePlate: `CC-${vehicleId.slice(0, 8)}`,
          capacityKg: 10_000,
          capacityVolume: 100,
          isActive: true,
        });
        await db.insert(driversTable).values({
          id: driverId,
          organizationId,
          vehicleId,
          name: "Concurrent test driver",
          startLatitude: depotLatitude,
          startLongitude: depotLongitude,
          driverRole: "technician",
          isActive: true,
        });
        await db.insert(driverCertificationsTable).values({
          id: certificationId,
          organizationId,
          driverId,
          certificationCode: "ADR",
          certificationName: "ADR",
          issuedAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        });
        await db.insert(planningDraftsTable).values({
          id: draftId,
          organizationId,
          name: "Concurrent protected draft",
          startAt: new Date("2026-10-12T08:00:00.000Z"),
          revision: 1,
          planId,
          state: { planningInputs },
        });
        const originalItinerary = stopIds.map((stopId, index) => ({
          stopId,
          sequenceOrder: index + 1,
          estimatedArrival: `2026-10-12T0${8 + index}:00:00.000Z`,
          distanceFromPreviousKm: index + 1,
        }));
        await db.insert(routesTable).values({
          id: routeId,
          planId,
          draftId,
          organizationId,
          vehicleId,
          name: "Concurrent imported plan",
          date: new Date("2026-10-12T08:00:00.000Z"),
          status: "optimized",
          planRevision: 7,
          totalStops: 2,
          plannerItinerary: originalItinerary,
          depotSnapshot,
          optimizationPlanningSnapshot: planningInputs,
          optimizationResourceSnapshot: { driver: { id: driverId } },
        });
        await db.insert(stopsTable).values(stopIds.map((id, index) => ({
          id,
          organizationId,
          routeId,
          sequenceOrder: index + 1,
          address: `Concurrent stop ${index + 1}`,
          latitude: depotLatitude + 0.002 + index * 0.001,
          longitude: depotLongitude + 0.002 + index * 0.001,
          serviceDurationMin: index === 0 ? 5 : 12,
          weightKg: 10,
          volumeM3: 0.1,
          status: "pending" as const,
          jobType: "field_service" as const,
          requiredCertifications: ["ADR"],
        })));

        const beforeStops = await db.select({
          id: stopsTable.id,
          routeId: stopsTable.routeId,
          sequenceOrder: stopsTable.sequenceOrder,
          serviceDurationMin: stopsTable.serviceDurationMin,
        }).from(stopsTable)
          .where(eq(stopsTable.organizationId, organizationId))
          .orderBy(asc(stopsTable.id));
        const [beforeRoute] = await db.select().from(routesTable)
          .where(eq(routesTable.id, routeId));

        setServiceTimeReoptimizationBeforePersistHookForTest(async () => {
          signalOptimizationPaused();
          await optimizationRelease;
        });
        const reoptimization = post(
          appFor(organizationId),
          concurrentChange === "draft-revision"
            ? `/import/route-plans/${planId}/reoptimize-planning-inputs`
            : `/import/route-plans/${planId}/reoptimize-service-time`,
          concurrentChange === "draft-revision" ? {
            draftId,
            draftRevision: 1,
            planningInputs,
          } : {
            serviceDurationMin: 8,
            serviceTimeStrategy: "preserve_individual",
            routes: [{ routeId, driverId, planRevision: 7 }],
            depotLatitude,
            depotLongitude,
          },
        );
        await optimizationPaused;

        switch (concurrentChange) {
          case "stop":
            await db.update(stopsTable).set({ weightKg: 25 })
              .where(eq(stopsTable.id, stopIds[0]));
            break;
          case "certification":
            await db.delete(driverCertificationsTable)
              .where(eq(driverCertificationsTable.id, certificationId));
            break;
          case "vehicle-capacity":
            await db.update(vehiclesTable).set({ capacityKg: 9_000 })
              .where(eq(vehiclesTable.id, vehicleId));
            break;
          case "driver-working-time":
            await db.update(driversTable).set({ workStartTime: "06:30:00" })
              .where(eq(driversTable.id, driverId));
            break;
          case "draft-revision":
            await db.update(planningDraftsTable).set({ revision: 2 })
              .where(eq(planningDraftsTable.id, draftId));
            break;
        }
        releaseOptimization();

        const response = await reoptimization;
        assert.equal(response.status, 409);

        const afterStops = await db.select({
          id: stopsTable.id,
          routeId: stopsTable.routeId,
          sequenceOrder: stopsTable.sequenceOrder,
          serviceDurationMin: stopsTable.serviceDurationMin,
        }).from(stopsTable)
          .where(eq(stopsTable.organizationId, organizationId))
          .orderBy(asc(stopsTable.id));
        const [afterRoute] = await db.select().from(routesTable)
          .where(eq(routesTable.id, routeId));
        assert.deepEqual(afterStops, beforeStops);
        assert.equal(afterRoute.planRevision, beforeRoute.planRevision);
        assert.equal(afterRoute.vehicleId, beforeRoute.vehicleId);
        assert.equal(afterRoute.totalStops, beforeRoute.totalStops);
        assert.deepEqual(afterRoute.plannerItinerary, beforeRoute.plannerItinerary);
        if (concurrentChange === "draft-revision") {
          const [draftAfter] = await db.select().from(planningDraftsTable)
            .where(eq(planningDraftsTable.id, draftId));
          assert.equal(draftAfter.revision, 2);
        }
      } finally {
        setServiceTimeReoptimizationBeforePersistHookForTest(undefined);
        releaseOptimization?.();
        await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
        await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
        await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
        await db.delete(driverCertificationsTable)
          .where(eq(driverCertificationsTable.organizationId, organizationId));
        await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
        await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
        await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
      }
    });
  }
});

test("instruction-only planning revision accepts a sparse priority map without driver coordinates", async () => {
  const organizationId = randomUUID();
  const planId = randomUUID();
  const draftId = randomUUID();
  const routeId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  const planningInputs = {
    version: 1 as const, objective: "balanced" as const, travelReservePercent: 0,
    stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [], depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const,
  };
  const depotSnapshot = {
    start: { address: "Verified start", latitude: 59.33, longitude: 18.07, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
    end: { address: "Verified end", latitude: 59.33, longitude: 18.07, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
  };
  await db.insert(organizationsTable).values({ id: organizationId, name: "Instruction revision", email: `${organizationId}@example.test` });
  try {
    await db.insert(vehiclesTable).values({ id: vehicleId, organizationId, name: "V", licensePlate: `IR-${vehicleId.slice(0, 8)}`, capacityKg: 1000, capacityVolume: 10, isActive: true });
    // Deliberately no start coordinates: this must not invoke route calculation.
    await db.insert(driversTable).values({ id: driverId, organizationId, vehicleId, name: "D", isActive: true });
    await db.insert(planningDraftsTable).values({ id: draftId, organizationId, name: "Draft", startAt: new Date("2026-10-12T08:00:00.000Z"), revision: 3, planId, state: { planningInputs } });
    await db.insert(routesTable).values({
      id: routeId, planId, draftId, organizationId, vehicleId, name: "Protected",
      date: new Date("2026-10-12T08:00:00.000Z"), status: "optimized", planRevision: 4,
      totalStops: 1, depotSnapshot, sharedInstructions: "Old",
      optimizationPlanningSnapshot: { ...planningInputs, stopPriorities: { [stopId]: 0 } },
      optimizationResourceSnapshot: { driver: { id: driverId } },
      planningSummary: {
        complete: true, objective: "balanced", travelReservePercent: 0, stopReserveMin: 0,
        mandatoryUnplannedStopIds: [], selectedPairValues: [`${vehicleId}:${driverId}`],
        usedPairValues: [`${vehicleId}:${driverId}`], unusedPairValues: [], unplanned: [],
      },
    });
    await db.insert(stopsTable).values({
      id: stopId, organizationId, routeId, planningPlanId: planId, planningDate: new Date("2026-10-12T08:00:00.000Z"),
      sequenceOrder: 1, address: "Stop", latitude: 59.34, longitude: 18.08,
      serviceDurationMin: 10, weightKg: 1, volumeM3: 0.1, status: "pending",
    });
    const response = await post(appFor(organizationId), `/import/route-plans/${planId}/reoptimize-planning-inputs`, {
      draftId, draftRevision: 3, planningInputs, sharedInstructions: null,
    });
    assert.equal(response.status, 200);
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.equal(route.sharedInstructions, null);
    assert.equal(route.planRevision, 5);
    const [draft] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId));
    assert.equal(draft.revision, 4);
    // A matching route snapshot must not hide a different persisted draft goal.
    await db.update(planningDraftsTable).set({
      state: { ...draft.state, planningInputs: { ...planningInputs, objective: "shortest" } },
    }).where(eq(planningDraftsTable.id, draftId));
    const mismatchedDraft = await updatePlanSharedInstructions(
      organizationId, planId, draftId, 4, null, planningInputs,
    );
    assert.equal(mismatchedDraft.needsReoptimization, true);
    const [unchangedDraft] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId));
    assert.equal(unchangedDraft.revision, 4);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("protected input reoptimization reuses an organization route depot outside the current plan", async () => {
  const organizationId = randomUUID();
  const planId = randomUUID();
  const draftId = randomUUID();
  const routeId = randomUUID();
  const sourceRouteId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  const date = new Date("2026-10-12T08:00:00.000Z");
  const sourceDepot = {
    start: { address: "Source start", latitude: 59.33, longitude: 18.07, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
    end: { address: "Source end", latitude: 59.34, longitude: 18.08, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
  };
  const baseInputs = {
    version: 1 as const, objective: "balanced" as const, travelReservePercent: 0,
    stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [], depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs" as const,
  };
  await db.insert(organizationsTable).values({ id: organizationId, name: "External depot", email: `${organizationId}@example.test` });
  try {
    await db.insert(vehiclesTable).values({ id: vehicleId, organizationId, name: "V", licensePlate: `ED-${vehicleId.slice(0, 8)}`, capacityKg: 1000, capacityVolume: 10, isActive: true });
    await db.insert(driversTable).values({ id: driverId, organizationId, vehicleId, name: "D", startLatitude: 59.33, startLongitude: 18.07, isActive: true });
    await db.insert(planningDraftsTable).values({ id: draftId, organizationId, name: "Draft", startAt: date, revision: 1, planId, state: { planningInputs: baseInputs } });
    await db.insert(routesTable).values([
      {
        id: routeId, planId, draftId, organizationId, vehicleId, name: "Target", date,
        status: "optimized", planRevision: 1, totalStops: 1,
        depotSnapshot: sourceDepot,
        optimizationPlanningSnapshot: { ...baseInputs, stopPriorities: { [stopId]: 0 } },
        optimizationResourceSnapshot: { driver: { id: driverId } },
        planningSummary: { complete: true, objective: "balanced", travelReservePercent: 0, stopReserveMin: 0, mandatoryUnplannedStopIds: [], selectedPairValues: [`${vehicleId}:${driverId}`], usedPairValues: [`${vehicleId}:${driverId}`], unusedPairValues: [], unplanned: [] },
      },
      {
        id: sourceRouteId, planId: randomUUID(), organizationId, vehicleId, name: "Verified historical source",
        date: new Date("2026-10-11T08:00:00.000Z"), status: "completed", planRevision: 1,
        totalStops: 0, depotSnapshot: sourceDepot,
      },
    ]);
    await db.insert(stopsTable).values({ id: stopId, organizationId, routeId, planningPlanId: planId, planningDate: date, sequenceOrder: 1, address: "Stop", latitude: 59.335, longitude: 18.075, serviceDurationMin: 10, weightKg: 1, volumeM3: 0.1, status: "pending" });
    const result = await reoptimizeImportRoutePlanPlanningInputs(organizationId, planId, {
      draftId, draftRevision: 1,
      planningInputs: { ...baseInputs, depotOverride: { scope: "plan", verifiedDepotId: `route:${sourceRouteId}` } },
    });
    assert.equal(result.routes.length, 1);
    const [saved] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.deepEqual(saved.depotSnapshot, sourceDepot);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("protected depot transitions restore immutable bases instead of retaining an old effective override", async () => {
  const organizationId = randomUUID();
  const draftId = randomUUID();
  const sourcePlanId = randomUUID();
  const vehicleIds = [randomUUID(), randomUUID()];
  const driverIds = [randomUUID(), randomUUID()];
  const sourceRouteIds = [randomUUID(), randomUUID()];
  const stopIds = [randomUUID(), randomUUID()];
  const date = new Date("2026-10-12T08:00:00.000Z");
  const base = { latitude: 59.3300, longitude: 18.0700 };
  const sourceDepots = [
    {
      start: { address: "Override A start", latitude: 59.4300, longitude: 18.1700, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
      end: { address: "Override A end", latitude: 59.4300, longitude: 18.1700, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
    },
    {
      start: { address: "Override B start", latitude: 59.5300, longitude: 18.2700, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
      end: { address: "Override B end", latitude: 59.5300, longitude: 18.2700, verifiedAt: "2026-01-01T00:00:00.000Z", verification: null },
    },
  ];
  const inputs: PlanningInputsV1 = {
    version: 1 as const, objective: "balanced" as const, travelReservePercent: 0,
    stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [],
    depotOverride: null, vehicleSelectionMode: "use_all_selected_pairs" as const,
  };
  await db.insert(organizationsTable).values({
    id: organizationId, name: "Depot transitions", email: `${organizationId}@example.test`,
    depotStartAddress: "Base start", depotStartLatitude: base.latitude, depotStartLongitude: base.longitude,
    depotStartVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    depotEndAddress: "Base end", depotEndLatitude: base.latitude, depotEndLongitude: base.longitude,
    depotEndVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  try {
    await db.insert(vehiclesTable).values(vehicleIds.map((id, index) => ({
      id, organizationId, name: `V${index}`, licensePlate: `DT-${id.slice(0, 8)}`,
      capacityKg: 1000, capacityVolume: 10, isActive: true,
    })));
    await db.insert(driversTable).values(driverIds.map((id, index) => ({
      id, organizationId, vehicleId: vehicleIds[index], name: `D${index}`,
      startLatitude: base.latitude, startLongitude: base.longitude, isActive: true,
    })));
    await db.insert(routesTable).values(sourceRouteIds.map((id, index) => ({
      id, planId: sourcePlanId, organizationId, vehicleId: vehicleIds[index],
      name: `Verified override ${index}`, date, status: "completed" as const, planRevision: 1,
      totalStops: 0, depotSnapshot: sourceDepots[index],
    })));
    await db.insert(planningDraftsTable).values({
      id: draftId, organizationId, name: "Depot draft", startAt: date, revision: 0,
      state: { planningInputs: inputs },
    });
    await db.insert(stopsTable).values(stopIds.map((id, index) => ({
      id, organizationId, address: `Stop ${index}`, latitude: 59.331 + index * .001,
      longitude: 18.071 + index * .001, serviceDurationMin: 10,
      weightKg: 1, volumeM3: .1, status: "pending" as const,
    })));
    const initial = await createImportRoutePlan(organizationId, {
      draftId, date, stopIds,
      pairs: vehicleIds.map((vehicleId, index) => ({ vehicleId, driverId: driverIds[index] })),
      depotLatitude: base.latitude, depotLongitude: base.longitude,
      planningInputs: {
        ...inputs,
        depotOverride: { scope: "plan", verifiedDepotId: `route:${sourceRouteIds[0]}` },
      },
    });
    const planId = initial.planId as string;
    const reoptimize = async (
      revision: number,
      depotOverride: PlanningInputsV1["depotOverride"],
    ) =>
      reoptimizeImportRoutePlanPlanningInputs(organizationId, planId, {
        draftId, draftRevision: revision, planningInputs: { ...inputs, depotOverride },
      });
    const savedByVehicle = async () => new Map((await db.select().from(routesTable).where(eq(
      routesTable.planId, planId,
    ))).map((route) => [route.vehicleId, route]));
    const assertDepotAndWorkday = (route: typeof routesTable.$inferSelect, expected: { latitude: number; longitude: number }) => {
      assert.equal(route.depotSnapshot?.start.latitude, expected.latitude);
      assert.equal(route.depotSnapshot?.start.longitude, expected.longitude);
      assert.equal(route.depotSnapshot?.end.latitude, expected.latitude);
      assert.equal(route.depotSnapshot?.end.longitude, expected.longitude);
      assert.ok(route.workdaySummary);
      assert.ok(route.workdaySummary.totalMin > route.workdaySummary.serviceMin);
      assert.ok(route.workdaySummary.returnMin >= 0);
    };

    // plan override -> none must use the original verified organization base,
    // rather than the prior plan-wide effective snapshot (override A).
    await reoptimize(0, null);
    for (const route of (await savedByVehicle()).values()) assertDepotAndWorkday(route, base);

    // pair A -> none must clear A's prior effective override too.
    await reoptimize(1, { scope: "pair", vehicleId: vehicleIds[0], verifiedDepotId: `route:${sourceRouteIds[0]}` });
    let afterPairA = await savedByVehicle();
    assertDepotAndWorkday(afterPairA.get(vehicleIds[0])!, sourceDepots[0].start);
    assertDepotAndWorkday(afterPairA.get(vehicleIds[1])!, base);
    await reoptimize(2, null);
    for (const route of (await savedByVehicle()).values()) assertDepotAndWorkday(route, base);

    // Retargeting A -> B must restore A's base and apply B's own verified
    // override; no route may inherit A's old effective depot.
    await reoptimize(3, { scope: "pair", vehicleId: vehicleIds[0], verifiedDepotId: `route:${sourceRouteIds[0]}` });
    await reoptimize(4, { scope: "pair", vehicleId: vehicleIds[1], verifiedDepotId: `route:${sourceRouteIds[1]}` });
    afterPairA = await savedByVehicle();
    assertDepotAndWorkday(afterPairA.get(vehicleIds[0])!, base);
    assertDepotAndWorkday(afterPairA.get(vehicleIds[1])!, sourceDepots[1].start);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("initial excluded pair is retained and can be re-added; excess selected pairs remain unused", async () => {
  const organizationId = randomUUID();
  const draftId = randomUUID();
  const vehicleIds = [randomUUID(), randomUUID()];
  const driverIds = [randomUUID(), randomUUID()];
  const stopId = randomUUID();
  const date = new Date("2026-10-12T08:00:00.000Z");
  const pairValues = vehicleIds.map((vehicleId, index) => `${vehicleId}:${driverIds[index]}`);
  const excludedInputs = {
    version: 1 as const, objective: "balanced" as const, travelReservePercent: 0,
    stopReserveMin: 0, stopPriorities: {}, excludedPairValues: [pairValues[1]],
    depotOverride: null, vehicleSelectionMode: "use_all_selected_pairs" as const,
  };
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Pair restore",
    email: `${organizationId}@example.test`,
    depotStartAddress: "Verified start",
    depotStartLatitude: 59.33,
    depotStartLongitude: 18.07,
    depotStartVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    depotStartVerification: { provider: "nominatim", source: "nominatim", displayName: "Verified start", query: "Verified start" },
    depotEndAddress: "Verified end",
    depotEndLatitude: 59.33,
    depotEndLongitude: 18.07,
    depotEndVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    depotEndVerification: { provider: "nominatim", source: "nominatim", displayName: "Verified end", query: "Verified end" },
  });
  try {
    await db.insert(vehiclesTable).values(vehicleIds.map((id, index) => ({
      id, organizationId, name: `V${index}`, licensePlate: `PR-${id.slice(0, 8)}`,
      capacityKg: 1000, capacityVolume: 10, isActive: true,
    })));
    await db.insert(driversTable).values(driverIds.map((id, index) => ({
      id, organizationId, vehicleId: vehicleIds[index], name: `D${index}`,
      startLatitude: 59.33, startLongitude: 18.07, isActive: true,
    })));
    await db.insert(planningDraftsTable).values({
      id: draftId, organizationId, name: "Pair draft", startAt: date, revision: 0,
      state: { planningInputs: excludedInputs },
    });
    await db.insert(stopsTable).values({
      id: stopId, organizationId, address: "Only stop", latitude: 59.335, longitude: 18.075,
      serviceDurationMin: 10, weightKg: 1, volumeM3: 0.1, status: "pending",
    });
    await createImportRoutePlan(organizationId, {
      draftId, date, stopIds: [stopId],
      pairs: vehicleIds.map((vehicleId, index) => ({ vehicleId, driverId: driverIds[index] })),
      depotLatitude: 59.33, depotLongitude: 18.07, planningInputs: excludedInputs,
    });
    const [createdDraft] = await db.select().from(planningDraftsTable)
      .where(eq(planningDraftsTable.id, draftId));
    assert.ok(createdDraft.planId);
    const [createdRoute] = await db.select().from(routesTable)
      .where(eq(routesTable.planId, createdDraft.planId));
    const createdSummary = createdRoute.planningSummary!;
    assert.deepEqual(createdSummary.selectedPairValues.sort(), [...pairValues].sort());
    assert.deepEqual(createdSummary.unusedPairValues.map((entry) => entry.pairValue), [pairValues[1]]);
    const reoptimized = await reoptimizeImportRoutePlanPlanningInputs(organizationId, createdDraft.planId, {
      draftId, draftRevision: createdDraft.revision,
      planningInputs: { ...excludedInputs, travelReservePercent: 10, excludedPairValues: [] },
    });
    assert.deepEqual(reoptimized.planningSummary.selectedPairValues.sort(), [...pairValues].sort());
    assert.equal(reoptimized.planningSummary.unusedPairValues.length, 1);
    assert.ok(pairValues.includes(reoptimized.planningSummary.unusedPairValues[0].pairValue));
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("persisted geographic evidence survives initial planning, profile reoptimization, and summary reopen", async () => {
  const organizationId = randomUUID();
  const draftId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  const date = new Date("2026-10-12T08:00:00.000Z");
  const pair = { vehicleId, driverId };
  const geographicInputs: PlanningInputsV1 = {
    version: 1,
    objective: "geographic",
    travelReservePercent: 0,
    stopReserveMin: 0,
    stopPriorities: {},
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs",
  };
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Optimization evidence",
    email: `${organizationId}@example.test`,
  });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Evidence vehicle",
      licensePlate: `OE-${vehicleId.slice(0, 8)}`,
      capacityKg: 1000,
      capacityVolume: 10,
      isActive: true,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Evidence driver",
      startLatitude: 59.33,
      startLongitude: 18.07,
      isActive: true,
    });
    await db.insert(planningDraftsTable).values({
      id: draftId,
      organizationId,
      name: "Evidence draft",
      startAt: date,
      revision: 0,
      state: { planningInputs: geographicInputs },
    });
    await db.insert(stopsTable).values({
      id: stopId,
      organizationId,
      address: "Evidence stop",
      latitude: 59.335,
      longitude: 18.075,
      serviceDurationMin: 10,
      weightKg: 1,
      volumeM3: 0.1,
      status: "pending",
    });

    const initial = await createImportRoutePlan(organizationId, {
      draftId,
      date,
      stopIds: [stopId],
      pairs: [pair],
      depotLatitude: 59.33,
      depotLongitude: 18.07,
      planningInputs: geographicInputs,
      // Legacy values deliberately disagree with the canonical profile.
      optimizationWeights: { distanceWeight: 1, geographicCohesionWeight: 0 },
      vehicleDistributionMode: "minimize",
    });
    const planId = initial.planId as string;
    const [initialRoute] = await db.select().from(routesTable).where(eq(routesTable.planId, planId));
    assert.equal(initialRoute.planningSummary?.optimizationEvidence?.source, "planningInputs");
    assert.equal(initialRoute.planningSummary?.optimizationEvidence?.effectiveObjective, "geographic");
    assert.equal(initialRoute.planningSummary?.optimizationEvidence?.effectiveWeights?.geographicCohesionWeight, 0.5);

    const [createdDraft] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId));
    const shortestInputs = { ...geographicInputs, objective: "shortest" as const };
    await reoptimizeImportRoutePlanPlanningInputs(organizationId, planId, {
      draftId,
      draftRevision: createdDraft.revision,
      planningInputs: shortestInputs,
    });
    const [reoptimizedRoute] = await db.select().from(routesTable).where(eq(routesTable.planId, planId));
    assert.equal(reoptimizedRoute.planningSummary?.optimizationEvidence?.source, "planningInputs");
    assert.equal(reoptimizedRoute.planningSummary?.optimizationEvidence?.effectiveObjective, "shortest");
    assert.equal(reoptimizedRoute.planningSummary?.optimizationEvidence?.effectiveWeights?.geographicCohesionWeight, 0);

    const reopened = await get(appFor(organizationId), `/import/route-plans/${planId}/planning-summary`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.planningSummary.optimizationEvidence.effectiveObjective, "shortest");
    const reopenedSummary = planningSummaryForResponse(reoptimizedRoute.planningSummary as any) as any;
    assert.equal(
      reopenedSummary.optimizationEvidence?.source,
      "planningInputs",
    );
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("legacy service-time reoptimization fails closed when a stop becomes unassigned", async () => {
  const organizationId = randomUUID();
  const planId = randomUUID();
  const routeId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  const date = new Date("2026-10-12T08:00:00.000Z");
  await db.insert(organizationsTable).values({ id: organizationId, name: "Legacy fail closed", email: `${organizationId}@example.test` });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId, organizationId, name: "Small vehicle", licensePlate: `LF-${vehicleId.slice(0, 8)}`,
      capacityKg: 100, capacityVolume: 1, isActive: true,
    });
    await db.insert(driversTable).values({
      id: driverId, organizationId, vehicleId, name: "Driver", startLatitude: 59.33,
      startLongitude: 18.07, isActive: true,
    });
    await db.insert(routesTable).values({
      id: routeId, planId, organizationId, vehicleId, name: "Legacy route", date,
      status: "optimized", planRevision: 7, totalStops: 1,
      depotSnapshot: {
        start: { address: "Verified start", latitude: 59.33, longitude: 18.07, verifiedAt: "2026-01-01T00:00:00.000Z", verification: { provider: "test" } },
        end: { address: "Verified end", latitude: 59.33, longitude: 18.07, verifiedAt: "2026-01-01T00:00:00.000Z", verification: { provider: "test" } },
      },
      optimizationPlanningSnapshot: {
        version: 1, objective: "balanced", travelReservePercent: 0, stopReserveMin: 0,
        stopPriorities: {}, excludedPairValues: [], depotOverride: null,
        vehicleSelectionMode: "use_all_selected_pairs",
      },
    });
    await db.insert(stopsTable).values({
      id: stopId, organizationId, routeId, planningPlanId: planId, planningDate: date,
      sequenceOrder: 1, address: "Too heavy", latitude: 59.335, longitude: 18.075,
      serviceDurationMin: 10, weightKg: 500, volumeM3: 0.1, status: "pending",
    });
    await assert.rejects(
      () => reoptimizeImportRoutePlanServiceTime(organizationId, planId, {
        serviceDurationMin: 15, serviceTimeStrategy: "replace_all",
        routes: [{ routeId, driverId, planRevision: 7 }],
        depotLatitude: 59.33, depotLongitude: 18.07,
      }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        return true;
      },
    );
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.equal(route.planRevision, 7);
    assert.equal(stop.routeId, routeId);
    assert.equal(stop.sequenceOrder, 1);
    assert.equal(stop.serviceDurationMin, 10);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});