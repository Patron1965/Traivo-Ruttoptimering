import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { requirePlatformAdmin } from "./middleware/auth";
import platformRoutingRouter from "./routes/platform-routing";

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.header("X-Test-Role");
    if (role) {
      (req as typeof req & { user?: object }).user = {
        id: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000002",
        name: "Test user",
        email: "test@example.invalid",
        role: "admin",
        isPlatformAdmin: role === "platform",
        driverProfileId: null,
      };
    }
    next();
  });
  app.use("/api/platform", requirePlatformAdmin());
  app.use("/api", platformRoutingRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("routing assignment APIs reject public and tenant-admin callers before database access", async () => {
  const orgId = "00000000-0000-4000-8000-000000000002";
  const publicResponse = await fetch(`${base}/platform/routing`);
  assert.equal(publicResponse.status, 401);

  const tenantStatus = await fetch(`${base}/platform/routing`, { headers: { "X-Test-Role": "tenant" } });
  assert.equal(tenantStatus.status, 403);
  const tenantWrite = await fetch(`${base}/platform/organizations/${orgId}/routing`, {
    method: "PUT",
    headers: { "X-Test-Role": "tenant", "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "shared" }),
  });
  assert.equal(tenantWrite.status, 403);
});

test("external service inventory is restricted and exposes only safe configuration evidence", async () => {
  assert.equal((await fetch(`${base}/platform/services`)).status, 401);
  assert.equal((await fetch(`${base}/platform/services`, { headers: { "X-Test-Role": "tenant" } })).status, 403);
  const response = await fetch(`${base}/platform/services`, { headers: { "X-Test-Role": "platform" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const services = await response.json();
  assert.ok(Array.isArray(services));
  assert.ok(services.length >= 12);
  assert.equal(new Set(services.map((service: { id: string }) => service.id)).size, services.length);
  for (const service of services) {
    assert.deepEqual(Object.keys(service).sort(), ["description", "detail", "id", "name", "state"]);
    assert.ok(["enabled", "disabled", "incomplete", "available"].includes(service.state));
    assert.ok(service.description && service.detail);
  }
});