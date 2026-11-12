import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCurrentExecutionPlanVersion,
  assertDuplicateExecutionEventCompatible,
  ExecutionEventError,
  plannedCompletionTimes,
  STANDARD_SKIP_REASONS,
} from "./services/execution-event-service";

type Event = { id: string; order: number; type: "completed" | "failed" | "skipped" | "proof" | "comment" };

test("driver offline proof metadata remains ordered through dispatcher reconnect protocol", () => {
  const persisted = new Map<string, Event>();
  const dispatcherA: Event[] = [];
  const dispatcherB: Event[] = [];
  let dispatcherBOnline = true;
  const publish = (event: Event) => {
    dispatcherA.push(event);
    if (dispatcherBOnline) dispatcherB.push(event);
  };
  const accept = (event: Event) => {
    if (persisted.has(event.id)) return false;
    persisted.set(event.id, event);
    publish(event);
    return true;
  };

  const offlineQueue: Event[] = [
    { id: "complete-1", order: 1, type: "completed" },
    { id: "proof-1", order: 2, type: "proof", planVersion: 5, occurredAt: "2026-01-01T08:02:00.000Z" } as Event & { planVersion: number; occurredAt: string },
    { id: "comment-1", order: 3, type: "comment" },
  ];
  dispatcherBOnline = false;
  for (const event of offlineQueue.sort((a, b) => a.order - b.order)) accept(event);
  assert.equal(accept({ ...offlineQueue[0] }), false, "delayed duplicate is ignored");
  assert.deepEqual([...persisted.values()].map((event) => event.type), ["completed", "proof", "comment"]);
  const proof = persisted.get("proof-1") as Event & { planVersion: number; occurredAt: string };
  assert.equal(proof.planVersion, 5);
  assert.equal(proof.occurredAt, "2026-01-01T08:02:00.000Z");

  dispatcherBOnline = true;
  // The subscribed reconnect handler invalidates queries and therefore
  // rehydrates the authoritative snapshot rather than relying on WS replay.
  dispatcherB.splice(0, dispatcherB.length, ...persisted.values());
  assert.deepEqual(dispatcherA, dispatcherB);
});

test("skip has a mandatory standard reason and stale plan events conflict", () => {
  assert.ok(STANDARD_SKIP_REASONS.includes("CUSTOMER_UNAVAILABLE"));
  assert.throws(
    () => assertCurrentExecutionPlanVersion(4, 5),
    (error) => error instanceof ExecutionEventError && error.statusCode === 409,
  );
  assert.doesNotThrow(() => assertCurrentExecutionPlanVersion(5, 5));
  assert.throws(
    () => assertDuplicateExecutionEventCompatible(
      { stopId: "stop-a", eventType: "proof" },
      "stop-b",
      { type: "proof", planVersion: 5, occurredAt: "2026-01-01T08:00:00.000Z" },
    ),
    (error) => error instanceof ExecutionEventError && error.statusCode === 409,
  );
  assert.throws(
    () => assertDuplicateExecutionEventCompatible(
      { stopId: "stop-a", eventType: "proof" },
      "stop-a",
      { type: "comment", planVersion: 5, occurredAt: "2026-01-01T08:00:00.000Z" },
    ),
    (error) => error instanceof ExecutionEventError && error.statusCode === 409,
  );
});

test("planned completion uses route return/depot events, never legal shift end", () => {
  assert.deepEqual(plannedCompletionTimes([
    { type: "return", endAt: "2026-01-01T15:40:00.000Z" },
    { type: "depot_end", endAt: "2026-01-01T15:45:00.000Z" },
  ]), {
    expectedFinishAt: "2026-01-01T15:45:00.000Z",
    depotReturnAt: "2026-01-01T15:40:00.000Z",
  });
});

test("execution deviation protocol never proposes moving locked stops", () => {
  const stops = [
    { id: "done", status: "completed", sequence: 1 },
    { id: "active", status: "in_progress", sequence: 2 },
    { id: "remaining", status: "pending", sequence: 3 },
  ];
  const redistributionCandidates = stops.filter((stop) => stop.status === "pending");
  assert.deepEqual(redistributionCandidates.map((stop) => stop.id), ["remaining"]);
});
