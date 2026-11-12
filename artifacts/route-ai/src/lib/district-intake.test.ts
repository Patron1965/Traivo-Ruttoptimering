import test from "node:test";
import assert from "node:assert/strict";
import { intakeBalanced, intakeMappingValid, type Intake } from "./district-intake.ts";

test("address-only intake mapping accepts missing coordinates but not aliased fields", () => {
  const mapping = { objectNumber: "Objekt", address: "Adress", latitude: "", longitude: "", postalCode: "", city: "" };
  assert.equal(intakeMappingValid(mapping), true);
  assert.equal(intakeMappingValid({ ...mapping, address: "Objekt" }), false);
  assert.equal(intakeMappingValid({ ...mapping, objectNumber: "" }), false);
  assert.equal(intakeMappingValid({ ...mapping, city: "Adress" }), false);
});

test("source reconciliation counts unresolved and rejected, and detects truncation", () => {
  const intake: Intake = { revision: 1, total: 8660, ready: 6506, unresolved: 2154, rejected: 0,
    rows: Array.from({ length: 8660 }, (_, i) => ({ sourceRowNumber: i + 2, original: {}, objectNumber: String(i), address: "", status: i < 6506 ? "ready" : "unresolved", reason: "" })) };
  assert.equal(intakeBalanced(intake), true);
  assert.equal(intakeBalanced({ ...intake, rows: intake.rows.slice(0, 6644) }), false);
  assert.equal(intakeBalanced({ ...intake, total: 6644 }), false);
});