import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { requireDistrictEntitlement } from "./district-entitlement";
import { requirePlatformAdmin } from "./auth";
import { DEFAULT_ORGANIZATION_SERVICE_POLICY as defaults } from "../services/organization-service-policy";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

afterEach(() => mock.restoreAll());

async function check(policy: boolean | null | "unavailable", role = "viewer", platform = false) {
  let status = 200;
  let nextCalls = 0;
  let reads = 0;
  mock.method(db, "select", () => {
    reads++;
    if (policy === "unavailable") throw new Error("offline");
    return { from: () => ({ where: (condition: SQL) => {
      assert.deepEqual(new PgDialect().sqlToQuery(condition).params, ["tenant-a"]);
      return { limit: async () => policy === null ? [] : [
      { policy: { ...defaults, districtEnabled: policy } },
    ] }; } }) } as unknown as ReturnType<typeof db.select>;
  });
  const req = {
    user: { id: "user-a", organizationId: "tenant-a", role, isPlatformAdmin: platform },
    query: { organizationId: "enabled-tenant" }, body: { organizationId: "enabled-tenant" },
  } as unknown as Request;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  await requireDistrictEntitlement(req, res, () => { nextCalls++; });
  return { status, nextCalls, reads };
}

for (const role of ["viewer", "dispatcher", "admin"]) {
  for (const enabled of [false, null, true] as const) {
    test(`${role}: district assignment ${String(enabled)} enforced before handlers`, async () => {
      const result = await check(enabled, role);
      assert.equal(result.status, enabled === true ? 200 : 403);
      assert.equal(result.nextCalls, enabled === true ? 1 : 0);
      assert.equal(result.reads, 1);
    });
  }
}
test("platform privileges do not bypass tenant entitlement", async () => {
  assert.equal((await check(false, "admin", true)).status, 403);
});
test("failed policy reads fail closed", async () => {
  const result = await check("unavailable");
  assert.equal(result.status, 503);
  assert.equal(result.nextCalls, 0);
});
test("only platform administrators may administer assignments", () => {
  for (const platform of [false, true]) {
    let status = 200, calls = 0;
    requirePlatformAdmin()(
      { user: { role: "admin", isPlatformAdmin: platform } } as Request,
      { status(code: number) { status = code; return this; }, json() {} } as unknown as Response,
      () => { calls++; },
    );
    assert.equal(status, platform ? 200 : 403);
    assert.equal(calls, platform ? 1 : 0);
  }
});
test("all district and intake endpoints are mounted after the shared gate", () => {
  for (const filename of ["district.ts", "district-intake.ts"]) {
    const source = readFileSync(new URL(`../routes/${filename}`, import.meta.url), "utf8");
    const gate = source.indexOf('requireDistrictEntitlement);');
    assert.ok(gate > 0);
    const routes = [...source.matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)];
    assert.ok(routes.length > 0);
    for (const route of routes) {
      assert.ok(route.index! > gate);
      assert.match(route[2], /^\/district-(plans|intake)(\/|$)/);
    }
  }
});
