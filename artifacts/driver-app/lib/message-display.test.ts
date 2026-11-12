import assert from "node:assert/strict";
import test from "node:test";
import {
  DELIVERY_LABEL, formatChatTime, messageScopeKey, pendingForScope, queuedDeliveryState, queuedForScope,
  senderLabel, serverDeliveryState, shouldQueueSendFailure, type LocalPending,
} from "./message-display.ts";

test("sender is name or truthful role, never a raw id", () => {
  assert.equal(senderLabel({ own: true }), "Du");
  assert.equal(senderLabel({ own: false, name: "Olle Berg" }), "Olle Berg");
  assert.equal(senderLabel({ own: false, name: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", role: "dispatcher" }), "Trafikledning");
  assert.equal(senderLabel({ own: false, role: "driver" }), "Chaufför");
});

test("times shown in Stockholm time", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  assert.equal(formatChatTime("2026-07-01T05:07:00Z", now), "07:07");
  assert.equal(formatChatTime("2026-01-15T22:30:00Z", now), "15 jan 23:30");
});

test("Läst only for real stop receipts from someone else", () => {
  assert.equal(serverDeliveryState(true, [{ userId: "disp", readAt: "t" }], "me"), "read");
  assert.equal(serverDeliveryState(true, [{ userId: "me", readAt: "t" }], "me"), "saved");
  assert.equal(serverDeliveryState(false, [{ userId: "disp", readAt: "t" }], "me"), "saved");
  assert.equal(DELIVERY_LABEL.saved, "Sparat i systemet");
});

test("only connection failures are queued; auth and validation are not", () => {
  assert.equal(shouldQueueSendFailure({ status: 0 }), true);
  assert.equal(shouldQueueSendFailure({ status: 503 }), true);
  for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(shouldQueueSendFailure({ status }), false);
  assert.equal(shouldQueueSendFailure(new Error("NETWORK_ERROR")), true);
  assert.equal(shouldQueueSendFailure(new Error("API_403")), false);
});

test("scope isolation by actor + route + stop", () => {
  const a = messageScopeKey("u1", "r1", null);
  const b = messageScopeKey("u1", "r1", "s1");
  const other = messageScopeKey("u2", "r1", "s1");
  assert.notEqual(a, b);
  assert.notEqual(b, other);
  const pending: LocalPending[] = [
    { scopeKey: a, clientMessageId: "1", body: "x", createdAt: "t", status: "failed" },
    { scopeKey: b, clientMessageId: "2", body: "y", createdAt: "t", status: "sending" },
  ];
  assert.deepEqual(pendingForScope(pending, b, []).map((p) => p.clientMessageId), ["2"]);
  assert.deepEqual(pendingForScope(pending, a, ["1"]), []);
  const queue = [
    { routeId: "r1", clientMessageId: "q1", syncStatus: "pending" },
    { routeId: "r1", stopId: "s1", clientMessageId: "q2", syncStatus: "failed" },
    { routeId: "r2", clientMessageId: "q3" },
  ];
  assert.deepEqual(queuedForScope(queue, "r1", null, []).map((q) => q.clientMessageId), ["q1"]);
  assert.deepEqual(queuedForScope(queue, "r1", "s1", []).map((q) => q.clientMessageId), ["q2"]);
  assert.equal(queuedDeliveryState("pending"), "queued");
  assert.equal(queuedDeliveryState("failed"), "failed");
});

import { sameOfflineQueueOwner } from "./message-display.ts";

test("queued sends require the same owner that started them", () => {
  const owner = { userId: "u1", organizationId: "o1" };
  assert.equal(sameOfflineQueueOwner(owner, { userId: "u1", organizationId: "o1" }), true);
  assert.equal(sameOfflineQueueOwner(owner, { userId: "u2", organizationId: "o1" }), false);
  assert.equal(sameOfflineQueueOwner(owner, { userId: "u1", organizationId: "o2" }), false);
  assert.equal(sameOfflineQueueOwner(owner, null), false);
  assert.equal(sameOfflineQueueOwner(null, null), false);
});
