import test from "node:test";
import assert from "node:assert/strict";
import { initialOptimizeState, selectOptimizationZone } from "./district-zone-selection.ts";
import type { DistrictJob } from "./district-api";

test("selecting a zone prepares optimization without requiring edit mode or starting a job", () => {
  const next = selectOptimizationZone(initialOptimizeState, "zone-a", []);
  assert.equal(next.zoneId, "zone-a");
  assert.equal(next.jobId, null);
  assert.equal(next.start, null);
});

test("selecting the same zone preserves current endpoint choices and result interval", () => {
  const state = { ...initialOptimizeState, zoneId: "zone-a", start: { pointId: "point-a" }, from: 3, to: 20 };
  assert.equal(selectOptimizationZone(state, "zone-a", []), state);
});

test("changing zones restores only the selected zone's latest job and clears old selection state", () => {
  const jobs: DistrictJob[] = [
    { id: "old-a", zoneId: "zone-a", revision: 1, progress: 100, status: "completed", createdAt: "2026-10-01T10:00:00Z" },
    { id: "new-a", zoneId: "zone-a", revision: 2, progress: 100, status: "completed", createdAt: "2026-10-02T10:00:00Z", start: { pointId: "point-a" }, mode: "open", end: { pointId: "end-a" }, serviceMinutes: 9 },
    { id: "job-b", zoneId: "zone-b", revision: 1, progress: 100, status: "completed", createdAt: "2026-10-03T10:00:00Z", start: { pointId: "point-b" } },
  ];
  const state = { ...initialOptimizeState, zoneId: "zone-b", start: { pointId: "point-b" }, jobId: "job-b", from: 5, to: 12 };
  const next = selectOptimizationZone(state, "zone-a", jobs);
  assert.equal(next.zoneId, "zone-a");
  assert.equal(next.jobId, "new-a");
  assert.deepEqual(next.start, { pointId: "point-a" });
  assert.equal(next.serviceMinutes, 9);
  assert.equal(next.mode, "open");
  assert.equal(next.useEnd, true);
  assert.equal(next.from, 1);
  assert.equal(next.to, 1);
  assert.deepEqual(jobs.map((job) => job.id), ["old-a", "new-a", "job-b"]);
});