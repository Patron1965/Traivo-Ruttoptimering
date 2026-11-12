import test from "node:test";
import assert from "node:assert/strict";
import {
  createDispatchMoveError,
  getDispatchMoveErrorStatus,
  isDispatchMoveRevisionConflict,
  isDispatchMoveUnauthorized,
} from "./dispatch-move-auth.ts";

test("marks a dispatch move session expiry as unauthorized", () => {
  const error = createDispatchMoveError(401, "Unauthorized");

  assert.equal(error.message, "Unauthorized");
  assert.equal(getDispatchMoveErrorStatus(error), 401);
  assert.equal(isDispatchMoveUnauthorized(error), true);
});

test("keeps non-auth dispatch move errors unchanged", () => {
  const error = createDispatchMoveError(409, "Plan changed");

  assert.equal(getDispatchMoveErrorStatus(error), 409);
  assert.equal(isDispatchMoveUnauthorized(error), false);
  assert.equal(isDispatchMoveUnauthorized(new Error("Unauthorized")), false);
});

test("identifies a revision conflict only from its stable response code", () => {
  const conflict = createDispatchMoveError(
    409,
    "One or more routes changed while the move was being saved.",
    { code: "DISPATCH_REVISION_CONFLICT" },
  );

  assert.equal(isDispatchMoveRevisionConflict(conflict), true);
  assert.equal(
    isDispatchMoveRevisionConflict(createDispatchMoveError(409, "Conflict")),
    false,
  );
  assert.equal(
    isDispatchMoveRevisionConflict(
      createDispatchMoveError(400, "Conflict", { code: "DISPATCH_REVISION_CONFLICT" }),
    ),
    false,
  );
});