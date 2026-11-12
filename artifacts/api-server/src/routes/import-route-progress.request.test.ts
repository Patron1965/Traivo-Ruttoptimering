import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  db,
  driversTable,
  importPlanProgressTable,
  organizationsTable,
  planningDraftsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser, UserRole } from "../middleware/auth";
import importRouteWorkflowRouter from "./import-route-workflow";
import { prepareOperationalRoadData } from "../middleware/operational-road-data";
import { RoadDataUnavailableError } from "../services/road-data-policy";
import {
  createImportProgressReporterForTest,
} from "../services/import-route-workflow";

type RunningApp = { url: string; close: () => Promise<void> };

function appFor(
  organizationId: string,
  role: UserRole | null = "dispatcher",
): Express {
  const app = express();
  app.use(express.json());
  if (role) {
    app.use((req, _res, next) => {
      req.user = {
        id: randomUUID(),
        name: "Import progress test",
        email: "import-progress@example.test",
        role,
        organizationId,
        driverProfileId: null,
      } satisfies AuthUser;
      next();
    });
  }
  app.use(prepareOperationalRoadData, importRouteWorkflowRouter);
  return app;
}

async function runningApp(
  organizationId: string,
  role: UserRole | null = "dispatcher",
): Promise<RunningApp> {
  const server = appFor(organizationId, role).listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function request(
  url: string,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

async function organization(id = randomUUID()): Promise<string> {
  await db.insert(organizationsTable).values({
    id,
    name: `Import progress ${id}`,
    email: `${id}@import-progress.test`,
  });
  return id;
}

async function resource(organizationId: string, suffix = "vehicle") {
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: `${suffix} ${vehicleId.slice(0, 6)}`,
    licensePlate: `IP-${vehicleId.slice(0, 8)}`,
    capacityKg: 100_000,
    capacityVolume: 1000,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: `${suffix} driver`,
    startLatitude: 59.3293,
    startLongitude: 18.0686,
    isActive: true,
  });
  return { vehicleId, driverId };
}

async function stop(
  organizationId: string,
  id = randomUUID(),
  index = 0,
) {
  await db.insert(stopsTable).values({
    id,
    organizationId,
    address: `Import progress stop ${id}`,
    latitude: 59.33 + index / 10_000,
    longitude: 18.07 + index / 10_000,
    sequenceOrder: null,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
    status: "pending",
  });
  return id;
}

async function cleanup(organizationIds: string[]) {
  for (const organizationId of organizationIds) {
    await db
      .delete(importPlanProgressTable)
      .where(eq(importPlanProgressTable.organizationId, organizationId));
    await db
      .delete(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));
    await db
      .delete(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    await db
      .delete(planningDraftsTable)
      .where(eq(planningDraftsTable.organizationId, organizationId));
    await db
      .delete(driversTable)
      .where(eq(driversTable.organizationId, organizationId));
    await db
      .delete(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));
    await db
      .delete(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
  }
}

function input(
  stopIds: string[],
  pair: { vehicleId: string; driverId: string },
  progressId?: string,
) {
  return {
    ...(progressId ? { progressId } : {}),
    stopIds,
    pairs: [pair],
    date: "2026-09-17T08:00:00.000Z",
    depotLatitude: 59.3293,
    depotLongitude: 18.0686,
  };
}

test("progress GET is tenant scoped and enforces operational roles", async () => {
  const ownOrg = await organization();
  const otherOrg = await organization();
  const progressId = randomUUID();
  const own = await runningApp(ownOrg);
  const other = await runningApp(otherOrg);
  const viewer = await runningApp(ownOrg, "viewer");
  const unauthenticated = await runningApp(ownOrg, null);
  try {
    const bad = await request(
      own.url,
      "/import/route-plans",
      "POST",
      {
        progressId,
        stopIds: [randomUUID()],
        pairs: [{ vehicleId: randomUUID(), driverId: randomUUID() }],
        date: "2026-09-17T08:00:00.000Z",
        depotLatitude: 59,
        depotLongitude: 18,
      },
    );
    assert.equal(bad.status, 400);
    assert.equal(
      (await request(other.url, `/import/route-plans/progress/${progressId}`))
        .status,
      404,
    );
    assert.equal(
      (await request(viewer.url, `/import/route-plans/progress/${progressId}`))
        .status,
      403,
    );
    assert.equal(
      (
        await request(
          unauthenticated.url,
          `/import/route-plans/progress/${progressId}`,
        )
      ).status,
      401,
    );
  } finally {
    await Promise.all([
      own.close(),
      other.close(),
      viewer.close(),
      unauthenticated.close(),
    ]);
    await cleanup([ownOrg, otherOrg]);
  }
});

test("road-data rejection is persisted as a terminal error with its specific code", async () => {
  const organizationId = await organization();
  const progressId = randomUUID();
  const server = await runningApp(organizationId);
  try {
    // Register through the real request path (a validation failure), then
    // exercise the reporter on a fresh running row without invoking routing.
    await request(server.url, "/import/route-plans", "POST", {
      progressId, stopIds: [randomUUID()],
      pairs: [{ vehicleId: randomUUID(), driverId: randomUUID() }],
      date: "2026-09-17T08:00:00.000Z", depotLatitude: 59, depotLongitude: 18,
    });
    await db.update(importPlanProgressTable).set({ status: "running", error: null })
      .where(eq(importPlanProgressTable.id, progressId));
    const reporter = createImportProgressReporterForTest(progressId, organizationId);
    await reporter.fail(new RoadDataUnavailableError());
    const result = await request(server.url, `/import/route-plans/progress/${progressId}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.error.code, "ROAD_DATA_UNAVAILABLE");
    assert.equal(result.body.result, null);
  } finally {
    await server.close();
    await cleanup([organizationId]);
  }
});

test("duplicate progressId cannot be reused by another organization", async () => {
  const firstOrg = await organization();
  const secondOrg = await organization();
  const progressId = randomUUID();
  const first = await runningApp(firstOrg);
  const second = await runningApp(secondOrg);
  try {
    const firstPost = await request(
      first.url,
      "/import/route-plans",
      "POST",
      {
        progressId,
        stopIds: [randomUUID()],
        pairs: [{ vehicleId: randomUUID(), driverId: randomUUID() }],
        date: "2026-09-17T08:00:00.000Z",
        depotLatitude: 59,
        depotLongitude: 18,
      },
    );
    assert.equal(firstPost.status, 400, JSON.stringify(firstPost.body));
    const [registered] = await db
      .select()
      .from(importPlanProgressTable)
      .where(eq(importPlanProgressTable.id, progressId));
    assert.ok(registered);
    const reused = await request(
      second.url,
      "/import/route-plans",
      "POST",
      {
        progressId,
        stopIds: [randomUUID()],
        pairs: [{ vehicleId: randomUUID(), driverId: randomUUID() }],
        date: "2026-09-17T08:00:00.000Z",
        depotLatitude: 59,
        depotLongitude: 18,
      },
    );
    assert.equal(reused.status, 409, JSON.stringify(reused.body));
    assert.equal(reused.body.code, "PROGRESS_ID_ALREADY_USED");
    const [row] = await db
      .select()
      .from(importPlanProgressTable)
      .where(eq(importPlanProgressTable.id, progressId));
    assert.equal(row.organizationId, firstOrg);
    assert.equal(row.status, "error");
  } finally {
    await Promise.all([first.close(), second.close()]);
    await cleanup([firstOrg, secondOrg]);
  }
});

test("completed progress is persisted after routes and survives a new app instance", async () => {
  const organizationId = await organization();
  const pair = await resource(organizationId);
  const stopId = await stop(organizationId);
  const progressId = randomUUID();
  const draftId = randomUUID();
  await db.insert(planningDraftsTable).values({
    id: draftId,
    organizationId,
    name: "Atomic progress draft",
    startAt: new Date("2026-09-17T08:00:00.000Z"),
    state: {},
  });
  const first = await runningApp(organizationId);
  try {
    const created = await request(
      first.url,
      "/import/route-plans",
      "POST",
      { ...input([stopId], pair, progressId), draftId },
    );
    assert.equal(created.status, 200);
    const [persistedRoute] = await db
      .select({ id: routesTable.id })
      .from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    assert.ok(persistedRoute);
    await first.close();
    const reloaded = await runningApp(organizationId);
    try {
      const progress = await request(
        reloaded.url,
        `/import/route-plans/progress/${progressId}`,
      );
      assert.equal(progress.status, 200);
      assert.equal(progress.body.status, "complete");
      assert.equal(progress.body.phase, "complete");
      assert.equal(progress.body.result.planId, created.body.planId);
      assert.equal(progress.body.estimatedRemainingMs, null);
      assert.ok(progress.body.serverNow);
      assert.equal(typeof progress.body.elapsedMs, "number");
      const [draft] = await db
        .select({ planId: planningDraftsTable.planId })
        .from(planningDraftsTable)
        .where(
          and(
            eq(planningDraftsTable.id, draftId),
            eq(planningDraftsTable.organizationId, organizationId),
          ),
        );
      assert.equal(draft.planId, created.body.planId);
      const staleReporter = createImportProgressReporterForTest(
        progressId,
        organizationId,
      );
      staleReporter.reportOptimization({
        totalClusters: 1,
        completedClusters: 0,
        phase: "optimizing",
        elapsedMs: 1,
        iterations: 1,
        improvements: 0,
        stopReason: null,
        clusterStopReasons: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 5100));
      const afterHeartbeat = await request(
        reloaded.url,
        `/import/route-plans/progress/${progressId}`,
      );
      assert.equal(afterHeartbeat.body.status, "complete");
      assert.equal(afterHeartbeat.body.result.planId, created.body.planId);
      await staleReporter.fail(new Error("test cleanup"));
    } finally {
      await reloaded.close();
    }
  } finally {
    await cleanup([organizationId]);
  }
});

test("booking conflict is an error progress with original conflict metadata", async () => {
  const organizationId = await organization();
  const pair = await resource(organizationId, "booked");
  const requestedStop = await stop(organizationId);
  const bookedRouteId = randomUUID();
  await db.insert(routesTable).values({
    id: bookedRouteId,
    planId: randomUUID(),
    organizationId,
    vehicleId: pair.vehicleId,
    name: "Existing booking",
    date: new Date("2026-09-17T08:00:00.000Z"),
    status: "optimized",
    totalStops: 1,
  });
  await db.insert(stopsTable).values({
    id: randomUUID(),
    organizationId,
    routeId: bookedRouteId,
    address: "Booked stop",
    latitude: 59.33,
    longitude: 18.07,
    sequenceOrder: 1,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
    status: "pending",
  });
  const app = await runningApp(organizationId);
  const progressId = randomUUID();
  try {
    const response = await request(
      app.url,
      "/import/route-plans",
      "POST",
      input([requestedStop], pair, progressId),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_ALREADY_PLANNED");
    const progress = await request(
      app.url,
      `/import/route-plans/progress/${progressId}`,
    );
    assert.equal(progress.body.status, "error");
    assert.equal(progress.body.error.code, "VEHICLE_ALREADY_PLANNED");
    assert.equal(progress.body.error.details.conflicts[0].routeId, bookedRouteId);
    assert.equal(progress.body.result, null);
  } finally {
    await app.close();
    await cleanup([organizationId]);
  }
});

test("ETA remains null for unchanged samples, then becomes positive on measured cluster advance", async () => {
  const organizationId = await organization();
  const progressId = randomUUID();
  const startedAt = new Date();
  await db.insert(importPlanProgressTable).values({
    id: progressId,
    organizationId,
    status: "running",
    phase: "optimizing",
    startedAt,
    updatedAt: startedAt,
    progress: { phaseUpdatedAt: startedAt.toISOString() },
    estimatedRemainingMs: null,
    planId: null,
    error: null,
    result: null,
  });
  const app = await runningApp(organizationId);
  const reporter = createImportProgressReporterForTest(
    progressId,
    organizationId,
  );
  try {
    const sample = {
      totalClusters: 3,
      completedClusters: 0,
      phase: "optimizing" as const,
      elapsedMs: 1000,
      iterations: 0,
      improvements: 0,
      stopReason: null,
      clusterStopReasons: {},
    };
    reporter.reportOptimization(sample);
    for (let i = 0; i < 10; i++) reporter.reportOptimization(sample);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const beforeAdvance = await request(
      app.url,
      `/import/route-plans/progress/${progressId}`,
    );
    assert.equal(beforeAdvance.body.estimatedRemainingMs, null);
    reporter.reportOptimization({
      ...sample,
      completedClusters: 1,
      elapsedMs: 2200,
      iterations: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterAdvance = await request(
      app.url,
      `/import/route-plans/progress/${progressId}`,
    );
    assert.ok((afterAdvance.body.estimatedRemainingMs ?? 0) > 0);
  } finally {
    await reporter.fail(new Error("test cleanup"));
    await app.close();
    await cleanup([organizationId]);
  }
});