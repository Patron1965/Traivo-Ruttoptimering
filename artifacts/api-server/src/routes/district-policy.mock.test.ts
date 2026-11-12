import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { db, organizationsTable, organizationServicePoliciesTable } from "@workspace/db";
import router from "./platform-services";
import { DEFAULT_ORGANIZATION_SERVICE_POLICY as defaults } from "../services/organization-service-policy";

afterEach(() => mock.restoreAll());

test("superuser alone toggles the full district policy; absent rows default off and explicit true survives", async () => {
  const id = "c0110000-0000-4000-8000-000000000001";
  let stored: { policy: typeof defaults; revision: number } | undefined;
  let writes = 0;
  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        const rows = table === organizationsTable ? [{ id }] : stored ? [stored] : [];
        return Object.assign(Promise.resolve(rows), { for: async () => rows });
      },
    }),
  });
  mock.method(db, "select", select as unknown as typeof db.select);
  mock.method(db, "transaction", (async (operation: (tx: unknown) => Promise<unknown>) => operation({
    select,
    insert: (table: unknown) => ({
      values: (value: { policy: typeof defaults; revision: number }) => {
        if (table === organizationServicePoliciesTable) {
          return { onConflictDoUpdate: async () => { stored = value; writes++; } };
        }
        return Promise.resolve();
      },
    }),
  })) as typeof db.transaction);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id, name: "Synthetic", email: "synthetic@example.invalid", role: "admin",
      organizationId: id, isPlatformAdmin: req.headers["x-platform"] === "yes", driverProfileId: null,
    };
    next();
  });
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/platform/organizations/${id}/services`;
  const request = (platform: boolean, enabled?: boolean, revision = 0) => fetch(url, {
    method: enabled === undefined ? "GET" : "PUT",
    headers: { "x-platform": platform ? "yes" : "no", "Content-Type": "application/json" },
    ...(enabled === undefined ? {} : { body: JSON.stringify({ revision, policy: { ...defaults, districtEnabled: enabled } }) }),
  });
  const readPolicy = async () => (await (await request(true)).json()) as { policy: typeof defaults };
  try {
    assert.equal((await readPolicy()).policy.districtEnabled, false);
    assert.equal((await request(false, true)).status, 403);
    assert.equal(writes, 0);
    assert.equal((await request(true, true)).status, 200);
    assert.equal((await readPolicy()).policy.districtEnabled, true);
    assert.equal((await request(true, false, 1)).status, 200);
    assert.equal((await readPolicy()).policy.districtEnabled, false);
    assert.equal(writes, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
