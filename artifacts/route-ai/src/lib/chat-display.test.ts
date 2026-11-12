import assert from "node:assert/strict";
import test from "node:test";
import {
  DELIVERY_LABEL, formatChatTime, patchPending, prunePending, readByCounterpart, senderLabel,
  serverDeliveryState, upsertPending, visiblePending, type PendingChatMessage,
} from "./chat-display.ts";

test("sender label uses real name, else truthful role, never a UUID", () => {
  assert.equal(senderLabel({ own: true, name: "Anna" }), "Du");
  assert.equal(senderLabel({ own: false, name: "Karin Lund" }), "Karin Lund");
  assert.equal(senderLabel({ own: false, name: "3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f", role: "driver" }), "Chaufför");
  assert.equal(senderLabel({ own: false, role: "dispatcher" }), "Trafikledning");
  assert.equal(senderLabel({ own: false, role: "something" }), "Okänd avsändare");
});

test("times are rendered in Stockholm time", () => {
  const now = new Date("2026-07-01T10:00:00Z");
  assert.equal(formatChatTime("2026-07-01T06:05:00Z", now), "08:05");
  assert.match(formatChatTime("2026-01-15T22:30:00Z", now), /15 jan\.? 23:30/);
});

test("Läst only from an actual counterpart stop receipt; route messages never read", () => {
  assert.equal(readByCounterpart([{ userId: "me", readAt: "x" }], "me"), false);
  assert.equal(serverDeliveryState("stop", [{ userId: "drv", readAt: "2026-01-01" }], "me"), "read");
  assert.equal(serverDeliveryState("stop", [], "me"), "saved");
  assert.equal(serverDeliveryState("route", [{ userId: "drv", readAt: "2026-01-01" }], "me"), "saved");
  assert.equal(DELIVERY_LABEL.queued, "Väntar på anslutning");
  assert.equal(DELIVERY_LABEL.failed, "Kunde inte skickas – försök igen");
});

const p = (scopeKey: string, id: string, status: PendingChatMessage["status"] = "sending"): PendingChatMessage =>
  ({ scopeKey, clientMessageId: id, body: id, createdAt: "2026-01-01T00:00:00Z", status });

test("pending evidence is isolated per scope and survives switching", () => {
  const state = [p("u1|route:r1", "a"), p("u1|stop:s1", "b", "failed"), p("u2|stop:s1", "c")];
  assert.deepEqual(visiblePending(state, "u1|stop:s1", []).map((x) => x.clientMessageId), ["b"]);
  assert.deepEqual(visiblePending(state, "u1|route:r1", ["a"]), []);
  // Pruning a confirmed message in one scope keeps every other scope intact.
  const pruned = prunePending(state, "u1|route:r1", ["a", "b"]);
  assert.deepEqual(pruned.map((x) => x.clientMessageId), ["b", "c"]);
  assert.equal(prunePending(state, "u1|route:r1", []), state);
});

test("retry keeps the same clientMessageId; successful POST becomes saved not error", () => {
  let state = upsertPending([], p("u1|route:r1", "x"));
  state = patchPending(state, "x", { status: "failed", error: "nät" });
  state = upsertPending(state, { ...state[0], status: "sending", error: undefined });
  assert.equal(state.length, 1);
  state = patchPending(state, "x", { status: "saved" });
  assert.equal(state[0].status, "saved");
  assert.equal(state[0].clientMessageId, "x");
});

import { routeDisplayName, unreadIdsToMark } from "./chat-display.ts";

test("hidden stop thread never marks messages read", () => {
  const msgs = [
    { id: "m1", senderUserId: "drv" },
    { id: "m2", senderUserId: "me" },
    { id: "m3", senderUserId: "drv", readReceipts: [{ userId: "me", readAt: "t" }] },
  ];
  assert.deepEqual(unreadIdsToMark(msgs, "me", new Set(), false), []);
  assert.deepEqual(unreadIdsToMark(msgs, "me", new Set(), true), ["m1"]);
  assert.deepEqual(unreadIdsToMark(msgs, "me", new Set(["m1"]), true), []);
});

test("route names never fall back to ids", () => {
  assert.equal(routeDisplayName("Norrort tisdag"), "Norrort tisdag");
  assert.equal(routeDisplayName("3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"), undefined);
  assert.equal(routeDisplayName(null), undefined);
});
