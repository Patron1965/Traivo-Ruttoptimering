import assert from "node:assert/strict";
import test from "node:test";
import { queueFailureStatus, assertConflictSelection, conflictStopItems } from "./queue-conflict-policy.ts";

test("expired login and retryable errors never become permanent route conflicts", () => {
  for (const status of [401, 408, 429, 500, 503]) assert.equal(queueFailureStatus(status, "generic"), "failed");
  assert.equal(queueFailureStatus(undefined, "unauthorized"), "failed");
  for (const status of [400, 403, 404, 409, 422]) assert.equal(queueFailureStatus(status, "generic"), "conflict");
  assert.equal(queueFailureStatus(undefined, "conflict"), "conflict");
});

test("archive selection includes dependencies on the same stop, not synced or other stops", () => {
  const conflict = { id: "a", queueType: "stopReport", stopId: "one", syncStatus: "conflict" };
  const pending = { ...conflict, id: "b", syncStatus: "pending" };
  const items = [conflict, pending, { ...pending, id: "c", stopId: "two" }, { ...pending, id: "d", syncStatus: "synced" }];
  assert.deepEqual(conflictStopItems(items, conflict), [conflict, pending]);
  assert.doesNotThrow(() => assertConflictSelection(items, [conflict, pending]));
  assert.throws(() => assertConflictSelection(items, [conflict]));
  assert.throws(() => assertConflictSelection(items, [conflict, pending, items[2]]));
  assert.throws(() => assertConflictSelection([{ ...conflict, syncStatus: "syncing" }, pending], [conflict, pending]));
});
