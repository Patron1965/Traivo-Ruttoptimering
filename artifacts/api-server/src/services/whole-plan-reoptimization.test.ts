import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import {
  applyWholePlanReoptimization,
  ImportRouteWorkflowError,
  previewWholePlanReoptimization,
  serviceDurationsForReoptimization,
} from "./import-route-workflow";

const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const planId = randomUUID();
const draftId = randomUUID();
const date = new Date("2026-10-12T08:00:00.000Z");
const vehicleIds = [randomUUID(), randomUUID()];
const driverIds = [randomUUID(), randomUUID()];
const routeIds = [randomUUID(), randomUUID()];
const stopIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const depotSnapshot = {
  start: {
    address: "Test depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
  end: {
    address: "Test depot",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { provider: "test" },
  },
};
const planningInputs = {
  version: 1 as const,
  objective: "geographic" as const,
  travelReservePercent: 0,
  stopReserveMin: 0,
  stopPriorities: Object.fromEntries(
    stopIds.map((id, index) => [
      id,
      (index === 1 ? 1 : index === 2 ? 2 : 0) as 0 | 1 | 2,
    ]),
  ),
  excludedPairValues: [],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs" as const,
};

const inputFor = (revision = 1, draftRevision = 1) => ({
  draftId,
  draftRevision,
  routes: routeIds.map((routeId, index) => ({
    routeId,
    driverId: driverIds[index],
    planRevision: revision,
  })),
  pairs: vehicleIds.map((vehicleId, index) => ({
    vehicleId,
    driverId: driverIds[index],
  })),
  depotLatitude: depotSnapshot.start.latitude,
  depotLongitude: depotSnapshot.start.longitude,
});

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Whole-plan reoptimization",
      email: `${organizationId}@example.test`,
    },
    {
      id: foreignOrganizationId,
      name: "Foreign whole-plan organization",
      email: `${foreignOrganizationId}@example.test`,
    },
  ]);
  await db.insert(vehiclesTable).values(
    vehicleIds.map((id, index) => ({
      id,
      organizationId,
      name: `Whole-plan vehicle ${index}`,
      licensePlate: `WP-${id.slice(0, 6)}`,
      capacityKg: 1000,
      capacityVolume: 10,
      isActive: true,
    })),
  );
  await db.insert(driversTable).values(
    driverIds.map((id, index) => ({
      id,
      organizationId,
      vehicleId: vehicleIds[index],
      name: `Whole-plan driver ${index}`,
      isActive: true,
      workStartTime: "07:00:00",
      workEndTime: "18:00:00",
      startLatitude: 59.3293,
      startLongitude: 18.0686,
    })),
  );
  await db.insert(planningDraftsTable).values({
    id: draftId,
    organizationId,
    name: "Protected whole plan",
    startAt: date,
    revision: 1,
    planId,
    state: { planningInputs },
  });
  await db.insert(routesTable).values(
    routeIds.map((id, index) => ({
      id,
      planId,
      draftId,
      organizationId,
      vehicleId: vehicleIds[index],
      name: `Whole-plan route ${index}`,
      date,
      status: "optimized" as const,
      planRevision: 1,
      totalStops: 2,
      totalDistanceKm: 20,
      totalDurationMin: 60,
      depotSnapshot,
      optimizationPlanningSnapshot: {
        ...planningInputs,
        stopPriorities: Object.fromEntries(
          stopIds.slice(index * 2, index * 2 + 2).map((stopId) => [stopId, 0 as const]),
        ),
      },
      optimizationResourceSnapshot: { driver: { id: driverIds[index] } },
      planningSummary: {
        complete: true,
        objective: "geographic" as const,
        travelReservePercent: 0,
        stopReserveMin: 0,
        mandatoryUnplannedStopIds: [],
        selectedPairValues: vehicleIds.map(
          (vehicleId, pairIndex) => `${vehicleId}:${driverIds[pairIndex]}`,
        ),
        usedPairValues: [`${vehicleIds[index]}:${driverIds[index]}`],
        unusedPairValues: [],
        unplanned: [],
      },
    })),
  );
  await db.insert(stopsTable).values(
    stopIds.map((id, index) => ({
      id,
      organizationId,
      routeId: routeIds[Math.floor(index / 2)],
      planningPlanId: planId,
      planningDate: date,
      sequenceOrder: (index % 2) + 1,
      address: `Whole-plan stop ${index}`,
      latitude: 59.33 + index * 0.002,
      longitude: 18.07 + index * 0.002,
       serviceDurationMin: index === 0 ? 5 : 10,
       priority: index === 1 ? 1 : index === 2 ? 2 : 0,
      weightKg: 1,
      volumeM3: 0.1,
      status: "pending" as const,
    })),
  );
});

after(async () => {
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(
    and(
      eq(organizationsTable.id, organizationId),
    ),
  );
  await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
});

test("lock-aware whole-plan preview accepts a pinned route without mutating its persisted pin", async () => {
  await db
    .update(routesTable)
    .set({ lockedFirstStopId: stopIds[0] })
    .where(eq(routesTable.id, routeIds[0]));
  try {
    const before = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)).orderBy(stopsTable.id);
    const preview = await previewWholePlanReoptimization(organizationId, planId, inputFor());
    assert.equal(preview.proposalHash.length, 64);
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeIds[0]));
    assert.equal(route.lockedFirstStopId, stopIds[0]);
    assert.equal(route.vehicleId, vehicleIds[0]);
    const after = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)).orderBy(stopsTable.id);
    assert.deepEqual(after, before);
  } finally {
    await db
      .update(routesTable)
      .set({ lockedFirstStopId: null })
      .where(eq(routesTable.id, routeIds[0]));
  }
});

test("whole-plan preview is read-only, apply is atomic, and preserves the profile/resources", async () => {
  const beforeRoutes = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.organizationId, organizationId))
    .orderBy(routesTable.id);
  const beforeStops = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.organizationId, organizationId))
    .orderBy(stopsTable.id);
  const beforeDraft = await db
    .select()
    .from(planningDraftsTable)
    .where(eq(planningDraftsTable.id, draftId));

  const preview = await previewWholePlanReoptimization(
    organizationId,
    planId,
    inputFor(),
  );
  assert.equal(preview.draftRevision, 2);
  assert.equal(preview.lockedStopCount, 0);
  assert.ok(preview.proposalHash.length === 64);
  assert.ok(preview.movedStopCount >= 0);
  assert.deepEqual(
    (await db.select().from(routesTable).where(eq(routesTable.organizationId, organizationId)).orderBy(routesTable.id))
      .map((route) => [route.id, route.planRevision, route.status]),
    beforeRoutes.map((route) => [route.id, route.planRevision, route.status]),
  );
  assert.deepEqual(
    (await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId)).orderBy(stopsTable.id))
      .map((stop) => [stop.id, stop.routeId, stop.sequenceOrder]),
    beforeStops.map((stop) => [stop.id, stop.routeId, stop.sequenceOrder]),
  );
  assert.equal(
    (await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId)))[0].revision,
    beforeDraft[0].revision,
  );

  const applied = await applyWholePlanReoptimization(
    organizationId,
    planId,
    { ...inputFor(), proposalHash: preview.proposalHash },
  );
  assert.equal(applied.draftRevision, 2);
  assert.equal(applied.routes.length, 2);
  const savedRoutes = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.organizationId, organizationId));
  assert.ok(savedRoutes.every((route) => route.planRevision === 2));
  assert.ok(savedRoutes.every((route) => route.planningSummary?.objective === "geographic"));
  assert.ok(savedRoutes.every((route) =>
    route.planningSummary?.selectedPairValues.length === 2,
  ));
  const savedStops = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.organizationId, organizationId))
    .orderBy(stopsTable.id);
  assert.deepEqual(
    savedStops.map((stop) => stop.serviceDurationMin).sort((a, b) => a - b),
    [5, 10, 10, 10],
  );
  assert.deepEqual(
    savedStops.map((stop) => [stop.id, stop.priority]),
    beforeStops.map((stop) => [stop.id, stop.priority]),
  );
  assert.equal(
    (await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId)))[0].revision,
    2,
  );
  await assert.rejects(
    applyWholePlanReoptimization(
      organizationId,
      planId,
      { ...inputFor(), proposalHash: preview.proposalHash },
    ),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );
});

test("whole-plan preserve-exact mode never applies modal/minimum duration replacement", () => {
  assert.deepEqual(
    serviceDurationsForReoptimization([5, 10, 10], 5, "preserve_exact"),
    [5, 10, 10],
  );
  assert.deepEqual(
    serviceDurationsForReoptimization([5, 10, 10], 5, "preserve_individual"),
    [5, 5, 5],
  );
});

test("whole-plan apply rejects stale proposals, foreign plans, and active execution", async () => {
  const currentRoutes = await db
    .select()
    .from(routesTable)
    .where(eq(routesTable.organizationId, organizationId));
  const currentDraft = await db
    .select()
    .from(planningDraftsTable)
    .where(eq(planningDraftsTable.id, draftId));
  const staleInput = inputFor(
    currentRoutes[0].planRevision,
    currentDraft[0].revision,
  );
  const preview = await previewWholePlanReoptimization(
    organizationId,
    planId,
    staleInput,
  );
  await db.update(routesTable)
    .set({ planRevision: currentRoutes[0].planRevision + 1 })
    .where(eq(routesTable.id, routeIds[0]));
  await assert.rejects(
    applyWholePlanReoptimization(
      organizationId,
      planId,
      { ...staleInput, proposalHash: preview.proposalHash },
    ),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );
  await db.update(routesTable)
    .set({ planRevision: currentRoutes[0].planRevision, status: "in_progress" })
    .where(eq(routesTable.id, routeIds[0]));
  await assert.rejects(
    previewWholePlanReoptimization(
      organizationId,
      planId,
      inputFor(currentRoutes[0].planRevision, currentDraft[0].revision),
    ),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );
  await assert.rejects(
    previewWholePlanReoptimization(
      foreignOrganizationId,
      planId,
      staleInput,
    ),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );
  await assert.rejects(
    applyWholePlanReoptimization(
      foreignOrganizationId,
      planId,
      { ...staleInput, proposalHash: preview.proposalHash },
    ),
    (error: unknown) =>
      error instanceof ImportRouteWorkflowError && error.statusCode === 409,
  );
});