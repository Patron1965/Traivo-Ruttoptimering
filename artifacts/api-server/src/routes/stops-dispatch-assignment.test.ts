import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express, { type Express } from "express";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { PreviewDispatchStopMoveResponse } from "@workspace/api-zod";
import {
  db,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
  driversTable,
  planningDraftsTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import { isAcceptedRouteRecipient } from "../services/field-service";
import {
  moveStopsForDispatch,
  setDispatchMutationBeforeLockHookForTest,
} from "../services/stop-service";
import stopsRouter from "./stops";
import { prepareDispatchLockRoadData } from "../services/stop-service";
import { clearOsrmCache } from "../services/osrm";
import { getDistanceCache, cachedDistance } from "../services/alns/distance-cache";
import { withRequiredRoadData } from "../services/road-data-policy";
import { runWithUsageContext } from "../services/usage-context";
import { currentOrganizationServicePolicy } from "../services/organization-service-policy";
import importRouteWorkflowRouter from "./import-route-workflow";

const dispatcher: AuthUser = {
  id: randomUUID(),
  name: "Dispatch assignment test user",
  email: "dispatch-assignment-tests@example.test",
  role: "dispatcher",
  organizationId: "",
  driverProfileId: null,
};

type StopOverrides = Partial<typeof stopsTable.$inferInsert>;
type VehicleOverrides = Partial<typeof vehiclesTable.$inferInsert>;
type DriverOverrides = Partial<typeof driversTable.$inferInsert>;

type DispatchFixture = {
  organizationId: string;
  routeId: string;
  stopId: string;
  vehicleId: string;
  driverId?: string;
  routeStopId?: string;
};

const depotSnapshot = {
  start: {
    address: "Authoritative start depot",
    latitude: 59.3,
    longitude: 18.0,
    verifiedAt: "2026-08-25T12:00:00.000Z",
    verification: { source: "test" },
  },
  end: {
    address: "Authoritative end depot",
    latitude: 59.31,
    longitude: 18.01,
    verifiedAt: "2026-08-25T12:00:00.000Z",
    verification: { source: "test" },
  },
};

const planningSnapshot = {
  version: 1 as const,
  objective: "balanced" as const,
  travelReservePercent: 20,
  stopReserveMin: 20,
  stopPriorities: {},
  excludedPairValues: [],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs" as const,
  maxDriverOvertimeMin: 0,
  allowLateStopsMin: 0,
};

function stalePlanningEvidence(stopId: string) {
  return {
    totalStops: 99,
    totalDistanceKm: 123,
    totalDurationMin: 456,
    co2EmissionsKg: 7,
    workdayTimeline: [{
      type: "service" as const,
      startAt: "2026-08-26T08:00:00.000Z",
      endAt: "2026-08-26T08:15:00.000Z",
      durationMin: 15,
      stopId,
    }],
    workdaySummary: {
      shiftMin: 480,
      nonReturnDrivingMin: 60,
      serviceMin: 15,
      waitingMin: 0,
      breakMin: 0,
      returnMin: 30,
      totalMin: 105,
      marginMin: 375,
      overtimeMin: 0,
      shiftEndAt: "2026-08-26T15:00:00.000Z",
    },
    geographicOverlapExplanation: {
      status: "confirmed" as const,
      reasonCode: "CAPACITY" as const,
      message: "Stale explanation",
      analyzedPairCount: 1,
      scope: { vehicleIds: ["vehicle-a", "vehicle-b"], stopIds: [stopId, "other-stop"] },
    },
    plannerItinerary: [{
      stopId,
      sequenceOrder: 1,
      estimatedArrival: "2026-08-26T08:00:00.000Z",
      distanceFromPreviousKm: 123,
    }],
    manualReviewRequired: false,
    manualReviewedAt: new Date("2026-08-25T13:00:00.000Z"),
    depotSnapshot,
    optimizationPlanningSnapshot: planningSnapshot,
    planningSummary: {
      complete: false,
      objective: "balanced" as const,
      travelReservePercent: 20,
      stopReserveMin: 20,
      mandatoryUnplannedStopIds: [stopId],
      selectedPairValues: [],
      usedPairValues: [],
      unusedPairValues: [],
      unplanned: [{
        stopId,
        priority: 2 as const,
        reason: "Stale unplanned reason",
      }],
    },
  };
}

function assertPersistedPlanningState(
  route: typeof routesTable.$inferSelect,
  expectedStopCount: number,
  expectedDepotSnapshot = depotSnapshot,
): void {
  assert.equal(route.totalStops, expectedStopCount);
  assert.notEqual(route.totalDistanceKm, null);
  assert.notEqual(route.totalDurationMin, null);
  assert.notEqual(route.co2EmissionsKg, null);
  assert.ok(route.workdayTimeline);
  assert.ok(route.workdaySummary);
  assert.equal(route.workdaySummary?.allowedOvertimeMin, 0);
  assert.equal(route.workdaySummary?.allowLateStopsMin, 0);
  assert.equal(route.geographicOverlapExplanation, null);
  assert.equal(route.plannerItinerary?.filter((entry) => !entry.isChargingStop).length, expectedStopCount);
  assert.equal(route.planningSummary, null);
  assert.equal(route.manualReviewRequired, true);
  assert.equal(route.manualReviewedAt, null);
  assert.deepEqual(route.depotSnapshot, expectedDepotSnapshot);
  assert.deepEqual(route.optimizationPlanningSnapshot, planningSnapshot);
}

async function createFixture({
  vehicle = {},
  routeVehicleId,
  driver = {},
  stop = {},
  routeStop,
  routeDepotSnapshot = depotSnapshot,
  routePlanningSnapshot = planningSnapshot,
  withDriver = true,
}: {
  vehicle?: VehicleOverrides;
  routeVehicleId?: string | null;
  driver?: DriverOverrides;
  stop?: StopOverrides;
  routeStop?: StopOverrides;
  routeDepotSnapshot?: typeof depotSnapshot | null;
  routePlanningSnapshot?: typeof planningSnapshot | null;
  withDriver?: boolean;
} = {}): Promise<DispatchFixture> {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  const routeStopId = routeStop ? randomUUID() : undefined;
  const driverId = withDriver ? randomUUID() : undefined;

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: `Dispatch assignment test ${organizationId.slice(0, 8)}`,
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Dispatch assignment test vehicle",
    licensePlate: `DA-${vehicleId.slice(0, 8)}`,
    capacityKg: 1_000,
    capacityVolume: 10,
    ...vehicle,
  });
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId: routeVehicleId === undefined ? vehicleId : routeVehicleId,
    name: "Dispatch assignment test route",
    date: new Date("2026-08-26T00:00:00.000Z"),
    depotSnapshot: routeDepotSnapshot,
    optimizationPlanningSnapshot: routePlanningSnapshot,
  });
  if (driverId) {
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Dispatch assignment test driver",
      ...driver,
    });
  }
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    routeId: null,
    address: "Dispatch assignment test stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    serviceDurationMin: 15,
    ...stop,
  });
  if (routeStopId) {
    await db.insert(stopsTable).values({
      id: routeStopId,
      organizationId,
      routeId,
      address: "Existing route test stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      sequenceOrder: 1,
      serviceDurationMin: 15,
      ...routeStop,
    });
  }

  return { organizationId, routeId, stopId, vehicleId, driverId, routeStopId };
}

async function removeFixture(fixture: DispatchFixture): Promise<void> {
  await db
    .delete(stopsTable)
    .where(eq(stopsTable.organizationId, fixture.organizationId));
  await db
    .delete(routesTable)
    .where(eq(routesTable.organizationId, fixture.organizationId));
  if (fixture.driverId) {
    await db.delete(driversTable).where(eq(driversTable.id, fixture.driverId));
  }
  await db.delete(vehiclesTable).where(eq(vehiclesTable.id, fixture.vehicleId));
  await db
    .delete(organizationsTable)
    .where(eq(organizationsTable.id, fixture.organizationId));
}

test("dispatch move clears overlap evidence on an untouched third counterpart route", async () => {
  const fixture = await createFixture({ routeStop: {} });
  const targetVehicleId = randomUUID();
  const targetDriverId = randomUUID();
  const targetRouteId = randomUUID();
  const counterpartVehicleId = randomUUID();
  const counterpartDriverId = randomUUID();
  const counterpartRouteId = randomUUID();
  try {
    await db.insert(vehiclesTable).values([
      {
        id: targetVehicleId,
        organizationId: fixture.organizationId,
        name: "Dispatch target vehicle",
        licensePlate: `DT-${targetVehicleId.slice(0, 8)}`,
        capacityKg: 1_000,
        capacityVolume: 10,
      },
      {
        id: counterpartVehicleId,
        organizationId: fixture.organizationId,
        name: "Dispatch counterpart vehicle",
        licensePlate: `DC-${counterpartVehicleId.slice(0, 8)}`,
        capacityKg: 1_000,
        capacityVolume: 10,
      },
    ]);
    await db.insert(driversTable).values([
      {
        id: targetDriverId,
        organizationId: fixture.organizationId,
        vehicleId: targetVehicleId,
        name: "Dispatch target driver",
      },
      {
        id: counterpartDriverId,
        organizationId: fixture.organizationId,
        vehicleId: counterpartVehicleId,
        name: "Dispatch counterpart driver",
      },
    ]);
    await db.insert(routesTable).values([
      {
        id: targetRouteId,
        organizationId: fixture.organizationId,
        vehicleId: targetVehicleId,
        name: "Dispatch target route",
        date: new Date("2026-08-26T00:00:00.000Z"),
        planRevision: 2,
      },
      {
        id: counterpartRouteId,
        organizationId: fixture.organizationId,
        vehicleId: counterpartVehicleId,
        name: "Untouched counterpart route",
        date: new Date("2026-08-26T00:00:00.000Z"),
        planRevision: 11,
        geographicOverlapExplanation: {
          status: "confirmed",
          reasonCode: "CAPACITY",
          message: "Old A-C evidence",
          analyzedPairCount: 1,
          scope: {
            vehicleIds: [fixture.vehicleId, counterpartVehicleId],
            stopIds: [fixture.routeStopId!, randomUUID()],
          },
        },
      },
    ]);

    const result = await moveStopsForDispatch(fixture.organizationId, {
      stopIds: [fixture.routeStopId!],
      routeId: targetRouteId,
      targetIndex: 0,
      routeRevisions: [
        { routeId: fixture.routeId, planRevision: 0 },
        { routeId: targetRouteId, planRevision: 2 },
      ],
    });
    assert.equal(result.kind, "moved");
    const [counterpart] = await db
      .select({
        explanation: routesTable.geographicOverlapExplanation,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.id, counterpartRouteId));
    assert.equal(counterpart.explanation, null);
    assert.equal(counterpart.planRevision, 11);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, fixture.organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, fixture.organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, fixture.organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, fixture.organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, fixture.organizationId));
  }
});

function appFor(organizationId: string, role: AuthUser["role"] = "dispatcher", includePlanRouter = false): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { ...dispatcher, organizationId, role };
    next();
  });
  app.use(stopsRouter);
  if (includePlanRouter) app.use(importRouteWorkflowRouter);
  return app;
}

async function requestAssignment(
  fixture: DispatchFixture,
  force = false,
  sequenceOrder?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/stops/${fixture.stopId}/dispatch-assignment`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routeId: fixture.routeId, force, sequenceOrder }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestStop(
  fixture: DispatchFixture,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/stops/${fixture.stopId}`,
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestStopUpdate(
  fixture: DispatchFixture,
  stopId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/stops/${stopId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestStopCreate(
  fixture: DispatchFixture,
  body: Record<string, unknown>,
  role: AuthUser["role"] = "dispatcher",
  plan?: { id: string; revision: number },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId, role, Boolean(plan));
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${plan ? `/import/route-plans/${plan.id}/stops` : "/stops"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan ? {
        stop: body,
        routes: [{ routeId: fixture.routeId, planRevision: plan.revision }],
      } : body),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestStopDeletion(
  fixture: DispatchFixture,
  stopIds: string[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/stops/bulk-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stopIds }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestBulkMove(
  fixture: DispatchFixture,
  stopIds: string[],
  targetIndex = 0,
  force = false,
  routeId: string | null = fixture.routeId,
  routeRevisions?: Array<{ routeId: string; planRevision: number }> | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const revisions = routeRevisions === undefined
      ? await (async () => {
        const organizationStops = await db
          .select({ id: stopsTable.id, routeId: stopsTable.routeId })
          .from(stopsTable)
          .where(eq(stopsTable.organizationId, fixture.organizationId));
        const affectedRouteIds = new Set([
          ...(routeId ? [routeId] : []),
          ...organizationStops
            .filter((stop) => stopIds.includes(stop.id) && stop.routeId)
            .map((stop) => stop.routeId!),
        ]);
        const organizationRoutes = await db
          .select({ routeId: routesTable.id, planRevision: routesTable.planRevision })
          .from(routesTable)
          .where(eq(routesTable.organizationId, fixture.organizationId));
        return organizationRoutes.filter((route) => affectedRouteIds.has(route.routeId));
      })()
      : routeRevisions ?? undefined;
    const response = await fetch(
      `http://127.0.0.1:${port}/stops/dispatch-move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stopIds,
          routeId,
          targetIndex,
          force,
          routeRevisions: revisions,
        }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestDispatchMovePreview(
  fixture: DispatchFixture,
  stopIds: string[],
  targetRouteId: string,
  targetIndex = 0,
  force = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const organizationStops = await db
      .select({ routeId: stopsTable.routeId })
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, fixture.organizationId),
        inArray(stopsTable.id, stopIds),
      ));
    const affectedRouteIds = Array.from(new Set([
      targetRouteId,
      ...organizationStops
        .map((stop) => stop.routeId)
        .filter((routeId): routeId is string => routeId != null),
    ]));
    const routeRevisions = await db
      .select({ routeId: routesTable.id, planRevision: routesTable.planRevision })
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, fixture.organizationId),
        inArray(routesTable.id, affectedRouteIds),
      ));
    const response = await fetch(
      `http://127.0.0.1:${port}/stops/dispatch-move/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stopIds,
          routeId: targetRouteId,
          targetIndex,
          force,
          routeRevisions,
        }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function requestDispatchDefer(
  fixture: DispatchFixture,
  stopIds: string[],
  routeRevisions?: Array<{ routeId: string; planRevision: number }>,
  targetDate = "2099-06-01",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = appFor(fixture.organizationId);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const revisions = routeRevisions ?? await (async () => {
      const [route] = await db.select({
        routeId: routesTable.id,
        planRevision: routesTable.planRevision,
      }).from(routesTable).where(eq(routesTable.id, fixture.routeId));
      return route ? [route] : [];
    })();
    const response = await fetch(`http://127.0.0.1:${port}/stops/dispatch-defer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stopIds, targetDate, routeRevisions: revisions }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function dispatchMutationGate(): {
  entered: Promise<void>;
  release: () => void;
  hook: () => Promise<void>;
} {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    hook: async () => {
      markEntered();
      await released;
    },
  };
}

test("bulk move rejects omitted route revisions without writing", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  try {
    const [routeBefore] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const response = await requestBulkMove(
      fixture,
      [fixture.stopId],
      0,
      false,
      fixture.routeId,
      null,
    );
    assert.equal(response.status, 400);
    const [stopAfter] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    const [routeAfter] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(stopAfter.routeId, null);
    assert.equal(routeAfter.planRevision, routeBefore.planRevision);
  } finally {
    await removeFixture(fixture);
  }
});

test("bulk move returns 409 and writes nothing for a stale route revision", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  try {
    await db.update(routesTable)
      .set(stalePlanningEvidence(fixture.routeStopId!))
      .where(eq(routesTable.id, fixture.routeId));
    const [routeBefore] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const response = await requestBulkMove(
      fixture,
      [fixture.stopId],
      0,
      false,
      fixture.routeId,
      [{ routeId: fixture.routeId, planRevision: routeBefore.planRevision + 1 }],
    );
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /changed/i);
    assert.equal(response.body.code, "DISPATCH_REVISION_CONFLICT");
    const [stopAfter] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    const [routeAfter] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(stopAfter.routeId, null);
    assert.deepEqual(routeAfter, routeBefore);
  } finally {
    await removeFixture(fixture);
  }
});

test("dispatch assignment returns 409 with each soft conflict code", async () => {
  const cases: Array<{
    name: string;
    fixtureOptions: Parameters<typeof createFixture>[0];
    expectedConflict: string;
  }> = [
    {
      name: "capacity",
      fixtureOptions: { stop: { weightKg: 1_001 } },
      expectedConflict: "CAPACITY",
    },
    {
      name: "time window",
      fixtureOptions: {
        stop: { timeWindowEnd: new Date("2000-01-01T00:00:00.000Z") },
      },
      expectedConflict: "TIME_WINDOW",
    },
    {
      name: "working hours",
      fixtureOptions: { stop: { serviceDurationMin: 700 } },
      expectedConflict: "WORKING_HOURS",
    },
    {
      name: "range",
      fixtureOptions: {
        vehicle: { rangeKm: 1 },
        stop: { latitude: 60, longitude: 18 },
        routeStop: { latitude: 59.3293, longitude: 18.0686 },
      },
      expectedConflict: "RANGE",
    },
    {
      name: "missing vehicle",
      fixtureOptions: { routeVehicleId: null },
      expectedConflict: "NO_VEHICLE",
    },
  ];

  for (const testCase of cases) {
    const fixture = await createFixture(testCase.fixtureOptions);
    try {
      const response = await requestAssignment(fixture);
      assert.equal(
        response.status,
        409,
        `${testCase.name} should be a conflict`,
      );
      assert.deepEqual(response.body.conflicts, [testCase.expectedConflict]);
      assert.match(String(response.body.error), /without an override/);
    } finally {
      await removeFixture(fixture);
    }
  }
});

test("force assignment persists an override marker for soft conflicts", async () => {
  const fixture = await createFixture({ stop: { weightKg: 1_001 } });
  try {
    const normal = await requestAssignment(fixture);
    assert.equal(normal.status, 409);
    assert.deepEqual(normal.body.conflicts, ["CAPACITY"]);

    const forced = await requestAssignment(fixture, true);
    assert.equal(forced.status, 200);
    assert.equal(forced.body.routeId, fixture.routeId);
    assert.ok(forced.body.assignmentOverrideAt);
    assert.deepEqual(forced.body.assignmentOverrideReasonCodes, ["CAPACITY"]);

    const saved = await requestStop(fixture);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.routeId, fixture.routeId);
    assert.ok(saved.body.assignmentOverrideAt);
    assert.deepEqual(saved.body.assignmentOverrideReasonCodes, ["CAPACITY"]);
  } finally {
    await removeFixture(fixture);
  }
});

test("assignment inserts at the requested route position without duplicate sequence values", async () => {
  const fixture = await createFixture({
    routeStop: { sequenceOrder: 1 },
  });
  try {
    const response = await requestAssignment(fixture, false, 1);
    assert.equal(response.status, 200);

    const ordered = await db
      .select({ id: stopsTable.id, sequenceOrder: stopsTable.sequenceOrder })
      .from(stopsTable)
      .where(eq(stopsTable.routeId, fixture.routeId))
      .orderBy(stopsTable.sequenceOrder);
    assert.deepEqual(
      ordered.map(({ id, sequenceOrder }) => ({ id, sequenceOrder })),
      [
        { id: fixture.stopId, sequenceOrder: 1 },
        { id: fixture.routeStopId, sequenceOrder: 2 },
      ],
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("manual assignment persists reserves and rejects an overtime overrun atomically", async () => {
  const fixture = await createFixture({ stop: { serviceDurationMin: 20 } });
  try {
    await db.update(routesTable).set({
      optimizationPlanningSnapshot: {
        ...planningSnapshot,
        travelReservePercent: 10,
        stopReserveMin: 2,
      },
    }).where(eq(routesTable.id, fixture.routeId));
    const response = await requestAssignment(fixture);
    assert.equal(response.status, 200);
    const [savedRoute] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.ok(savedRoute.workdayTimeline?.some((event) => event.type === "depot_end"));
    assert.equal(savedRoute.workdaySummary?.stopReserveMin, 2);
    assert.ok((savedRoute.workdaySummary?.travelReserveMin ?? 0) > 0);
    assert.equal(savedRoute.workdaySummary?.allowedOvertimeMin, 0);
  } finally {
    await removeFixture(fixture);
  }

  const overrun = await createFixture({ stop: { serviceDurationMin: 600 } });
  try {
    const [before] = await db.select().from(routesTable)
      .where(eq(routesTable.id, overrun.routeId));
    const response = await requestAssignment(overrun);
    assert.equal(response.status, 409);
    assert.deepEqual(response.body.conflicts, ["WORKING_HOURS"]);
    const [stop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, overrun.stopId));
    const [after] = await db.select().from(routesTable)
      .where(eq(routesTable.id, overrun.routeId));
    assert.equal(stop.routeId, null);
    assert.equal(after.planRevision, before.planRevision);
    assert.equal(after.workdaySummary, null);
  } finally {
    await removeFixture(overrun);
  }
});

test("legacy route created without a depot or driver accepts safe manual assignment", async () => {
  const fixture = await createFixture({
    routeDepotSnapshot: null,
    routePlanningSnapshot: null,
    withDriver: false,
  });
  const secondStopId = randomUUID();
  try {
    const response = await requestAssignment(fixture);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await db.insert(stopsTable).values({
      id: secondStopId,
      organizationId: fixture.organizationId,
      routeId: null,
      address: "Legacy route follow-up stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      serviceDurationMin: 15,
    });
    const moveResponse = await requestBulkMove(fixture, [secondStopId], 1);
    assert.equal(moveResponse.status, 200, JSON.stringify(moveResponse.body));
    const [stop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    const [secondStop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, secondStopId));
    const [route] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(stop.routeId, fixture.routeId);
    assert.equal(stop.sequenceOrder, 1);
    assert.equal(secondStop.routeId, fixture.routeId);
    assert.equal(secondStop.sequenceOrder, 2);
    assert.equal(route.depotSnapshot, null);
    assert.equal(route.optimizationPlanningSnapshot, null);
    assert.equal(route.planRevision, 2);
    assert.equal(route.manualReviewRequired, true);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.id, secondStopId));
    await removeFixture(fixture);
  }
});

test("protected assignment uses the exact optimization driver, not another active vehicle driver", async () => {
  const fixture = await createFixture();
  const secondDriverId = randomUUID();
  try {
    await db.insert(driversTable).values({
      id: secondDriverId,
      organizationId: fixture.organizationId,
      vehicleId: fixture.vehicleId,
      name: "Ambiguous second driver",
      isActive: true,
    });
    await db.update(routesTable).set({
      draftId: randomUUID(),
      optimizationResourceSnapshot: { driver: { id: fixture.driverId } },
    }).where(eq(routesTable.id, fixture.routeId));
    const response = await requestAssignment(fixture);
    assert.equal(response.status, 200);
    const [stop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(stop.routeId, fixture.routeId);
  } finally {
    await db.delete(driversTable).where(eq(driversTable.id, secondDriverId));
    await removeFixture(fixture);
  }
});

test("legacy assignment rejects ambiguous active drivers without writing", async () => {
  const fixture = await createFixture();
  const secondDriverId = randomUUID();
  try {
    await db.insert(driversTable).values({
      id: secondDriverId,
      organizationId: fixture.organizationId,
      vehicleId: fixture.vehicleId,
      name: "Ambiguous second driver",
      isActive: true,
    });
    const [before] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const response = await requestAssignment(fixture);
    assert.equal(response.status, 409);
    const [stop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    const [after] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(stop.routeId, null);
    assert.equal(after.planRevision, before.planRevision);
  } finally {
    await db.delete(driversTable).where(eq(driversTable.id, secondDriverId));
    await removeFixture(fixture);
  }
});

test("assignment clears stale unplanned evidence while invalidating route planning summary", async () => {
  const fixture = await createFixture({
    driver: {},
    stop: { unplannedReason: "Stale unplanned reason" },
  });
  try {
    await db
      .update(routesTable)
      .set({
        status: "in_progress",
        planRevision: 7,
        handoffStatus: "accepted",
        handoffVersion: 7,
        handoffDriverId: fixture.driverId,
        sentAt: new Date("2026-08-26T06:00:00.000Z"),
        receivedAt: new Date("2026-08-26T06:01:00.000Z"),
        openedAt: new Date("2026-08-26T06:02:00.000Z"),
        acceptedAt: new Date("2026-08-26T06:03:00.000Z"),
        ...stalePlanningEvidence(fixture.stopId),
      })
      .where(eq(routesTable.id, fixture.routeId));

    const response = await requestAssignment(fixture);
    assert.equal(response.status, 200);

    const [route] = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(route.planRevision, 8);
    assert.equal(route.handoffStatus, "pending");
    assert.equal(route.handoffVersion, null);
    assert.equal(route.handoffDriverId, null);
    assert.equal(route.acceptedAt, null);
    assertPersistedPlanningState(route, 1);
    const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, fixture.stopId));
    assert.equal(stop.unplannedReason, null);
    assert.equal(
      isAcceptedRouteRecipient(route, fixture.driverId!),
      false,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("conflicts are evaluated using the requested insertion position", async () => {
  const fixture = await createFixture({
    stop: { timeWindowEnd: new Date("2026-08-26T07:30:00.000Z") },
    routeStop: { sequenceOrder: 1, serviceDurationMin: 700 },
  });
  try {
    const beforeLongStop = await requestAssignment(fixture, false, 1);
    assert.equal(beforeLongStop.status, 409);
    assert.equal(
      (beforeLongStop.body.conflicts as string[]).includes("TIME_WINDOW"),
      false,
    );

    const afterLongStop = await requestAssignment(fixture, false, 2);
    assert.equal(afterLongStop.status, 409);
    assert.equal(
      (afterLongStop.body.conflicts as string[]).includes("TIME_WINDOW"),
      true,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("bulk move atomically accepts a mixed planned and unplanned selection", async () => {
  const fixture = await createFixture({
    stop: { unplannedReason: "Stale unplanned reason" },
    routeStop: { sequenceOrder: 1 },
  });
  try {
    const response = await requestBulkMove(
      fixture,
      [fixture.stopId, fixture.routeStopId!],
      0,
    );
    assert.equal(response.status, 200);

    const ordered = await db
      .select({ id: stopsTable.id, sequenceOrder: stopsTable.sequenceOrder })
      .from(stopsTable)
      .where(eq(stopsTable.routeId, fixture.routeId))
      .orderBy(stopsTable.sequenceOrder);
    assert.deepEqual(ordered, [
      { id: fixture.stopId, sequenceOrder: 1 },
      { id: fixture.routeStopId, sequenceOrder: 2 },
    ]);
    const [movedStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, fixture.stopId));
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.equal(movedStop.unplannedReason, null);
    assert.equal(route.planningSummary, null);
  } finally {
    await removeFixture(fixture);
  }
});

test("bulk move atomically increments and revokes every affected route handoff", async () => {
  const fixture = await createFixture({
    driver: {},
    routeStop: { sequenceOrder: 1 },
  });
  const sourceRouteId = randomUUID();
  const sourceStopId = randomUUID();
  try {
    await db.insert(routesTable).values({
      id: sourceRouteId,
      organizationId: fixture.organizationId,
      vehicleId: fixture.vehicleId,
      name: "Sent source route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      status: "in_progress",
      planRevision: 3,
      handoffStatus: "sent",
      handoffVersion: 3,
      handoffDriverId: fixture.driverId,
      sentAt: new Date("2026-08-26T05:00:00.000Z"),
      ...stalePlanningEvidence(sourceStopId),
    });
    await db.insert(stopsTable).values({
      id: sourceStopId,
      organizationId: fixture.organizationId,
      routeId: sourceRouteId,
      address: "Source route stop",
      latitude: 59.34,
      longitude: 18.07,
      status: "pending",
      sequenceOrder: 1,
      serviceDurationMin: 15,
    });
    await db
      .update(routesTable)
      .set({
        status: "in_progress",
        planRevision: 9,
        handoffStatus: "accepted",
        handoffVersion: 9,
        handoffDriverId: fixture.driverId,
        acceptedAt: new Date("2026-08-26T06:00:00.000Z"),
        ...stalePlanningEvidence(fixture.routeStopId!),
      })
      .where(eq(routesTable.id, fixture.routeId));

    const response = await requestBulkMove(fixture, [sourceStopId], 1);
    assert.equal(response.status, 200);

    const routes = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.organizationId, fixture.organizationId));
    const byId = new Map(routes.map((route) => [route.id, route]));
    const source = byId.get(sourceRouteId)!;
    const target = byId.get(fixture.routeId)!;
    assert.equal(source.planRevision, 4);
    assert.equal(target.planRevision, 10);
    assertPersistedPlanningState(source, 0);
    assertPersistedPlanningState(target, 2);
    for (const route of [source, target]) {
      assert.equal(route.handoffStatus, "pending");
      assert.equal(route.handoffVersion, null);
      assert.equal(route.handoffDriverId, null);
      assert.equal(route.sentAt, null);
      assert.equal(route.acceptedAt, null);
      assert.equal(isAcceptedRouteRecipient(route, fixture.driverId!), false);
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("moving a stop between separately staffed routes refreshes both authoritative workdays", async () => {
  const fixture = await createFixture({
    routeStop: { sequenceOrder: 1, serviceDurationMin: 20 },
  });
  const sourceVehicleId = randomUUID();
  const sourceDriverId = randomUUID();
  const sourceRouteId = randomUUID();
  const sourceStopId = randomUUID();
  try {
    await db.insert(vehiclesTable).values({
      id: sourceVehicleId,
      organizationId: fixture.organizationId,
      name: "Separate source vehicle",
      licensePlate: `DS-${sourceVehicleId.slice(0, 8)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
    });
    await db.insert(driversTable).values({
      id: sourceDriverId,
      organizationId: fixture.organizationId,
      vehicleId: sourceVehicleId,
      name: "Separate source driver",
      workStartTime: "07:00",
      workEndTime: "18:00",
    });
    await db.insert(routesTable).values({
      id: sourceRouteId,
      organizationId: fixture.organizationId,
      vehicleId: sourceVehicleId,
      name: "Separately staffed source route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      depotSnapshot,
      optimizationPlanningSnapshot: planningSnapshot,
    });
    await db.insert(stopsTable).values({
      id: sourceStopId,
      organizationId: fixture.organizationId,
      routeId: sourceRouteId,
      address: "Move this stop to another driver",
      latitude: 59.34,
      longitude: 18.07,
      status: "pending",
      sequenceOrder: 1,
      serviceDurationMin: 20,
    });

    const response = await requestBulkMove(
      fixture,
      [sourceStopId],
      1,
      false,
      fixture.routeId,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const [source, target] = await Promise.all([
      db.select().from(routesTable).where(eq(routesTable.id, sourceRouteId)),
      db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId)),
    ]);
    assert.equal(source[0]?.totalStops, 0);
    assert.ok(source[0]?.workdayTimeline?.some((event) => event.type === "depot_end"));
    assert.equal(target[0]?.totalStops, 2);
    assert.ok(target[0]?.workdayTimeline?.some((event) => event.type === "depot_end"));
    assert.equal(target[0]?.workdaySummary?.allowedOvertimeMin, 0);

    const moved = await db.select().from(stopsTable).where(eq(stopsTable.id, sourceStopId));
    assert.equal(moved[0]?.routeId, fixture.routeId);
    assert.equal(moved[0]?.sequenceOrder, 2);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.id, sourceStopId));
    await db.delete(routesTable).where(eq(routesTable.id, sourceRouteId));
    await db.delete(driversTable).where(eq(driversTable.id, sourceDriverId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, sourceVehicleId));
    await removeFixture(fixture);
  }
});

test("bulk move rejects the complete group without partial persistence", async () => {
  const fixture = await createFixture({
    routeStop: { sequenceOrder: 1, status: "completed" },
  });
  try {
    await db.update(routesTable)
      .set(stalePlanningEvidence(fixture.routeStopId!))
      .where(eq(routesTable.id, fixture.routeId));
    const [routeBefore] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const response = await requestBulkMove(
      fixture,
      [fixture.stopId, fixture.routeStopId!],
      0,
    );
    assert.equal(response.status, 409);

    const saved = await db
      .select({
        id: stopsTable.id,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, fixture.organizationId));
    const byId = new Map(saved.map((stop) => [stop.id, stop]));
    assert.equal(byId.get(fixture.stopId)?.routeId, null);
    assert.equal(byId.get(fixture.stopId)?.sequenceOrder, null);
    assert.equal(byId.get(fixture.routeStopId!)?.routeId, fixture.routeId);
    assert.equal(byId.get(fixture.routeStopId!)?.sequenceOrder, 1);
    const [routeAfter] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.deepEqual(routeAfter, routeBefore);
  } finally {
    await removeFixture(fixture);
  }
});

test("bulk move atomically returns planned stops to the queue and resequences the source", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  const remainingStopId = randomUUID();
  try {
    await db.insert(stopsTable).values({
      id: remainingStopId,
      organizationId: fixture.organizationId,
      routeId: fixture.routeId,
      address: "Remaining source route stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      sequenceOrder: 2,
      serviceDurationMin: 15,
    });
    await db.update(routesTable)
      .set(stalePlanningEvidence(fixture.routeStopId!))
      .where(eq(routesTable.id, fixture.routeId));
    const response = await requestBulkMove(
      fixture,
      [fixture.routeStopId!],
      0,
      false,
      null,
    );
    assert.equal(response.status, 200);

    const saved = await db
      .select({
        id: stopsTable.id,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, fixture.organizationId));
    const byId = new Map(saved.map((stop) => [stop.id, stop]));
    assert.equal(byId.get(fixture.routeStopId!)?.routeId, null);
    assert.equal(byId.get(fixture.routeStopId!)?.sequenceOrder, null);
    assert.equal(byId.get(remainingStopId)?.routeId, fixture.routeId);
    assert.equal(byId.get(remainingStopId)?.sequenceOrder, 1);
    const [route] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assertPersistedPlanningState(route, 1);
  } finally {
    await removeFixture(fixture);
  }
});

test("new projects preview without writing, reject sent sources and commit selected stops exactly once", async () => {
  const fixture = await createFixture({ driver: {}, routeStop: { sequenceOrder: 1 } });
  try {
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    const input = { stopIds: [fixture.routeStopId!], routeId: null, targetIndex: 0,
      routeRevisions: [{ routeId: route.id, planRevision: route.planRevision }],
      newProject: { name: "Selected map stops", date: "2026-11-03", vehicleId: fixture.vehicleId } };
    const preview = await moveStopsForDispatch(fixture.organizationId, input, { previewOnly: true });
    assert.equal(preview.kind, "preview");
    if (preview.kind !== "preview") throw new Error("Expected preview");
    assert.equal((await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.organizationId, fixture.organizationId))).length, 0);
    await db.update(routesTable).set({ status: "optimized", sentAt: new Date() }).where(eq(routesTable.id, route.id));
    const blocked = await moveStopsForDispatch(fixture.organizationId, { ...input, expectedPreviewDigest: preview.previewDigest });
    assert.equal(blocked.kind, "ineligible");
    const [untouched] = await db.select().from(stopsTable).where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(untouched.routeId, route.id);
    await db.update(routesTable).set({ status: route.status, sentAt: null }).where(eq(routesTable.id, route.id));
    const fresh = await moveStopsForDispatch(fixture.organizationId, input, { previewOnly: true });
    if (fresh.kind !== "preview") throw new Error("Expected fresh preview");
    const result = await moveStopsForDispatch(fixture.organizationId, { ...input, expectedPreviewDigest: fresh.previewDigest });
    assert.equal(result.kind, "moved");
    if (result.kind !== "moved") throw new Error("Expected move");
    assert.ok(result.draftId);
    const [draft] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, result.draftId!));
    assert.deepEqual(draft.state.selectedStopIds, input.stopIds);
    assert.deepEqual(draft.state.resourceSelection, { pairValues: [`${fixture.vehicleId}|${fixture.driverId}`], optimizationProfile: "balanced" });
    const [moved] = await db.select().from(stopsTable).where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(moved.routeId, null);
    assert.equal(moved.planningPlanId, null);
    const repeated = await moveStopsForDispatch(fixture.organizationId, { ...input, routeRevisions: [] }, { previewOnly: true });
    assert.equal(repeated.kind, "ineligible");
    assert.equal((await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.organizationId, fixture.organizationId))).length, 1);
  } finally {
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, fixture.organizationId));
    await removeFixture(fixture);
  }
});

test("unlocked canonical source routes prepare missing road legs before unassignment", async () => {
  const fixture = await createFixture({ routeStop: {
    sequenceOrder: 1, latitude: 59.31, longitude: 18.03,
  } });
  const originalFetch = globalThis.fetch;
  let matrixCalls = 0;
  clearOsrmCache(); getDistanceCache().clear();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.ok(url.pathname.includes("/table/"), "only synthetic matrix requests are allowed");
    matrixCalls++;
    const count = url.pathname.split("/").at(-1)!.split(";").length;
    const distances = Array.from({ length: count }, (_, i) =>
      Array.from({ length: count }, (_, j) => i === j ? 0 : 1000));
    return new Response(JSON.stringify({ code: "Ok", distances,
      durations: distances.map(row => row.map(value => value / 10)) }));
  }) as typeof fetch;
  try {
    await db.update(routesTable).set({
      depotSnapshot, optimizationPlanningSnapshot: planningSnapshot, optimizationFrozen: false,
    }).where(eq(routesTable.id, fixture.routeId));
    await runWithUsageContext({
      organizationId: fixture.organizationId,
      servicePolicy: { ...currentOrganizationServicePolicy(), roadProvider: "osrm" },
    }, async () => {
      const strict = await prepareDispatchLockRoadData(fixture.organizationId, { stopIds: [fixture.routeStopId!] });
      assert.equal(strict, false, "road warming must not fabricate route locks");
      assert.ok(matrixCalls > 0, "an unlocked source route must fetch missing road data");
      withRequiredRoadData(() => assert.equal(
        cachedDistance(59.31, 18.03, depotSnapshot.start.latitude, depotSnapshot.start.longitude), 1,
      ));
      const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
      const input = { stopIds: [fixture.routeStopId!], routeId: null, targetIndex: 0,
        routeRevisions: [{ routeId: route.id, planRevision: route.planRevision }] };
      const preview = await moveStopsForDispatch(fixture.organizationId, input, { previewOnly: true });
      assert.equal(preview.kind, "preview");
      if (preview.kind !== "preview") throw new Error("Expected an unassignment preview");
      assert.equal(preview.canMove, true);
      const moved = await moveStopsForDispatch(fixture.organizationId, {
        ...input, expectedPreviewDigest: preview.previewDigest,
      });
      assert.equal(moved.kind, "moved");
      const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, fixture.routeStopId!));
      assert.equal(stop.routeId, null);
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearOsrmCache(); getDistanceCache().clear();
    await removeFixture(fixture);
  }
});

test("dispatch move preview is non-mutating and the same move still commits", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  const targetRouteId = randomUUID();
  const targetAnchorId = randomUUID();
  try {
    await db.update(routesTable).set({
      handoffStatus: "accepted",
      handoffVersion: 3,
      handoffDriverId: fixture.driverId!,
      acceptedAt: new Date("2026-08-25T12:00:00.000Z"),
    }).where(eq(routesTable.id, fixture.routeId));
    await db.insert(routesTable).values({
      id: targetRouteId,
      organizationId: fixture.organizationId,
      vehicleId: fixture.vehicleId,
      name: "Dispatch preview target route",
      date: new Date("2026-08-26T00:00:00.000Z"),
      planRevision: 4,
    });
    await db.insert(stopsTable).values({
      id: targetAnchorId,
      organizationId: fixture.organizationId,
      routeId: targetRouteId,
      address: "Existing target stop",
      latitude: 59.33,
      longitude: 18.03,
      status: "pending",
      sequenceOrder: 1,
      serviceDurationMin: 15,
    });

    const [sourceBefore] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const [targetBefore] = await db.select().from(routesTable)
      .where(eq(routesTable.id, targetRouteId));
    const [movingBefore] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.ok(sourceBefore);
    assert.ok(targetBefore);
    assert.ok(movingBefore);
    const preview = await requestDispatchMovePreview(
      fixture,
      [fixture.routeStopId!],
      targetRouteId,
      1,
    );
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const { previewDigest, consequences, ...legacyPreview } = PreviewDispatchStopMoveResponse.parse(preview.body);
    assert.match(previewDigest, /^[a-f0-9]{64}$/);
    assert.equal(consequences.routes.length, 2);
    assert.deepEqual(legacyPreview, {
      canMove: true,
      conflicts: [],
      sourceRouteIds: [fixture.routeId],
      targetRouteId,
      targetStopCount: 2,
    });

    const [sourceAfterPreview] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const [targetAfterPreview] = await db.select().from(routesTable)
      .where(eq(routesTable.id, targetRouteId));
    const [movingAfterPreview] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(sourceAfterPreview.planRevision, sourceBefore.planRevision);
    assert.equal(sourceAfterPreview.handoffStatus, "accepted");
    assert.equal(targetAfterPreview.planRevision, targetBefore.planRevision);
    assert.deepEqual(
      [movingAfterPreview.routeId, movingAfterPreview.sequenceOrder],
      [movingBefore.routeId, movingBefore.sequenceOrder],
    );

    const committed = await requestBulkMove(
      fixture,
      [fixture.routeStopId!],
      1,
      false,
      targetRouteId,
    );
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    const [movingAfterCommit] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(movingAfterCommit.routeId, targetRouteId);
    assert.equal(movingAfterCommit.sequenceOrder, 2);
    const [sourceAfterCommit] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const [targetAfterCommit] = await db.select().from(routesTable)
      .where(eq(routesTable.id, targetRouteId));
    assert.equal(sourceAfterCommit.planRevision, sourceBefore.planRevision + 1);
    assert.equal(sourceAfterCommit.handoffStatus, "pending");
    assert.equal(targetAfterCommit.planRevision, targetBefore.planRevision + 1);
  } finally {
    await removeFixture(fixture);
  }
});

test("dispatch move preview reports soft conflicts without turning them into hard errors", async () => {
  const fixture = await createFixture({
    vehicle: { capacityKg: 1 },
    routeStop: { sequenceOrder: 1, weightKg: 2 },
  });
  const targetRouteId = randomUUID();
  try {
    await db.insert(routesTable).values({
      id: targetRouteId,
      organizationId: fixture.organizationId,
      vehicleId: fixture.vehicleId,
      name: "Dispatch preview conflict target",
      date: new Date("2026-08-26T00:00:00.000Z"),
    });
    const response = await requestDispatchMovePreview(
      fixture,
      [fixture.routeStopId!],
      targetRouteId,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { previewDigest, consequences, ...legacyPreview } = PreviewDispatchStopMoveResponse.parse(response.body);
    assert.match(previewDigest, /^[a-f0-9]{64}$/);
    assert.equal(consequences.status, "unknown");
    assert.deepEqual(legacyPreview, {
      canMove: false,
      conflicts: ["CAPACITY"],
      sourceRouteIds: [fixture.routeId],
      targetRouteId,
      targetStopCount: 1,
    });
    const [unchanged] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(unchanged.routeId, fixture.routeId);
    assert.equal(unchanged.sequenceOrder, 1);
  } finally {
    await removeFixture(fixture);
  }
});

test("planned-to-unplanned bulk rejection leaves every source stop unchanged", async () => {
  const fixture = await createFixture({
    stop: { status: "completed" },
    routeStop: { sequenceOrder: 1 },
  });
  try {
    const response = await requestBulkMove(
      fixture,
      [fixture.routeStopId!, fixture.stopId],
      0,
      false,
      null,
    );
    assert.equal(response.status, 409);

    const saved = await db
      .select({
        id: stopsTable.id,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, fixture.organizationId));
    const byId = new Map(saved.map((stop) => [stop.id, stop]));
    assert.equal(byId.get(fixture.routeStopId!)?.routeId, fixture.routeId);
    assert.equal(byId.get(fixture.routeStopId!)?.sequenceOrder, 1);
    assert.equal(byId.get(fixture.stopId)?.routeId, null);
  } finally {
    await removeFixture(fixture);
  }
});

test("concurrent moves of the same unplanned stop produce one revision conflict without route sequence gaps", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  const secondRouteId = randomUUID();
  const secondAnchorId = randomUUID();
  try {
    await db.insert(routesTable).values({
      id: secondRouteId,
      organizationId: fixture.organizationId,
      vehicleId: fixture.vehicleId,
      name: "Concurrent target route",
      date: new Date("2026-08-26T00:00:00.000Z"),
    });
    await db.insert(stopsTable).values({
      id: secondAnchorId,
      organizationId: fixture.organizationId,
      routeId: secondRouteId,
      address: "Concurrent target anchor",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      sequenceOrder: 1,
      serviceDurationMin: 15,
    });

    const [first, second] = await Promise.all([
      requestBulkMove(fixture, [fixture.stopId], 0, false, fixture.routeId),
      requestBulkMove(fixture, [fixture.stopId], 0, false, secondRouteId),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort((a, b) => a - b),
      [200, 409],
    );

    const routed = await db
      .select({
        id: stopsTable.id,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
      })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, fixture.organizationId));
    const sequencesByRoute = [fixture.routeId, secondRouteId].map((routeId) =>
      routed
        .filter((stop) => stop.routeId === routeId)
        .map((stop) => stop.sequenceOrder)
        .sort((a, b) => (a ?? 0) - (b ?? 0)),
    );
    assert.deepEqual(
      sequencesByRoute.map((values) => values.length).sort(),
      [1, 2],
    );
    for (const values of sequencesByRoute) {
      assert.deepEqual(values, values.map((_, index) => index + 1));
    }
    assert.equal(
      routed.filter((stop) => stop.id === fixture.stopId).length,
      1,
    );
  } finally {
    await db
      .delete(stopsTable)
      .where(eq(stopsTable.organizationId, fixture.organizationId));
    await db.delete(routesTable).where(eq(routesTable.id, secondRouteId));
    await removeFixture(fixture);
  }
});

test("bulk and legacy assignment serialize with either a valid write or a stale bulk conflict", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  const bulkStopId = randomUUID();
  try {
    await db.insert(stopsTable).values({
      id: bulkStopId,
      organizationId: fixture.organizationId,
      routeId: null,
      address: "Concurrent bulk assignment stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      serviceDurationMin: 15,
    });

    const [legacy, bulk] = await Promise.all([
      requestAssignment(fixture, false, 2),
      requestBulkMove(fixture, [bulkStopId], 1),
    ]);
    assert.equal(legacy.status, 200);
    assert.ok(bulk.status === 200 || bulk.status === 409);

    const ordered = await db
      .select({ id: stopsTable.id, sequenceOrder: stopsTable.sequenceOrder })
      .from(stopsTable)
      .where(eq(stopsTable.routeId, fixture.routeId))
      .orderBy(stopsTable.sequenceOrder);
    assert.equal(ordered.length, bulk.status === 200 ? 3 : 2);
    assert.deepEqual(
      ordered.map((stop) => stop.sequenceOrder),
      ordered.map((_, index) => index + 1),
    );
    assert.equal(new Set(ordered.map((stop) => stop.id)).size, ordered.length);
    const [bulkStop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, bulkStopId));
    assert.equal(
      bulkStop.routeId,
      bulk.status === 200 ? fixture.routeId : null,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("bulk move rejects a fractional target index", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  try {
    const response = await requestBulkMove(
      fixture,
      [fixture.stopId],
      0.5,
    );
    assert.equal(response.status, 400);
    const saved = await requestStop(fixture);
    assert.equal(saved.body.routeId, null);
  } finally {
    await removeFixture(fixture);
  }
});

test("driver working hours produce a forceable red-warning conflict", async () => {
  const fixture = await createFixture({
    driver: { workStartTime: "07:00", workEndTime: "07:05" },
    stop: { serviceDurationMin: 15 },
  });
  try {
    const normal = await requestAssignment(fixture);
    assert.equal(normal.status, 409);
    assert.deepEqual(normal.body.conflicts, ["WORKING_HOURS"]);

    const forced = await requestAssignment(fixture, true);
    assert.equal(forced.status, 200);
    assert.ok(forced.body.assignmentOverrideAt);
    assert.deepEqual(forced.body.assignmentOverrideReasonCodes, ["WORKING_HOURS"]);
  } finally {
    await removeFixture(fixture);
  }
});

test("force assignment still rejects field-service and pickup-delivery integrity failures", async () => {
  const fieldServiceFixture = await createFixture({
    stop: {
      jobType: "field_service",
      requiredSkills: ["SKILL_NOT_AVAILABLE"],
    },
  });
  const pickupDeliveryFixture = await createFixture({
    stop: {
      jobType: "pickup_delivery",
      pickupAddress: "Pickup location without coordinates",
      pickupLatitude: null,
      pickupLongitude: null,
    },
  });

  try {
    const fieldServiceResponse = await requestAssignment(
      fieldServiceFixture,
      true,
    );
    assert.equal(fieldServiceResponse.status, 409);
    assert.match(
      String(fieldServiceResponse.body.error),
      /Field service requirements/,
    );

    const pickupDeliveryResponse = await requestAssignment(
      pickupDeliveryFixture,
      true,
    );
    assert.equal(pickupDeliveryResponse.status, 409);
    assert.deepEqual(pickupDeliveryResponse.body.conflicts, []);
    assert.match(
      String(pickupDeliveryResponse.body.error),
      /pickup coordinates/,
    );

    const [fieldServiceStop, pickupDeliveryStop] = await Promise.all([
      requestStop(fieldServiceFixture),
      requestStop(pickupDeliveryFixture),
    ]);
    assert.equal(fieldServiceStop.status, 200);
    assert.equal(fieldServiceStop.body.routeId, null);
    assert.equal(fieldServiceStop.body.assignmentOverrideAt, null);
    assert.equal(pickupDeliveryStop.status, 200);
    assert.equal(pickupDeliveryStop.body.routeId, null);
    assert.equal(pickupDeliveryStop.body.assignmentOverrideAt, null);
  } finally {
    await removeFixture(fieldServiceFixture);
    await removeFixture(pickupDeliveryFixture);
  }
});

test("dispatch assignment rejects stops that are already routed or no longer pending", async () => {
  const alreadyRoutedFixture = await createFixture({
    stop: { routeId: undefined },
  });
  const nonPendingFixture = await createFixture({
    stop: { status: "completed" },
  });

  try {
    await db
      .update(stopsTable)
      .set({ routeId: alreadyRoutedFixture.routeId, sequenceOrder: 2 })
      .where(eq(stopsTable.id, alreadyRoutedFixture.stopId));

    for (const fixture of [alreadyRoutedFixture, nonPendingFixture]) {
      const response = await requestAssignment(fixture, true);
      assert.equal(response.status, 409);
      assert.deepEqual(response.body.conflicts, []);
      assert.match(String(response.body.error), /pending, unplanned/);
    }
  } finally {
    await removeFixture(alreadyRoutedFixture);
    await removeFixture(nonPendingFixture);
  }
});

test("bulk move rejects a stop status transition after its validation snapshot", async () => {
  const fixture = await createFixture();
  const gate = dispatchMutationGate();
  setDispatchMutationBeforeLockHookForTest(gate.hook);
  try {
    const movePromise = requestBulkMove(fixture, [fixture.stopId]);
    await gate.entered;
    await db
      .update(stopsTable)
      .set({ status: "in_progress" })
      .where(eq(stopsTable.id, fixture.stopId));
    gate.release();

    const response = await movePromise;
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /changed/i);
    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(stop.status, "in_progress");
    assert.equal(stop.routeId, null);
  } finally {
    gate.release();
    setDispatchMutationBeforeLockHookForTest(undefined);
    await removeFixture(fixture);
  }
});

test("bulk move rejects a vehicle constraint change after its validation snapshot", async () => {
  const fixture = await createFixture({ stop: { weightKg: 500 } });
  const gate = dispatchMutationGate();
  setDispatchMutationBeforeLockHookForTest(gate.hook);
  try {
    const movePromise = requestBulkMove(fixture, [fixture.stopId]);
    await gate.entered;
    await db
      .update(vehiclesTable)
      .set({ capacityKg: 100 })
      .where(eq(vehiclesTable.id, fixture.vehicleId));
    gate.release();

    const response = await movePromise;
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /changed/i);
    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(stop.routeId, null);
  } finally {
    gate.release();
    setDispatchMutationBeforeLockHookForTest(undefined);
    await removeFixture(fixture);
  }
});

test("legacy assignment rejects a driver constraint change after its validation snapshot", async () => {
  const fixture = await createFixture({ driver: {} });
  const gate = dispatchMutationGate();
  setDispatchMutationBeforeLockHookForTest(gate.hook);
  try {
    const assignmentPromise = requestAssignment(fixture);
    await gate.entered;
    await db
      .update(driversTable)
      .set({ workEndTime: "07:01" })
      .where(eq(driversTable.id, fixture.driverId!));
    gate.release();

    const response = await assignmentPromise;
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /changed/i);
    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(stop.routeId, null);
  } finally {
    gate.release();
    setDispatchMutationBeforeLockHookForTest(undefined);
    await removeFixture(fixture);
  }
});

test("bulk removal preserves a completed stop before or after the pending stop", async () => {
  for (const pendingBeforeLocked of [true, false]) {
    const fixture = await createFixture({
      routeStop: {
        status: "completed",
        sequenceOrder: pendingBeforeLocked ? 2 : 1,
      },
    });
    try {
      await db
        .update(stopsTable)
        .set({
          routeId: fixture.routeId,
          sequenceOrder: pendingBeforeLocked ? 1 : 2,
        })
        .where(eq(stopsTable.id, fixture.stopId));

      const response = await requestBulkMove(
        fixture,
        [fixture.stopId],
        0,
        false,
        null,
      );
      assert.equal(response.status, pendingBeforeLocked ? 409 : 200);
      if (pendingBeforeLocked) {
        assert.match(String(response.body.error), /locked/i);
        assert.equal(response.body.code, "STOP_LIFECYCLE_LOCKED");
        assert.deepEqual(response.body.details, {
          stopId: fixture.routeStopId!,
          routeId: fixture.routeId,
          sequenceOrder: 2,
          status: "completed",
          address: "Existing route test stop",
        });
        assert.equal(
          Object.prototype.hasOwnProperty.call(response.body.details, "notes"),
          false,
        );
        assert.equal(
          Object.prototype.hasOwnProperty.call(response.body.details, "contactName"),
          false,
        );
      }

      const [lockedStop] = await db
        .select()
        .from(stopsTable)
        .where(eq(stopsTable.id, fixture.routeStopId!));
      assert.equal(lockedStop.status, "completed");
      assert.equal(lockedStop.routeId, fixture.routeId);
      assert.equal(lockedStop.sequenceOrder, pendingBeforeLocked ? 2 : 1);

      const [pendingStop] = await db
        .select()
        .from(stopsTable)
        .where(eq(stopsTable.id, fixture.stopId));
      assert.equal(
        pendingStop.routeId,
        pendingBeforeLocked ? fixture.routeId : null,
      );
      assert.equal(
        pendingStop.sequenceOrder,
        pendingBeforeLocked ? 1 : null,
      );
    } finally {
      await removeFixture(fixture);
    }
  }
});

test("bulk move identifies a locked stop when it is part of the selection", async () => {
  const fixture = await createFixture({
    stop: {
      status: "completed",
      address: "Locked queue stop",
    },
  });
  try {
    const response = await requestBulkMove(fixture, [fixture.stopId], 0);
    assert.equal(response.status, 409);
    // Keep the pre-existing message for clients that display or match it.
    assert.equal(response.body.error, "Only pending stops can be moved in dispatch");
    assert.equal(response.body.code, "STOP_LIFECYCLE_LOCKED");
    assert.deepEqual(response.body.details, {
      stopId: fixture.stopId,
      routeId: null,
      sequenceOrder: null,
      status: "completed",
      address: "Locked queue stop",
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("legacy assignment identifies a locked stop when it is the selected stop", async () => {
  const fixture = await createFixture({
    stop: {
      status: "failed",
      address: "Failed queue stop",
    },
  });
  try {
    const response = await requestAssignment(fixture);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "Only pending, unplanned stops can be assigned from this queue");
    assert.equal(response.body.code, "STOP_LIFECYCLE_LOCKED");
    assert.deepEqual(response.body.details, {
      stopId: fixture.stopId,
      routeId: null,
      sequenceOrder: null,
      status: "failed",
      address: "Failed queue stop",
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("bulk insertion rejects before an active stop and succeeds after it without touching it", async () => {
  const fixture = await createFixture({
    routeStop: { status: "in_progress", sequenceOrder: 1 },
  });
  try {
    const before = await requestBulkMove(fixture, [fixture.stopId], 0);
    assert.equal(before.status, 409);
    assert.match(String(before.body.error), /locked/i);

    const after = await requestBulkMove(fixture, [fixture.stopId], 1);
    assert.equal(after.status, 200);

    const [lockedStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(lockedStop.status, "in_progress");
    assert.equal(lockedStop.routeId, fixture.routeId);
    assert.equal(lockedStop.sequenceOrder, 1);
    const [pendingStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(pendingStop.routeId, fixture.routeId);
    assert.equal(pendingStop.sequenceOrder, 2);
  } finally {
    await removeFixture(fixture);
  }
});

test("legacy insertion rejects before an active stop and succeeds after it without touching it", async () => {
  const fixture = await createFixture({
    routeStop: { status: "in_progress", sequenceOrder: 1 },
  });
  try {
    const before = await requestAssignment(fixture, false, 1);
    assert.equal(before.status, 409);
    assert.match(String(before.body.error), /locked/i);
    assert.equal(before.body.code, "STOP_LIFECYCLE_LOCKED");
    assert.deepEqual(before.body.details, {
      stopId: fixture.routeStopId!,
      routeId: fixture.routeId,
      sequenceOrder: 1,
      status: "in_progress",
      address: "Existing route test stop",
    });

    const after = await requestAssignment(fixture, false, 2);
    assert.equal(after.status, 200);

    const [lockedStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(lockedStop.status, "in_progress");
    assert.equal(lockedStop.routeId, fixture.routeId);
    assert.equal(lockedStop.sequenceOrder, 1);
    const [pendingStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(pendingStop.routeId, fixture.routeId);
    assert.equal(pendingStop.sequenceOrder, 2);
  } finally {
    await removeFixture(fixture);
  }
});

test("generic stop editing cannot bypass atomic route position or lifecycle mutations", async () => {
  const fixture = await createFixture({
    routeStop: { status: "in_progress", sequenceOrder: 1 },
  });
  try {
    const pendingMove = await requestStopUpdate(fixture, fixture.stopId, {
      routeId: fixture.routeId,
      sequenceOrder: 2,
    });
    assert.equal(pendingMove.status, 409);
    assert.match(String(pendingMove.body.error), /atomic planning or dispatch/i);

    const lockedMove = await requestStopUpdate(fixture, fixture.routeStopId!, {
      routeId: null,
      sequenceOrder: null,
    });
    assert.equal(lockedMove.status, 409);
    assert.match(String(lockedMove.body.error), /atomic planning or dispatch/i);

    const reopen = await requestStopUpdate(fixture, fixture.routeStopId!, {
      status: "pending",
    });
    assert.equal(reopen.status, 409);
    assert.match(String(reopen.body.error), /cannot be reopened/i);

    const [pendingStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.stopId));
    assert.equal(pendingStop.status, "pending");
    assert.equal(pendingStop.routeId, null);
    assert.equal(pendingStop.sequenceOrder, null);
    const [lockedStop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(lockedStop.status, "in_progress");
    assert.equal(lockedStop.routeId, fixture.routeId);
    assert.equal(lockedStop.sequenceOrder, 1);
  } finally {
    await removeFixture(fixture);
  }
});

test("generic stop creation cannot attach a stop directly to a route", async () => {
  const fixture = await createFixture();
  try {
    const response = await requestStopCreate(fixture, {
      organizationId: fixture.organizationId,
      address: "Unsafe generic route attachment",
      latitude: 59.35,
      longitude: 18.08,
      routeId: fixture.routeId,
      sequenceOrder: 1,
    });
    assert.equal(response.status, 409);
    assert.match(String(response.body.error), /create stops unassigned/i);
    const attached = await db
      .select()
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, fixture.organizationId),
        eq(stopsTable.routeId, fixture.routeId),
      ));
    assert.equal(attached.length, 0);
  } finally {
    await removeFixture(fixture);
  }
});

test("late stop joins only its active plan's unassigned queue without changing routes", async () => {
  const fixture = await createFixture();
  try {
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.ok(route);
    const response = await requestStopCreate(fixture, {
      organizationId: fixture.organizationId,
      address: "Late plan stop",
      latitude: 59.35,
      longitude: 18.08,
      planningDate: "2030-01-01",
    }, "dispatcher", { id: route.planId, revision: route.planRevision });
    assert.equal(response.status, 201);
    const [created] = await db.select().from(stopsTable).where(eq(stopsTable.id, response.body.id as string));
    assert.ok(created);
    assert.equal(created.routeId, null);
    assert.equal(created.status, "pending");
    assert.equal(created.planningPlanId, route.planId);
    assert.equal(created.planningDate?.getTime(), route.date.getTime());
    const [unchanged] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    assert.equal(unchanged?.planRevision, route.planRevision + 1);

    const foreign = await requestStopCreate(fixture, {
      organizationId: fixture.organizationId,
      address: "Wrong plan",
      latitude: 59.35,
      longitude: 18.08,
    }, "dispatcher", { id: randomUUID(), revision: route.planRevision + 1 });
    assert.equal(foreign.status, 409);
    const forbidden = await requestStopCreate(fixture, {
      organizationId: fixture.organizationId,
      address: "Viewer cannot add",
      latitude: 59.35,
      longitude: 18.08,
    }, "viewer", { id: route.planId, revision: route.planRevision + 1 });
    assert.equal(forbidden.status, 403);

    await db.update(routesTable).set({ status: "completed" }).where(eq(routesTable.id, fixture.routeId));
    const closed = await requestStopCreate(fixture, {
      organizationId: fixture.organizationId,
      address: "Closed plan",
      latitude: 59.35,
      longitude: 18.08,
    }, "dispatcher", { id: route.planId, revision: route.planRevision + 1 });
    assert.equal(closed.status, 409);
    const planStops = await db.select().from(stopsTable).where(and(
      eq(stopsTable.organizationId, fixture.organizationId),
      eq(stopsTable.planningPlanId, route.planId),
    ));
    assert.equal(planStops.length, 1);
  } finally {
    await removeFixture(fixture);
  }
});

test("late stop creation followed by assignment preserves the selected plan and leaves another plan untouched", async () => {
  const fixture = await createFixture();
  try {
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, fixture.routeId));
    const [other] = await db.insert(routesTable).values({
      organizationId: fixture.organizationId,
      name: "Other late-stop plan",
      date: route.date,
    }).returning();
    const created = await requestStopCreate(fixture, {
      organizationId: fixture.organizationId,
      address: "Late stop for selected plan",
      latitude: 59.3293,
      longitude: 18.0686,
    }, "dispatcher", { id: route.planId, revision: route.planRevision });
    assert.equal(created.status, 201);
    const stopId = created.body.id as string;
    const assigned = await requestAssignment({ ...fixture, stopId }, false, 1);
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const [saved] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.equal(saved.routeId, fixture.routeId);
    assert.equal(saved.planningPlanId, route.planId);
    assert.equal(saved.sequenceOrder, 1);
    const [unchanged] = await db.select().from(routesTable).where(eq(routesTable.id, other.id));
    assert.deepEqual(unchanged, other);
    const otherStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, other.id));
    assert.equal(otherStops.length, 0);
  } finally {
    await removeFixture(fixture);
  }
});

test("generic deletion preserves lifecycle anchors and compacts pending positions", async () => {
  const lockedFixture = await createFixture({
    routeStop: { status: "in_progress", sequenceOrder: 2 },
  });
  try {
    await db
      .update(stopsTable)
      .set({ routeId: lockedFixture.routeId, sequenceOrder: 1 })
      .where(eq(stopsTable.id, lockedFixture.stopId));
    const rejected = await requestStopDeletion(
      lockedFixture,
      [lockedFixture.stopId],
    );
    assert.equal(rejected.status, 409);
    const lockedStops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, lockedFixture.routeId));
    assert.deepEqual(
      lockedStops
        .map((stop) => [stop.id, stop.status, stop.sequenceOrder])
        .sort(),
      [
        [lockedFixture.routeStopId!, "in_progress", 2],
        [lockedFixture.stopId, "pending", 1],
      ].sort(),
    );
  } finally {
    await removeFixture(lockedFixture);
  }

  const pendingFixture = await createFixture({
    routeStop: { status: "pending", sequenceOrder: 2 },
  });
  try {
    await db
      .update(stopsTable)
      .set({ routeId: pendingFixture.routeId, sequenceOrder: 1 })
      .where(eq(stopsTable.id, pendingFixture.stopId));
    const deleted = await requestStopDeletion(
      pendingFixture,
      [pendingFixture.stopId],
    );
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deletedCount, 1);
    const [remaining] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, pendingFixture.routeStopId!));
    assert.equal(remaining.status, "pending");
    assert.equal(remaining.sequenceOrder, 1);
  } finally {
    await removeFixture(pendingFixture);
  }
});

test("dispatch defer atomically dates a composite P&D order and invalidates its source route acceptance", async () => {
  const fixture = await createFixture({
    routeStop: {
      sequenceOrder: 1,
      jobType: "pickup_delivery",
      pickupAddress: "Pickup location",
      pickupLatitude: 59.32,
      pickupLongitude: 18.02,
      planningDate: new Date("2026-08-26T00:00:00.000Z"),
    },
  });
  const remainingStopId = randomUUID();
  const draftId = randomUUID();
  try {
    const [routeBefore] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.ok(routeBefore);
    await db.update(routesTable).set({
      draftId,
      handoffStatus: "accepted",
      handoffVersion: 3,
      handoffDriverId: fixture.driverId!,
      acceptedAt: new Date("2026-08-25T12:00:00.000Z"),
      optimizationResourceSnapshot: { driver: { id: fixture.driverId! } },
    }).where(eq(routesTable.id, fixture.routeId));
    await db.update(stopsTable).set({
      planningPlanId: routeBefore.planId,
    }).where(eq(stopsTable.id, fixture.routeStopId!));
    await db.insert(stopsTable).values({
      id: remainingStopId,
      organizationId: fixture.organizationId,
      routeId: fixture.routeId,
      address: "Still planned",
      latitude: 59.33,
      longitude: 18.03,
      status: "pending",
      sequenceOrder: 2,
      serviceDurationMin: 15,
      planningPlanId: routeBefore.planId,
    });

    const response = await requestDispatchDefer(fixture, [fixture.routeStopId!]);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.stopIds, [fixture.routeStopId]);
    assert.equal(response.body.targetDate, "2099-06-01");
    assert.deepEqual(response.body.sourceRouteImpacts, [{
      routeId: fixture.routeId,
      previousPlanRevision: routeBefore.planRevision,
      planRevision: routeBefore.planRevision + 1,
      deferredStopIds: [fixture.routeStopId],
      remainingStopCount: 1,
    }]);

    const [deferred] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    assert.equal(deferred.routeId, null);
    assert.equal(deferred.sequenceOrder, null);
    assert.equal(deferred.planningDate?.toISOString(), "2099-05-31T22:00:00.000Z");
    assert.equal(deferred.planningPlanId, null);
    assert.equal(deferred.jobType, "pickup_delivery");
    assert.equal(deferred.pickupAddress, "Pickup location");
    assert.equal(deferred.pickupLatitude, 59.32);
    assert.equal(deferred.pickupLongitude, 18.02);
    const [remaining] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, remainingStopId));
    assert.equal(remaining.sequenceOrder, 1);
    const oldPlanStops = await db.select({ id: stopsTable.id }).from(stopsTable).where(and(
      eq(stopsTable.organizationId, fixture.organizationId),
      eq(stopsTable.planningPlanId, routeBefore.planId),
    ));
    assert.deepEqual(oldPlanStops.map((stop) => stop.id), [remainingStopId]);
    const futureBacklog = await db.select({ id: stopsTable.id }).from(stopsTable).where(and(
      eq(stopsTable.organizationId, fixture.organizationId),
      eq(stopsTable.status, "pending"),
      isNull(stopsTable.routeId),
      gte(stopsTable.planningDate, new Date("2099-05-31T22:00:00.000Z")),
      lt(stopsTable.planningDate, new Date("2099-06-01T22:00:00.000Z")),
    ));
    assert.deepEqual(futureBacklog.map((stop) => stop.id), [fixture.routeStopId]);
    const [routeAfter] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(routeAfter.planId, routeBefore.planId);
    assert.equal(routeAfter.draftId, draftId);
    assert.equal(routeAfter.planRevision, routeBefore.planRevision + 1);
    assert.equal(routeAfter.handoffStatus, "pending");
    assert.equal(routeAfter.handoffVersion, null);
    assert.equal(routeAfter.handoffDriverId, null);
    assert.equal(routeAfter.acceptedAt, null);
  } finally {
    await removeFixture(fixture);
  }
});

test("dispatch defer rejects non-pending and cross-tenant selected stops without mutation", async () => {
  const nonPendingFixture = await createFixture({
    routeStop: { status: "completed", sequenceOrder: 1 },
  });
  const tenantFixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  try {
    const [before] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, nonPendingFixture.routeStopId!));
    const nonPending = await requestDispatchDefer(
      nonPendingFixture,
      [nonPendingFixture.routeStopId!],
    );
    assert.equal(nonPending.status, 409);
    const [unchanged] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, nonPendingFixture.routeStopId!));
    assert.equal(unchanged.routeId, before.routeId);
    assert.equal(unchanged.status, "completed");

    const crossTenant = await requestDispatchDefer(
      nonPendingFixture,
      [tenantFixture.routeStopId!],
    );
    assert.equal(crossTenant.status, 404);
    const [foreignStop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, tenantFixture.routeStopId!));
    assert.equal(foreignStop.routeId, tenantFixture.routeId);
  } finally {
    await removeFixture(nonPendingFixture);
    await removeFixture(tenantFixture);
  }
});

test("dispatch defer rejects stale source route revisions without partial writes", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  try {
    const [before] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    const response = await requestDispatchDefer(
      fixture,
      [fixture.routeStopId!],
      [{ routeId: fixture.routeId, planRevision: before.planRevision + 1 }],
    );
    assert.equal(response.status, 409);
    const [stopAfter] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    const [routeAfter] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(stopAfter.routeId, fixture.routeId);
    assert.equal(stopAfter.planningDate, null);
    assert.equal(routeAfter.planRevision, before.planRevision);
  } finally {
    await removeFixture(fixture);
  }
});

test("concurrent dispatch defer requests for one stop commit once and conflict atomically", async () => {
  const fixture = await createFixture({ routeStop: { sequenceOrder: 1 } });
  let arrivals = 0;
  let markBothArrived!: () => void;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    markBothArrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  setDispatchMutationBeforeLockHookForTest(async () => {
    arrivals += 1;
    if (arrivals === 2) markBothArrived();
    await released;
  });
  try {
    const requests = [
      requestDispatchDefer(fixture, [fixture.routeStopId!]),
      requestDispatchDefer(fixture, [fixture.routeStopId!]),
    ];
    await bothArrived;
    release();
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const [stop] = await db.select().from(stopsTable)
      .where(eq(stopsTable.id, fixture.routeStopId!));
    const [route] = await db.select().from(routesTable)
      .where(eq(routesTable.id, fixture.routeId));
    assert.equal(stop.routeId, null);
    assert.equal(stop.sequenceOrder, null);
    assert.equal(stop.planningDate?.toISOString(), "2099-05-31T22:00:00.000Z");
    assert.equal(route.planRevision, 1);
  } finally {
    setDispatchMutationBeforeLockHookForTest(undefined);
    release();
    await removeFixture(fixture);
  }
});
