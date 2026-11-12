import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIELD_SERVICE_ASSIGNMENT_ERROR,
  FieldServiceAssignmentError,
} from "./field-service";

test("field-service assignment errors do not expose requirement values", () => {
  const secretSkill = "skill-private-123";
  const secretEquipment = "equipment-private-456";
  const error = new FieldServiceAssignmentError(FIELD_SERVICE_ASSIGNMENT_ERROR);
  assert.equal(error.statusCode, 409);
  assert.doesNotMatch(error.message, new RegExp(secretSkill));
  assert.doesNotMatch(error.message, new RegExp(secretEquipment));
  assert.equal(
    error.message,
    "Field service requirements are not met for the assigned vehicle and technician",
  );
});