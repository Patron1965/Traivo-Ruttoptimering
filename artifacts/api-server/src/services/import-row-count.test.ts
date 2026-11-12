import assert from "node:assert/strict";
import test from "node:test";
import {
  assertImportRowCount,
  ImportRowCountMismatchError,
  validateImportStopCoordinates,
} from "./stop-service";

test("accepts a batch only when expected and received row counts match", () => {
  assert.doesNotThrow(() => assertImportRowCount(247, 247));
  assert.throws(
    () => assertImportRowCount(247, 246),
    (error) => {
      assert.ok(error instanceof ImportRowCountMismatchError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /No rows were saved/);
      return true;
    },
  );
});

test("rejects invalid delivery and pickup coordinate pairs before persistence", () => {
  assert.deepEqual(validateImportStopCoordinates({
    latitude: 59.33,
    longitude: 18.07,
  }), []);
  assert.deepEqual(validateImportStopCoordinates({
    latitude: 999,
    longitude: 18.07,
    pickupAddress: "Terminalen",
    pickupLatitude: 59.3,
    pickupLongitude: 999,
  }), [
    "Leveransadressen saknar ett giltigt koordinatpar.",
    "Pickupadressen saknar ett giltigt koordinatpar.",
  ]);
});