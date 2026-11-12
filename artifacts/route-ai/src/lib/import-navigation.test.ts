import assert from "node:assert/strict";
import test from "node:test";
import { resolveImportResumeStep } from "./import-navigation.ts";

test("retained post-resource step without a server plan returns to resource selection", () => {
  assert.equal(resolveImportResumeStep(6, null, true), 5);
  assert.equal(resolveImportResumeStep(7, undefined, true), 5);
});

test("missing-plan recovery does not hide a prior server plan failure", () => {
  assert.equal(resolveImportResumeStep(6, "plan-1", true), 6);
  assert.equal(resolveImportResumeStep(6, null, false), 6);
});