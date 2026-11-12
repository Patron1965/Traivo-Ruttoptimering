import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, organizationsTable, usersTable, stopsTable, deliveryProofsTable } from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import router from "./org-settings";
import { outgoingDriverReads } from "../middleware/outgoing-driver-reads";
import { withStopProofTypes } from "../services/stop-proof-summary";

test("report categories accept historical IDs and are tenant-scoped, admin-only and revision protected; proof summaries do not leak files", async () => {
  const category = `${randomUUID().slice(0, 14)}0000-0000-${randomUUID().slice(-12)}`;
  const org = randomUUID(), foreignOrg = randomUUID(), user = randomUUID();
  const stop = randomUUID(), foreignStop = randomUUID();
  let principal = { id: user, organizationId: org, role: "admin", name: "Test", email: `${user}@fixture.invalid` } as AuthUser;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = principal; next(); });
  app.use(outgoingDriverReads);
  app.use(router);
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/org/report-categories`;
  const put = (body: unknown) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await db.insert(organizationsTable).values([
      { id: org, name: "Reporting test", email: `${org}@fixture.invalid` },
      { id: foreignOrg, name: "Other reporting test", email: `${foreignOrg}@fixture.invalid` },
    ]);
    await db.insert(usersTable).values({ id: user, organizationId: org, name: "Test", email: `${user}@fixture.invalid`, role: "admin" });
    await db.insert(stopsTable).values([
      { id: stop, organizationId: org, address: "Synthetic", latitude: 59, longitude: 18, executionComment: "Original category label" },
      { id: foreignStop, organizationId: foreignOrg, address: "Other synthetic", latitude: 59, longitude: 18 },
    ]);
    assert.deepEqual(await (await fetch(url)).json(), { revision: 0, categories: [] });
    const categories = [{ id: category, label: "Specialavvikelse", active: true }];
    let response = await put({ revision: 0, categories });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { revision: 1, categories });
    assert.equal((await put({ revision: 0, categories })).status, 409);
    assert.equal((await put({ revision: 1, categories: [] })).status, 400);
    principal = { ...principal, role: "dispatcher" };
    assert.equal((await put({ revision: 1, categories })).status, 403);
    principal = { ...principal, role: "driver", driverProfileId: randomUUID() };
    assert.equal((await fetch(url)).status, 200);
    principal = { ...principal, role: "admin", organizationId: foreignOrg };
    assert.deepEqual(await (await fetch(`${url}?organizationId=${org}`)).json(), { revision: 0, categories: [] });
    principal = { ...principal, organizationId: org };
    response = await put({ revision: 1, categories: [{ ...categories[0], label: "Renamed", active: false }] });
    assert.equal(response.status, 200);
    const [unchanged] = await db.select().from(stopsTable).where(eq(stopsTable.id, stop));
    assert.equal(unchanged.executionComment, "Original category label");

    await db.insert(deliveryProofsTable).values([
      { stopId: stop, proofType: "photo", data: "synthetic evidence" },
      { stopId: stop, proofType: "photo", data: "synthetic second evidence" },
      { stopId: stop, proofType: "signature", data: "synthetic signature" },
      { stopId: foreignStop, proofType: "photo", data: "not visible in this tenant" },
    ]);
    const summaries = await withStopProofTypes([{ id: stop }, { id: foreignStop }], org, "dispatcher");
    assert.deepEqual(summaries, [{ id: stop, proofTypes: ["photo", "signature"] }, { id: foreignStop, proofTypes: [] }]);
    assert.deepEqual(await withStopProofTypes([{ id: stop }], org, "viewer"), [{ id: stop, proofTypes: [] }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(deliveryProofsTable).where(inArray(deliveryProofsTable.stopId, [stop, foreignStop]));
    await db.delete(stopsTable).where(inArray(stopsTable.id, [stop, foreignStop]));
    await db.delete(usersTable).where(eq(usersTable.id, user));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, [org, foreignOrg]));
  }
});
