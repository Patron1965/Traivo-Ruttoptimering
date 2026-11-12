import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express, { type Express } from "express";
import {
  auditLogTable,
  db,
  deliveryProofsTable,
  driversTable,
  organizationsTable,
  planningDraftsTable,
  routeExecutionsTable,
  routesTable,
  stopsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AuthUser } from "../middleware/auth";
import * as routeService from "../services/route-service";
import * as stopService from "../services/stop-service";
import stopsRouter from "./stops";

const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const routeId = randomUUID();
const selectedId = randomUUID();
const releasedId = randomUUID();
const terminalId = randomUUID();
const foreignStopId = randomUUID();
const executionRouteId = randomUUID();
const executionStopId = randomUUID();
const executionDriverId = randomUUID();
const executionUserId = randomUUID();
const completedRouteId = randomUUID();
const completedStopId = randomUUID();
const draftId = randomUUID();
const draftStopId = randomUUID();
const raceRouteId = randomUUID();
const raceStopId = randomUUID();
const editRaceStopId = randomUUID();
const survivingRouteId = randomUUID();
const archivedSurvivorId = randomUUID();
const liveSurvivorId = randomUUID();
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

const user: AuthUser = {
  id: randomUUID(),
  name: "Stop archive dispatcher",
  email: "stop-archive@example.test",
  role: "dispatcher",
  organizationId,
  driverProfileId: null,
};

async function request(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: organizationId, name: "Stop archive test", email: `${organizationId}@example.test` },
    { id: foreignOrganizationId, name: "Foreign stop archive test", email: `${foreignOrganizationId}@example.test` },
  ]);
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    name: "Sent archive route",
    date: new Date("2028-01-01T08:00:00.000Z"),
    status: "in_progress",
    handoffStatus: "sent",
    totalStops: 2,
  });
  await db.insert(routesTable).values({
    id: executionRouteId,
    organizationId,
    name: "Execution-only archive route",
    date: new Date("2028-01-02T08:00:00.000Z"),
    status: "optimized",
    handoffStatus: "pending",
    totalStops: 1,
  });
  await db.insert(routesTable).values({
    id: raceRouteId,
    organizationId,
    name: "Dispatch archive race route",
    date: new Date("2028-01-04T08:00:00.000Z"),
    status: "optimized",
    handoffStatus: "pending",
    totalStops: 0,
  });
  await db.insert(routesTable).values({
    id: survivingRouteId,
    organizationId,
    name: "Route with surviving operational stop",
    date: new Date("2028-01-05T08:00:00.000Z"),
    status: "optimized",
    handoffStatus: "pending",
    totalStops: 2,
  });
  await db.insert(routesTable).values({
    id: completedRouteId,
    organizationId,
    name: "Completed historical route",
    date: new Date("2027-12-31T08:00:00.000Z"),
    status: "completed",
    handoffStatus: "accepted",
    handoffVersion: 1,
    totalStops: 1,
  });
  await db.insert(driversTable).values({
    id: executionDriverId,
    organizationId,
    name: "Execution archive driver",
  });
  await db.insert(usersTable).values({
    id: executionUserId,
    organizationId,
    name: "Execution archive user",
    email: `${executionUserId}@example.test`,
    role: "driver",
    driverProfileId: executionDriverId,
  });
  await db.insert(stopsTable).values([
    {
      id: selectedId, organizationId, routeId, sequenceOrder: 1,
      address: "Selected live stop", latitude: 59.33, longitude: 18.07, status: "in_progress",
    },
    {
      id: releasedId, organizationId, routeId, sequenceOrder: 2,
      address: "Other unfinished stop", latitude: 59.34, longitude: 18.08, status: "pending",
    },
    {
      id: terminalId, organizationId,
      address: "Terminal archived stop", latitude: 59.35, longitude: 18.09, status: "completed",
      terminalAt: new Date("2027-12-31T08:00:00.000Z"),
    },
    {
      id: foreignStopId, organizationId: foreignOrganizationId,
      address: "Foreign stop", latitude: 60, longitude: 18,
    },
    {
      id: executionStopId, organizationId, routeId: executionRouteId, sequenceOrder: 1,
      address: "Execution-only active stop", latitude: 59.36, longitude: 18.1, status: "pending",
    },
    {
      id: completedStopId, organizationId, routeId: completedRouteId, sequenceOrder: 1,
      address: "Completed historical stop", latitude: 59.37, longitude: 18.11, status: "completed",
      terminalAt: new Date("2027-12-31T09:00:00.000Z"),
    },
    {
      id: draftStopId, organizationId,
      address: "Unassigned imported draft stop", latitude: 59.38, longitude: 18.12, status: "pending",
    },
    {
      id: raceStopId, organizationId,
      address: "Archive versus assignment race stop", latitude: 59.39, longitude: 18.13, status: "pending",
    },
    {
      id: editRaceStopId, organizationId,
      address: "Archive versus generic edit race stop", latitude: 59.4, longitude: 18.14, status: "pending",
    },
    {
      id: archivedSurvivorId, organizationId, routeId: survivingRouteId, sequenceOrder: 1,
      address: "Archived sibling stop", latitude: 59.41, longitude: 18.15, status: "pending",
    },
    {
      id: liveSurvivorId, organizationId, routeId: survivingRouteId, sequenceOrder: 2,
      address: "Surviving operational stop", latitude: 59.42, longitude: 18.16, status: "pending",
    },
  ]);
  await db.insert(planningDraftsTable).values({
    id: draftId,
    organizationId,
    name: "Archive invalidation draft",
    startAt: new Date("2028-01-03T08:00:00.000Z"),
    state: {
      selectedStopIds: [draftStopId],
      importedStopIds: [draftStopId],
      savedStops: [{ id: draftStopId, address: "embedded state row" }],
      assignedRoutes: [{ stopIds: [draftStopId], stops: [{ id: draftStopId }] }],
    },
    importedPayloadHash: "draft-import-payload",
    importedResult: {
      receivedRowCount: 1,
      savedRowCount: 1,
      imported: 1,
      stopIds: [draftStopId],
      // This intentionally mirrors the former replay fallback. It must never
      // make an archived row visible or assignable again.
      stops: [{ id: draftStopId, address: "embedded stale stop" }],
      rowResults: [{ sourceRowNumber: 1, status: "saved", stopId: draftStopId }],
    },
    planId: null,
    planResult: { unassignedStopIds: [draftStopId] },
  });
  await db.insert(routeExecutionsTable).values({
    organizationId,
    routeId: executionRouteId,
    driverId: executionDriverId,
    planVersion: 1,
    startedAt: new Date("2028-01-02T08:00:00.000Z"),
    startClientEventId: `archive-execution-${executionRouteId}`,
    startedByUserId: executionUserId,
  });
  await db.insert(routeExecutionsTable).values({
    organizationId,
    routeId: completedRouteId,
    driverId: executionDriverId,
    planVersion: 0,
    startedAt: new Date("2027-12-31T08:00:00.000Z"),
    startClientEventId: `archive-completed-execution-${completedRouteId}`,
    startedByUserId: executionUserId,
  });
  await db.insert(deliveryProofsTable).values({
    stopId: selectedId,
    proofType: "barcode",
    data: "retained-proof",
  });

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use("/api", stopsRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
  closeServer = () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
});

after(async () => {
  await closeServer?.();
  await db.delete(routeExecutionsTable).where(inArray(routeExecutionsTable.routeId, [executionRouteId, completedRouteId]));
  await db.delete(auditLogTable).where(and(
    eq(auditLogTable.organizationId, organizationId),
    eq(auditLogTable.action, "stops.bulk_archive"),
  ));
  await db.delete(planningDraftsTable).where(eq(planningDraftsTable.id, draftId));
  await db.delete(deliveryProofsTable).where(eq(deliveryProofsTable.stopId, selectedId));
  await db.delete(stopsTable).where(inArray(stopsTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(routesTable).where(inArray(routesTable.id, [routeId, executionRouteId, completedRouteId, raceRouteId, survivingRouteId]));
  await db.delete(usersTable).where(eq(usersTable.id, executionUserId));
  await db.delete(driversTable).where(eq(driversTable.id, executionDriverId));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [organizationId, foreignOrganizationId]));
});

test("archive wins an assignment race and the stale dispatch write returns a conflict", async () => {
  let entered!: () => void;
  let release!: () => void;
  const enteredLock = new Promise<void>((resolve) => { entered = resolve; });
  const releaseLock = new Promise<void>((resolve) => { release = resolve; });
  stopService.setDispatchMutationBeforeLockHookForTest(async () => {
    entered();
    await releaseLock;
  });
  try {
    const assignment = stopService.assignStopForDispatch(
      raceStopId,
      organizationId,
      { routeId: raceRouteId, sequenceOrder: 1 },
    );
    await enteredLock;
    const archive = await stopService.archiveStops(
      [raceStopId],
      organizationId,
      { userId: user.id, userEmail: user.email },
    );
    assert.equal(archive.archivedCount, 1);
    release();
    await assert.rejects(assignment, { name: "DispatchRevisionConflictError" });
  } finally {
    stopService.setDispatchMutationBeforeLockHookForTest(undefined);
  }
});

test("archive wins a generic edit race and the stale write returns 409", async () => {
  let entered!: () => void;
  let release!: () => void;
  const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
  const releaseWrite = new Promise<void>((resolve) => { release = resolve; });
  stopService.setStopUpdateBeforeWriteHookForTest(async () => {
    entered();
    await releaseWrite;
  });
  try {
    const edit = stopService.updateStop(editRaceStopId, organizationId, { address: "stale edit" });
    await enteredWrite;
    const archive = await stopService.archiveStops(
      [editRaceStopId],
      organizationId,
      { userId: user.id, userEmail: user.email },
    );
    assert.equal(archive.archivedCount, 1);
    release();
    await assert.rejects(edit, { name: "StopArchivedError", statusCode: 409 });
    const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, editRaceStopId));
    assert.equal(stop?.address, "Archive versus generic edit race stop");
  } finally {
    stopService.setStopUpdateBeforeWriteHookForTest(undefined);
  }
});

test("unassigned draft JSON references are invalidated and stale replay rejects archived stops", async () => {
  const archived = await request("/stops/bulk-archive", { stopIds: [draftStopId] });
  assert.equal(archived.status, 200);
  const [invalidatedDraft] = await db.select().from(planningDraftsTable).where(eq(planningDraftsTable.id, draftId));
  assert.equal(invalidatedDraft?.importedPayloadHash, null);
  assert.equal(invalidatedDraft?.importedResult, null);
  assert.equal(invalidatedDraft?.planResult, null);
  assert.equal(JSON.stringify(invalidatedDraft?.state).includes(draftStopId), false);

  // Defense in depth for data written by an older deployment: replay must
  // reject an archived durable source rather than returning `stored.stops`.
  await db.update(planningDraftsTable).set({
    importedPayloadHash: "stale-payload",
    importedResult: {
      receivedRowCount: 1,
      savedRowCount: 1,
      imported: 1,
      stopIds: [draftStopId],
      stops: [{ id: draftStopId, address: "embedded stale stop" }],
      rowResults: [{ sourceRowNumber: 1, status: "saved", stopId: draftStopId }],
    },
  }).where(eq(planningDraftsTable.id, draftId));
  await assert.rejects(
    () => stopService.getDraftImportReplay(organizationId, draftId, "stale-payload"),
    (error: unknown) =>
      error instanceof Error
      && error.name === "PlanningDraftError"
      && "code" in error
      && error.code === "DRAFT_ARCHIVED_STOPS",
  );
});

test("completed route execution shutdown requires confirmation but preserves route history", async () => {
  const blocked = await request("/stops/bulk-archive", { stopIds: [completedStopId] });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.details.affectedRouteIds, [completedRouteId]);
  const [stillActive] = await db.select().from(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, completedRouteId));
  assert.equal(stillActive?.status, "active");

  const archived = await request("/stops/bulk-archive", {
    stopIds: [completedStopId],
    confirmActiveRoutes: true,
  });
  assert.equal(archived.status, 200);
  const [stop, route, execution] = await Promise.all([
    db.select().from(stopsTable).where(eq(stopsTable.id, completedStopId)).then(([row]) => row),
    db.select().from(routesTable).where(eq(routesTable.id, completedRouteId)).then(([row]) => row),
    db.select().from(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, completedRouteId)).then(([row]) => row),
  ]);
  assert.ok(stop?.archivedAt);
  assert.equal(stop?.routeId, completedRouteId);
  assert.equal(route?.status, "completed");
  assert.equal(route?.handoffStatus, "accepted");
  assert.equal(execution?.status, "ended");
  const historicalStops = await routeService.getRouteStops(completedRouteId, organizationId);
  assert.equal(historicalStops?.some((row) => row.id === completedStopId), true);
});

test("an active execution requires confirmation even on an optimized route and is ended atomically", async () => {
  const blocked = await request("/stops/bulk-archive", { stopIds: [executionStopId] });
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.details.affectedRouteIds, [executionRouteId]);
  const [stillActive] = await db.select().from(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, executionRouteId));
  assert.equal(stillActive?.status, "active");

  const archived = await request("/stops/bulk-archive", {
    stopIds: [executionStopId],
    confirmActiveRoutes: true,
  });
  assert.equal(archived.status, 200);
  const [ended, route] = await Promise.all([
    db.select().from(routeExecutionsTable).where(eq(routeExecutionsTable.routeId, executionRouteId)).then(([row]) => row),
    db.select().from(routesTable).where(eq(routesTable.id, executionRouteId)).then(([row]) => row),
  ]);
  assert.equal(ended?.status, "ended");
  assert.ok(ended?.endedAt);
  assert.equal(route?.status, "cancelled");
});

test("archiving one pending stop does not strand the surviving operational route stop", async () => {
  const archived = await request("/stops/bulk-archive", { stopIds: [archivedSurvivorId] });
  assert.equal(archived.status, 200);
  const [route] = await db.select().from(routesTable).where(eq(routesTable.id, survivingRouteId));
  assert.ok(route);
  const moved = await stopService.moveStopsForDispatch(organizationId, {
    stopIds: [liveSurvivorId],
    routeId: null,
    targetIndex: 0,
    routeRevisions: [{ routeId: survivingRouteId, planRevision: route.planRevision }],
  });
  assert.equal(moved.kind, "moved");
  const [live] = await db.select().from(stopsTable).where(eq(stopsTable.id, liveSurvivorId));
  assert.equal(live?.routeId, null);
});

test("bulk archive is tenant-scoped, atomic, confirmation-gated, idempotent, and retains POD/history", async () => {
  const missing = await request("/stops/bulk-archive", {
    stopIds: [selectedId, randomUUID()],
    confirmActiveRoutes: true,
  });
  assert.equal(missing.status, 404);
  const [notMutated] = await db.select().from(stopsTable).where(eq(stopsTable.id, selectedId));
  assert.equal(notMutated?.archivedAt, null);

  const foreign = await request("/stops/bulk-archive", {
    stopIds: [selectedId, foreignStopId],
    confirmActiveRoutes: true,
  });
  assert.equal(foreign.status, 404);

  const needsConfirmation = await request("/stops/bulk-archive", {
    stopIds: [selectedId, terminalId],
  });
  assert.equal(needsConfirmation.status, 409);
  assert.equal(needsConfirmation.body.code, "STOP_ARCHIVE_CONFIRMATION_REQUIRED");
  assert.deepEqual(needsConfirmation.body.details.affectedRouteIds, [routeId]);
  const beforeConfirmation = await db.select({ archivedAt: stopsTable.archivedAt }).from(stopsTable).where(
    inArray(stopsTable.id, [selectedId, terminalId]),
  );
  assert.ok(beforeConfirmation.every((stop) => stop.archivedAt === null));

  const archived = await request("/stops/bulk-archive", {
    stopIds: [selectedId, terminalId],
    confirmActiveRoutes: true,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.archivedCount, 2);
  assert.deepEqual(new Set(archived.body.archivedStopIds), new Set([selectedId, terminalId]));
  assert.deepEqual(archived.body.affectedRouteIds, [routeId]);

  const [selected, terminal, released, route] = await Promise.all([
    db.select().from(stopsTable).where(eq(stopsTable.id, selectedId)).then(([row]) => row),
    db.select().from(stopsTable).where(eq(stopsTable.id, terminalId)).then(([row]) => row),
    db.select().from(stopsTable).where(eq(stopsTable.id, releasedId)).then(([row]) => row),
    db.select().from(routesTable).where(eq(routesTable.id, routeId)).then(([row]) => row),
  ]);
  assert.ok(selected?.archivedAt);
  assert.equal(selected?.routeId, routeId);
  assert.equal(selected?.status, "in_progress");
  assert.ok(terminal?.archivedAt);
  assert.equal(terminal?.terminalAt?.toISOString(), "2027-12-31T08:00:00.000Z");
  assert.equal(released?.routeId, null);
  assert.equal(released?.status, "pending");
  assert.equal(route?.status, "cancelled");
  const proofs = await db.select().from(deliveryProofsTable).where(eq(deliveryProofsTable.stopId, selectedId));
  assert.equal(proofs.length, 1);
  const [audit] = await db
    .select()
    .from(auditLogTable)
    .where(and(
      eq(auditLogTable.organizationId, organizationId),
      eq(auditLogTable.action, "stops.bulk_archive"),
    ))
    .orderBy(desc(auditLogTable.createdAt))
    .limit(1);
  assert.equal(audit?.userId, user.id);
  assert.deepEqual(
    (audit?.diff as { archivedStopIds?: string[] }).archivedStopIds?.sort(),
    [selectedId, terminalId].sort(),
  );

  await assert.rejects(
    () => stopService.updateStop(selectedId, organizationId, { address: "must not write" }),
    { name: "StopArchivedError", statusCode: 409 },
  );
  const assignment = await stopService.assignStopForDispatch(
    selectedId,
    organizationId,
    { routeId, sequenceOrder: 1 },
  );
  assert.equal(assignment.kind, "ineligible");

  const activeHistory = await fetch(`${baseUrl}/stops/organization?organizationId=${organizationId}&pageSize=100`);
  const activePage = await activeHistory.json() as { items: Array<{ id: string }> };
  assert.equal(activePage.items.some((stop) => stop.id === selectedId || stop.id === terminalId), false);
  const archivedHistory = await fetch(`${baseUrl}/stops/organization?organizationId=${organizationId}&archiveState=archived&pageSize=100`);
  const archivedPage = await archivedHistory.json() as { items: Array<{ id: string }> };
  // Other cases in this file archive their own fixture stops. Assert this
  // case's scoped records rather than assuming the shared history page is
  // otherwise empty, while still proving active and archived filtering.
  const thisCaseArchived = new Set(
    archivedPage.items
      .map((stop) => stop.id)
      .filter((id) => id === selectedId || id === terminalId),
  );
  assert.deepEqual(thisCaseArchived, new Set([selectedId, terminalId]));

  const retry = await request("/stops/bulk-archive", {
    stopIds: [selectedId, terminalId],
    confirmActiveRoutes: false,
  });
  assert.deepEqual(retry, {
    status: 200,
    body: { archivedCount: 0, archivedStopIds: [], affectedRouteIds: [] },
  });
  const archivedRows = await db.select({ id: stopsTable.id }).from(stopsTable).where(and(
    inArray(stopsTable.id, [selectedId, terminalId]),
    isNull(stopsTable.archivedAt),
  ));
  assert.equal(archivedRows.length, 0);
});