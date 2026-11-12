import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { assertOrgScope, getOrgId, OrgScopeError, type AuthUser } from "./auth";

const sessionOrganizationId = "00000000-0000-0000-0000-000000000001";
const attackerOrganizationId = "00000000-0000-0000-0000-000000000002";

test("getOrgId rejects unauthenticated client-provided organization ids", () => {
  const req = {
    query: { organizationId: attackerOrganizationId },
    body: { organizationId: attackerOrganizationId },
  } as unknown as Request;

  assert.throws(() => getOrgId(req), OrgScopeError);
});

test("getOrgId always uses the authenticated session organization", () => {
  const user: AuthUser = {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Tenant A User",
    email: "tenant-a@example.test",
    role: "dispatcher",
    organizationId: sessionOrganizationId,
    driverProfileId: null,
  };
  const req = {
    user,
    query: { organizationId: attackerOrganizationId },
    body: { organizationId: attackerOrganizationId },
  } as unknown as Request;

  assert.equal(getOrgId(req), sessionOrganizationId);
});

test("assertOrgScope rejects a cross-tenant supplied organization id", () => {
  const req = {
    user: {
      id: "00000000-0000-0000-0000-000000000003",
      name: "Tenant A User",
      email: "tenant-a@example.test",
      role: "dispatcher",
      organizationId: sessionOrganizationId,
      driverProfileId: null,
    } satisfies AuthUser,
  } as unknown as Request;

  assert.throws(
    () => assertOrgScope(req, attackerOrganizationId),
    (err: unknown) => err instanceof OrgScopeError && err.statusCode === 403,
  );
  assert.equal(assertOrgScope(req, sessionOrganizationId), sessionOrganizationId);
});