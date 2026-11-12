import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { eq } from "drizzle-orm";
import {
  db,
  driverCertificationsTable,
  driversTable,
  organizationsTable,
  routesTable,
  planningDraftsTable,
  routePlanApprovalsTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import planningDraftsRouter from "./planning-drafts";
import stopsRouter from "./stops";
import importRouteWorkflowRouter from "./import-route-workflow";
import routesRouter from "./routes";
import {
  setImportPlanBeforePersistHookForTest,
} from "../services/import-route-workflow";
import { test } from "node:test";
import { DRAFT_STATE_MAX_BYTES } from "../services/planning-draft-service";

type RunningApp = { app: Express; close: () => Promise<void>; url: string };

async function runningApp(organizationId: string, userId = randomUUID()): Promise<RunningApp> {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      name: "Planning draft test",
      email: "planning-draft-test@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(planningDraftsRouter);
  app.use(stopsRouter);
  app.use(importRouteWorkflowRouter);
  app.use(routesRouter);
  app.use((
    error: Error & { status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(
  baseUrl: string,
  path: string,
  method: string,
  body?: unknown,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null) as any,
  };
}

async function createOrganization(id: string, name: string): Promise<void> {
  await db.insert(organizationsTable).values({
    id,
    name,
    email: `${id}@planning-draft.test`,
  });
}

test("planning drafts are tenant scoped and use revision compare-and-swap", async () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const composedAddressMapping = {
    address: [
      { component: "address", column: "Adress" },
      { component: "postalCode", column: "Postnummer" },
      { component: "city", column: "Postort" },
    ],
  };
  await createOrganization(organizationId, "Draft tenant");
  await createOrganization(otherOrganizationId, "Other tenant");
  const server = await runningApp(organizationId);
  const otherServer = await runningApp(otherOrganizationId);
  try {
    const created = await request(server.url, "/planning-drafts", "POST", {
      name: "September route",
      startAt: "2026-09-02T13:30:00.000Z",
      state: { step: 1, mapping: composedAddressMapping },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.revision, 0);
    assert.equal(created.body.importedResult, null);
    assert.equal(created.body.planId, null);
    assert.deepEqual(created.body.state.mapping, composedAddressMapping);

    const listed = await request(server.url, "/planning-drafts", "GET");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.drafts.length, 1);

    const resumed = await request(
      server.url,
      `/planning-drafts/${created.body.id}`,
      "GET",
    );
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body.state.mapping, composedAddressMapping);

    const hidden = await request(
      otherServer.url,
      `/planning-drafts/${created.body.id}`,
      "GET",
    );
    assert.equal(hidden.status, 404);

    const updated = await request(
      server.url,
      `/planning-drafts/${created.body.id}`,
      "PUT",
      { revision: 0, state: { step: 2 } },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.revision, 1);

    const stale = await request(
      server.url,
      `/planning-drafts/${created.body.id}`,
      "PUT",
      { revision: 0, state: { step: 3 } },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "DRAFT_REVISION_CONFLICT");
    assert.equal(stale.body.draft.revision, 1);

    const [first, second] = await Promise.all([
      request(server.url, `/planning-drafts/${created.body.id}`, "PUT", {
        revision: 1,
        state: { step: 4 },
      }),
      request(server.url, `/planning-drafts/${created.body.id}`, "PUT", {
        revision: 1,
        state: { step: 5 },
      }),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort((left, right) => left - right),
      [200, 409],
    );
  } finally {
    await server.close();
    await otherServer.close();
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, otherOrganizationId),
    );
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
  }
});

test("draft state validation rejects malformed JSON, server-owned fields, and oversized state", async () => {
  const organizationId = randomUUID();
  await createOrganization(organizationId, "Validation tenant");
  const server = await runningApp(organizationId);
  try {
    const malformed = await fetch(`${server.url}/planning-drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"broken"',
    });
    assert.equal(malformed.status, 400);

    const serverOwned = await request(server.url, "/planning-drafts", "POST", {
      name: "Owned fields",
      startAt: "2026-09-02T13:30:00.000Z",
      state: {},
      revision: 99,
      planId: randomUUID(),
    });
    assert.equal(serverOwned.status, 400);
    assert.equal(serverOwned.body.code, "SERVER_OWNED_FIELD");

    const oversized = await request(server.url, "/planning-drafts", "POST", {
      name: "Too large",
      startAt: "2026-09-02T13:30:00.000Z",
      state: { snapshot: "x".repeat(DRAFT_STATE_MAX_BYTES + 1) },
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.code, "DRAFT_STATE_TOO_LARGE");
  } finally {
    await server.close();
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("draft imports are idempotent under concurrent retries", async () => {
  const organizationId = randomUUID();
  await createOrganization(organizationId, "Import tenant");
  const server = await runningApp(organizationId);
  try {
    const draft = await request(server.url, "/planning-drafts", "POST", {
      name: "Import once",
      startAt: "2026-09-02T13:30:00.000Z",
      state: { step: 1 },
    });
    const payload = {
      organizationId,
      draftId: draft.body.id,
      expectedRowCount: 1,
      stops: [{
        address: "Testgatan 1",
        latitude: 59.3293,
        longitude: 18.0686,
        sourceRowNumber: 1,
      }],
    };
    const [first, second] = await Promise.all([
      request(server.url, "/stops/import", "POST", payload),
      request(server.url, "/stops/import", "POST", payload),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort((left, right) => left - right),
      [200, 201],
    );
    assert.deepEqual(first.body.stopIds, second.body.stopIds);
    const saved = await db.select({ id: stopsTable.id }).from(stopsTable).where(
      eq(stopsTable.organizationId, organizationId),
    );
    assert.equal(saved.length, 1);
    const [storedDraft] = await db.select().from(planningDraftsTable).where(
      eq(planningDraftsTable.id, draft.body.id),
    );
    assert.deepEqual(storedDraft.importedResult?.stopIds, first.body.stopIds);
  } finally {
    await server.close();
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("draft route-plan creation is idempotent, uses startAt in names, and rejects date drift", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  await createOrganization(organizationId, "Plan tenant");
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Van 7",
    licensePlate: `PLAN-${vehicleId.slice(0, 6)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Plan driver",
    startLatitude: 59.3293,
    startLongitude: 18.0686,
    endLatitude: 59.3293,
    endLongitude: 18.0686,
    isActive: true,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    address: "Plan street 1",
    latitude: 59.3303,
    longitude: 18.0696,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
    status: "pending",
  });
  const server = await runningApp(organizationId);
  try {
    const draft = await request(server.url, "/planning-drafts", "POST", {
      name: "Afternoon import",
      startAt: "2026-09-02T14:30:00.000Z",
      state: { step: 6 },
    });
    assert.equal(draft.status, 201);
    const payload = {
      draftId: draft.body.id,
      stopIds: [stopId],
      pairs: [{ vehicleId, driverId }],
      date: "2026-09-02T14:30:00.000Z",
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
    };
    const first = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.routes.length, 1);
    assert.match(first.body.routes[0].name, /^Afternoon import – Van 7 – 2026-09-02 16:30$/);

    // The original request identity is the client intent. Changing the
    // organization depot after a lost response must not create a second plan.
    await db.update(organizationsTable).set({
      depotStartAddress: "Changed depot",
      depotStartLatitude: 59.4,
      depotStartLongitude: 18.1,
      depotStartVerification: {
        provider: "google",
        source: "google",
        displayName: "Changed depot",
        query: "Changed depot",
      },
      depotStartVerifiedAt: new Date("2026-09-01T12:00:00.000Z"),
      depotEndAddress: "Changed depot",
      depotEndLatitude: 59.4,
      depotEndLongitude: 18.1,
      depotEndVerification: {
        provider: "google",
        source: "google",
        displayName: "Changed depot",
        query: "Changed depot",
      },
      depotEndVerifiedAt: new Date("2026-09-01T12:00:00.000Z"),
    }).where(eq(organizationsTable.id, organizationId));
    const replay = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.planId, first.body.planId);
    assert.equal(replay.body.routes[0].routeId, first.body.routes[0].routeId);
    const savedRoutes = await db.select({ id: routesTable.id }).from(routesTable).where(
      eq(routesTable.planId, first.body.planId),
    );
    assert.equal(savedRoutes.length, 1);

    const frozen = await request(
      server.url,
      `/planning-drafts/${draft.body.id}`,
      "PUT",
      { revision: 0, name: "Renamed after planning" },
    );
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.code, "DRAFT_FROZEN");

    const drift = await request(server.url, "/import/route-plans", "POST", {
      ...payload,
      date: "2026-09-02T08:00:00.000Z",
    });
    assert.equal(drift.status, 409);
    assert.equal(drift.body.error, "The route plan date must match the planning draft startAt.");
  } finally {
    await server.close();
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("protected route resume preserves the optimization-selected driver through execution", async () => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const vehicleId = randomUUID();
  const firstDriverId = "00000000-0000-4000-8000-000000000001";
  const selectedDriverId = "fffffff4-ffff-4fff-bfff-ffffffffffff";
  const stopId = randomUUID();
  const secondStopId = randomUUID();
  await createOrganization(organizationId, "Selected driver tenant");
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Selected driver planner",
    email: `${userId}@selected-driver.test`,
    role: "dispatcher",
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Shared van",
    licensePlate: `SELECT-${vehicleId.slice(0, 6)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  });
  await db.insert(driversTable).values([
    {
      id: firstDriverId,
      organizationId,
      vehicleId,
      name: "First linked driver",
      startLatitude: 59.3293,
      startLongitude: 18.0686,
      endLatitude: 59.3293,
      endLongitude: 18.0686,
      isActive: true,
    },
    {
      id: selectedDriverId,
      organizationId,
      vehicleId,
      name: "Optimization-selected driver",
      startLatitude: 59.3293,
      startLongitude: 18.0686,
      endLatitude: 59.3293,
      endLongitude: 18.0686,
      isActive: true,
    },
  ]);
  await db.insert(driverCertificationsTable).values({
    driverId: firstDriverId,
    organizationId,
    certificationCode: "OTHER_DRIVER_CERT",
    certificationName: "Other linked driver's certificate",
    issuedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  await db.insert(stopsTable).values([
    {
      id: stopId,
      organizationId,
      address: "Selected driver stop",
      latitude: 59.3303,
      longitude: 18.0696,
      serviceDurationMin: 5,
      weightKg: 1,
      volumeM3: 0.1,
      status: "pending",
    },
    {
      id: secondStopId,
      organizationId,
      address: "Selected driver second stop",
      latitude: 59.3313,
      longitude: 18.0706,
      serviceDurationMin: 5,
      weightKg: 1,
      volumeM3: 0.1,
      status: "pending",
    },
  ]);
  const server = await runningApp(organizationId, userId);
  try {
    const draft = await request(server.url, "/planning-drafts", "POST", {
      name: "Selected driver plan",
      startAt: "2026-09-04T14:30:00.000Z",
      state: { step: 6 },
    });
    assert.equal(draft.status, 201);
    const payload = {
      draftId: draft.body.id,
      stopIds: [stopId, secondStopId],
      pairs: [{ vehicleId, driverId: selectedDriverId }],
      date: "2026-09-04T14:30:00.000Z",
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
    };
    const first = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.routes.length, 1);
    let route = first.body.routes[0];
    const routeId = route.routeId;
    assert.equal(route.driverId, selectedDriverId);

    const beforeApproval = await request(
      server.url,
      `/import/route-plans/${route.planId}/approval`,
      "GET",
    );
    assert.equal(beforeApproval.status, 200);
    assert.equal(beforeApproval.body.routes[0].driverId, selectedDriverId);
    const replayBeforeApproval = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(replayBeforeApproval.status, 200, JSON.stringify(replayBeforeApproval.body));
    assert.equal(replayBeforeApproval.body.routes[0].driverId, selectedDriverId);

    const reordered = await request(
      server.url,
      `/routes/${routeId}/reorder-stops`,
      "PUT",
      { stopIds: [secondStopId, stopId], planRevision: route.planRevision },
    );
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    [route] = (await db.select().from(routesTable).where(eq(routesTable.id, routeId)));
    assert.equal(route.planRevision, 1);

    const routePreview = await request(
      server.url,
      `/routes/${routeId}/reoptimization/preview`,
      "POST",
      {
        planRevision: route.planRevision,
        depotLatitude: 59.3293,
        depotLongitude: 18.0686,
      },
    );
    assert.equal(routePreview.status, 200, JSON.stringify(routePreview.body));
    const routeApplied = await request(
      server.url,
      `/routes/${routeId}/reoptimization/apply`,
      "POST",
      {
        planRevision: route.planRevision,
        depotLatitude: 59.3293,
        depotLongitude: 18.0686,
        optimizedStopIds: routePreview.body.optimizedStopIds,
      },
    );
    assert.equal(routeApplied.status, 200, JSON.stringify(routeApplied.body));
    [route] = (await db.select().from(routesTable).where(eq(routesTable.id, routeId)));
    assert.equal(route.planRevision, 2);

    const approved = await request(
      server.url,
      `/import/route-plans/${route.planId}/approve`,
      "POST",
      {
        routes: [{
          routeId,
          planRevision: route.planRevision,
          driverId: selectedDriverId,
        }],
      },
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.routes[0].driverId, selectedDriverId);

    const dispatched = await request(
      server.url,
      `/routes/${routeId}/dispatch`,
      "POST",
      { driverId: selectedDriverId },
    );
    assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
    for (const status of ["in_progress", "completed"] as const) {
      await db.update(stopsTable).set({ status }).where(eq(stopsTable.id, stopId));
      const executionApproval = await request(
        server.url,
        `/import/route-plans/${route.planId}/approval`,
        "GET",
      );
      assert.equal(executionApproval.status, 200);
      assert.equal(executionApproval.body.routes[0].driverId, selectedDriverId);
      assert.equal(executionApproval.body.routes[0].approval.approved, true);
    }
    const replayAfterExecution = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(replayAfterExecution.status, 200, JSON.stringify(replayAfterExecution.body));
    assert.equal(replayAfterExecution.body.routes[0].driverId, selectedDriverId);
  } finally {
    await server.close();
    await db.delete(routePlanApprovalsTable)
      .where(eq(routePlanApprovalsTable.organizationId, organizationId));
    await db.delete(driverCertificationsTable)
      .where(eq(driverCertificationsTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("all-unplanned protected draft has canonical empty approval state, replay, and recoverable planning inputs", async () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  const cancelledRouteId = randomUUID();
  await createOrganization(organizationId, "Empty plan tenant");
  await createOrganization(otherOrganizationId, "Other empty plan tenant");
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Small van",
    licensePlate: `EMPTY-${vehicleId.slice(0, 6)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Empty plan driver",
    startLatitude: 59.3293,
    startLongitude: 18.0686,
    endLatitude: 59.3293,
    endLongitude: 18.0686,
    workStartTime: "07:00:00",
    workEndTime: "07:10:00",
    isActive: true,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    address: "Recovery stop",
    latitude: 59.3303,
    longitude: 18.0696,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
    status: "pending",
  });
  const server = await runningApp(organizationId);
  const otherServer = await runningApp(otherOrganizationId);
  try {
    const draft = await request(server.url, "/planning-drafts", "POST", {
      name: "No feasible routes",
      startAt: "2026-09-03T14:30:00.000Z",
      state: { step: 6 },
    });
    assert.equal(draft.status, 201);
    const payload = {
      draftId: draft.body.id,
      stopIds: [stopId],
      pairs: [{ vehicleId, driverId }],
      date: "2026-09-03T14:30:00.000Z",
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      customerReference: "RECOVERY-42",
      planningInputs: {
        version: 1,
        objective: "balanced",
        travelReservePercent: 0,
        stopReserveMin: 120,
        stopPriorities: {},
        excludedPairValues: [],
        depotOverride: null,
        vehicleSelectionMode: "use_all_selected_pairs",
      },
    };
    const first = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.routes.length, 0);
    assert.deepEqual(first.body.unassignedStopIds, [stopId]);
    const [savedStop] = await db.select({
      routeId: stopsTable.routeId,
      planningPlanId: stopsTable.planningPlanId,
      unplannedReason: stopsTable.unplannedReason,
    }).from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.equal(savedStop.routeId, null);
    assert.equal(savedStop.planningPlanId, first.body.planId);
    assert.ok(savedStop.unplannedReason);
    const emptySummary = await request(
      server.url,
      `/import/route-plans/${first.body.planId}/planning-summary`,
      "GET",
    );
    assert.equal(emptySummary.status, 200, JSON.stringify(emptySummary.body));
    assert.equal(emptySummary.body.draftId, draft.body.id);
    assert.deepEqual(emptySummary.body.routes, []);
    assert.equal(emptySummary.body.planningInputs.stopReserveMin, 120);
    assert.deepEqual(emptySummary.body.planningSummary.mandatoryUnplannedStopIds, []);

    const emptyApproval = await request(
      server.url,
      `/import/route-plans/${first.body.planId}/approval`,
      "GET",
    );
    assert.equal(emptyApproval.status, 200);
    assert.deepEqual(emptyApproval.body, {
      planId: first.body.planId,
      protected: true,
      routes: [],
    });
    const foreignApproval = await request(
      otherServer.url,
      `/import/route-plans/${first.body.planId}/approval`,
      "GET",
    );
    assert.equal(foreignApproval.status, 404);
    const emptyPost = await request(
      server.url,
      `/import/route-plans/${first.body.planId}/approve`,
      "POST",
      { routes: [] },
    );
    assert.equal(emptyPost.status, 400);

    const replay = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.planId, first.body.planId);
    assert.deepEqual(replay.body.routes, []);
    assert.deepEqual(replay.body.unassignedStopIds, [stopId]);

    await db.insert(routesTable).values({
      id: cancelledRouteId,
      planId: first.body.planId,
      draftId: draft.body.id,
      organizationId,
      name: "Historical cancelled route",
      date: new Date("2026-09-03T14:30:00.000Z"),
      status: "cancelled",
    });
    const cancelledApproval = await request(
      server.url,
      `/import/route-plans/${first.body.planId}/approval`,
      "GET",
    );
    assert.equal(cancelledApproval.status, 200);
    assert.deepEqual(cancelledApproval.body, emptyApproval.body);
    const replayWithHistory = await request(server.url, "/import/route-plans", "POST", payload);
    assert.equal(replayWithHistory.status, 200);
    assert.deepEqual(replayWithHistory.body.routes, []);
    const [historicalRoute] = await db.select({ status: routesTable.status })
      .from(routesTable).where(eq(routesTable.id, cancelledRouteId));
    assert.equal(historicalRoute.status, "cancelled");

    // There is no live route to use as an anchor. The protected endpoint must
    // instead recover only the exact plan-owned unassigned stop from the
    // locked, server-written draft result and preserve its route metadata.
    const recovered = await request(
      server.url,
      `/import/route-plans/${first.body.planId}/reoptimize-planning-inputs`,
      "POST",
      {
        draftId: draft.body.id,
        draftRevision: 0,
        planningInputs: {
          version: 1,
          objective: "balanced",
          travelReservePercent: 0,
          stopReserveMin: 0,
          stopPriorities: {},
          excludedPairValues: [],
          depotOverride: null,
          vehicleSelectionMode: "use_all_selected_pairs",
        },
        sharedInstructions: "Återställd plan",
      },
    );
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.draftRevision, 1);
    assert.equal(recovered.body.routes.length, 1);
    const [restoredRoute] = await db.select().from(routesTable).where(eq(
      routesTable.id,
      recovered.body.routes[0].routeId,
    ));
    assert.equal(restoredRoute.customerReference, "RECOVERY-42");
    assert.equal(restoredRoute.sharedInstructions, "Återställd plan");
    assert.equal(restoredRoute.draftId, draft.body.id);
    assert.equal(restoredRoute.status, "optimized");
    const [restoredStop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.equal(restoredStop.routeId, restoredRoute.id);
    assert.equal(restoredStop.planningPlanId, first.body.planId);
  } finally {
    await server.close();
    await otherServer.close();
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
  }
});

test("initial optimization rejects a stop changed after its planning snapshot", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const stopId = randomUUID();
  await createOrganization(organizationId, "Snapshot tenant");
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Snapshot van",
    licensePlate: `SNAP-${vehicleId.slice(0, 6)}`,
    capacityKg: 10_000,
    capacityVolume: 100,
    isActive: true,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    vehicleId,
    name: "Snapshot driver",
    startLatitude: 59.3293,
    startLongitude: 18.0686,
    isActive: true,
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    address: "Snapshot street 1",
    latitude: 59.3303,
    longitude: 18.0696,
    serviceDurationMin: 5,
    weightKg: 1,
    volumeM3: 0.1,
    status: "pending",
  });
  const server = await runningApp(organizationId);
  try {
    const draft = await request(server.url, "/planning-drafts", "POST", {
      name: "Snapshot import",
      startAt: "2026-09-02T14:30:00.000Z",
      state: {},
    });
    setImportPlanBeforePersistHookForTest(async () => {
      await db.update(stopsTable).set({ latitude: 59.5 }).where(
        eq(stopsTable.id, stopId),
      );
    });
    const response = await request(server.url, "/import/route-plans", "POST", {
      draftId: draft.body.id,
      stopIds: [stopId],
      pairs: [{ vehicleId, driverId }],
      date: "2026-09-02T14:30:00.000Z",
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "Planeringsunderlaget ändrades under optimeringen. Ladda om och försök igen.");
    const savedStops = await db.select({
      routeId: stopsTable.routeId,
      planningPlanId: stopsTable.planningPlanId,
    }).from(stopsTable).where(eq(stopsTable.id, stopId));
    assert.equal(savedStops[0]?.routeId, null);
    assert.equal(savedStops[0]?.planningPlanId, null);
    const savedRoutes = await db.select({ id: routesTable.id }).from(routesTable).where(
      eq(routesTable.organizationId, organizationId),
    );
    assert.equal(savedRoutes.length, 0);
  } finally {
    setImportPlanBeforePersistHookForTest(undefined);
    await server.close();
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(
      eq(planningDraftsTable.organizationId, organizationId),
    );
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
