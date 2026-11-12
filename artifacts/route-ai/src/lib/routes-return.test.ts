import test from "node:test";
import assert from "node:assert/strict";
import { carryRoutesReturnTo, readRoutesReturnTo, sanitizeRoutesReturnTo } from "./routes-return.ts";

test("accepts only local /routes with validated filters", () => {
  assert.equal(sanitizeRoutesReturnTo("/routes?q=Solna&status=all&date=2025-03-04&x=1"), "/routes?q=Solna&status=all&date=2025-03-04");
  assert.equal(sanitizeRoutesReturnTo("/routes"), "/routes");
  assert.equal(sanitizeRoutesReturnTo("/routes?status=evil&date=bad"), "/routes");
  for (const bad of ["https://evil.example/routes", "//evil.example/routes", "/routes/../admin", "/routesx", "/\\evil", "javascript:alert(1)", "/dispatch", null, ""]) {
    assert.equal(sanitizeRoutesReturnTo(bad), null, String(bad));
  }
});

test("returnTo survives rebuilt dispatch params", () => {
  const search = "?view=traffic&routeId=r1&returnTo=%2Froutes%3Fstatus%3Dall";
  assert.equal(readRoutesReturnTo(search), "/routes?status=all");
  const next = carryRoutesReturnTo(new URLSearchParams({ view: "live", planId: "p" }), search);
  assert.equal(next.get("returnTo"), "/routes?status=all");
  assert.equal(carryRoutesReturnTo(new URLSearchParams({ returnTo: "https://x" }), "?returnTo=https://x").get("returnTo"), null);
});
