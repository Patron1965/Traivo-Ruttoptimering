import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import {
  ApplyRouteReoptimizationResponse,
  PreviewRouteReoptimizationResponse,
} from "@workspace/api-zod";
import {
  applyRouteScopedReoptimization,
  ImportRouteWorkflowError,
  planningSummaryForResponse,
  previewRouteScopedReoptimization,
  setRouteScopedReoptimizationAfterLockHookForTest,
} from "./import-route-workflow";
import {
  assignStopForDispatch,
  DispatchRevisionConflictError,
  setDispatchMutationBeforeLockHookForTest,
} from "./stop-service";

const organizationId = randomUUID();
const vehicleId = randomUUID();
const driverId = randomUUID();
const routeId = randomUUID();
const otherRouteId = randomUUID();
const lockedStopId = randomUUID();
const pendingStopIds = [randomUUID(), randomUUID()];
const concurrentlyAssignedStopId = randomUUID();
const persistedDepotSnapshot = {
  start: {
    address: "Persisted start depot",
    latitude: 59.3,
    longitude: 18,
    verifiedAt: "2026-08-25T12:00:00.000Z",
    verification: { provider: "test" },
  },
  end: {
    address: "Persisted end depot",
    latitude: 59.31,
    longitude: 18.01,
    verifiedAt: "2026-08-25T12:00:00.000Z",
    verification: { provider: "test" },
  },
};
const organizationDepotSnapshot = {
  start: {
    address: "Organization start depot",
    latitude: 59.36,
    longitude: 18.1,
    verifiedAt: "2026-08-20T10:00:00.000Z",
    verification: { provider: "nominatim" },
  },
  end: {
    address: "Organization end depot",
    latitude: 59.37,
    longitude: 18.11,
    verifiedAt: "2026-08-20T10:00:00.000Z",
    verification: { provider: "nominatim" },
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
const geographicEvidence = {
  source: "planningInputs" as const,
  requestedObjective: "geographic" as const,
  effectiveObjective: "geographic" as const,
  requestedWeights: {
    distanceWeight: 0.25,
    co2Weight: 0.1,
    etaPrecisionWeight: 0.1,
    driverHappinessWeight: 0.05,
    geographicCohesionWeight: 0.5,
  },
  effectiveWeights: {
    distanceWeight: 0.25,
    co2Weight: 0.1,
    etaPrecisionWeight: 0.1,
    driverHappinessWeight: 0.05,
    geographicCohesionWeight: 0.5,
  },
  vehicleDistributionMode: "balance" as const,
  vehicleSelectionMode: "use_all_selected_pairs" as const,
};

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Route scoped reoptimization",
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Scoped vehicle",
    licensePlate: `SC-${vehicleId.slice(0, 6)}`,
    capacityKg: 1_000,
    capacityVolume: 10,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Scoped driver",
    isActive: true,
    workStartTime: "07:00:00",
    workEndTime: "18:00:00",
    startLatitude: 59.3293,
    startLongitude: 18.0686,
  });
  await db.insert(routesTable).values([
    {
      id: routeId,
      organizationId,
      vehicleId,
      name: "Selected route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      status: "optimized",
      planRevision: 2,
      totalStops: 3,
      depotSnapshot: persistedDepotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
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
    },
    {
      id: otherRouteId,
      organizationId,
      name: "Untouched route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      status: "optimized",
      planRevision: 9,
      totalStops: 0,
      depotSnapshot: persistedDepotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
    },
  ]);
  await db.insert(stopsTable).values([
    {
      id: lockedStopId,
      organizationId,
      routeId,
      address: "Locked stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "completed",
      sequenceOrder: 1,
      serviceDurationMin: 5,
    },
    ...pendingStopIds.map((id, index) => ({
      id,
      organizationId,
      routeId,
      address: `Pending stop ${index + 1}`,
      latitude: 59.34 + index * 0.005,
      longitude: 18.08 + index * 0.005,
      status: "pending" as const,
      sequenceOrder: index + 2,
      serviceDurationMin: 5,
    })),
    {
      id: concurrentlyAssignedStopId,
      organizationId,
      routeId: null,
      address: "Concurrently assigned stop",
      latitude: 59.35,
      longitude: 18.09,
      status: "pending",
      sequenceOrder: null,
      serviceDurationMin: 5,
    },
  ]);
});

after(async () => {
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

test("preview/apply only reorder pending stops and use route revision CAS", async () => {
  const input = {
    planRevision: 2,
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  };
  const preview = await previewRouteScopedReoptimization(organizationId, routeId, input);
  assert.equal(PreviewRouteReoptimizationResponse.safeParse(preview).success, true);
  assert.deepEqual(preview.lockedStopIds, [lockedStopId]);
  assert.deepEqual(new Set(preview.optimizedStopIds), new Set(pendingStopIds));
   assert.equal(preview.depotSnapshot?.start.address, persistedDepotSnapshot.start.address);
  assert.ok(preview.workdayTimeline);

  const [historicalRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
  assert.equal(historicalRoute.planningSummary?.optimizationEvidence, undefined);
  assert.equal(
    (planningSummaryForResponse(historicalRoute.planningSummary) as any)
      ?.optimizationEvidence?.source,
    "unknown",
  );

  const applied = await applyRouteScopedReoptimization(organizationId, routeId, {
    ...input,
    optimizedStopIds: preview.optimizedStopIds,
  });
  assert.equal(ApplyRouteReoptimizationResponse.safeParse(applied).success, true);
  assert.equal(applied.planRevision, 3);
  const [locked] = await db.select().from(stopsTable).where(eq(stopsTable.id, lockedStopId));
  assert.equal(locked.status, "completed");
  assert.equal(locked.sequenceOrder, 1);
  const [savedRoute] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
   assert.equal(savedRoute.depotSnapshot?.start.address, persistedDepotSnapshot.start.address);
  assert.ok(savedRoute.workdayTimeline);
  assert.ok(savedRoute.workdaySummary);
  assert.equal(savedRoute.planningSummary?.optimizationEvidence?.source, "legacy");
  assert.deepEqual(savedRoute.planningSummary?.optimizationEvidence?.effectiveWeights, {
    distanceWeight: 0.25,
    co2Weight: 0.1,
    etaPrecisionWeight: 0.1,
    driverHappinessWeight: 0.05,
    geographicCohesionWeight: 0.5,
  });
  assert.equal(savedRoute.planningSummary?.optimizationEvidence?.vehicleDistributionMode, "minimize");
  const [otherRoute] = await db.select().from(routesTable).where(eq(routesTable.id, otherRouteId));
  assert.equal(otherRoute.planRevision, 9);

  await assert.rejects(
    applyRouteScopedReoptimization(organizationId, routeId, {
      ...input,
      optimizedStopIds: preview.optimizedStopIds,
    }),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );
});

test("route-scoped apply and legacy dispatch assignment serialize on the same route lock", async () => {
  const [routeBefore] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
  await db
    .update(routesTable)
    .set({
      planningSummary: {
        ...routeBefore.planningSummary!,
        optimizationEvidence: geographicEvidence,
      },
    })
    .where(eq(routesTable.id, routeId));
  const input = {
    planRevision: 3,
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  };
  const preview = await previewRouteScopedReoptimization(organizationId, routeId, input);
  let signalLocked!: () => void;
  let releaseApply!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  let signalAssignmentSnapshot!: () => void;
  const assignmentSnapshotReady = new Promise<void>(resolve => {
    signalAssignmentSnapshot = resolve;
  });
  setDispatchMutationBeforeLockHookForTest(async () => { signalAssignmentSnapshot(); });
  setRouteScopedReoptimizationAfterLockHookForTest(async () => {
    signalLocked();
    await released;
  });

  try {
    const applyPromise = applyRouteScopedReoptimization(organizationId, routeId, {
      ...input,
      optimizedStopIds: preview.optimizedStopIds,
    });
    await locked;
    const assignmentPromise = assignStopForDispatch(
      concurrentlyAssignedStopId,
      organizationId,
      { routeId, sequenceOrder: 4 },
    );
    await assignmentSnapshotReady;
    releaseApply();

    const [applyResult, assignmentResult] = await Promise.allSettled([
      applyPromise,
      assignmentPromise,
    ]);
    assert.equal(applyResult.status, "fulfilled");
    assert.equal(
      applyResult.status === "fulfilled" ? applyResult.value.planRevision : null,
      4,
    );
    assert.equal(assignmentResult.status, "rejected");
    assert.ok(assignmentResult.status === "rejected" &&
      assignmentResult.reason instanceof DispatchRevisionConflictError);

    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.equal(route.planRevision, 4);
    assert.equal(route.planningSummary?.optimizationEvidence?.source, "planningInputs");
    assert.equal(route.planningSummary?.optimizationEvidence?.effectiveObjective, "geographic");
    assert.deepEqual(route.planningSummary?.optimizationEvidence?.effectiveWeights, geographicEvidence.effectiveWeights);
    assert.equal(route.planningSummary?.optimizationEvidence?.vehicleDistributionMode, "minimize");

    const orderedStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.routeId, routeId));
    const orderedIds = orderedStops
      .sort((left, right) => (left.sequenceOrder ?? 0) - (right.sequenceOrder ?? 0))
      .map((stop) => stop.id);
    assert.deepEqual(orderedIds, [
      lockedStopId,
      ...preview.optimizedStopIds,
    ]);
    const [unassignedStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, concurrentlyAssignedStopId));
    assert.equal(unassignedStop.routeId, null);
  } finally {
    releaseApply();
    setRouteScopedReoptimizationAfterLockHookForTest(undefined);
    setDispatchMutationBeforeLockHookForTest(undefined);
  }
});

test("route-scoped apply rejects concurrent vehicle and driver profile changes without writes", async (t) => {
  for (const concurrentChange of ["vehicle-capacity", "driver-working-time"] as const) {
    await t.test(concurrentChange, async () => {
      const [routeBefore] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
      const stopsBefore = await db.select().from(stopsTable)
        .where(eq(stopsTable.routeId, routeId));
      const input = {
        planRevision: routeBefore.planRevision,
        depotLatitude: 59.3293,
        depotLongitude: 18.0686,
      };
      const preview = await previewRouteScopedReoptimization(organizationId, routeId, input);
      let signalLocked!: () => void;
      let releaseApply!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseApply = resolve;
      });
      setRouteScopedReoptimizationAfterLockHookForTest(async () => {
        signalLocked();
        await released;
      });

      try {
        const applyPromise = applyRouteScopedReoptimization(organizationId, routeId, {
          ...input,
          optimizedStopIds: preview.optimizedStopIds,
        });
        await locked;
        if (concurrentChange === "vehicle-capacity") {
          await db.update(vehiclesTable).set({ capacityKg: 900 })
            .where(eq(vehiclesTable.id, vehicleId));
        } else {
          await db.update(driversTable).set({ workStartTime: "06:30:00" })
            .where(eq(driversTable.id, driverId));
        }
        releaseApply();

        await assert.rejects(
          applyPromise,
          (error: unknown) =>
            error instanceof ImportRouteWorkflowError && error.statusCode === 409,
        );
        const [routeAfter] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
        const stopsAfter = await db.select().from(stopsTable)
          .where(eq(stopsTable.routeId, routeId));
        assert.equal(routeAfter.planRevision, routeBefore.planRevision);
        assert.deepEqual(routeAfter.plannerItinerary, routeBefore.plannerItinerary);
        assert.deepEqual(
          stopsAfter
            .map((stop) => [stop.id, stop.sequenceOrder])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
          stopsBefore
            .map((stop) => [stop.id, stop.sequenceOrder])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
        );
      } finally {
        releaseApply();
        setRouteScopedReoptimizationAfterLockHookForTest(undefined);
        if (concurrentChange === "vehicle-capacity") {
          await db.update(vehiclesTable).set({ capacityKg: 1_000 })
            .where(eq(vehiclesTable.id, vehicleId));
        } else {
          await db.update(driversTable).set({ workStartTime: "07:00:00" })
            .where(eq(driversTable.id, driverId));
        }
      }
    });
  }
});

test("route snapshot takes priority over the currently verified organization depot", async () => {
  const verifiedAt = new Date("2026-08-20T10:00:00.000Z");
  const routeDepotSnapshot = {
    start: {
      address: "Route start depot",
      latitude: 59.328,
      longitude: 18.067,
      verifiedAt: verifiedAt.toISOString(),
      verification: {
        provider: "nominatim" as const,
        source: "nominatim" as const,
        displayName: "Route start depot",
        query: "Route start depot",
      },
    },
    end: {
      address: "Route end depot",
      latitude: 59.327,
      longitude: 18.066,
      verifiedAt: verifiedAt.toISOString(),
      verification: {
        provider: "nominatim" as const,
        source: "nominatim" as const,
        displayName: "Route end depot",
        query: "Route end depot",
      },
    },
  };
  await db.update(organizationsTable).set({
    depotStartAddress: "Organization start depot",
    depotStartLatitude: 59.36,
    depotStartLongitude: 18.1,
    depotStartVerifiedAt: verifiedAt,
    depotStartVerification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "Organization start depot",
      query: "Organization start depot",
    },
    depotEndAddress: "Organization end depot",
    depotEndLatitude: 59.37,
    depotEndLongitude: 18.11,
    depotEndVerifiedAt: verifiedAt,
    depotEndVerification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "Organization end depot",
      query: "Organization end depot",
    },
  }).where(eq(organizationsTable.id, organizationId));
  await db.update(routesTable).set({ depotSnapshot: routeDepotSnapshot })
    .where(eq(routesTable.id, routeId));
  const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));

  const preview = await previewRouteScopedReoptimization(organizationId, routeId, {
    planRevision: route.planRevision,
    depotLatitude: 60,
    depotLongitude: 19,
  });

  assert.equal(preview.depotSnapshot?.start.address, "Route start depot");
  assert.equal(preview.depotSnapshot?.end.address, "Route end depot");
  assert.ok(preview.workdayTimeline);
  assert.ok(preview.workdayTimeline.length > 0);
  assert.equal(
    preview.workdayTimeline.at(-1)?.type,
    "depot_end",
  );
});

test("persisted verified organization depot evidence is retained atomically", async () => {
  await db.update(routesTable).set({ depotSnapshot: organizationDepotSnapshot })
    .where(eq(routesTable.id, routeId));
  const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
  const input = {
    planRevision: route.planRevision,
    depotLatitude: 60,
    depotLongitude: 19,
  };
  const preview = await previewRouteScopedReoptimization(organizationId, routeId, input);
  assert.equal(preview.depotSnapshot?.start.address, "Organization start depot");

  const applied = await applyRouteScopedReoptimization(organizationId, routeId, {
    ...input,
    optimizedStopIds: preview.optimizedStopIds,
  });
  const [saved] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));

  assert.equal(applied.depotSnapshot?.start.address, "Organization start depot");
  assert.deepEqual(saved.depotSnapshot?.start.address, "Organization start depot");
  assert.ok(preview.workdayTimeline);
  assert.ok(preview.workdaySummary);
  assert.deepEqual(
    saved.workdayTimeline,
    JSON.parse(JSON.stringify(preview.workdayTimeline.map((event) => ({
      ...event,
      startAt: new Date(event.startAt).toISOString(),
      endAt: new Date(event.endAt).toISOString(),
    })))),
  );
  assert.equal(saved.workdaySummary?.totalMin, preview.workdaySummary.totalMin);
  const appliedHttpJson = JSON.parse(JSON.stringify(applied));
  assert.deepEqual(saved.plannerItinerary, appliedHttpJson.plannerItinerary);
  assert.ok(appliedHttpJson.plannerItinerary.every(
    (stop: { estimatedArrival: unknown }) => typeof stop.estimatedArrival === "string",
  ));
  assert.equal(saved.totalStops, 3);
  assert.equal(saved.totalDistanceKm, applied.totalDistanceKm);
  assert.equal(saved.totalDurationMin, applied.totalDurationMin);
  assert.equal(saved.co2EmissionsKg, applied.co2EmissionsKg);
});