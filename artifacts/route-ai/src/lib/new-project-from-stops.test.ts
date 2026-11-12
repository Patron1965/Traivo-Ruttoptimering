import assert from "node:assert/strict";
import test from "node:test";
import { newProjectBlockReason } from "./new-project-from-stops";

const stops = [{ routeId: "route", status: "pending" as const }];
const route = { id: "route", name: "Test", status: "optimized" as const, sentAt: null, handoffStatus: "pending" as const };

test("unsent route and unassigned pending stops allow another resource", () => {
  assert.equal(newProjectBlockReason(stops, [route]), null);
  assert.equal(newProjectBlockReason([{ routeId: null, status: "pending" }], []), null);
});
test("sent timestamp and handoff each block extraction even for optimized routes", () => {
  assert.match(newProjectBlockReason(stops, [{ ...route, sentAt: "2026-11-03T08:00:00Z" }])!, /har redan skickats/);
  assert.match(newProjectBlockReason(stops, [{ ...route, handoffStatus: "accepted" }])!, /har redan skickats/);
});
test("missing route and in-progress route fail closed with specific reasons", () => {
  assert.match(newProjectBlockReason(stops, [])!, /kunde inte hämtas/);
  assert.match(newProjectBlockReason(stops, [{ ...route, status: "in_progress" }])!, /påbörjad/);
  assert.match(newProjectBlockReason([{ routeId: "route", status: "completed" }], [route])!, /Endast väntande/);
});
