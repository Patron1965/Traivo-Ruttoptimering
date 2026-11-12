import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { Express } from "express";
import {
  auditLogTable,
  db,
  deliveryProofsTable,
  driversTable,
  executionEventsTable,
  organizationsTable,
  pool,
  routesTable,
  serviceReportsTable,
  sessionsTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createSession } from "../lib/session";

const runId = randomUUID();
const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const adminUserId = randomUUID();
const dispatcherUserId = randomUUID();
const viewerUserId = randomUUID();
const foreignAdminUserId = randomUUID();
const vehicleId = randomUUID();
const routeId = randomUUID();
const driverId = randomUUID();
const ids = {
  beforeDst: randomUUID(),
  dstStart: randomUUID(),
  dstEnd: randomUUID(),
  afterDst: randomUUID(),
  noPlannedDate: randomUUID(),
  proofProtected: randomUUID(),
  activeProtected: randomUUID(),
  executionProtected: randomUUID(),
  serviceReportProtected: randomUUID(),
  completedTerminal: randomUUID(),
  failedTerminal: randomUUID(),
  skippedTerminal: randomUUID(),
  singleDelete: randomUUID(),
  assigned: randomUUID(),
  assignedBulk: randomUUID(),
  foreign: randomUUID(),
};
let adminToken = "";
let dispatcherToken = "";
let viewerToken = "";
let server: Server;
let baseUrl = "";

async function request(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Connection", "close");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

function stop(id: string, values: Partial<typeof stopsTable.$inferInsert> = {}) {
  return {
    id,
    organizationId,
    address: `Archive ${id}`,
    latitude: 59.33,
    longitude: 18.07,
    ...values,
  };
}

before(async () => {
  await db.insert(organizationsTable).values([
    { id: organizationId, name: `Archive ${runId}`, email: `${runId}@example.test` },
    { id: foreignOrganizationId, name: `Foreign ${runId}`, email: `${runId}-foreign@example.test` },
  ]);
  await db.insert(usersTable).values([
    { id: adminUserId, organizationId, name: "Archive admin", email: `${runId}-admin@example.test`, role: "admin" },
    { id: dispatcherUserId, organizationId, name: "Archive dispatcher", email: `${runId}-dispatcher@example.test`, role: "dispatcher" },
    { id: viewerUserId, organizationId, name: "Archive viewer", email: `${runId}-viewer@example.test`, role: "viewer" },
    { id: foreignAdminUserId, organizationId: foreignOrganizationId, name: "Foreign admin", email: `${runId}-foreign-admin@example.test`, role: "admin" },
  ]);
  adminToken = (await createSession({ userId: adminUserId, organizationId, userAgent: "organization-stops-test" })).token;
  dispatcherToken = (await createSession({ userId: dispatcherUserId, organizationId, userAgent: "organization-stops-test" })).token;
  viewerToken = (await createSession({ userId: viewerUserId, organizationId, userAgent: "organization-stops-test" })).token;

  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: `Archive vehicle ${runId}`,
    licensePlate: `AR-${runId.slice(0, 6)}`,
  });
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: `Archive route ${runId}`,
    date: new Date("2025-03-30T00:00:00.000Z"),
    status: "draft",
    planRevision: 0,
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    name: `Archive technician ${runId}`,
    email: `${runId}-technician@example.test`,
    vehicleId,
  });
  await db.insert(stopsTable).values([
    stop(ids.beforeDst, { address: `Before DST ${runId}`, timeWindowStart: new Date("2025-03-29T22:59:59.999Z") }),
    stop(ids.dstStart, {
      address: `Customer Stockholm ${runId}`,
      contactName: `Customer ${runId}`,
      externalRef: `ORDER-DST-${runId}`,
      notes: `private note ${runId}`,
      timeWindowStart: new Date("2025-03-29T23:00:00.000Z"),
    }),
    stop(ids.dstEnd, { address: `Late DST ${runId}`, timeWindowStart: new Date("2025-03-30T21:59:59.999Z") }),
    stop(ids.afterDst, { address: `After DST ${runId}`, timeWindowStart: new Date("2025-03-30T22:00:00.000Z") }),
    stop(ids.noPlannedDate, { address: `No planned date ${runId}` }),
    stop(ids.proofProtected, { address: `Proof protected ${runId}` }),
    stop(ids.activeProtected, { address: `Active protected ${runId}`, status: "in_progress" }),
    stop(ids.executionProtected, { address: `Execution protected ${runId}` }),
    stop(ids.serviceReportProtected, { address: `Service report protected ${runId}`, jobType: "field_service" }),
    stop(ids.completedTerminal, { address: `Completed terminal ${runId}`, status: "completed" }),
    stop(ids.failedTerminal, { address: `Failed terminal ${runId}`, status: "failed" }),
    stop(ids.skippedTerminal, { address: `Skipped terminal ${runId}`, status: "skipped" }),
    stop(ids.singleDelete, { address: `Delete me ${runId}` }),
    stop(ids.assigned, { address: `Assigned ${runId}`, routeId, sequenceOrder: 1 }),
    stop(ids.assignedBulk, { address: `Assigned bulk ${runId}`, routeId, sequenceOrder: 2 }),
  ]);
  await db.insert(deliveryProofsTable).values({
    stopId: ids.proofProtected,
    proofType: "barcode",
    data: `proof-${runId}`,
  });
  await db.insert(executionEventsTable).values({
    organizationId,
    routeId,
    stopId: ids.executionProtected,
    actorUserId: adminUserId,
    clientEventId: `event-${runId}`,
    eventType: "comment",
    planVersion: 0,
    occurredAt: new Date(),
    payload: {},
  });
  await db.insert(serviceReportsTable).values({
    organizationId,
    stopId: ids.serviceReportProtected,
    driverId,
    status: "submitted",
    billingReady: true,
    billingReadyAt: new Date(),
    signatureEvidenceRef: `signature-${runId}`,
  });
  await db.insert(stopsTable).values({
    id: ids.foreign,
    organizationId: foreignOrganizationId,
    address: `FOREIGN-ARCHIVE-${runId}`,
    latitude: 60,
    longitude: 18,
  });

  const { default: app } = await import("../app");
  server = createServer(app as Express);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(executionEventsTable).where(eq(executionEventsTable.stopId, ids.executionProtected));
  await db.delete(serviceReportsTable).where(eq(serviceReportsTable.stopId, ids.serviceReportProtected));
  await db.delete(deliveryProofsTable).where(eq(deliveryProofsTable.stopId, ids.proofProtected));
  await db.delete(stopsTable).where(inArray(stopsTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(routesTable).where(eq(routesTable.id, routeId));
  await db.delete(driversTable).where(eq(driversTable.id, driverId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.id, vehicleId));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [adminUserId, dispatcherUserId, viewerUserId, foreignAdminUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [adminUserId, dispatcherUserId, viewerUserId, foreignAdminUserId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [organizationId, foreignOrganizationId]));
  await pool.end();
});

test("organization archive applies tenant scope, search, assignment, exact total, and pagination before limiting", async () => {
  const firstPage = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&page=1&pageSize=2`);
  assert.equal(firstPage.status, 200);
  const page = await firstPage.json() as { total: number; page: number; pageSize: number; items: Array<{ organizationId: string }> };
  assert.equal(page.total, 15);
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 2);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((item) => item.organizationId === organizationId));

  const lastPage = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&page=8&pageSize=2`);
  assert.equal(lastPage.status, 200);
  const lastPageBody = await lastPage.json() as { total: number; items: unknown[] };
  assert.equal(lastPageBody.total, 15);
  assert.equal(lastPageBody.items.length, 1);
  const search = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&search=${encodeURIComponent(`ORDER-DST-${runId}`)}`);
  const searched = await search.json() as { total: number; items: Array<{ id: string }> };
  assert.equal(searched.total, 1);
  assert.deepEqual(searched.items.map((item) => item.id), [ids.dstStart]);

  const assigned = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&assignment=assigned`);
  assert.equal((await assigned.json() as { total: number }).total, 2);
  const unassigned = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&assignment=unassigned`);
  assert.equal((await unassigned.json() as { total: number }).total, 13);

  const foreign = await request(adminToken, `/api/stops/organization?organizationId=${foreignOrganizationId}`);
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.text()).includes(`FOREIGN-ARCHIVE-${runId}`), false);

  const dispatcherArchive = await request(dispatcherToken, `/api/stops/organization?organizationId=${organizationId}`);
  assert.equal(dispatcherArchive.status, 200);

  const pagedFirst = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&search=${encodeURIComponent(`DST ${runId}`)}&page=1&pageSize=1`);
  const pagedSecond = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&search=${encodeURIComponent(`DST ${runId}`)}&page=2&pageSize=1`);
  const [firstMatch, secondMatch] = await Promise.all([
    pagedFirst.json() as Promise<{ total: number; items: Array<{ id: string }> }>,
    pagedSecond.json() as Promise<{ total: number; items: Array<{ id: string }> }>,
  ]);
  assert.equal(firstMatch.total, 3);
  assert.equal(secondMatch.total, 3);
  assert.equal(firstMatch.items.length, 1);
  assert.equal(secondMatch.items.length, 1);
  assert.notEqual(firstMatch.items[0].id, secondMatch.items[0].id);
});

test("organization archive classifies every stop work status before pagination and keeps protected pending stops current", async () => {
  const current = await request(
    adminToken,
    `/api/stops/organization?organizationId=${organizationId}&workStatus=current&pageSize=100`,
  );
  assert.equal(current.status, 200);
  const currentPage = await current.json() as { total: number; items: Array<{ id: string; status: string }> };
  assert.equal(currentPage.total, 12);
  assert.equal(currentPage.items.length, 12);
  assert.ok(currentPage.items.every((item) => item.status === "pending" || item.status === "in_progress"));
  const protectedPendingIds = new Set<string>([
    ids.proofProtected,
    ids.activeProtected,
    ids.executionProtected,
    ids.serviceReportProtected,
  ]);
  assert.deepEqual(
    protectedPendingIds,
    new Set(currentPage.items.filter((item) => protectedPendingIds.has(item.id)).map((item) => item.id)),
  );
  const terminalIds = new Set<string>([ids.completedTerminal, ids.failedTerminal, ids.skippedTerminal]);
  assert.equal(currentPage.items.some((item) => terminalIds.has(item.id)), false);

  const terminal = await request(
    adminToken,
    `/api/stops/organization?organizationId=${organizationId}&workStatus=terminal&pageSize=100`,
  );
  assert.equal(terminal.status, 200);
  const terminalPage = await terminal.json() as { total: number; items: Array<{ id: string; status: string }> };
  assert.equal(terminalPage.total, 3);
  assert.deepEqual(
    new Set(terminalPage.items.map((item) => item.id)),
    new Set([ids.completedTerminal, ids.failedTerminal, ids.skippedTerminal]),
  );
  assert.deepEqual(
    new Set(terminalPage.items.map((item) => item.status)),
    new Set(["completed", "failed", "skipped"]),
  );

  const protectedCurrent = await request(
    adminToken,
    `/api/stops/organization?organizationId=${organizationId}&workStatus=current&deletionProtection=protected&page=1&pageSize=1`,
  );
  const protectedCurrentSecond = await request(
    adminToken,
    `/api/stops/organization?organizationId=${organizationId}&workStatus=current&deletionProtection=protected&page=2&pageSize=1`,
  );
  const [protectedFirstPage, protectedSecondPage] = await Promise.all([
    protectedCurrent.json() as Promise<{ total: number; items: Array<{ id: string }> }>,
    protectedCurrentSecond.json() as Promise<{ total: number; items: Array<{ id: string }> }>,
  ]);
  assert.equal(protectedFirstPage.total, 4);
  assert.equal(protectedSecondPage.total, 4);
  assert.equal(protectedFirstPage.items.length, 1);
  assert.equal(protectedSecondPage.items.length, 1);
  assert.notEqual(protectedFirstPage.items[0].id, protectedSecondPage.items[0].id);

  const deletableCurrent = await request(
    adminToken,
    `/api/stops/organization?organizationId=${organizationId}&workStatus=current&deletionProtection=deletable&pageSize=100`,
  );
  const deletablePage = await deletableCurrent.json() as { total: number; items: Array<{ id: string; status: string; deletionProtection: string | null }> };
  assert.equal(deletablePage.total, 8);
  assert.ok(deletablePage.items.every((item) => item.status === "pending" && item.deletionProtection === null));
  assert.equal(
    deletablePage.items.find((item) => item.id === ids.assigned)?.deletionProtection,
    null,
  );
  assert.equal(
    deletablePage.items.find((item) => item.id === ids.assignedBulk)?.deletionProtection,
    null,
  );
});

test("organization archive honors Europe/Stockholm DST bounds and can include missing planned dates", async () => {
  const boundary = "dateField=planned_delivery&dateFrom=2025-03-29T23%3A00%3A00.000Z&dateToExclusive=2025-03-30T22%3A00%3A00.000Z";
  const dated = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&${boundary}`);
  assert.equal(dated.status, 200);
  const datedPage = await dated.json() as { total: number; items: Array<{ id: string }> };
  assert.equal(datedPage.total, 2);
  assert.deepEqual(new Set(datedPage.items.map((item) => item.id)), new Set([ids.dstStart, ids.dstEnd]));

  const withMissing = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&${boundary}&includeWithoutPlannedDate=true`);
  assert.equal(withMissing.status, 200);
  assert.equal((await withMissing.json() as { total: number }).total, 13);

  const explicitFalse = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&${boundary}&includeWithoutPlannedDate=false`);
  assert.equal(explicitFalse.status, 200);
  assert.equal((await explicitFalse.json() as { total: number }).total, 2);
});

test("viewer retains the existing redacted stop read while the administrative archive stays role-protected", async () => {
  const archive = await request(viewerToken, `/api/stops/organization?organizationId=${organizationId}`);
  assert.equal(archive.status, 403);

  const legacy = await request(viewerToken, `/api/stops?organizationId=${organizationId}`);
  assert.equal(legacy.status, 200);
  const stops = await legacy.json() as Array<{ id: string; notes: string | null; externalRef: string | null }>;
  const matched = stops.find((item) => item.id === ids.dstStart);
  assert.ok(matched);
  assert.equal(matched.notes, null);
  assert.equal(matched.externalRef, null);
});

test("manual deletion protects proofs, events, and reports but deletes pending stops singly and in bulk", async () => {
  for (const stopId of [ids.proofProtected, ids.activeProtected, ids.executionProtected, ids.serviceReportProtected]) {
    const response = await request(adminToken, "/api/stops/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ stopIds: [stopId] }),
    });
    assert.equal(response.status, 409);
    const [stillPresent] = await db.select({ id: stopsTable.id }).from(stopsTable).where(and(
      eq(stopsTable.id, stopId),
      eq(stopsTable.organizationId, organizationId),
    ));
    assert.ok(stillPresent);
  }

  const archive = await request(adminToken, `/api/stops/organization?organizationId=${organizationId}&pageSize=100`);
  const protectedRows = new Map((await archive.json() as {
    items: Array<{ id: string; deletionProtection: string | null }>;
  }).items.map((item) => [item.id, item.deletionProtection]));
  assert.equal(protectedRows.get(ids.proofProtected), "proof_on_file");
  assert.equal(protectedRows.get(ids.activeProtected), "active_or_terminal_status");
  assert.equal(protectedRows.get(ids.executionProtected), "execution_history");
  assert.equal(protectedRows.get(ids.serviceReportProtected), "service_report");

  const bulkEligible = await request(adminToken, "/api/stops/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ stopIds: [ids.noPlannedDate] }),
  });
  assert.equal(bulkEligible.status, 200);
  assert.equal((await bulkEligible.json() as { deletedCount: number }).deletedCount, 1);

  const assignedBulk = await request(adminToken, "/api/stops/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ stopIds: [ids.assignedBulk] }),
  });
  assert.equal(assignedBulk.status, 200);
  assert.equal((await assignedBulk.json() as { deletedCount: number }).deletedCount, 1);

  const [routeAfterBulk] = await db
    .select({ status: routesTable.status, totalStops: routesTable.totalStops })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  assert.equal(routeAfterBulk.status, "draft");
  assert.equal(routeAfterBulk.totalStops, 1);

  const assignedSingle = await request(adminToken, `/api/stops/${ids.assigned}`, { method: "DELETE" });
  assert.equal(assignedSingle.status, 204);

  const [routeAfterSingle] = await db
    .select({ status: routesTable.status, totalStops: routesTable.totalStops })
    .from(routesTable)
    .where(eq(routesTable.id, routeId));
  assert.equal(routeAfterSingle.status, "cancelled");
  assert.equal(routeAfterSingle.totalStops, 0);

  const singleEligible = await request(adminToken, `/api/stops/${ids.singleDelete}`, { method: "DELETE" });
  assert.equal(singleEligible.status, 204);
  const [deleted] = await db.select({ id: stopsTable.id }).from(stopsTable).where(eq(stopsTable.id, ids.singleDelete));
  assert.equal(deleted, undefined);
});