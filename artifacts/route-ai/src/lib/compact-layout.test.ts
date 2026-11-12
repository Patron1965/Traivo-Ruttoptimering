import assert from "node:assert/strict";
import test from "node:test";
import { initialSidebarCollapsed, shouldShowStepError } from "./compact-layout.ts";

test("sidebar collapses by default on 1366 and stays open on wide screens", () => {
  assert.equal(initialSidebarCollapsed(null, 1366), true);
  assert.equal(initialSidebarCollapsed(null, 1440), false);
  assert.equal(initialSidebarCollapsed(null, 1920), false);
});

test("explicit sidebar preference wins over width", () => {
  assert.equal(initialSidebarCollapsed("0", 1366), false);
  assert.equal(initialSidebarCollapsed("1", 1920), true);
});

test("optimization error is shown once when the progress card shows it", () => {
  const msg = "Optimeringen misslyckades";
  assert.equal(shouldShowStepError(msg, { visible: true, status: "error", errorMessage: msg }), false);
  assert.equal(shouldShowStepError(msg, { visible: true, status: "error", errorMessage: ` ${msg} ` }), false);
});

test("distinct or non-card errors still render in the step", () => {
  assert.equal(shouldShowStepError("Annat fel", { visible: true, status: "error", errorMessage: "Fel" }), true);
  assert.equal(shouldShowStepError("Fel", { visible: false, status: "error", errorMessage: "Fel" }), true);
  assert.equal(shouldShowStepError("Fel", { visible: true, status: "running" }), true);
  assert.equal(shouldShowStepError(null, { visible: false, status: "idle" }), false);
});
