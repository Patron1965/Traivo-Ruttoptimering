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
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  driverCertificationsTable,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routePlanApprovalsTable,
  routeExecutionsTable,
  routesTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import {
  materialResourceSnapshot,
  materialResourceSnapshotHash,
} from "../services/route-plan-approval-service";
import importRouteWorkflowRouter from "./import-route-workflow";
import routesRouter from "./routes";
import { normalizePlanningInputs } from "../services/import-route-workflow";
import { discardSyntheticDispatch } from "../testing/capture-synthetic-dispatch";

function appFor(user: AuthUser): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(importRouteWorkflowRouter);
  app.use(routesRouter);
  app.use((
    error: Error & { statusCode?: number; code?: string },
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    res.status(error.statusCode ?? 500).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  });
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("protected route approval exposes exact recipient and gates dispatch", async () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const actorUserId = randomUUID();
  const draftId = randomUUID();
  const planId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  const vehicleId = randomUUID();
  const driverId = randomUUID();
  const date = new Date("2026-10-12T08:00:00.000Z");
  const user: AuthUser = {
    id: actorUserId,
    name: "Approval test",
    email: `${actorUserId}@approval.test`,
    role: "dispatcher",
    organizationId,
    driverProfileId: null,
  };
  const app = appFor(user);

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Approval test organization",
    email: `${organizationId}@approval.test`,
  });
  await db.insert(organizationsTable).values({
    id: otherOrganizationId,
    name: "Other approval organization",
    email: `${otherOrganizationId}@approval.test`,
  });
  try {
    await db.insert(usersTable).values({
      id: actorUserId,
      organizationId,
      name: user.name,
      email: user.email,
      role: user.role,
    });
    await db.insert(planningDraftsTable).values({
      id: draftId,
      organizationId,
      name: "Approval draft",
      startAt: date,
      state: { step: "approval" },
    });
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Approval vehicle",
      licensePlate: `AP-${vehicleId.slice(0, 8)}`,
      capacityKg: 10_000,
      capacityVolume: 100,
      isActive: true,
    });
    await db.insert(driversTable).values({
      id: driverId,
      organizationId,
      vehicleId,
      name: "Approval driver",
      startLatitude: 59.3293,
      startLongitude: 18.0686,
      isActive: true,
    });
    await db.insert(routesTable).values({
      id: routeId,
      planId,
      draftId,
      organizationId,
      vehicleId,
      name: "Approval route",
      status: "optimized",
      planRevision: 3,
      date,
      totalStops: 1,
      depotSnapshot: {
        start: { address: "Synthetic verified start", latitude: 59.3293, longitude: 18.0686,
          verifiedAt: date.toISOString(), verification: { source: "synthetic_test" } },
        end: { address: "Synthetic verified end", latitude: 59.3293, longitude: 18.0686,
          verifiedAt: date.toISOString(), verification: { source: "synthetic_test" } },
      },
      optimizationPlanningSnapshot: normalizePlanningInputs(null),
    });
    await db.insert(stopsTable).values({
      id: stopId,
      organizationId,
      routeId,
      sequenceOrder: 1,
      address: "Approval stop",
      latitude: 59.3293,
      longitude: 18.0686,
    });
    const [approvalVehicle] = await db.select().from(vehiclesTable)
      .where(eq(vehiclesTable.id, vehicleId));
    const [approvalDriver] = await db.select().from(driversTable)
      .where(eq(driversTable.id, driverId));
    const approvalStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.routeId, routeId));
    assert.ok(approvalVehicle);
    assert.ok(approvalDriver);
    const optimizationSnapshot = materialResourceSnapshot(
      approvalVehicle,
      approvalDriver,
      approvalStops,
      [],
    );
    await db.update(routesTable).set({
      optimizationResourceSnapshot: optimizationSnapshot,
      optimizationResourceSnapshotHash: materialResourceSnapshotHash(
        approvalVehicle,
        approvalDriver,
        approvalStops,
        [],
      ),
    }).where(eq(routesTable.id, routeId));

    const initial = await request(
      app,
      "GET",
      `/import/route-plans/${planId}/approval`,
    );
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.planId, planId);
    assert.equal(initial.body.protected, true);
    assert.deepEqual(initial.body.routes[0].approval, {
      approved: false,
      approvedAt: null,
      approvedByUserId: null,
    });
    assert.equal(initial.body.routes[0].driverId, driverId);

    const forbidden = await request(
      appFor({ ...user, role: "viewer" }),
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision: 3, driverId }] },
    );
    assert.equal(forbidden.status, 403);
    const hidden = await request(
      appFor({ ...user, organizationId: otherOrganizationId }),
      "GET",
      `/import/route-plans/${planId}/approval`,
    );
    assert.equal(hidden.status, 404);

    const blocked = await request(
      app,
      "POST",
      `/routes/${routeId}/dispatch`,
      { driverId },
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "APPROVAL_REQUIRED");
    const [beforeApproval] = await db
      .select({ status: routesTable.status, handoffStatus: routesTable.handoffStatus })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(beforeApproval.status, "optimized");
    assert.equal(beforeApproval.handoffStatus, "pending");

    const staleRevision = await request(
      app,
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision: 2, driverId }] },
    );
    assert.equal(staleRevision.status, 409);
    assert.equal(staleRevision.body.code, "STALE_PLAN_REVISION");

    let planRevision = 3;
    const reoptimize = async () => {
      const response = await request(
        app,
        "POST",
        `/import/route-plans/${planId}/reoptimize-service-time`,
        {
          serviceDurationMin: 30,
          serviceTimeStrategy: "preserve_individual",
          routes: [{ routeId, driverId, planRevision }],
          depotLatitude: 59.3293,
          depotLongitude: 18.0686,
        },
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const updated = response.body.routes.find((candidate: any) =>
        candidate.routeId === routeId);
      assert.ok(updated);
      planRevision = updated.planRevision;
    };

    await db.update(vehiclesTable).set({ capacityKg: 1 }).where(eq(vehiclesTable.id, vehicleId));
    const capacityChangedApproval = await request(
      app,
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision, driverId }] },
    );
    assert.equal(capacityChangedApproval.status, 409);
    assert.equal(capacityChangedApproval.body.code, "STALE_RESOURCE_SNAPSHOT");
    await reoptimize();

    await db.update(driversTable).set({ workStartTime: "09:00:00" })
      .where(eq(driversTable.id, driverId));
    const workHoursChangedApproval = await request(
      app,
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision, driverId }] },
    );
    assert.equal(workHoursChangedApproval.status, 409);
    assert.equal(workHoursChangedApproval.body.code, "STALE_RESOURCE_SNAPSHOT");
    await reoptimize();

    const certificationId = randomUUID();
    await db.insert(driverCertificationsTable).values({
      id: certificationId,
      driverId,
      organizationId,
      certificationCode: "HV",
      certificationName: "High voltage",
      issuedAt: date,
    });
    const certificationChangedApproval = await request(
      app,
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision, driverId }] },
    );
    assert.equal(certificationChangedApproval.status, 409);
    assert.equal(certificationChangedApproval.body.code, "STALE_RESOURCE_SNAPSHOT");
    await reoptimize();

    const approved = await request(
      app,
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision, driverId }] },
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.body.routes[0].approval.approved, true);
    assert.equal(approved.body.routes[0].approval.approvedByUserId, actorUserId);
    assert.equal(approved.body.routes[0].driverId, driverId);

    const concurrentApprovals = await Promise.all([
      request(
        app,
        "POST",
        `/import/route-plans/${planId}/approve`,
        { routes: [{ routeId, planRevision, driverId }] },
      ),
      request(
        app,
        "POST",
        `/import/route-plans/${planId}/approve`,
        { routes: [{ routeId, planRevision, driverId }] },
      ),
    ]);
    assert.deepEqual(
      concurrentApprovals.map((response) => response.status).sort(),
      [200, 200],
    );

    await db.update(stopsTable).set({
      jobType: "field_service",
      requiredSkills: ["electrical"],
    }).where(eq(stopsTable.id, stopId));
    const staleResourceState = await request(
      app,
      "GET",
      `/import/route-plans/${planId}/approval`,
    );
    assert.equal(staleResourceState.status, 200);
    assert.equal(staleResourceState.body.routes[0].approval.approved, false);
    const staleResourceDispatch = await request(
      app,
      "POST",
      `/routes/${routeId}/dispatch`,
      { driverId },
    );
    assert.equal(staleResourceDispatch.status, 409);
    assert.equal(staleResourceDispatch.body.code, "STALE_RESOURCE_SNAPSHOT");
    await db.update(stopsTable).set({
      jobType: "delivery",
      requiredSkills: null,
    }).where(eq(stopsTable.id, stopId));
    const reapproved = await request(
      app,
      "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision, driverId }] },
    );
    assert.equal(reapproved.status, 200);

    const dispatched = await request(
      app,
      "POST",
      `/routes/${routeId}/dispatch`,
      { driverId },
    );
    assert.equal(dispatched.status, 200);
    const [afterDispatch] = await db
      .select({
        status: routesTable.status,
        handoffStatus: routesTable.handoffStatus,
        handoffVersion: routesTable.handoffVersion,
        handoffDriverId: routesTable.handoffDriverId,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(afterDispatch.status, "in_progress");
    assert.equal(afterDispatch.handoffStatus, "sent");
    assert.equal(afterDispatch.handoffVersion, planRevision);
    assert.equal(afterDispatch.handoffDriverId, driverId);
    const stalePublishedApproval = await request(app, "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision: planRevision - 1, driverId }] });
    assert.equal(stalePublishedApproval.status, 409);
    const reviewedPublished = await request(app, "POST",
      `/import/route-plans/${planId}/approve`,
      { routes: [{ routeId, planRevision, driverId }] });
    assert.equal(reviewedPublished.status, 200);
    const [stillSent] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.equal(stillSent.handoffStatus, "sent", "approval alone cannot change driver acknowledgement");
    assert.equal(stillSent.handoffVersion, planRevision);
  } finally {
    await db.delete(routePlanApprovalsTable).where(eq(routePlanApprovalsTable.organizationId, organizationId));
    await discardSyntheticDispatch(organizationId, [routeId]);
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
    await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
  }
});

test("same-revision dispatch cannot replace the driver after execution starts", async () => {
  const organizationId = randomUUID();
  const actorUserId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();
  const vehicleId = randomUUID();
  const currentDriverId = randomUUID();
  const replacementDriverId = randomUUID();
  const startedAt = new Date("2026-10-13T08:00:00.000Z");
  const user: AuthUser = {
    id: actorUserId,
    name: "Execution dispatch guard",
    email: `${actorUserId}@execution-dispatch.test`,
    role: "dispatcher",
    organizationId,
    driverProfileId: null,
  };
  const app = appFor(user);

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Execution dispatch guard organization",
    email: `${organizationId}@execution-dispatch.test`,
  });
  try {
    await db.insert(usersTable).values({
      id: actorUserId,
      organizationId,
      name: user.name,
      email: user.email,
      role: user.role,
    });
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Execution guard vehicle",
      licensePlate: `EG-${vehicleId.slice(0, 8)}`,
      isActive: true,
    });
    await db.insert(driversTable).values([
      {
        id: currentDriverId,
        organizationId,
        vehicleId,
        name: "Current execution driver",
        isActive: true,
      },
      {
        id: replacementDriverId,
        organizationId,
        vehicleId,
        name: "Replacement execution driver",
        isActive: true,
      },
    ]);
    await db.insert(routesTable).values({
      id: routeId,
      organizationId,
      vehicleId,
      name: "Execution dispatch guard route",
      status: "in_progress",
      planRevision: 8,
      handoffStatus: "accepted",
      handoffVersion: 8,
      handoffDriverId: currentDriverId,
      date: startedAt,
      totalStops: 1,
    });
    await db.insert(stopsTable).values({
      id: stopId,
      organizationId,
      routeId,
      address: "Execution dispatch guard stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      sequenceOrder: 0,
    });
    await db.insert(routeExecutionsTable).values({
      organizationId,
      routeId,
      driverId: currentDriverId,
      planVersion: 8,
      status: "active",
      startedAt,
      startClientEventId: `execution-dispatch-start-${routeId}`,
      startedByUserId: actorUserId,
    });

    const replacement = await request(
      app,
      "POST",
      `/routes/${routeId}/dispatch`,
      { driverId: replacementDriverId },
    );
    assert.equal(replacement.status, 409);
    assert.equal(String(replacement.body.error).includes(currentDriverId), false);
    assert.equal(String(replacement.body.error).includes(replacementDriverId), false);

    const [route] = await db
      .select({
        status: routesTable.status,
        handoffStatus: routesTable.handoffStatus,
        handoffDriverId: routesTable.handoffDriverId,
        handoffVersion: routesTable.handoffVersion,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.deepEqual(route, {
      status: "in_progress",
      handoffStatus: "accepted",
      handoffDriverId: currentDriverId,
      handoffVersion: 8,
    });
    const [execution] = await db
      .select({ driverId: routeExecutionsTable.driverId, status: routeExecutionsTable.status })
      .from(routeExecutionsTable)
      .where(eq(routeExecutionsTable.routeId, routeId));
    assert.deepEqual(execution, { driverId: currentDriverId, status: "active" });
  } finally {
    await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, routeId));
    await db.delete(stopsTable).where(eq(stopsTable.routeId, routeId));
    await db.delete(routesTable).where(eq(routesTable.id, routeId));
    await db.delete(usersTable).where(eq(usersTable.id, actorUserId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});