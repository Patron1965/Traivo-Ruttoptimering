import assert from "node:assert/strict";
import { test } from "node:test";
import { customerLoginSettings, validateLoginPreference, REGION_STOCKHOLM_TENANT_ID } from "./organization-login-preference";

test("only the bound Region Stockholm tenant can request SITHS", () => {
  assert.equal(validateLoginPreference(REGION_STOCKHOLM_TENANT_ID, "siths"), null);
  for (const id of ["another-tenant", "Region Stockholm", "", "region-stockholm"]) {
    assert.ok(validateLoginPreference(id, "siths"));
    assert.equal(customerLoginSettings(id).sithsEligible, false);
  }
});

test("password remains available for every tenant and old policies", () => {
  for (const id of [REGION_STOCKHOLM_TENANT_ID, "another-tenant"]) {
    assert.equal(validateLoginPreference(id, "password"), null);
    assert.equal(validateLoginPreference(id), null);
    assert.equal(customerLoginSettings(id).activeLoginService, "password");
    assert.equal(customerLoginSettings(id).loginConnectionStatus, "active");
  }
});

test("saving a SITHS preference cannot pretend the separate test connection is active", () => {
  assert.deepEqual(customerLoginSettings(REGION_STOCKHOLM_TENANT_ID, "siths"), {
    sithsEligible: true, activeLoginService: "password", loginConnectionStatus: "not_configured",
  });
});
