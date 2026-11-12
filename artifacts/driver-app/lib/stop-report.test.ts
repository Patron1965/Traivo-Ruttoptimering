import assert from "node:assert/strict";
import test from "node:test";
import { sendStopReport, type StopReport, type StopReportPort } from "./stop-report.ts";
import { evaluateProximity } from "./proximity.ts";

const report: StopReport = {
  id: "stable-report", stopId: "stop", routeId: "route", planVersion: 7,
  occurredAt: "2026-10-14T06:30:00Z", outcome: "completed", stage: "delivery",
  proofs: [{ type: "photo", data: "photo" }, { type: "signature", data: "signature" }],
};
function port(overrides: Partial<StopReportPort> = {}) {
  const calls: string[] = [];
  return { calls, api: {
    getStop: async () => ({ routeId: "route", jobType: "delivery" }),
    proof: async (_id, input) => { calls.push(input.clientEventId); },
    event: async (_id, input) => { calls.push(input.clientEventId); },
    pickup: async () => { calls.push("pickup"); },
    ...overrides,
  } satisfies StopReportPort };
}
test("media is acknowledged before an outcome; a retry retains operation IDs", async () => {
  const mock = port();
  await sendStopReport(report, mock.api);
  await sendStopReport(report, mock.api);
  assert.deepEqual(mock.calls, [
    "stable-report:proof:0", "stable-report:proof:1", "stable-report:outcome",
    "stable-report:proof:0", "stable-report:proof:1", "stable-report:outcome",
  ]);
});
test("failed media never sends completion", async () => {
  const mock = port({ proof: async () => { throw new Error("storage failure"); } });
  await assert.rejects(sendStopReport(report, mock.api));
  assert.equal(mock.calls.length, 0);
});
test("another route or service job cannot receive generic completion", async () => {
  for (const stop of [{ routeId: "other" }, { routeId: "route", jobType: "field_service" }]) {
    const mock = port({ getStop: async () => stop });
    await assert.rejects(sendStopReport(report, mock.api));
    assert.deepEqual(mock.calls, []);
  }
});
test("pickup only performs the existing pickup transition", async () => {
  const mock = port();
  await sendStopReport({ ...report, stage: "pickup" }, mock.api);
  assert.equal(mock.calls.at(-1), "pickup");
  assert.equal(mock.calls.some(id => id.includes("outcome")), false);
});
test("missing, inaccurate, stale and future GPS are unknown, not far", () => {
  const target = { latitude: 59.3, longitude: 18.1 };
  const sample = { ...target, accuracy: 10, recordedAt: 100_000 };
  assert.equal(evaluateProximity(null, target, 100_000).state, "unknown");
  assert.equal(evaluateProximity({ ...sample, accuracy: 100 }, target, 100_000).state, "unknown");
  assert.equal(evaluateProximity(sample, target, 200_000).state, "unknown");
  assert.equal(evaluateProximity(sample, target, 90_000).state, "unknown");
  assert.equal(evaluateProximity(sample, target, 100_000).state, "near");
  assert.equal(evaluateProximity({ ...sample, latitude: 59.4 }, target, 100_000).state, "far");
});
test("skipped report sends proofs first, then a skipped event with its reason", async () => {
  const events: unknown[] = [];
  const mock = port({ event: async (_id, input) => { events.push(input); } });
  await sendStopReport({ ...report, outcome: "skipped", skipReason: "OTHER", comment: "Orsak: Porten låst (kategori c1)" }, mock.api);
  assert.deepEqual(mock.calls, ["stable-report:proof:0", "stable-report:proof:1"]);
  assert.equal((events[0] as { type: string; skipReason: string }).type, "skipped");
  assert.equal((events[0] as { skipReason: string }).skipReason, "OTHER");
});
test("skipped pickup is an event, never a pickup transition", async () => {
  const mock = port();
  await sendStopReport({ ...report, stage: "pickup", outcome: "skipped", skipReason: "ACCESS_BLOCKED" }, mock.api);
  assert.equal(mock.calls.includes("pickup"), false);
  assert.equal(mock.calls.at(-1), "stable-report:outcome");
});
test("skipped report without an explicit reason is rejected before any upload", async () => {
  const mock = port();
  await assert.rejects(sendStopReport({ ...report, outcome: "skipped" }, mock.api));
  assert.deepEqual(mock.calls, []);
});
test("offline replay of a skipped photo report reuses the same proof and outcome IDs", async () => {
  const skipped: StopReport = { ...report, outcome: "skipped", skipReason: "OTHER", proofs: [{ type: "photo", data: "photo" }], comment: "Orsak: Porten låst (kategori 3f1c)" };
  let fail = true;
  const mock = port({ event: async (_id, input) => { if (fail) { fail = false; throw new Error("offline"); } mock.calls.push(input.clientEventId); } });
  await assert.rejects(sendStopReport(skipped, mock.api));
  await sendStopReport(skipped, mock.api);
  assert.deepEqual(mock.calls, ["stable-report:proof:0", "stable-report:proof:0", "stable-report:outcome"]);
  assert.equal(skipped.comment?.includes("Porten låst"), true);
});
