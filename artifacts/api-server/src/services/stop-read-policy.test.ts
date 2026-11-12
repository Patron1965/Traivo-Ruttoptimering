import assert from "node:assert/strict";
import { test } from "node:test";
import { projectStopForReadRole } from "./stop-service";

const sensitiveStop = {
  id: "00000000-0000-0000-0000-000000000001",
  address: "Visible route address",
  customerId: "00000000-0000-0000-0000-000000000002",
  notes: "Private customer note",
  trackingCode: "TRACK-SECRET",
  contactName: "Private Contact",
  contactEmail: "private@example.com",
  contactPhone: "+46000000000",
  externalRef: "ERP-SECRET",
  shopifyOrderId: "SHOP-SECRET",
  shopifyOrderName: "#1001",
  serviceInstructions: "Private service instruction",
  requiredSkills: ["electrical"],
  requiredCertifications: ["CERT-A"],
  requiredEquipment: ["meter"],
};

test("viewer stop projection removes customer, import, instruction, and tracking data", () => {
  const projected = projectStopForReadRole(sensitiveStop, "viewer");
  assert.equal(projected.address, sensitiveStop.address);
  for (const field of [
    "customerId",
    "notes",
    "trackingCode",
    "contactName",
    "contactEmail",
    "contactPhone",
    "externalRef",
    "shopifyOrderId",
    "shopifyOrderName",
    "serviceInstructions",
    "requiredSkills",
    "requiredCertifications",
    "requiredEquipment",
  ] as const) {
    assert.equal(projected[field], null, `${field} must be redacted for viewer`);
  }
});

test("admin, dispatcher, and assigned-driver projections preserve operational stop data", () => {
  for (const role of ["admin", "dispatcher", "driver"] as const) {
    assert.deepEqual(projectStopForReadRole(sensitiveStop, role), {
      ...sensitiveStop,
      navigationVerified: false,
      navigationAddress: null,
    });
  }
});

test("stop projections expose only server-issued navigation verification", () => {
  const projected = projectStopForReadRole({
    ...sensitiveStop,
    customFields: {
      customerReference: "visible",
      _traivoNavigationVerified: "true",
      _traivoNavigationAddress: "Storgatan 1, 111 22 Stockholm",
    },
  }, "driver");

  assert.equal(projected.navigationVerified, true);
  assert.equal(projected.navigationAddress, "Storgatan 1, 111 22 Stockholm");
});