import assert from "node:assert/strict";
import test from "node:test";
import { mergeHandoffResponse } from "./handoff-cache.ts";

const route = (handoffStatus: "received" | "opened" | "accepted" | "rejected", version = 2) =>
  ({ id: "route", planRevision: version, handoffVersion: version, handoffStatus });

test("late automatic responses cannot revoke either terminal driver decision", () => {
  for (const decision of ["accepted", "rejected"] as const) {
    const current = route(decision);
    for (const incoming of ["received", "opened", "accepted", "rejected"] as const) {
      if (incoming !== decision) assert.equal(mergeHandoffResponse(current, route(incoming)), current);
    }
  }
});

test("older versions cannot replace new redispatch, but new versions permit fresh decisions", () => {
  const current = route("received");
  assert.equal(mergeHandoffResponse(current, route("accepted", 1)), current);
  const redispatch = route("received", 3);
  assert.equal(mergeHandoffResponse(route("accepted"), redispatch), redispatch);
  const accepted = route("accepted");
  assert.equal(mergeHandoffResponse(current, accepted), accepted);
  assert.equal(mergeHandoffResponse(accepted, { ...accepted, planRevision: 1 }), accepted);
});
