import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { db, organizationsTable, sessionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Express } from "express";
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectAccessGroupType, ObjectPermission } from "../lib/objectAcl";
import { createSession } from "../lib/session";

const organizationId = randomUUID();
const adminId = randomUUID();
const otherOrganizationId = randomUUID();
const otherAdminId = randomUUID();
const stagedObjectPaths = new Set<string>();
const genericObjectPaths = new Set<string>();
const actors: Record<string, { token: string; userId: string }> = {};
let app: Express;
let server: Server;
let baseUrl = "";

const pngOne = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==",
  "base64",
);
const pngTwo = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC",
  "base64",
);

async function request(
  actor: { token: string } | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Connection", "close");
  if (actor) headers.set("Authorization", `Bearer ${actor.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function readJson(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  assert.notEqual(text, "", `Expected JSON response, got ${response.status}`);
  return JSON.parse(text) as Record<string, any>;
}

function objectPathFromPreview(previewUrl: string): string {
  const prefix = "/api/branding/logo/preview/";
  assert.ok(previewUrl.startsWith(prefix), previewUrl);
  const token = previewUrl.slice(prefix.length);
  const objectPath = Buffer.from(token, "base64url").toString("utf8");
  assert.match(objectPath, /^\/objects\/branding\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i);
  stagedObjectPaths.add(objectPath);
  return objectPath;
}

async function stage(actor: { token: string }, bytes: Buffer): Promise<{ previewUrl: string; objectPath: string }> {
  const response = await request(actor, "/api/branding/logo", {
    method: "POST",
    body: JSON.stringify({
      data: bytes.toString("base64"),
      contentType: "image/png",
    }),
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(typeof body.logoUrl, "string");
  return {
    previewUrl: body.logoUrl,
    objectPath: objectPathFromPreview(body.logoUrl),
  };
}

async function saveLogo(
  actor: { token: string },
  logoUrl: string | null,
  logoDarkUrl: string | null = null,
): Promise<Record<string, any>> {
  const response = await request(actor, "/api/branding", {
    method: "PUT",
    body: JSON.stringify({
      displayName: "Real storage fixture",
      websiteUrl: "https://storage-fixture.example.test",
      primaryColor: "#112233",
      accentColor: "#445566",
      backgroundColor: "#fefefe",
      logoUrl,
      logoDarkUrl,
    }),
  });
  assert.equal(response.status, 200);
  return readJson(response);
}

async function assertRasterPixels(response: Response, expected: Buffer): Promise<void> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const actual = Buffer.from(await response.arrayBuffer());
  const [expectedRaw, actualRaw] = await Promise.all([
    sharp(expected).raw().toBuffer(),
    sharp(actual).raw().toBuffer(),
  ]);
  assert.deepEqual(actualRaw, expectedRaw);
}

before(async () => {
  assert.ok(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID, "real object storage bucket is required");
  assert.ok(process.env.PRIVATE_OBJECT_DIR, "real private object storage path is required");

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: `Real branding storage ${organizationId}`,
      email: `${organizationId}@example.test`,
    },
    {
      id: otherOrganizationId,
      name: `Other branding storage ${otherOrganizationId}`,
      email: `${otherOrganizationId}@example.test`,
    },
  ]);
  await db.insert(usersTable).values([
    {
      id: adminId,
      organizationId,
      name: "Real branding storage admin",
      email: `${adminId}@example.test`,
      role: "admin",
    },
    {
      id: otherAdminId,
      organizationId: otherOrganizationId,
      name: "Other branding storage admin",
      email: `${otherAdminId}@example.test`,
      role: "admin",
    },
  ]);
  for (const [key, userId, organization] of [
    ["admin", adminId, organizationId],
    ["otherAdmin", otherAdminId, otherOrganizationId],
  ] as const) {
    const session = await createSession({
      userId,
      organizationId: organization,
      userAgent: `real-branding-storage-${key}`,
    });
    actors[key] = { token: session.token, userId };
  }

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

  const objectStorage = new ObjectStorageService();
  for (const objectPath of stagedObjectPaths) {
    await objectStorage.deleteObjectEntity(objectPath);
  }
  for (const objectPath of genericObjectPaths) {
    await objectStorage.deleteObjectEntity(objectPath);
  }
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, adminId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, otherAdminId));
  await db.delete(usersTable).where(eq(usersTable.id, adminId));
  await db.delete(usersTable).where(eq(usersTable.id, otherAdminId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrganizationId));
});

test("real object storage supports stage, ACL, save, replace, remove, and reset", async () => {
  const first = await stage(actors.admin, pngOne);
  const firstDark = await stage(actors.admin, pngTwo);

  const preview = await request(actors.admin, new URL(first.previewUrl, baseUrl).pathname);
  await assertRasterPixels(preview, pngOne);

  const otherPreview = await request(actors.otherAdmin, new URL(first.previewUrl, baseUrl).pathname);
  assert.equal(otherPreview.status, 403);

  const objectEntity = `/api/storage/objects/${first.objectPath.slice("/objects/".length)}`;
  const ownerStorageRead = await request(actors.admin, objectEntity);
  await assertRasterPixels(ownerStorageRead, pngOne);
  const otherStorageRead = await request(actors.otherAdmin, objectEntity);
  assert.equal(otherStorageRead.status, 403);

  const savedFirst = await saveLogo(actors.admin, first.previewUrl, firstDark.previewUrl);
  assert.match(savedFirst.logoUrl, new RegExp(`^/api/branding/public/${organizationId}/light\\?v=[a-f0-9]{16}$`));
  assert.match(savedFirst.logoDarkUrl, new RegExp(`^/api/branding/public/${organizationId}/dark\\?v=[a-f0-9]{16}$`));
  assert.notEqual(savedFirst.logoUrl, savedFirst.logoDarkUrl);
  const publicFirst = await request(null, savedFirst.logoUrl);
  await assertRasterPixels(publicFirst, pngOne);
  assert.equal(publicFirst.headers.get("cache-control"), "no-store");
  const publicFirstDark = await request(null, savedFirst.logoDarkUrl);
  await assertRasterPixels(publicFirstDark, pngTwo);
  assert.equal(publicFirstDark.headers.get("cache-control"), "no-store");

  const second = await stage(actors.admin, pngTwo);
  const savedSecond = await saveLogo(actors.admin, second.previewUrl, firstDark.previewUrl);
  assert.match(savedSecond.logoUrl, new RegExp(`^/api/branding/public/${organizationId}/light\\?v=[a-f0-9]{16}$`));
  assert.notEqual(savedSecond.logoUrl, savedFirst.logoUrl);
  const staleLight = await request(null, savedFirst.logoUrl);
  assert.equal(staleLight.status, 404);
  const publicSecond = await request(null, savedSecond.logoUrl);
  await assertRasterPixels(publicSecond, pngTwo);
  assert.equal(publicSecond.headers.get("cache-control"), "no-store");
  const unversionedSecond = await request(null, savedSecond.logoUrl.split("?")[0]);
  await assertRasterPixels(unversionedSecond, pngTwo);
  assert.equal(unversionedSecond.headers.get("cache-control"), "no-store");

  const currentSelection = await saveLogo(actors.admin, savedSecond.logoUrl, savedSecond.logoDarkUrl);
  assert.equal(currentSelection.logoUrl, savedSecond.logoUrl);
  const currentBranding = await request(actors.admin, "/api/branding");
  assert.equal((await readJson(currentBranding)).logoUrl, savedSecond.logoUrl);

  const removed = await saveLogo(actors.admin, null, firstDark.previewUrl);
  assert.equal(removed.logoUrl, null);
  assert.match(removed.logoDarkUrl, new RegExp(`^/api/branding/public/${organizationId}/dark\\?v=[a-f0-9]{16}$`));
  const afterRemove = await request(null, `/api/branding/public/${organizationId}/light`);
  assert.equal(afterRemove.status, 404);

  const reset = await request(actors.admin, "/api/branding", { method: "DELETE" });
  assert.equal(reset.status, 200);
  assert.equal((await readJson(reset)).logoUrl, null);
  const afterReset = await request(actors.admin, "/api/branding");
  assert.equal((await readJson(afterReset)).logoUrl, null);
});

test("generic private objects cannot become branding previews or public logos", async () => {
  const uploadRequest = await request(actors.admin, "/api/storage/uploads/request-url", {
    method: "POST",
    body: JSON.stringify({
      name: "proof.pdf",
      size: 24,
      contentType: "application/pdf",
    }),
  });
  assert.equal(uploadRequest.status, 200);
  const upload = await readJson(uploadRequest);
  assert.equal(typeof upload.uploadURL, "string");
  assert.equal(typeof upload.objectPath, "string");
  const genericObjectPath = upload.objectPath as string;
  genericObjectPaths.add(genericObjectPath);
  assert.match(genericObjectPath, /^\/objects\/uploads\/[0-9a-f-]{36}$/i);

  const proofBytes = Buffer.from("%PDF-1.7\nbranding proof\n");
  const uploadResponse = await fetch(upload.uploadURL as string, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: proofBytes,
  });
  assert.equal(uploadResponse.ok, true);
  const objectStorage = new ObjectStorageService();
  await objectStorage.trySetObjectEntityAclPolicy(genericObjectPath, {
    owner: actors.admin.userId,
    visibility: "private",
    aclRules: [{
      group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: organizationId },
      permission: ObjectPermission.READ,
    }],
  });

  const fabricatedPreview = `/api/branding/logo/preview/${
    Buffer.from(genericObjectPath, "utf8").toString("base64url")
  }`;
  const preview = await request(actors.admin, fabricatedPreview);
  assert.equal(preview.status, 404);
  assert.deepEqual(await readJson(preview), { error: "Logo not found" });

  const save = await request(actors.admin, "/api/branding", {
    method: "PUT",
    body: JSON.stringify({
      displayName: null,
      websiteUrl: null,
      primaryColor: null,
      accentColor: null,
      backgroundColor: null,
      logoUrl: fabricatedPreview,
      logoDarkUrl: null,
    }),
  });
  assert.equal(save.status, 400);
  assert.match((await readJson(save)).error, /staged branding image/i);

  await db.update(organizationsTable)
    .set({ brandLogoUrl: genericObjectPath })
    .where(eq(organizationsTable.id, organizationId));
  const maliciousBranding = await request(actors.admin, "/api/branding");
  const genericPublicUrl = (await readJson(maliciousBranding)).logoUrl;
  assert.match(genericPublicUrl, new RegExp(`^/api/branding/public/${organizationId}/light\\?v=`));
  const selectedGenericSave = await request(actors.admin, "/api/branding", {
    method: "PUT",
    body: JSON.stringify({
      displayName: null,
      websiteUrl: null,
      primaryColor: null,
      accentColor: null,
      backgroundColor: null,
      logoUrl: genericPublicUrl,
      logoDarkUrl: null,
    }),
  });
  assert.equal(selectedGenericSave.status, 400);
  assert.match((await readJson(selectedGenericSave)).error, /no longer available/i);
  const maliciousPublic = await request(null, `/api/branding/public/${organizationId}/light`);
  assert.equal(maliciousPublic.status, 404);
  assert.deepEqual(await readJson(maliciousPublic), { error: "Logo not found" });
  await db.update(organizationsTable)
    .set({ brandLogoUrl: null })
    .where(eq(organizationsTable.id, organizationId));
});
