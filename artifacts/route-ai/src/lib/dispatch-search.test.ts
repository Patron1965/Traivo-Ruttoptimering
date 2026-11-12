import assert from "node:assert/strict";
import test from "node:test";
import {
  filterDispatchSearchScope,
  getEffectiveStopPriority,
  isStopPrioritized,
  searchDispatchItems,
  type DispatchSearchItem,
} from "./dispatch-search.ts";

function item(
  overrides: Partial<DispatchSearchItem> & {
    stop: DispatchSearchItem["stop"];
  },
): DispatchSearchItem {
  return {
    stopId: overrides.stop.id,
    organizationId: "org-1",
    planId: "plan-1",
    routeId: "route-1",
    routeDate: "2026-04-03",
    routeName: "Rutt Norr",
    vehicleName: "Volvo",
    vehicleLicense: "ABC123",
    driverName: "Åsa",
    ...overrides,
  };
}

const items = [
  item({
    stop: {
      id: "stop-1",
      address: "Storgatan 1, 111 22 Stockholm",
      pickupAddress: null,
      contactName: "Åsa Kund",
      notes: "Ring före leverans",
      externalRef: "ORDER-42",
      shopifyOrderName: null,
      trackingCode: "TRACK-1",
      sequenceOrder: 3,
      status: "pending",
      priority: 1,
      serviceInstructions: null,
    },
    effectivePriority: 1,
  }),
  item({
    stopId: "stop-2",
    routeId: null,
    planId: null,
    routeDate: null,
    routeName: null,
    vehicleName: null,
    vehicleLicense: null,
    driverName: null,
    stop: {
      id: "stop-2",
      address: "Hamngatan 5, 222 33 Malmö",
      pickupAddress: null,
      contactName: "Bo Kund",
      notes: "Portkod 1234",
      externalRef: "ORDER-99",
      shopifyOrderName: null,
      trackingCode: null,
      sequenceOrder: null,
      status: "failed",
      priority: 2,
      serviceInstructions: null,
    },
    effectivePriority: 2,
  }),
];

test("searches address/postcode, references, notes, stop id and sequence", () => {
  assert.deepEqual(searchDispatchItems(items, "11122").map((result) => result.stopId), ["stop-1"]);
  assert.deepEqual(searchDispatchItems(items, "order-42").map((result) => result.stopId), ["stop-1"]);
  assert.deepEqual(searchDispatchItems(items, "portkod").map((result) => result.stopId), ["stop-2"]);
  assert.deepEqual(searchDispatchItems(items, "stop-2").map((result) => result.stopId), ["stop-2"]);
  assert.ok(
    searchDispatchItems(items, "3").some(
      (result) => result.stopId === "stop-1" && result.matchedFields.includes("sequence"),
    ),
  );
});

test("searches status, priority, route, registration and driver", () => {
  assert.deepEqual(searchDispatchItems(items, "hög").map((result) => result.stopId), ["stop-1"]);
  assert.deepEqual(searchDispatchItems(items, "måste med").map((result) => result.stopId), ["stop-2"]);
  assert.deepEqual(searchDispatchItems(items, "rutt asa").map((result) => result.stopId), ["stop-1"]);
  assert.deepEqual(searchDispatchItems(items, "abc123").map((result) => result.stopId), ["stop-1"]);
  assert.deepEqual(searchDispatchItems(items, "misslyckad").map((result) => result.stopId), ["stop-2"]);
});

test("scope keeps the selected plan/date tenant and current unassigned stops", () => {
  assert.deepEqual(
    filterDispatchSearchScope(items, {
      organizationId: "org-1",
      planId: "plan-1",
      date: "2026-04-03",
      includeUnassigned: true,
    }).map((result) => result.stopId),
    ["stop-1", "stop-2"],
  );
  assert.deepEqual(
    filterDispatchSearchScope(items, {
      organizationId: "another-tenant",
      includeUnassigned: true,
    }),
    [],
  );
  assert.deepEqual(
    filterDispatchSearchScope(items, {
      planId: "other-plan",
      includeUnassigned: false,
    }).map((result) => result.stopId),
    [],
  );
});

test("effective priority uses persisted plan semantics without a threshold", () => {
  assert.equal(getEffectiveStopPriority({ id: "stop-1", priority: 1 }, { "stop-1": 2 }), 2);
  assert.equal(getEffectiveStopPriority({ id: "stop-1", priority: 1 }, { "stop-1": 1 }), 1);
  assert.equal(getEffectiveStopPriority({ id: "stop-1", priority: 1 }, { "stop-1": 7 }), 1);
  assert.equal(getEffectiveStopPriority({ id: "stop-1", priority: null }), 0);
  assert.equal(isStopPrioritized(0), false);
  assert.equal(isStopPrioritized(1), true);
  assert.equal(isStopPrioritized(2), true);
});
