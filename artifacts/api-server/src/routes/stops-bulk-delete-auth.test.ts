import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { BulkDeleteStopsBody } from "@workspace/api-zod";
import type { AuthUser, UserRole } from "../middleware/auth";
import { requireBulkStopDeleteAccess } from "./stops";

const baseUser: AuthUser = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Test User",
  email: "test@example.com",
  role: "admin",
  organizationId: "00000000-0000-0000-0000-000000000010",
  driverProfileId: null,
};

function appFor(role?: UserRole): Express {
  const app = express();
  app.use(express.json());
  if (role) {
    app.use((req, _res, next) => {
      req.user = { ...baseUser, role };
      next();
    });
  }
  app.post("/stops/bulk-delete", requireBulkStopDeleteAccess, (req, res) => {
    res.status(200).json({ organizationId: req.user!.organizationId });
  });
  app.post("/stops/bulk-archive", requireBulkStopDeleteAccess, (req, res) => {
    res.status(200).json({ organizationId: req.user!.organizationId });
  });
  return app;
}

async function requestApp(app: Express, path = "/stops/bulk-delete"): Promise<Response> {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: "00000000-0000-0000-0000-000000000999",
        stopIds: ["00000000-0000-0000-0000-000000000020"],
      }),
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("bulk deletion requires an authenticated admin or dispatcher", async () => {
  assert.equal((await requestApp(appFor())).status, 401);
  assert.equal((await requestApp(appFor("viewer"))).status, 403);
  assert.equal((await requestApp(appFor("driver"))).status, 403);
  assert.equal((await requestApp(appFor("dispatcher"))).status, 200);
  assert.equal((await requestApp(appFor("admin"))).status, 200);
});

test("bulk archive has the same authenticated admin or dispatcher boundary", async () => {
  assert.equal((await requestApp(appFor(), "/stops/bulk-archive")).status, 401);
  assert.equal((await requestApp(appFor("viewer"), "/stops/bulk-archive")).status, 403);
  assert.equal((await requestApp(appFor("driver"), "/stops/bulk-archive")).status, 403);
  assert.equal((await requestApp(appFor("dispatcher"), "/stops/bulk-archive")).status, 200);
  assert.equal((await requestApp(appFor("admin"), "/stops/bulk-archive")).status, 200);
});

test("bulk deletion scope comes from the authenticated user", async () => {
  const response = await requestApp(appFor("admin"));
  const body = await response.json() as { organizationId: string };
  assert.equal(body.organizationId, baseUser.organizationId);
});

test("bulk deletion contract accepts the 574-stop operational batch", () => {
  const stopIds = Array.from(
    { length: 574 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  );

  const parsed = BulkDeleteStopsBody.parse({ stopIds });
  assert.equal(parsed.stopIds.length, 574);
});