import assert from "node:assert/strict";
import test from "node:test";
import type { Driver, ImportRoutePlanApprovalResult, Route } from "@workspace/api-client-react";
import { dispatchRouteDriverNames } from "./dispatch-route-drivers.ts";

const route = { id: "r", organizationId: "org", planId: "p", draftId: "draft", vehicleId: "v", planRevision: 2, handoffDriverId: "new" } as Route;
const drivers = [
  { id: "original", name: "Original driver", vehicleId: "v", organizationId: "org", isActive: true },
  { id: "new", name: "Replacement driver", vehicleId: "v", organizationId: "org", isActive: true },
] as Driver[];
const evidence = {
  planId: "p", protected: true,
  routes: [{ routeId: "r", planId: "p", draftId: "draft", vehicleId: "v", planRevision: 2, driverId: "original" }],
} as ImportRoutePlanApprovalResult;

test("protected routes use exact snapshot-based evidence, not handoff or first current vehicle driver", () => {
  assert.equal(dispatchRouteDriverNames([route], [...drivers].reverse(), evidence).get("r"), "Original driver");
  assert.equal(dispatchRouteDriverNames([route], [drivers[1]], evidence).size, 0);
  assert.equal(dispatchRouteDriverNames([route], drivers).size, 0);
});

test("missing, stale and cross-plan evidence cannot prove protected recipient", () => {
  for (const changed of [
    { ...evidence, protected: false },
    { ...evidence, planId: "other" },
    { ...evidence, routes: [{ ...evidence.routes[0], planRevision: 1 }] },
    { ...evidence, routes: [{ ...evidence.routes[0], vehicleId: "other" }] },
    { ...evidence, routes: [{ ...evidence.routes[0], draftId: "other" }] },
    { ...evidence, routes: [{ ...evidence.routes[0], driverId: null }] },
  ]) assert.equal(dispatchRouteDriverNames([route], drivers, changed).size, 0);
});

test("nonprotected routes honor handoff; unknown hidden snapshots never fall back to vehicle driver", () => {
  const legacy = { ...route, draftId: null };
  assert.equal(dispatchRouteDriverNames([legacy], drivers).get("r"), "Replacement driver");
  assert.equal(dispatchRouteDriverNames([{ ...legacy, handoffDriverId: null }], [drivers[0]]).size, 0);
  for (const changed of [
    { ...drivers[1], vehicleId: "other" },
    { ...drivers[1], organizationId: "other" },
    { ...drivers[1], isActive: false },
  ]) assert.equal(dispatchRouteDriverNames([legacy], [changed]).size, 0);
});
