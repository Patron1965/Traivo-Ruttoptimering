import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { Express } from "express";
import {
  db,
  organizationsTable,
  pool,
  sessionsTable,
  stopsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createSession } from "../lib/session";

const organizationId = randomUUID();
const userId = randomUUID();
const runId = randomUUID();
const originalFetch = globalThis.fetch;
const originalGoogleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
let server: Server;
let baseUrl = "";
let providerCalls = 0;

function providerResult(address: string): Record<string, unknown> {
  const isPickup = address.toLocaleLowerCase().includes("pickup");
  const isOutOfRange = address.toLocaleLowerCase().includes("out of range");
  const route = isPickup
    ? "Exact Pickup Road"
    : isOutOfRange
      ? "Out of Range Road"
      : "Exact Delivery Road";
  const number = isPickup ? "9" : "7";
  const postalCode = isPickup ? "111 23" : "111 22";
  const latitude = isPickup ? 60.22222 : 60.11111;
  const longitude = isPickup ? 17.22222 : 17.11111;
  return {
    status: "OK",
    results: [{
      place_id: `exact-${isPickup ? "pickup" : "delivery"}`,
      formatted_address: `${route} ${number}, ${postalCode} Stockholm`,
      types: ["street_address"],
      address_components: [
        { long_name: route, types: ["route"] },
        { long_name: number, types: ["street_number"] },
        { long_name: postalCode, types: ["postal_code"] },
        { long_name: "Stockholm", types: ["locality"] },
      ],
      geometry: { location: { lat: latitude, lng: longitude } },
    }],
  };
}

async function request(token: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await originalFetch(`${baseUrl}/api/stops/import`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Connection: "close",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  process.env.GOOGLE_MAPS_API_KEY = "stops-import-request-test";
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.startsWith("https://maps.googleapis.com/maps/api/geocode/json")) {
      providerCalls += 1;
      const address = new URL(url).searchParams.get("address") ?? "";
      const lower = address.toLocaleLowerCase();
      if (lower.includes("partial candidate") || lower.includes("partial pickup")) {
        const pickup = lower.includes("partial pickup");
        return new Response(JSON.stringify({
          status: "OK",
          results: [{
            place_id: pickup ? "partial-pickup" : "partial-candidate",
            formatted_address: pickup
              ? "Partial Pickup Road 88, 111 26 Stockholm"
              : "Partial Candidate Road 11, 111 24 Stockholm",
            types: ["street_address"],
            address_components: [
              { long_name: pickup ? "Partial Pickup Road" : "Partial Candidate Road", types: ["route"] },
              { long_name: pickup ? "88" : "11", types: ["street_number"] },
              { long_name: pickup ? "111 26" : "111 24", types: ["postal_code"] },
              { long_name: "Stockholm", types: ["locality"] },
            ],
            geometry: { location: { lat: pickup ? 60.44444 : 60.33333, lng: pickup ? 17.44444 : 17.33333 } },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (lower.includes("broad area")) {
        return new Response(JSON.stringify({
          status: "OK",
          results: [{
            place_id: "broad-candidate",
            formatted_address: "Stockholm, Sweden",
            types: ["locality"],
            address_components: [{ long_name: "Stockholm", types: ["locality"] }],
            geometry: { location: { lat: 59.3293, lng: 18.0686 } },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(providerResult(address)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("http://127.0.0.1:")) {
      // The request helper must continue to use the real fetch for localhost.
      return originalFetch(input, init);
    }
    throw new Error(`Unexpected external fetch in stops import test: ${url}`);
  };

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: `Stops import request ${runId}`,
    email: `${runId}@example.test`,
  });
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Stops import dispatcher",
    email: `${runId}-user@example.test`,
    role: "dispatcher",
  });
  const token = (await createSession({
    userId,
    organizationId,
    userAgent: "stops-import-request-test",
  })).token;
  testToken = token;

  const { default: app } = await import("../app");
  server = createServer(app as Express);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

let testToken = "";

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalGoogleMapsApiKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = originalGoogleMapsApiKey;
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, userId));
  await db.delete(usersTable).where(eq(usersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await pool.end();
});

test("keeps selected delivery and pickup coordinates and source fields without provider calls", async () => {
  const address = "Exact Delivery Road 7, 111 22 Stockholm";
  const pickupAddress = "Exact Pickup Road 9, 111 23 Stockholm";
  const response = await request(testToken, {
    organizationId,
    expectedRowCount: 1,
    stops: [{
      address,
      latitude: 59.30101,
      longitude: 18.40101,
      pickupAddress,
      pickupLatitude: 59.30202,
      pickupLongitude: 18.40202,
      notes: "Original notes",
      externalRef: "ORIGINAL-REF",
      customFields: {
        source: "import",
        _traivoNavigationVerified: "true",
        _traivoNavigationAddress: "Forged provider address",
      },
      sourceRowNumber: 4,
    }],
  });

  assert.equal(response.status, 201);
  assert.equal(providerCalls, 0);
  const [saved] = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  assert.ok(saved);
  assert.equal(saved.address, address);
  assert.equal(saved.latitude, 59.30101);
  assert.equal(saved.longitude, 18.40101);
  assert.equal(saved.pickupAddress, pickupAddress);
  assert.equal(saved.pickupLatitude, 59.30202);
  assert.equal(saved.pickupLongitude, 18.40202);
  assert.equal(saved.notes, "Original notes");
  assert.equal(saved.externalRef, "ORIGINAL-REF");
  assert.deepEqual(saved.customFields, { source: "import" });
});

test("geocodes an import with missing coordinates only on an exact provider result", async () => {
  const response = await request(testToken, {
    organizationId,
    expectedRowCount: 1,
    stops: [{
      address: "Exact Delivery Road 7, 111 22 Stockholm",
      pickupAddress: "Exact Pickup Road 9, 111 23 Stockholm",
    }],
  });

  assert.equal(response.status, 201);
  assert.equal(providerCalls, 2);
  const [exact] = await db.select().from(stopsTable).where(eq(stopsTable.id, response.body.stops[0].id));
  assert.ok(exact);
  assert.equal(exact.latitude, 60.11111);
  assert.equal(exact.longitude, 17.11111);
  assert.equal(exact.pickupLatitude, 60.22222);
  assert.equal(exact.pickupLongitude, 17.22222);
});

test("rejects partial and broad geocode candidates without explicit coordinates", async () => {
  const response = await request(testToken, {
    organizationId,
    expectedRowCount: 3,
    stops: [
      { address: "Partial Candidate Road 12, 111 25 Stockholm" },
      { address: "Broad Area Stockholm" },
      {
        address: "Exact Delivery Road 7, 111 22 Stockholm",
        pickupAddress: "Partial Pickup Road 12, 111 25 Stockholm",
      },
    ],
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.rowResults.length, 3);
  assert.ok(response.body.rowResults.every((row: { reasons: string[] }) =>
    row.reasons.some((reason) => reason.includes("giltigt koordinatpar"))));
  assert.equal(response.body.failedPickupAddresses.length, 1);
  const saved = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  assert.equal(saved.some((stop) => stop.address.includes("Partial Candidate")), false);
  assert.equal(saved.some((stop) => stop.address.includes("Broad Area")), false);
});

test("rejects out-of-range selected coordinates without replacing them by a provider result", async () => {
  const beforeCalls = providerCalls;
  const response = await request(testToken, {
    organizationId,
    expectedRowCount: 1,
    stops: [{
      address: "Out of Range Road 7, 111 22 Stockholm",
      latitude: 91,
      longitude: 18.40101,
      pickupAddress: "Exact Pickup Road 9, 111 23 Stockholm",
      pickupLatitude: 59.30202,
      pickupLongitude: 18.40202,
    }],
  });

  assert.equal(response.status, 422);
  assert.equal(providerCalls, beforeCalls);
  assert.match(response.body.rowResults[0].reasons.join(" "), /giltigt koordinatpar/);
  const saved = await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  assert.equal(saved.some((stop) => stop.address === "Out of Range Road 7, 111 22 Stockholm" && stop.latitude === 91), false);
});