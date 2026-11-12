import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultImportInfoVisibility, toggleImportInfo, isAlwaysVisibleCount, isStatusChainPartVisible, IMPORT_INFO_LABELS,
} from "./import-info-disclosure.ts";

test("all categories collapsed by default", () => {
  assert.deepEqual(Object.values(defaultImportInfoVisibility()), [false, false, false, false]);
  assert.deepEqual(Object.values(IMPORT_INFO_LABELS), ["Planöversikt", "Importstatistik", "Planeringsgränser", "Hjälptexter"]);
});

test("categories toggle independently", () => {
  const s = toggleImportInfo(defaultImportInfoVisibility(), "limits");
  assert.equal(s.limits, true);
  assert.equal(s.help, false);
  assert.equal(toggleImportInfo(s, "limits").limits, false);
  assert.equal(toggleImportInfo(s, "limits", true).limits, true);
});

test("action-requiring counts are never hidden", () => {
  assert.equal(isAlwaysVisibleCount("action", 3), true);
  assert.equal(isAlwaysVisibleCount("rejected", 1), true);
  assert.equal(isAlwaysVisibleCount("action", 0), false);
  assert.equal(isAlwaysVisibleCount("read", 10), false);
});

test("status chain keeps status, next action, blockers and errors visible", () => {
  for (const part of ["status", "nextAction", "blockers", "error", "loading"] as const) {
    assert.equal(isStatusChainPartVisible(part, false), true);
  }
  for (const part of ["context", "lifecycle", "steps", "revision"] as const) {
    assert.equal(isStatusChainPartVisible(part, false), false);
    assert.equal(isStatusChainPartVisible(part, true), true);
  }
});
