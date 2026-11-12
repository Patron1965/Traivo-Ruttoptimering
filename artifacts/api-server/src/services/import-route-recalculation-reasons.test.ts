import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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
  createImportRoutePlan,
  reoptimizeImportRoutePlanPlanningInputs,
  type PlanningInputsV1,
} from "./import-route-workflow";

test("planning-input recalculation refreshes diagnostics and clears stale reasons after recovery", async () => {
  const organizationId = randomUUID();
  const draftId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  const anchorStopId = randomUUID();
  const date = new Date("2026-10-12T08:00:00.000Z");
  const planningInputs: PlanningInputsV1 = {
    version: 1,
    objective: "balanced",
    travelReservePercent: 0,
    stopReserveMin: 0,
    stopPriorities: {},
    excludedPairValues: [],
    depotOverride: null,
    vehicleSelectionMode: "use_all_selected_pairs",
  };

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Recalculation diagnostics",
    email: `${organizationId}@example.test`,
    depotStartAddress: "Diagnostic start depot",
    depotStartLatitude: 59.33,
    depotStartLongitude: 18.07,
    depotStartVerification: {
      provider: "google",
      source: "google",
      displayName: "Diagnostic start depot",
      query: "Diagnostic start depot",
    },
    depotStartVerifiedAt: date,
    depotEndAddress: "Diagnostic end depot",
    depotEndLatitude: 59.33,
    depotEndLongitude: 18.07,
    depotEndVerification: {
      provider: "google",
      source: "google",
      displayName: "Diagnostic end depot",
      query: "Diagnostic end depot",
    },
    depotEndVerifiedAt: date,
  });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Diagnostic vehicle",
      licensePlate: `RD-${vehicleId.slice(0, 8)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Diagnostic driver",
      startLatitude: 59.33,
      startLongitude: 18.07,
      workStartTime: "07:00:00",
      workEndTime: "16:00:00",
      isActive: true,
    });
    await db.insert(planningDraftsTable).values({
      id: draftId,
      organizationId,
      name: "Diagnostic draft",
      startAt: date,
      revision: 0,
      state: { planningInputs },
    });
    await db.insert(stopsTable).values([
      {
        id: stopId,
        organizationId,
        address: "Diagnostic stop",
        latitude: 59.34,
        longitude: 18.08,
        serviceDurationMin: 10,
        weightKg: 500,
        volumeM3: 0.1,
        status: "pending" as const,
      },
      {
        id: anchorStopId,
        organizationId,
        address: "Anchor stop",
        latitude: 59.335,
        longitude: 18.075,
        serviceDurationMin: 10,
        weightKg: 1,
        volumeM3: 0.1,
        status: "pending" as const,
      },
    ]);

    const created = await createImportRoutePlan(organizationId, {
      draftId,
      date,
      stopIds: [stopId, anchorStopId],
      pairs: [{ vehicleId, driverId }],
      depotLatitude: 59.33,
      depotLongitude: 18.07,
      planningInputs,
    });
    const activePlanId = created.planId as string;

    const recalculate = async () => {
      const [draft] = await db.select({ revision: planningDraftsTable.revision })
        .from(planningDraftsTable)
        .where(and(
          eq(planningDraftsTable.id, draftId),
          eq(planningDraftsTable.organizationId, organizationId),
        ));
      // The initial plan creates its route with a generated ID, so resolve the
      // current route while retaining a single route in this isolated fixture.
      const [currentRoute] = await db.select({
        id: routesTable.id,
        planRevision: routesTable.planRevision,
      }).from(routesTable).where(and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planId, activePlanId),
      ));
      assert.ok(draft);
      assert.ok(currentRoute);
      return reoptimizeImportRoutePlanPlanningInputs(organizationId, activePlanId, {
        draftId,
        draftRevision: draft.revision,
        planningInputs,
      });
    };
    const assertReason = async (pattern: RegExp) => {
      const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
      const [route] = await db.select().from(routesTable).where(eq(routesTable.planId, activePlanId));
      const summary = route.planningSummary!;
      assert.equal(stop.routeId, null);
      assert.match(stop.unplannedReason ?? "", pattern);
      assert.equal(summary.unplanned.length, 1);
      assert.match(summary.unplanned[0].reason, pattern);
      assert.equal(summary.unplanned[0].reason, stop.unplannedReason);
    };
    const assertPlannedAndCleared = async () => {
      const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
      const [route] = await db.select().from(routesTable).where(eq(routesTable.planId, activePlanId));
      assert.equal(stop.routeId, route.id);
      assert.equal(stop.unplannedReason, null);
      assert.deepEqual(route.planningSummary?.unplanned, []);
    };

    await db.update(vehiclesTable).set({ capacityKg: 100 }).where(eq(vehiclesTable.id, vehicleId));
    await recalculate();
    await assertReason(/kapaciteten/i);

    await db.update(vehiclesTable).set({ capacityKg: 1_000 }).where(eq(vehiclesTable.id, vehicleId));
    await recalculate();
    await assertPlannedAndCleared();

    await db.update(stopsTable).set({
      timeWindowEnd: new Date("2026-10-12T04:00:00.000Z"),
    }).where(eq(stopsTable.id, stopId));
    await recalculate();
    await assertReason(/tidsfönster/i);

    await db.update(stopsTable).set({ timeWindowEnd: null }).where(eq(stopsTable.id, stopId));
    await recalculate();
    await assertPlannedAndCleared();

    await db.update(stopsTable).set({ serviceDurationMin: 120 }).where(eq(stopsTable.id, stopId));
    await db.update(driversTable).set({ workEndTime: "08:30:00" }).where(eq(driversTable.id, driverId));
    await recalculate();
    await assertReason(/arbetstid|arbetspass/i);

    await db.update(stopsTable).set({ serviceDurationMin: 10 }).where(eq(stopsTable.id, stopId));
    await db.update(driversTable).set({ workEndTime: "16:00:00" }).where(eq(driversTable.id, driverId));
    await recalculate();
    await assertPlannedAndCleared();
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});