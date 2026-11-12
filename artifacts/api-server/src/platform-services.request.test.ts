import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, pool, organizationsTable, auditLogTable } from "@workspace/db";
import router from "./routes/platform-services";

const ids = [randomUUID(), randomUUID(), randomUUID()];
let server: Server;
let base: string;
const policy = {
  roadProvider: "disabled", geocodingProvider: "nominatim", smsProvider: "disabled",
  emailEnabled: false, aiEnabled: false, cuoptEnabled: false, districtEnabled: false,
};
before(async () => {
  await db.insert(organizationsTable).values(ids.map(id => ({
    id, name: "Synthetic service policy test", email: `services-${id}@example.invalid`,
  })));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header("X-Test-Role")) (req as typeof req & { user: object }).user = {
      id: randomUUID(), organizationId: ids[0], role: "admin",
      name: "Synthetic service admin", email: "services@example.invalid", driverProfileId: null,
      isPlatformAdmin: req.header("X-Test-Role") === "platform",
    };
    next();
  });
  app.use("/api", router);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}/api/platform/organizations`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, ids));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, ids));
  await pool.end();
});
async function request(id: string, role = "platform", body?: unknown) {
  return fetch(`${base}/${id}/services`, {
    method: body ? "PUT" : "GET",
    headers: { ...(role ? { "X-Test-Role": role } : {}), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test("only platform administrators may read or change customer service permissions", async () => {
  assert.equal((await request(ids[0], "")).status, 401);
  assert.equal((await request(ids[0], "tenant")).status, 403);
  assert.equal((await request(ids[0], "tenant", { revision: 0, policy })).status, 403);
});
test("inheritance, persistence, tenant isolation, conflicts and audit are real database backed", async () => {
  const initial = await request(ids[0]);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const initialBody = await initial.json() as { revision: number; policy: typeof policy };
  assert.equal(initialBody.revision, 0);
  assert.equal(initialBody.policy.roadProvider, "inherit");
  assert.equal((await request(ids[0], "platform", { revision: 0, policy })).status, 200);
  const saved = await (await request(ids[0])).json() as { revision: number; policy: typeof policy };
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.policy, { ...policy, preferredLoginService: "password" });
  const other = await (await request(ids[1])).json() as { revision: number; policy: typeof policy };
  assert.equal(other.revision, 0);
  assert.equal(other.policy.aiEnabled, true);
  assert.equal((await request(ids[0], "platform", { revision: 0, policy })).status, 409);
  const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.organizationId, ids[0]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "platform.organization.services.update");
});
test("concurrent first saves serialize and invalid/foreign fields never persist", async () => {
  const responses = await Promise.all([request(ids[1], "platform", { revision: 0, policy }),
    request(ids[1], "platform", { revision: 0, policy })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal((await request(ids[1], "platform", { revision: 1, policy: { ...policy, secret: "not-allowed" } })).status, 400);
  assert.equal((await request(randomUUID())).status, 404);
});

test("LINK can be saved with Common API credentials and no obsolete MyLINK token", async () => {
  const keys = ["LINK_USERNAME", "LINK_PASSWORD", "LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID", "LINK_GATE_ID",
    "LINK_MOBILITY_SENDER", "LINK_MOBILITY_API_TOKEN"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys.slice(0, 5)) process.env[key] = "synthetic";
    process.env.LINK_MOBILITY_SENDER = "Traivo";
    delete process.env.LINK_MOBILITY_API_TOKEN;
    const linkPolicy = { ...policy, smsProvider: "linkmobility" };
    const response = await request(ids[2], "platform", { revision: 0, policy: linkPolicy });
    assert.equal(response.status, 200);
    const saved = await (await request(ids[2])).json() as { policy: typeof policy };
    assert.equal(saved.policy.smsProvider, "linkmobility");
    delete process.env.LINK_GATE_ID;
    assert.equal((await request(ids[2], "platform", { revision: 1, policy: linkPolicy })).status, 400);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});
