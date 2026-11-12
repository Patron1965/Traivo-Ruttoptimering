import assert from "node:assert/strict";
import test from "node:test";
import { stopTileText } from "./stop-tile-contrast.ts";
import { getContrastRatio } from "./theme-utils.ts";

test("orange and light vehicle colours get dark numbers with at least 4.5:1", () => {
  for (const hex of ["#f59e0b", "#f97316", "#e8a33d", "#facc15", "#a3e635", "#7dd3fc"]) {
    const { color, textShadow } = stopTileText(hex);
    assert.equal(color, "#020617", hex);
    assert.equal(textShadow, "none");
    assert.ok(getContrastRatio(hex, color) >= 4.5, hex);
  }
});

test("dark vehicle colours keep white numbers with at least 4.5:1", () => {
  for (const hex of ["#1d4ed8", "#7c3aed", "#0f766e", "#b91c1c", "#334155"]) {
    const { color } = stopTileText(hex);
    assert.equal(color, "#ffffff", hex);
    assert.ok(getContrastRatio(hex, color) >= 4.5, hex);
  }
});

test("chosen colour is always the higher-contrast option", () => {
  for (const hex of ["#10b981", "#ef4444", "#3b82f6", "#ec4899", "#808080"]) {
    const { color } = stopTileText(hex);
    const other = color === "#ffffff" ? "#020617" : "#ffffff";
    assert.ok(getContrastRatio(hex, color) >= getContrastRatio(hex, other), hex);
  }
});

test("invalid colours fall back to white", () => {
  assert.equal(stopTileText("orange").color, "#ffffff");
  assert.equal(stopTileText("#fff").color, "#ffffff");
});
