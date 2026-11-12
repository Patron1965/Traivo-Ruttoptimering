import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  and,
  eq,
  inArray,
  isNull,
} from "drizzle-orm";
import {
  auditLogTable,
  customerSitesTable,
  customerVisitIdempotencyTable,
  customersTable,
  db,
  planningDraftsTable,
  sessionsTable,
  stopsTable,
  usersTable,
  organizationsTable,
} from "@workspace/db";
import app from "../app";
import { createSession, validateSessionWithoutTouch } from "../lib/session";

type Actor = {
  organizationId: string;
  role: "admin" | "driver" | "viewer";
  token: string;
};

type JsonResponse = {
  status: number;
  body: any;
};

const originalFetch = globalThis.fetch;
const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;
const runId = randomUUID();
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const serverActors: Actor[] = [];
let server: Server;
let baseUrl = "";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function googleExact(
  placeId: string,
  formattedAddress: string,
  latitude: number,
  longitude: number,
  street: string,
  houseNumber: string,
  postalCode: string,
): { status: "OK"; results: unknown[] } {
  return {
    status: "OK",
    results: [{
      place_id: placeId,
      formatted_address: formattedAddress,
      partial_match: false,
      types: ["street_address"],
      address_components: [
        { long_name: street, types: ["route"] },
        { long_name: houseNumber, types: ["street_number"] },
        { long_name: postalCode, types: ["postal_code"] },
        { long_name: "Stockholm", types: ["postal_town"] },
      ],
      geometry: { location: { lat: latitude, lng: longitude } },
    }],
  };
}

function customerAddressResult(query: string): unknown {
  if (query.includes("Kundtestgatan 10")) {
    return googleExact(
      "customer-exact",
      "Kundtestgatan 10, 111 11 Stockholm, Sweden",
      59.3001,
      18.0101,
      "Kundtestgatan",
      "10",
      "111 11",
    );
  }
  if (query.includes("Kundtestgatan 20")) {
    return {
      status: "OK",
      results: [
        googleExact(
          "customer-candidate-a",
          "Kundtestgatan 20, 111 12 Stockholm, Sweden",
          59.3002,
          18.0102,
          "Kundtestgatan",
          "20",
          "111 12",
        ).results[0],
        googleExact(
          "customer-candidate-b",
          "Kundtestgatan 20, 111 12 Stockholm, Sweden",
          59.3003,
          18.0103,
          "Kundtestgatan",
          "20",
          "111 12",
        ).results[0],
      ],
    };
  }
  if (query.includes("Kundtestgatan 30")) {
    return googleExact(
      "customer-update-exact",
      "Kundtestgatan 30, 111 13 Stockholm, Sweden",
      59.3004,
      18.0104,
      "Kundtestgatan",
      "30",
      "111 13",
    );
  }
  return { status: "ZERO_RESULTS", results: [] };
}

async function request(
  actor: Actor | undefined,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<JsonResponse> {
  const headers = new Headers({ connection: "close" });
  if (actor) headers.set("Authorization", `Bearer ${actor.token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

async function createActor(
  targetOrganizationId: string,
  role: Actor["role"],
): Promise<Actor> {
  const userId = randomUUID();
  await db.insert(usersTable).values({
    id: userId,
    organizationId: targetOrganizationId,
    name: `${role} customer register ${runId}`,
    email: `${role}-${userId}@customer-register.test`,
    role,
  });
  const { token } = await createSession({
    userId,
    organizationId: targetOrganizationId,
    userAgent: "customer-register-request-test",
  });
  const actor = { organizationId: targetOrganizationId, role, token };
  serverActors.push(actor);
  return actor;
}

async function deleteFixtureRows(): Promise<void> {
  const organizations = [organizationId, otherOrganizationId];
  await db.delete(customerVisitIdempotencyTable).where(
    inArray(customerVisitIdempotencyTable.organizationId, organizations),
  );
  await db.delete(stopsTable).where(inArray(stopsTable.organizationId, organizations));
  await db.delete(planningDraftsTable).where(inArray(planningDraftsTable.organizationId, organizations));
  await db.delete(customerSitesTable).where(inArray(customerSitesTable.organizationId, organizations));
  await db.delete(customersTable).where(inArray(customersTable.organizationId, organizations));
  await db.delete(sessionsTable).where(inArray(sessionsTable.organizationId, organizations));
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, organizations));
  await db.delete(usersTable).where(inArray(usersTable.organizationId, organizations));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizations));
}

test("customer register full-app requests cover verification, planning, isolation, archive, and idempotency", async () => {
  process.env.GOOGLE_MAPS_API_KEY = "customer-register-test-key";
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "maps.googleapis.com") {
      return response(200, customerAddressResult(parsed.searchParams.get("address") ?? ""));
    }
    if (parsed.hostname === "nominatim.openstreetmap.org") return response(200, []);
    return originalFetch(url, init);
  };

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: `Customer register ${runId}`,
      email: `${organizationId}@customer-register.test`,
    },
    {
      id: otherOrganizationId,
      name: `Other customer register ${runId}`,
      email: `${otherOrganizationId}@customer-register.test`,
    },
  ]);
  const admin = await createActor(organizationId, "admin");
  const otherAdmin = await createActor(otherOrganizationId, "admin");
  const viewer = await createActor(organizationId, "viewer");
  const driver = await createActor(organizationId, "driver");
  assert.ok(await validateSessionWithoutTouch(admin.token));

  server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await request(admin, "/api/customers", "POST", {
      name: "Kundregister AB",
      email: "kontakt@kundregister.test",
      phone: "010-123456",
      address: "Kundgatan 1",
      customerNumber: "K-1001",
      organizationNumber: "559999-1234",
      contactName: "Kundansvarig",
      postalCode: "111 11",
      city: "Stockholm",
      country: "Sverige",
      billingEmail: "faktura@kundregister.test",
      billingAddress: "Box 100, 111 11 Stockholm",
      notes: "Privat kundanteckning ska aldrig bli körinstruktion.",
      unavailablePeriods: [
        { weekday: 7, start: "01:30", end: "03:30" },
        { weekday: 1, start: "09:00", end: "10:00" },
      ],
      sites: [{
        name: "Stockholmskontoret",
        address: "Kundtestgatan 10, 111 11 Stockholm",
        contactName: "Testkontakt",
        contactPhone: "010-654321",
        contactEmail: "site@kundregister.test",
        windowStart: "01:30",
        windowEnd: "03:30",
        serviceDurationMin: 45,
        isPrioritized: true,
        instructions: "Ring på porttelefonen.",
      }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.sites.length, 1);
    assert.equal(created.body.sites[0].isPrioritized, true);
    const customerId = created.body.id as string;
    const exactSiteId = created.body.sites[0].id as string;
    assert.equal(created.body.address, "Kundgatan 1");
    assert.equal(created.body.customerNumber, "K-1001");
    assert.equal(created.body.organizationNumber, "559999-1234");
    assert.equal(created.body.contactName, "Kundansvarig");
    assert.equal(created.body.postalCode, "111 11");
    assert.equal(created.body.city, "Stockholm");
    assert.equal(created.body.country, "Sverige");
    assert.equal(created.body.billingEmail, "faktura@kundregister.test");
    assert.equal(created.body.billingAddress, "Box 100, 111 11 Stockholm");
    assert.equal(created.body.notes, "Privat kundanteckning ska aldrig bli körinstruktion.");
    assert.deepEqual(created.body.unavailablePeriods, [
      { weekday: 1, start: "09:00", end: "10:00" },
      { weekday: 7, start: "01:30", end: "03:30" },
    ]);
    assert.equal(created.body.sites[0].verificationStatus, "exact");
    assert.equal(created.body.sites[0].verificationMetadata.provider, "google");

    const listed = await request(admin, "/api/customers");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].sites[0].addressInput, "Kundtestgatan 10, 111 11 Stockholm");
    assert.equal(listed.body[0].address, "Kundgatan 1");
    assert.equal(listed.body[0].billingAddress, "Box 100, 111 11 Stockholm");
    assert.equal(listed.body[0].notes, "Privat kundanteckning ska aldrig bli körinstruktion.");
    assert.deepEqual(listed.body[0].unavailablePeriods, [
      { weekday: 1, start: "09:00", end: "10:00" },
      { weekday: 7, start: "01:30", end: "03:30" },
    ]);

    const updatedCustomer = await request(admin, `/api/customers/${customerId}`, "PUT", {
      name: "Kundregister AB (uppdaterad)",
      phone: "010-999999",
      address: "Ny kundadress 2",
      customerNumber: "K-2002",
      organizationNumber: "559999-5678",
      contactName: "Ny kundkontakt",
      postalCode: "222 22",
      city: "Göteborg",
      country: "Sverige",
      billingEmail: "nyfaktura@kundregister.test",
      billingAddress: "Box 200, 222 22 Göteborg",
      notes: "Ny privat anteckning.",
      unavailablePeriods: [
        { weekday: 7, start: "01:00", end: "03:30" },
        { weekday: 1, start: "09:00", end: "10:00" },
      ],
    });
    assert.equal(updatedCustomer.status, 200, JSON.stringify(updatedCustomer.body));
    assert.equal(updatedCustomer.body.name, "Kundregister AB (uppdaterad)");
    assert.equal(updatedCustomer.body.address, "Ny kundadress 2");
    assert.equal(updatedCustomer.body.customerNumber, "K-2002");
    assert.equal(updatedCustomer.body.billingEmail, "nyfaktura@kundregister.test");
    assert.equal(updatedCustomer.body.notes, "Ny privat anteckning.");
    assert.deepEqual(updatedCustomer.body.unavailablePeriods, [
      { weekday: 1, start: "09:00", end: "10:00" },
      { weekday: 7, start: "01:00", end: "03:30" },
    ]);

    const ambiguous = await request(admin, `/api/customers/${customerId}/sites`, "POST", {
      name: "Andra arbetsstället",
      address: "Kundtestgatan 20, 111 12 Stockholm",
    });
    assert.equal(ambiguous.status, 422, JSON.stringify(ambiguous.body));
    assert.equal(ambiguous.body.code, "ADDRESS_VERIFICATION_REQUIRED");
    const candidateId = ambiguous.body.details.candidates[0].id as string;
    const candidateSite = await request(admin, `/api/customers/${customerId}/sites`, "POST", {
      name: "Andra arbetsstället",
      address: "Kundtestgatan 20, 111 12 Stockholm",
      verificationCandidateId: candidateId,
    });
    assert.equal(candidateSite.status, 201, JSON.stringify(candidateSite.body));
    const candidateSiteId = candidateSite.body.sites.find(
      (site: { name: string }) => site.name === "Andra arbetsstället",
    ).id as string;
    assert.equal(
      candidateSite.body.sites.find((site: { id: string }) => site.id === candidateSiteId).isPrioritized,
      false,
    );
    assert.equal(
      candidateSite.body.sites.find((site: { id: string }) => site.id === candidateSiteId).verificationStatus,
      "candidate",
    );

    const invalidWindow = await request(admin, `/api/customers/${customerId}/sites`, "POST", {
      name: "Ogiltigt tidsfönster",
      address: "Kundtestgatan 10, 111 11 Stockholm",
      windowStart: "25:00",
      windowEnd: "26:00",
    });
    assert.equal(invalidWindow.status, 400, JSON.stringify(invalidWindow.body));
    assert.equal(invalidWindow.body.code, "INVALID_CUSTOMER_REQUEST");
    const reversedWindow = await request(admin, `/api/customers/${customerId}/sites`, "POST", {
      name: "Omvänt tidsfönster",
      address: "Kundtestgatan 10, 111 11 Stockholm",
      windowStart: "16:00",
      windowEnd: "08:00",
    });
    assert.equal(reversedWindow.status, 422, JSON.stringify(reversedWindow.body));
    assert.equal(reversedWindow.body.code, "INVALID_SITE_WINDOW");

    const missingSiteRevision = await request(
      admin,
      `/api/customers/${customerId}/sites/${candidateSiteId}`,
      "PUT",
      {
        name: "Saknad revision",
        address: "Kundtestgatan 20, 111 12 Stockholm",
      },
    );
    assert.equal(missingSiteRevision.status, 400, JSON.stringify(missingSiteRevision.body));
    assert.equal(missingSiteRevision.body.code, "INVALID_CUSTOMER_REQUEST");

    const updatedSite = await request(
      admin,
      `/api/customers/${customerId}/sites/${candidateSiteId}`,
      "PUT",
      {
        name: "Andra arbetsstället",
        address: "Kundtestgatan 30, 111 13 Stockholm",
        serviceDurationMin: 20,
        expectedRevision: 0,
        isPrioritized: true,
      },
    );
    assert.equal(updatedSite.status, 200, JSON.stringify(updatedSite.body));
    const updatedSiteRow = updatedSite.body.sites.find(
      (site: { id: string }) => site.id === candidateSiteId,
    );
    assert.equal(updatedSiteRow.verificationStatus, "exact");
    assert.equal(updatedSiteRow.isPrioritized, true);
    assert.equal(updatedSiteRow.address, "Kundtestgatan 30, 111 13 Stockholm, Sweden");

    // Viewer reads within its tenant but cannot write; drivers cannot read or
    // write the register. A different tenant cannot see this customer.
    const viewerList = await request(viewer, "/api/customers");
    assert.equal(viewerList.status, 200);
    assert.equal(viewerList.body.length, 1);
    const viewerWrite = await request(viewer, "/api/customers", "POST", { name: "Nope" });
    assert.equal(viewerWrite.status, 403);
    assert.equal((await request(driver, "/api/customers")).status, 403);
    assert.equal((await request(driver, "/api/customers", "POST", { name: "Nope" })).status, 403);
    const otherTenantList = await request(otherAdmin, "/api/customers");
    assert.equal(otherTenantList.status, 200);
    assert.deepEqual(otherTenantList.body, []);
    const otherTenantPlan = await request(otherAdmin, "/api/customers/plan-visits", "POST", {
      siteIds: [exactSiteId],
      date: "2026-03-29",
      idempotencyKey: `foreign-${runId}`,
    });
    assert.equal(otherTenantPlan.status, 422);
    assert.equal(otherTenantPlan.body.code, "INVALID_SITE_SELECTION");

    const importedDraftId = randomUUID();
    const importedResultStopId = randomUUID();
    const importedResultSnapshotId = randomUUID();
    const importedRowResultStopId = randomUUID();
    const importedResult = {
      receivedRowCount: 1,
      savedRowCount: 1,
      imported: 1,
      stopIds: [importedResultStopId],
      stops: [{ id: importedResultSnapshotId, address: "Importerad adress" }],
      rowResults: [{ sourceRowNumber: 1, status: "saved" as const, stopId: importedRowResultStopId }],
    };
    await db.insert(planningDraftsTable).values({
      id: importedDraftId,
      organizationId,
      name: "Importerad kunddag",
      startAt: new Date("2026-03-29T00:00:00.000Z"),
      state: { source: "import", selectedStopIds: ["already-selected-stop"] },
      importedResult,
    });
    const existingDraftPlan = await request(admin, "/api/customers/plan-visits", "POST", {
      siteIds: [candidateSiteId],
      date: "2026-03-29",
      draftId: importedDraftId,
      draftRevision: 0,
      idempotencyKey: `existing-${runId}`,
    });
    assert.equal(existingDraftPlan.status, 201, JSON.stringify(existingDraftPlan.body));
    assert.equal(existingDraftPlan.body.count, 1);
    const [storedDraft] = await db.select().from(planningDraftsTable).where(
      eq(planningDraftsTable.id, importedDraftId),
    );
    assert.equal(storedDraft.revision, 1);
    assert.equal(storedDraft.state.source, "import");
    assert.deepEqual(storedDraft.importedResult, importedResult);
    const selectedStopIds = storedDraft.state.selectedStopIds;
    assert.ok(Array.isArray(selectedStopIds));
    assert.ok(selectedStopIds.includes("already-selected-stop"));
    assert.ok(selectedStopIds.includes(existingDraftPlan.body.stopIds[0]));
    assert.deepEqual(storedDraft.state.customerVisitStopIds, [existingDraftPlan.body.stopIds[0]]);
    const importedStopIds = storedDraft.state.importedStopIds;
    assert.ok(Array.isArray(importedStopIds));
    assert.ok(importedStopIds.includes(importedResultStopId));
    assert.ok(importedStopIds.includes(importedResultSnapshotId));
    assert.ok(importedStopIds.includes(importedRowResultStopId));

    const newDraftBody = {
      siteIds: [exactSiteId],
      date: "2026-03-29",
      planName: "Ny kunddag",
      idempotencyKey: `new-${runId}`,
    };
    const newDraftPlan = await request(admin, "/api/customers/plan-visits", "POST", newDraftBody);
    assert.equal(newDraftPlan.status, 201, JSON.stringify(newDraftPlan.body));
    assert.equal(newDraftPlan.body.count, 1);
    const [newDraft] = await db.select().from(planningDraftsTable).where(
      eq(planningDraftsTable.id, newDraftPlan.body.draftId),
    );
    assert.equal(newDraft.state.step, 5, "customer visits open resource selection, never the upload screen");
    const retry = await request(admin, "/api/customers/plan-visits", "POST", newDraftBody);
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body, newDraftPlan.body);
    const reusedKey = await request(admin, "/api/customers/plan-visits", "POST", {
      ...newDraftBody,
      date: "2026-03-30",
    });
    assert.equal(reusedKey.status, 409, JSON.stringify(reusedKey.body));
    assert.equal(reusedKey.body.code, "IDEMPOTENCY_KEY_REUSED");

    const mondayPlan = await request(admin, "/api/customers/plan-visits", "POST", {
      siteIds: [exactSiteId],
      date: "2026-03-30",
      planName: "Nästa kunddag",
      idempotencyKey: `monday-${runId}`,
    });
    assert.equal(mondayPlan.status, 201, JSON.stringify(mondayPlan.body));
    const [mondayStop] = await db.select().from(stopsTable).where(
      eq(stopsTable.id, mondayPlan.body.stopIds[0]),
    );
    assert.deepEqual(mondayStop.unavailablePeriods, [{
      start: "2026-03-30T07:00:00.000Z",
      end: "2026-03-30T08:00:00.000Z",
    }]);

    const exported = await request(
      admin,
      `/api/export?format=json&organizationId=${organizationId}`,
    );
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.ok(exported.body.tables.customer_sites.length >= 2);
    assert.ok(exported.body.tables.customer_visit_idempotency.length >= 2);

    const beforeInvalid = await db.select({ id: stopsTable.id }).from(stopsTable).where(
      eq(stopsTable.organizationId, organizationId),
    );
    const invalidSelection = await request(admin, "/api/customers/plan-visits", "POST", {
      siteIds: [exactSiteId, randomUUID()],
      date: "2026-03-29",
      idempotencyKey: `invalid-${runId}`,
    });
    assert.equal(invalidSelection.status, 422, JSON.stringify(invalidSelection.body));
    assert.equal(invalidSelection.body.code, "INVALID_SITE_SELECTION");
    const afterInvalid = await db.select({ id: stopsTable.id }).from(stopsTable).where(
      eq(stopsTable.organizationId, organizationId),
    );
    assert.equal(afterInvalid.length, beforeInvalid.length);

    const [existingStop] = await db.select().from(stopsTable).where(
      eq(stopsTable.id, existingDraftPlan.body.stopIds[0]),
    );
    assert.equal(existingStop.address, "Kundtestgatan 30, 111 13 Stockholm, Sweden");
    assert.equal(existingStop.customerSiteName, "Andra arbetsstället");
    assert.equal(existingStop.timeWindowStart, null);
    assert.equal(existingStop.serviceDurationMin, 20);
    assert.equal(existingStop.priority, 1);
    assert.equal(existingStop.notes, null);
    const [dstStop] = await db.select().from(stopsTable).where(
      eq(stopsTable.id, newDraftPlan.body.stopIds[0]),
    );
    assert.equal(dstStop.timeWindowStart?.toISOString(), "2026-03-29T00:30:00.000Z");
    assert.equal(dstStop.timeWindowEnd?.toISOString(), "2026-03-29T01:30:00.000Z");
    assert.equal(dstStop.serviceDurationMin, 45);
    assert.equal(dstStop.priority, 1);
    assert.equal(dstStop.notes, "Ring på porttelefonen.");
    assert.notEqual(dstStop.notes, "Ny privat anteckning.");
    assert.deepEqual(dstStop.unavailablePeriods, [{
      start: "2026-03-29T00:00:00.000Z",
      end: "2026-03-29T01:30:00.000Z",
    }]);

    const clearedCustomer = await request(admin, `/api/customers/${customerId}`, "PUT", {
      email: null,
      phone: null,
      address: null,
      customerNumber: null,
      organizationNumber: null,
      contactName: null,
      postalCode: null,
      city: null,
      country: null,
      billingEmail: null,
      billingAddress: null,
      notes: null,
      unavailablePeriods: [],
    });
    assert.equal(clearedCustomer.status, 200, JSON.stringify(clearedCustomer.body));
    assert.equal(clearedCustomer.body.name, "Kundregister AB (uppdaterad)");
    for (const field of [
      "email",
      "phone",
      "address",
      "customerNumber",
      "organizationNumber",
      "contactName",
      "postalCode",
      "city",
      "country",
      "billingEmail",
      "billingAddress",
      "notes",
    ]) {
      assert.equal(clearedCustomer.body[field], null, `${field} should be clearable`);
    }
    assert.deepEqual(clearedCustomer.body.unavailablePeriods, []);
    const [historicalDstStop] = await db.select().from(stopsTable).where(
      eq(stopsTable.id, newDraftPlan.body.stopIds[0]),
    );
    assert.deepEqual(historicalDstStop.unavailablePeriods, [{
      start: "2026-03-29T00:00:00.000Z",
      end: "2026-03-29T01:30:00.000Z",
    }]);

    const renamedSite = await request(
      admin,
      `/api/customers/${customerId}/sites/${candidateSiteId}`,
      "PUT",
      {
        name: "Andra arbetsstället (nytt namn)",
        address: "Kundtestgatan 30, 111 13 Stockholm",
        serviceDurationMin: 20,
        expectedRevision: 1,
      },
    );
    assert.equal(renamedSite.status, 200, JSON.stringify(renamedSite.body));
    assert.equal(
      renamedSite.body.sites.find((site: { id: string }) => site.id === candidateSiteId).isPrioritized,
      true,
    );
    assert.equal(
      renamedSite.body.sites.find((site: { id: string }) => site.id === candidateSiteId).revision,
      2,
    );
    const staleSiteUpdate = await request(
      admin,
      `/api/customers/${customerId}/sites/${candidateSiteId}`,
      "PUT",
      {
        name: "Stale edit",
        address: "Kundtestgatan 30, 111 13 Stockholm",
        expectedRevision: 1,
      },
    );
    assert.equal(staleSiteUpdate.status, 409, JSON.stringify(staleSiteUpdate.body));
    assert.equal(staleSiteUpdate.body.code, "CUSTOMER_SITE_REVISION_CONFLICT");
    const staleSiteDelete = await request(
      admin,
      `/api/customers/${customerId}/sites/${candidateSiteId}?expectedRevision=1`,
      "DELETE",
    );
    assert.equal(staleSiteDelete.status, 409, JSON.stringify(staleSiteDelete.body));
    assert.equal(staleSiteDelete.body.code, "CUSTOMER_SITE_REVISION_CONFLICT");

    const archivedSite = await request(
      admin,
      `/api/customers/${customerId}/sites/${candidateSiteId}?expectedRevision=2`,
      "DELETE",
    );
    assert.equal(archivedSite.status, 204);
    const archiveCustomer = await request(admin, `/api/customers/${customerId}`, "DELETE");
    assert.equal(archiveCustomer.status, 204);
    const activeAfterArchive = await request(admin, "/api/customers");
    assert.equal(activeAfterArchive.status, 200);
    assert.deepEqual(activeAfterArchive.body, []);
    const explicitlyActive = await request(admin, "/api/customers?includeArchived=false");
    assert.equal(explicitlyActive.status, 200);
    assert.deepEqual(explicitlyActive.body, []);
    const history = await request(admin, `/api/stops/${existingStop.id}`);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.address, "Kundtestgatan 30, 111 13 Stockholm, Sweden");
    assert.equal(history.body.customerName, "Kundregister AB (uppdaterad)");
    const archivedCustomers = await request(admin, "/api/customers?includeArchived=true");
    assert.equal(archivedCustomers.status, 200);
    assert.equal(archivedCustomers.body[0].archivedAt != null, true);
    // Import preserves existing and archived data, isolates tenants and tolerates retries.
    const importedRow = {
      name: "Excelkund",
      customerNumber: " EXCEL-100 ",
      address: "Kundtestgatan 10, 111 11 Stockholm",
      sites: [{ name: "Leverans", address: "Kundtestgatan 10, 111 11 Stockholm", instructions: "Ring på." }],
    };
    const imported = await request(admin, "/api/customers/import-row", "POST", importedRow);
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.outcome, "created");
    const skipped = await request(admin, "/api/customers/import-row", "POST", {
      ...importedRow, name: "Får inte skrivas över", customerNumber: "excel-100",
      sites: [{ name: "Fel", address: "Ingen verifierbar adress" }],
    });
    assert.equal(skipped.body.outcome, "skipped", JSON.stringify(skipped));
    const [storedImport] = await db.select().from(customersTable).where(and(
      eq(customersTable.organizationId, organizationId), eq(customersTable.customerNumber, "EXCEL-100"),
    ));
    assert.equal(storedImport.name, "Excelkund");
    assert.equal((await request(otherAdmin, "/api/customers/import-row", "POST", importedRow)).body.outcome, "created");
    assert.equal((await request(viewer, "/api/customers/import-row", "POST", importedRow)).status, 403);
    assert.equal((await request(driver, "/api/customers/import-row", "POST", importedRow)).status, 403);
    assert.equal((await request(undefined, "/api/customers/import-row", "POST", importedRow)).status, 401);
    await request(admin, `/api/customers/${storedImport.id}`, "DELETE");
    assert.equal((await request(admin, "/api/customers/import-row", "POST", importedRow)).body.outcome, "skipped");
    const concurrent = await Promise.all([1, 2].map(() =>
      request(admin, "/api/customers/import-row", "POST", { name: "Samtidig kund", address: "Testadress" }),
    ));
    assert.deepEqual(concurrent.map(r => r.body.outcome).sort(), ["created", "skipped"]);
    const invalid = await request(admin, "/api/customers/import-row", "POST", {
      name: "Ogiltig Excelkund",
      sites: [{ name: "Fel plats", address: "Ingen verifierbar adress" }],
    });
    assert.equal(invalid.status, 422, JSON.stringify(invalid));
    const invalidRows = await db.select().from(customersTable).where(and(
      eq(customersTable.organizationId, organizationId), eq(customersTable.name, "Ogiltig Excelkund"),
    ));
    assert.equal(invalidRows.length, 0);
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await deleteFixtureRows();
    globalThis.fetch = originalFetch;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalGoogleKey;
  }
});