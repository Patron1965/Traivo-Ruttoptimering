import assert from "node:assert/strict";
import test from "node:test";
import { ensureWorkExecution, isRetryableWorkFailure } from "./work-execution.ts";

const accepted = { status: "optimized", handoffStatus: "accepted", handoffVersion: 24, planRevision: 24 };
test("work starts the accepted execution before a stop update without starting device GPS", async () => {
  const calls = [];
  await ensureWorkExecution("route", 24, {
    getRoute: async () => accepted,
    getExecution: async () => null,
    start: async (...args) => calls.push(args),
  }, "2026-10-14T06:00:00.000Z");
  assert.deepEqual(calls, [["route", "start", "work-start:route:24", "2026-10-14T06:00:00.000Z"]]);
});
test("work reuses an active execution and never rebases stale queued work", async () => {
  let starts = 0;
  const port = {
    getRoute: async () => accepted,
    getExecution: async () => ({ status: "active" }),
    start: async () => { starts++; },
  };
  await ensureWorkExecution("route", 24, port);
  assert.equal(starts, 0);
  await assert.rejects(ensureWorkExecution("route", 23, port));
  assert.equal(starts, 0);
  await assert.rejects(ensureWorkExecution("route", 24, {
    ...port, getRoute: async () => ({ ...accepted, handoffStatus: "sent" }),
  }));
});
test("only transport/server failures are retryable, never authorization or lifecycle conflicts", () => {
  for (const status of [0, 500, 502, 503]) assert.equal(isRetryableWorkFailure({ status }), true);
  for (const status of [400, 401, 403, 404, 409, 422, 429]) assert.equal(isRetryableWorkFailure({ status }), false);
  assert.equal(isRetryableWorkFailure(new Error("programming failure")), false);
});
