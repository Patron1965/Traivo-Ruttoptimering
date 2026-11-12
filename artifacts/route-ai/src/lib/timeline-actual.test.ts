import assert from "node:assert/strict";
import test from "node:test";
import { actualTerminalKind, buildActualMarks, compactActualLabels, stockholmParts } from "./timeline-actual.ts";

const grid = { startHour: 6, endHour: 20, width: 1400 };

test("Stockholm time is used regardless of runtime zone", () => {
  const p = stockholmParts(new Date("2026-11-09T09:21:28.657Z"));
  assert.equal(p?.time, "10:21");
  assert.equal(p?.date, "2026-11-09");
  assert.equal(stockholmParts(new Date("2026-07-01T08:00:00Z"))?.time, "10:00");
});

test("report on another day than plan is labelled with date and not placed on grid", () => {
  const [m] = buildActualMarks([{ stopId: "a", sequenceOrder: 1, status: "completed", terminalAt: "2026-11-09T09:21:28.657Z" }], "2026-11-10", grid);
  assert.equal(m.otherDay, true);
  assert.equal(m.label, "#1 Fakt. 9 nov 10:21");
  assert.equal(m.placement, "before_grid");
  assert.equal(m.x, null);
});

test("same-day report is placed at actual time", () => {
  const [m] = buildActualMarks([{ stopId: "a", sequenceOrder: 1, status: "failed", terminalAt: "2026-11-10T09:21:00Z" }], "2026-11-10", grid);
  assert.equal(m.placement, "in_grid");
  assert.equal(m.label, "#1 Fakt. 10:21");
  assert.ok(Math.abs((m.x ?? 0) - 435) < 0.1);
});

test("pending stops never get marks; invalid times are explicit; outside hours not clamped", () => {
  const marks = buildActualMarks([
    { stopId: "p", sequenceOrder: 1, status: "pending", terminalAt: "2026-11-10T09:00:00Z" },
    { stopId: "i", sequenceOrder: 2, status: "skipped", terminalAt: "nonsense" },
    { stopId: "m", sequenceOrder: 3, status: "completed", terminalAt: null },
    { stopId: "l", sequenceOrder: 4, status: "completed", terminalAt: "2026-11-10T21:30:00Z" },
  ], "2026-11-10", grid);
  assert.deepEqual(marks.map((m) => m.stopId).sort(), ["i", "l", "m"]);
  assert.equal(marks.find((m) => m.stopId === "i")?.placement, "invalid_time");
  assert.equal(marks.find((m) => m.stopId === "m")?.placement, "invalid_time");
  assert.equal(marks.find((m) => m.stopId === "l")?.placement, "after_grid");
  assert.equal(actualTerminalKind("arrived"), null);
});

test("stockholmHour converts for display", async () => {
  const { stockholmHour } = await import("./timeline-actual.ts");
  assert.ok(Math.abs(stockholmHour(new Date("2026-11-09T09:21:00Z")) - (10 + 21 / 60)) < 1e-9);
  assert.ok(Number.isNaN(stockholmHour(new Date("x"))));
});

test("overlapping adjacent labels are compacted", () => {
  const marks = buildActualMarks([
    { stopId: "a", sequenceOrder: 1, status: "completed", terminalAt: "2026-11-10T09:00:00Z" },
    { stopId: "b", sequenceOrder: 2, status: "completed", terminalAt: "2026-11-10T09:10:00Z" },
    { stopId: "c", sequenceOrder: 3, status: "completed", terminalAt: "2026-11-10T10:00:00Z" },
  ], "2026-11-10", grid);
  const shown = compactActualLabels(marks);
  assert.ok(shown.has("a"));
  assert.ok(!shown.has("b"));
  assert.ok(shown.has("c"));
});
