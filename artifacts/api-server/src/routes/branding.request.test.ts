import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  organizationsTable,
  routesTable,
  sessionsTable,
  stopsTable,
  usersTable,
} from "@workspace/db";
import { createSession } from "../lib/session";
import type { Express } from "express";
import { canAccessObject, ObjectAccessGroupType, ObjectPermission } from "../lib/objectAcl";

type Actor = {
  organizationId: string;
  userId: string;
  token: string;
};

const organizationIds = [randomUUID(), randomUUID()];
const adminAId = randomUUID();
const dispatcherAId = randomUUID();
const viewerAId = randomUUID();
const adminBId = randomUUID();
const routeId = randomUUID();
const stopId = randomUUID();
const trackingCode = `branding-${randomUUID()}`;
const actors: Record<string, Actor> = {};
let server: Server;
let baseUrl = "";
let app: Express;

async function request(
  actor: Actor | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Connection", "close");
  if (actor) headers.set("Authorization", `Bearer ${actor.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function json(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  assert.notEqual(text, "", `Expected JSON response, got ${response.status}`);
  return JSON.parse(text) as Record<string, any>;
}

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: organizationIds[0],
      name: `Branding tenant A ${organizationIds[0]}`,
      email: `${organizationIds[0]}@example.test`,
    },
    {
      id: organizationIds[1],
      name: `Branding tenant B ${organizationIds[1]}`,
      email: `${organizationIds[1]}@example.test`,
    },
  ]);
  await db.insert(usersTable).values([
    {
      id: adminAId,
      organizationId: organizationIds[0],
      name: "Branding admin A",
      email: `${adminAId}@example.test`,
      role: "admin",
    },
    {
      id: dispatcherAId,
      organizationId: organizationIds[0],
      name: "Branding dispatcher A",
      email: `${dispatcherAId}@example.test`,
      role: "dispatcher",
    },
    {
      id: viewerAId,
      organizationId: organizationIds[0],
      name: "Branding viewer A",
      email: `${viewerAId}@example.test`,
      role: "viewer",
    },
    {
      id: adminBId,
      organizationId: organizationIds[1],
      name: "Branding admin B",
      email: `${adminBId}@example.test`,
      role: "admin",
    },
  ]);

  for (const [key, userId, organizationId] of [
    ["adminA", adminAId, organizationIds[0]],
    ["dispatcherA", dispatcherAId, organizationIds[0]],
    ["viewerA", viewerAId, organizationIds[0]],
    ["adminB", adminBId, organizationIds[1]],
  ] as const) {
    const session = await createSession({
      userId,
      organizationId,
      userAgent: `branding-request-${key}`,
    });
    actors[key] = { userId, organizationId, token: session.token };
  }

  await db.insert(routesTable).values({
    id: routeId,
    organizationId: organizationIds[0],
    name: "Branding public tracking route",
    status: "draft",
    date: new Date(),
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId: organizationIds[0],
    routeId,
    address: "Branding test address",
    latitude: 59.3,
    longitude: 18.0,
    trackingCode,
  });

  ({ default: app } = await import("../app"));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => error ? reject(error) : resolve()),
  );
  await db.delete(stopsTable).where(inArray(stopsTable.id, [stopId]));
  await db.delete(routesTable).where(inArray(routesTable.id, [routeId]));
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [
    adminAId,
    dispatcherAId,
    viewerAId,
    adminBId,
  ]));
  await db.delete(usersTable).where(inArray(usersTable.id, [
    adminAId,
    dispatcherAId,
    viewerAId,
    adminBId,
  ]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
});

test("branding is tenant-scoped, admin-only for writes, and resettable", async () => {
  const initialA = await request(actors.adminA, "/api/branding");
  assert.equal(initialA.status, 200);
  assert.deepEqual(await json(initialA), {
    displayName: `Branding tenant A ${organizationIds[0]}`,
    websiteUrl: null,
    primaryColor: null,
    accentColor: null,
    backgroundColor: null,
    logoUrl: null,
    logoDarkUrl: null,
  });

  const initialB = await request(actors.adminB, "/api/branding");
  assert.equal(initialB.status, 200);
  assert.deepEqual(await json(initialB), {
    displayName: `Branding tenant B ${organizationIds[1]}`,
    websiteUrl: null,
    primaryColor: null,
    accentColor: null,
    backgroundColor: null,
    logoUrl: null,
    logoDarkUrl: null,
  });

  const brand = {
    displayName: "Tenant A public brand",
    websiteUrl: "https://tenant-a.example.test",
    primaryColor: "#112233",
    accentColor: "#445566",
    backgroundColor: "#fefefe",
    logoUrl: null,
    logoDarkUrl: null,
  };
  const savedA = await request(actors.adminA, "/api/branding", {
    method: "PUT",
    body: JSON.stringify(brand),
  });
  assert.equal(savedA.status, 200);
  assert.deepEqual(await json(savedA), { ...brand, websiteUrl: `${brand.websiteUrl}/` });

  const crossTenantRead = await request(actors.adminB, "/api/branding");
  assert.equal(crossTenantRead.status, 200);
  assert.equal((await json(crossTenantRead)).displayName, `Branding tenant B ${organizationIds[1]}`);

  for (const [actor, expectedError] of [
    [actors.dispatcherA, "Forbidden: admin role required"],
    [actors.viewerA, "Forbidden: read-only role cannot modify data"],
  ] as const) {
    const response = await request(actor, "/api/branding", {
      method: "PUT",
      body: JSON.stringify(brand),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await json(response), { error: expectedError });
  }

  const viewerDelete = await request(actors.viewerA, "/api/branding", { method: "DELETE" });
  assert.equal(viewerDelete.status, 403);
  assert.deepEqual(await json(viewerDelete), { error: "Forbidden: read-only role cannot modify data" });

  const resetB = await request(actors.adminB, "/api/branding", { method: "DELETE" });
  assert.equal(resetB.status, 200);
  assert.equal((await json(resetB)).displayName, null);

  const resetA = await request(actors.adminA, "/api/branding", { method: "DELETE" });
  assert.equal(resetA.status, 200);
  assert.deepEqual(await json(resetA), {
    displayName: null,
    websiteUrl: null,
    primaryColor: null,
    accentColor: null,
    backgroundColor: null,
    logoUrl: null,
    logoDarkUrl: null,
  });
  const reloadedA = await request(actors.adminA, "/api/branding");
  assert.equal(reloadedA.status, 200);
  assert.equal((await json(reloadedA)).displayName, `Branding tenant A ${organizationIds[0]}`);
});

test("logo uploads require admin role and magic-byte validation before storage", async () => {
  const validPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");
  const body = { data: validPng, contentType: "image/png" };

  const dispatcher = await request(actors.dispatcherA, "/api/branding/logo", {
    method: "POST",
    body: JSON.stringify(body),
  });
  assert.equal(dispatcher.status, 403);
  assert.deepEqual(await json(dispatcher), { error: "Forbidden: admin role required" });

  const mismatch = await request(actors.adminA, "/api/branding/logo", {
    method: "POST",
    body: JSON.stringify({ ...body, contentType: "image/jpeg" }),
  });
  assert.equal(mismatch.status, 400);
  const mismatchBody = await json(mismatch);
  assert.match(mismatchBody.error, /match|contents/i);

  const malformed = await request(actors.adminA, "/api/branding/logo", {
    method: "POST",
    body: JSON.stringify({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]).toString("base64"),
      contentType: "image/png",
    }),
  });
  assert.equal(malformed.status, 400);
  assert.match((await json(malformed)).error, /malformed|truncated/i);

  const privateLogoFile = {
    getMetadata: async () => [{
      metadata: {
        "custom:aclPolicy": JSON.stringify({
          owner: actors.adminA.userId,
          visibility: "private",
          aclRules: [{
            group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationIds[0] },
            permission: ObjectPermission.READ,
          }],
        }),
      },
    }],
  } as any;
  assert.equal(await canAccessObject({
    objectFile: privateLogoFile,
    userId: actors.adminA.userId,
    requestedPermission: ObjectPermission.READ,
  }), true);
  assert.equal(await canAccessObject({
    objectFile: privateLogoFile,
    userId: actors.adminB.userId,
    requestedPermission: ObjectPermission.READ,
  }), false);
  assert.equal(await canAccessObject({
    objectFile: privateLogoFile,
    requestedPermission: ObjectPermission.READ,
  }), false);
});

test("public selected-logo route excludes legacy URLs and legacy tracking no longer exposes branding", async () => {
  const brand = {
    displayName: "Tenant A tracking brand",
    websiteUrl: "https://tenant-a.example.test",
    primaryColor: "#112233",
    accentColor: "#445566",
    backgroundColor: "#fefefe",
    logoUrl: null,
    logoDarkUrl: null,
  };
  const saved = await request(actors.adminA, "/api/branding", {
    method: "PUT",
    body: JSON.stringify(brand),
  });
  assert.equal(saved.status, 200);

  const selectedObjectPath = `/objects/branding/${organizationIds[0]}/${randomUUID()}`;
  await db.update(organizationsTable)
    .set({ brandLogoUrl: selectedObjectPath })
    .where(eq(organizationsTable.id, organizationIds[0]));
  const selectedBranding = await request(actors.adminA, "/api/branding");
  const selectedBrandingBody = await json(selectedBranding);
  const selectedTracking = await request(null, `/api/track/${trackingCode}`);
  const selectedTrackingBody = await json(selectedTracking);
  assert.equal(selectedTracking.status, 404);
  assert.equal(selectedTrackingBody.code, "TRACKING_UNAVAILABLE");
  assert.match(selectedBrandingBody.logoUrl, /\?v=[a-f0-9]{16}$/);

  // Private drafts/legacy logos never authorize public customer branding.
  await db.update(organizationsTable)
    .set({ brandLogoUrl: "https://legacy.example.test/logo.png" })
    .where(eq(organizationsTable.id, organizationIds[0]));

  const publicLogo = await request(null, `/api/branding/public/${organizationIds[0]}/light`);
  assert.equal(publicLogo.status, 404);
  assert.deepEqual(await json(publicLogo), { error: "Logo not found" });

  const tracking = await request(null, `/api/track/${trackingCode}`);
  assert.equal(tracking.status, 404);
  const trackingBody = await json(tracking);
  assert.equal(trackingBody.code, "TRACKING_UNAVAILABLE");
  assert.equal(trackingBody.brand, undefined);
  assert.equal(trackingBody.trackingCode, undefined);
});
