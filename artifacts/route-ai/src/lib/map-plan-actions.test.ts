import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMapPlanTarget, resourceEditBlockReason } from "./map-plan-actions.ts";

const a = { id: "a", planId: "plan", status: "optimized" };
const b = { id: "b", planId: "plan", status: "optimized" };
const other = { id: "other", planId: "other-plan", status: "optimized" };
const cancelled = { id: "cancelled", planId: "plan", status: "cancelled" };
const all = [a, b, other, cancelled];
test("resource editing explains sent, draft and missing depot states", () => {
  assert.equal(resourceEditBlockReason([a], true), null);
  assert.match(resourceEditBlockReason([{ status: "dispatched" }], true)!, /skickad/);
  assert.match(resourceEditBlockReason([{ status: "optimized", sentAt: "2026-11-02" }], true)!, /skickad/);
  assert.match(resourceEditBlockReason([{ status: "draft" }], true)!, /utkastet/);
  assert.match(resourceEditBlockReason([a], false)!, /Depån saknas/);
  assert.match(resourceEditBlockReason([], true)!, /arbetsplan/);
});
test("one visible route resolves the complete plan, not only its visible routes", () => {
  assert.deepEqual(resolveMapPlanTarget([a], new Set(), all), { route: a, planRoutes: [a, b] });
});
test("multiple selected routes never implicitly target the first", () => {
  assert.equal(resolveMapPlanTarget([a, b], new Set(["a", "b"]), all).route, undefined);
  assert.equal(resolveMapPlanTarget([a, b], new Set(), all).route, undefined);
});
test("a stale selection from another scope cannot become a write target", () => {
  assert.equal(resolveMapPlanTarget([a], new Set(["other"]), all).route, undefined);
});
test("explicit selection resolves exactly that plan", () => {
  assert.deepEqual(resolveMapPlanTarget([a, other], new Set(["other"]), all).planRoutes, [other]);
});
