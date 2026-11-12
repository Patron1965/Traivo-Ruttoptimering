import { test } from "node:test";
import assert from "node:assert/strict";
import { activeResourcePairs, onlyAuthorizedSoftConflicts, resourceConfirmation, resourceReviewRequest, resourceReviewError } from "./route-resource-review.ts";

test("resource options include only actual active linked pairs", () => {
  const vehicles = [{ id: "v1", isActive: true }, { id: "v2", isActive: false }];
  const drivers = [{ id: "d1", vehicleId: "v1", isActive: true }, { id: "d2", vehicleId: "v2", isActive: true },
    { id: "d3", vehicleId: "missing", isActive: true }, { id: "d4", vehicleId: "v1", isActive: false }];
  assert.deepEqual(activeResourcePairs(vehicles as any, drivers as any).map(pair => pair.value), ["v1:d1"]);
});
test("immutable exact request plus reviewed digest, soft consent never admits hard/unknown", () => {
  const request = resourceReviewRequest("route", 4, "vehicle:driver", true)!;
  assert.ok(Object.isFrozen(request));
  const result = { canChange: true, previewDigest: "reviewed", conflicts: ["CAPACITY"] } as any;
  assert.equal(resourceConfirmation(request, result, false), null);
  assert.deepEqual(resourceConfirmation(request, result, true), { ...request, expectedPreviewDigest: "reviewed" });
  for (const code of ["RANGE", "TIME_WINDOW", "NEW_UNKNOWN_CODE"]) {
    assert.equal(onlyAuthorizedSoftConflicts([code]), false);
    assert.equal(resourceConfirmation(request, { ...result, conflicts: [code] }, true), null);
  }
  assert.equal(resourceConfirmation({ ...request, force: false }, result, true), null);
});
test("business rejection is explicit, arbitrary transport stack is not surfaced", () => {
  assert.equal(resourceReviewError({ data: { error: "Ruttens resurser är frysta. Lås upp först." } }),
    "Ruttens resurser är frysta. Lås upp först.");
  assert.doesNotMatch(resourceReviewError(new Error("internal stack /secret/path")), /secret|stack/);
});
