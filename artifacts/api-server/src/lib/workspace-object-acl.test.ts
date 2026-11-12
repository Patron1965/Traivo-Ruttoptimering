import assert from "node:assert/strict";
import { test } from "node:test";
import type { File } from "@google-cloud/storage";
import { canAccessObject, ObjectAccessGroupType, ObjectPermission } from "./objectAcl";

test("verified workspace grants only the selected organization ACL, never actor ownership in another company", async () => {
  const file = { getMetadata: async () => [{
    metadata: { "custom:aclPolicy": JSON.stringify({
      owner: "same-superuser",
      visibility: "private",
      aclRules: [{ group: { type: ObjectAccessGroupType.ORG_MEMBERS, id: "customer-a" }, permission: ObjectPermission.READ }],
    }) },
  }] } as unknown as File;
  const base = { userId: "same-superuser", objectFile: file, requestedPermission: ObjectPermission.READ };
  assert.equal(await canAccessObject({ ...base, workspaceOrganizationId: "customer-a" }), true);
  assert.equal(await canAccessObject({ ...base, workspaceOrganizationId: "customer-b" }), false);
  assert.equal(await canAccessObject({ ...base, authenticatedOrganizationId: "home-organization" }), false);
  assert.equal(await canAccessObject({ ...base, workspaceOrganizationId: "customer-a", requestedPermission: ObjectPermission.WRITE }), false);
});