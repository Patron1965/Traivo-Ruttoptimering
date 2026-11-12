import assert from "node:assert/strict";
import test from "node:test";
import { resolveImportedServiceDuration } from "./stop-service";
import { serviceDurationsForReoptimization } from "./import-route-workflow";

test("matched service duration overrides the organization default", () => {
  assert.equal(resolveImportedServiceDuration(12, 5), 12);
  assert.equal(resolveImportedServiceDuration(0, 5), 0);
});

test("organization default applies when service duration is not matched", () => {
  assert.equal(resolveImportedServiceDuration(undefined, 7), 7);
  assert.equal(resolveImportedServiceDuration(null, 7), 7);
});

test("system fallback is used only when neither value exists", () => {
  assert.equal(resolveImportedServiceDuration(undefined, undefined), 5);
});

test("reoptimization preserves individually matched service durations", () => {
  assert.deepEqual(
    serviceDurationsForReoptimization([5, 5, 12, 5], 8, "preserve_individual"),
    [8, 8, 12, 8],
  );
});

test("reoptimization can explicitly replace every service duration", () => {
  assert.deepEqual(
    serviceDurationsForReoptimization([5, 5, 12, 5], 8, "replace_all"),
    [8, 8, 8, 8],
  );
});